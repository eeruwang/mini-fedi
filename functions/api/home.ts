/// <reference types="@cloudflare/workers-types" />
import type { PagesFunction } from "@cloudflare/workers-types";

type Env = { FEDIOAUTH_KV: KVNamespace };

// ---------- small utils ----------
function parseCookies(req: Request) {
  const h = req.headers.get("Cookie") || "";
  const out: Record<string,string> = {};
  h.split(/;\s*/).forEach(p => {
    const i = p.indexOf("="); if (i > -1) out[p.slice(0,i)] = decodeURIComponent(p.slice(i+1));
  });
  return out;
}

async function sha256Hex(s: string) {
  const data = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,"0")).join("");
}

function parseLinkForNextMaxId(link: string | null): string | null {
  if (!link) return null;
  const m = link.match(/<[^>]*[?&]max_id=([^&>]+)[^>]*>;\s*rel="next"/);
  return m ? decodeURIComponent(m[1]) : null;
}

async function fetchWithTimeout(input: RequestInfo, init: RequestInit = {}, ms = 1500) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(input, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

function limiter(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    const fn = queue.shift();
    if (fn) fn();
  };
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= concurrency) {
      await new Promise<void>(r => queue.push(r));
    }
    active++;
    try { return await task(); } finally { next(); }
  };
}

// ---------- Misskey helpers (KV + memory cached) ----------
const metaMem = new Map<string, any>(); // host -> meta

// ⬇️⬇️ 여기 아래에 'resolveAliasFromMeta' 함수를 그대로 붙여넣기
function resolveAliasFromMeta(meta: any, key: string) {
  // Misskey 계열마다 저장 위치가 달라서 몇 군데를 탐색
  const maps = [
    meta?.reactionEmojis,                // Misskey
    meta?.reactions,                     // 일부 포크
    meta?.reactionsConfig?.reactions     // 또 다른 포크 표기
  ].find(m => m && typeof m === 'object') as Record<string, unknown> | undefined;

  if (!maps) return null;
  const v = maps[key];
  if (typeof v !== 'string') return null;

  const s = v.trim();
  // ":name:" 또는 ":name@host:" 같은 커스텀 이모지 별칭
  if (/^:.*:$/.test(s)) {
    const nameHost = s.slice(1, -1); // 양쪽 콜론 제거
    const [name, host] = nameHost.split('@');
    return { kind: 'custom' as const, name, host: host || null };
  }
  // 유니코드 문자(예: ❤️)로 매핑된 별칭
  return { kind: 'unicode' as const, char: s };
}


async function getMisskeyMeta(env: Env, host: string) {
  if (metaMem.has(host)) return metaMem.get(host);
  const kvKey = `mkmeta:${host}`;
  const cached = await env.FEDIOAUTH_KV.get(kvKey);
  if (cached) {
    try { const v = JSON.parse(cached); metaMem.set(host, v); return v; } catch {}
  }
  const res = await fetchWithTimeout(`https://${host}/api/meta`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  }, 1500);
  if (!res.ok) return null;
  const meta = await res.json();
  metaMem.set(host, meta);
  await env.FEDIOAUTH_KV.put(kvKey, JSON.stringify(meta), { expirationTtl: 86400 });
  return meta;
}

// ap/show (타임아웃 + KV 캐시)
async function getApShow(env: Env, host: string, apUri: string) {
  const digest = await sha256Hex(apUri);
  const key = `mk:note:${host}:${digest}`;
  const cached = await env.FEDIOAUTH_KV.get(key);
  if (cached) { try { return { status: 200, data: JSON.parse(cached) }; } catch {} }

  const res = await fetchWithTimeout(`https://${host}/api/ap/show`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uri: apUri }),
  }, 1500);

  if (!res.ok) return { status: res.status, data: null };

  const data = await res.json();
  await env.FEDIOAUTH_KV.put(key, JSON.stringify(data), { expirationTtl: 120 });
  return { status: 200, data };
}

function parseMkReactionKey(key: string) {
  if (!key.includes(":")) return { kind: "unicode" as const, name: key, host: null };
  const trimmed = key.replace(/^:/, "").replace(/:$/, "");
  const [name, host] = trimmed.split("@");
  return { kind: "custom" as const, name, host: host || null };
}

function resolveEmojiUrlFromMeta(meta: any, name: string) {
  const list = Array.isArray(meta?.emojis) ? meta.emojis : [];
  const found = list.find((e: any) => e?.name === name);
  return found?.url || null;
}

function resolveEmojiUrlFromApTag(apObject: any, name: string): string | null {
  const tags = Array.isArray(apObject?.object?.tag) ? apObject.object.tag
             : Array.isArray(apObject?.tag) ? apObject.tag : [];
  for (const t of tags) {
    const tname = typeof t?.name === "string" ? t.name.replace(/^:/,"").replace(/:$/,"") : "";
    const url = t?.icon?.url || t?.icon?.href || t?.icon;
    if (t?.type === "Emoji" && tname === name && typeof url === "string") return url;
  }
  return null;
}

function extractMisskeyNoteIdFromApUri(apUri: string): string | null {
  try {
    const u = new URL(apUri);
    const m = u.pathname.match(/^\/notes\/([a-zA-Z0-9]+)/);
    return m ? m[1] : null;
  } catch { return null; }
}

async function getNotesShow(env: Env, host: string, noteId: string) {
  const key = `mk:note:byid:${host}:${noteId}`;
  const cached = await env.FEDIOAUTH_KV.get(key);
  if (cached) { try { return { status: 200, data: JSON.parse(cached) }; } catch {} }

  const res = await fetchWithTimeout(`https://${host}/api/notes/show`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ noteId }),
  }, 1500);

  if (!res.ok) return { status: res.status, data: null };

  const data = await res.json();
  await env.FEDIOAUTH_KV.put(key, JSON.stringify(data), { expirationTtl: 120 });
  return { status: 200, data };
}

// ---------- main ----------
export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const t0 = Date.now();
  const { request, env } = ctx;
  const cookies = parseCookies(request);
  const apToken = cookies["ap_token"];
  const apInst  = cookies["ap_inst"];

  if (!apToken || !apInst) {
    return new Response(JSON.stringify({ error: "not logged in" }), {
      status: 401, headers: { "content-type": "application/json" }
    });
  }

  const url = new URL(request.url);
  const max_id = url.searchParams.get("max_id") || "";
  const debug  = url.searchParams.get("debug") === "1";

  // 👇 추가: 병합 on/off, 병합 최대 개수
  const merge = url.searchParams.get("merge") !== "0";            // 기본 on
  const mergeLimit = Math.max(0, Number(url.searchParams.get("merge_limit") || "6")); // 기본 6개만

  // 1) Mastodon 홈
  const mastoURL = new URL(`https://${apInst}/api/v1/timelines/home`);
  if (max_id) mastoURL.searchParams.set("max_id", max_id);

  const res = await fetchWithTimeout(mastoURL.toString(), {
    headers: { authorization: `Bearer ${apToken}` }
  }, 5000);
  if (!res.ok) {
    return new Response(JSON.stringify({ error: `mastodon ${res.status}` }), {
      status: 502, headers: { "content-type": "application/json" }
    });
  }

  const statuses: any[] = await res.json();
  const linkHeader = res.headers.get("Link");
  const next_max_id =
    parseLinkForNextMaxId(linkHeader) ||
    (statuses.length ? statuses[statuses.length - 1].id : null);


  // ---- 2) Misskey 리액션 병합 (병렬 처리) ----
  let mergedCount = 0, triedCount = 0, errorCount = 0;

  if (merge) {
    // ---- Misskey 리액션 병합 (병렬 처리) ----
    // 후보만 추출
    type Job = { st: any; apUri: string; host: string; noteId: string|null };
    const allJobs: Job[] = [];
    for (const st of statuses) {
      const apUri: string | undefined = st?.reblog?.uri || st?.uri;
      if (!apUri || !/^https?:\/\//i.test(apUri)) { if (debug) st._mkDebug = { stage: "skip_no_ap_uri" }; continue; }
      const noteId = extractMisskeyNoteIdFromApUri(apUri);
      if (!noteId) { if (debug) st._mkDebug = { stage: "skip_non_misskey_shape", apUri, host: new URL(apUri).host }; continue; }
      allJobs.push({ st, apUri, host: new URL(apUri).host, noteId });
    }

    // 👇 추가: 페이지당 병합 개수 제한
    const jobs = allJobs.slice(0, mergeLimit);

    // 호스트별 meta 1회 선행
    const uniqueHosts = Array.from(new Set(jobs.map(j => j.host)));
    await Promise.all(uniqueHosts.map(h => getMisskeyMeta(env, h).catch(()=>null)));

    const run = limiter(6); // 동시 6개 유지

    await Promise.all(jobs.map(job => run(async () => {
      const st = job.st;
      triedCount++;
      try {
        let apRes = await getApShow(env, job.host, job.apUri);
        let obj = apRes.data?.object || apRes.data || null;

        if (!obj && job.noteId) {
          const { status, data } = await getNotesShow(env, job.host, job.noteId);
          if (status === 200 && data) {
            obj = data;
            if (debug) st._mkDebug = { stage: "fallback_notes_show_ok", apUri: job.apUri, host: job.host, noteId: job.noteId };
          } else if (debug) {
            st._mkDebug = { stage: "no_ap_object_and_notes_show_failed", apUri: job.apUri, host: job.host, noteId: job.noteId, status };
          }
        } else if (debug && !st._mkDebug) {
          st._mkDebug = { stage: apRes.status === 200 ? "ap_show_ok" : "ap_show_failed", status: apRes.status, apUri: job.apUri, host: job.host };
        }

        if (!obj) return;

        const reactions = obj?.reactions || obj?.reactionCounts || null;
        if (!reactions || typeof reactions !== "object") {
          if (debug) st._mkDebug = { ...(st._mkDebug||{}), stage: "no_reactions" };
          return;
        }

        const meta = metaMem.get(job.host) || null;
        // char(유니코드) 지원을 위해 char?: string 필드 추가
        const out: Array<{ name: string; url: string | null; count: number; char?: string }> = [];

        for (const k of Object.keys(reactions)) {
          const count = reactions[k] ?? 0;
          if (!count) continue;

          // 기본 분류 (콜론 존재 여부)
          let kindInfo = parseMkReactionKey(k);

          // 콜론이 없는 키(우리 로직상 'unicode')일 때 → meta 별칭 해석 시도
          if (kindInfo.kind === 'unicode' && meta) {
            const alias = resolveAliasFromMeta(meta, k);
            if (alias) {
              if (alias.kind === 'custom') {
                // 별칭이 커스텀 이모지라면 name을 치환
                kindInfo = { kind: 'custom', name: alias.name, host: alias.host };
              } else {
                // 유니코드 문자 매핑이면 문자로 바로 추가
                out.push({ name: alias.char, url: null, count, char: alias.char });
                continue;
              }
            }
          }

          if (kindInfo.kind === 'unicode') {
            // 진짜 텍스트/유니코드(별칭 아님)
            out.push({ name: kindInfo.name, url: null, count, char: kindInfo.name });
          } else {
            // 커스텀 이모지 URL 해상 (meta 우선, 없으면 AP tag)
            const name = kindInfo.name;
            const url1 = meta ? resolveEmojiUrlFromMeta(meta, name) : null;
            const url2 = resolveEmojiUrlFromApTag(obj, name);
            out.push({ name, url: url1 || url2 || null, count });
          }
        }


        if (out.length) {
          st._mkReactions = out;
          // 디버깅/클라 보강용으로 호스트도 내려주면 좋음
          st._mkHost = job.host;
          mergedCount++;
          if (debug) st._mkDebug = { ...(st._mkDebug||{}), stage: (st._mkDebug?.stage ?? "ok"), merged: out.length, host: job.host };
        } else if (debug) {
          st._mkDebug = { ...(st._mkDebug||{}), stage: "empty_after_parse" };
        }
      } catch (e:any) {
        errorCount++;
        if (debug) st._mkDebug = { stage: "error", message: String(e) };
      }
    })));
  } // if(merge)


  const elapsed = Date.now() - t0;
  const body = JSON.stringify({ items: statuses, next_max_id });
  return new Response(body, {
    headers: {
      "content-type": "application/json",
      "x-mk-merge-summary": `tried=${triedCount}; merged=${mergedCount}; errors=${errorCount}`,
      "x-mk-merge-ms": String(elapsed)
    }
  });
};
