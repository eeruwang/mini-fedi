/// <reference types="@cloudflare/workers-types" />
import type { PagesFunction } from "@cloudflare/workers-types";

type Env = { FEDIOAUTH_KV: KVNamespace };

// ---------- small utils ----------
function parseCookies(req: Request) {
  const h = req.headers.get("Cookie") || "";
  const out: Record<string, string> = {};
  h.split(/;\s*/).forEach((p) => {
    const i = p.indexOf("=");
    if (i > -1) out[p.slice(0, i)] = decodeURIComponent(p.slice(i + 1));
  });
  return out;
}

async function sha256Hex(s: string) {
  const data = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
      await new Promise<void>((r) => queue.push(r));
    }
    active++;
    try {
      return await task();
    } finally {
      next();
    }
  };
}

// ---------- normalize helpers ----------
function normalizeName(s: string) {
  return String(s || "").replace(/^:|:$/g, "").trim().toLowerCase();
}
function normalizeHost(h: string | null | undefined) {
  return (h || "").trim().toLowerCase() || null;
}
function variantsOfName(n: string) {
  const base = normalizeName(n);
  const underscore = base.replace(/-/g, "_");
  const hyphen = base.replace(/_/g, "-");
  return Array.from(new Set([base, underscore, hyphen]));
}

// ---------- Misskey helpers (KV + memory cached) ----------
const metaMem = new Map<string, any>(); // host(lower) -> meta(with indexes)

// 별칭(알리아스) 조회: meta._aliasByKey(Map)에서 정규화된 키로 탐색
function resolveAliasFromMeta(meta: any, key: string) {
  const idx = meta?._aliasByKey as Map<string, any> | undefined;
  if (!idx) return null;
  // key 의 여러 변형으로 조회 (콜론 제거/소문자/언더스코어/하이픈)
  for (const v of variantsOfName(key)) {
    const hit = idx.get(v);
    if (hit) return hit;
  }
  return null;
}

// 원격 호스트의 이모지 URL 조회: meta를 가져와 name 매칭
async function getEmojiUrlFromHost(env: Env, host: string, name: string): Promise<string | null> {
  const m = await getMisskeyMeta(env, normalizeHost(host)!).catch(() => null);
  if (!m) return null;
  return resolveEmojiUrlFromMeta(m, normalizeName(name));
}

async function getMisskeyMeta(env: Env, host: string) {
  host = normalizeHost(host)!;
  if (metaMem.has(host)) return metaMem.get(host);

  const kvKey = `mkmeta:${host}`;
  const cached = await env.FEDIOAUTH_KV.get(kvKey);
  if (cached) {
    try {
      const v = JSON.parse(cached);
      const withIndex = buildMetaIndex(v);
      metaMem.set(host, withIndex);
      return withIndex;
    } catch {}
  }

  const res = await fetchWithTimeout(
    `https://${host}/api/meta`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    },
    1500,
  );
  if (!res.ok) return null;

  const meta = await res.json();
  const withIndex = buildMetaIndex(meta);
  metaMem.set(host, withIndex);
  await env.FEDIOAUTH_KV.put(kvKey, JSON.stringify(meta), { expirationTtl: 86400 });
  return withIndex;
}

// ap/show (타임아웃 + KV 캐시)
async function getApShow(env: Env, host: string, apUri: string) {
  host = normalizeHost(host)!;
  const digest = await sha256Hex(apUri);
  const key = `mk:note:${host}:${digest}`;
  const cached = await env.FEDIOAUTH_KV.get(key);
  if (cached) {
    try {
      return { status: 200, data: JSON.parse(cached) };
    } catch {}
  }

  const res = await fetchWithTimeout(
    `https://${host}/api/ap/show`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uri: apUri }),
    },
    1500,
  );

  if (!res.ok) return { status: res.status, data: null };

  const data = await res.json();
  await env.FEDIOAUTH_KV.put(key, JSON.stringify(data), { expirationTtl: 120 });
  return { status: 200, data };
}

// 콜론 유무/패턴에 따라 custom/unicode 판단
function parseMkReactionKey(key: string) {
  const raw = String(key || "");
  // :name: / :name@host:
  if (/^:.*:$/.test(raw)) {
    const body = raw.slice(1, -1);
    const [n, h] = body.split("@");
    return { kind: "custom" as const, name: normalizeName(n), host: normalizeHost(h) };
  }
  const trimmed = raw.trim();
  // 콜론이 없어도 shortcode 패턴이면 custom 취급 (예: blobcat_siwasiwameltcry 또는 name@host)
  if (/^[a-z0-9._:-]+(?:@[a-z0-9.-]+)?$/i.test(trimmed)) {
    const [n, h] = trimmed.split("@");
    return { kind: "custom" as const, name: normalizeName(n), host: normalizeHost(h) };
  }
  // 그 외는 유니코드로 간주
  return { kind: "unicode" as const, name: trimmed, host: null };
}

// --- meta indexers ---
function buildMetaIndex(metaRaw: any) {
  const meta = metaRaw || {};

  // 1) 이모지 이름 → URL (여러 변형으로 인덱싱)
  const emojiByName = new Map<string, string>();
  const list = Array.isArray(meta?.emojis) ? meta.emojis : [];
  for (const e of list) {
    const url = e?.url || e?.uri || e?.publicUrl || null;
    if (!url) continue;
    for (const v of variantsOfName(e?.name || "")) {
      emojiByName.set(v, url);
    }
  }

  // 2) 별칭키 → 타입(custom/unicode)
  const maps = [
    meta?.reactionEmojis,
    meta?.reactions,
    meta?.reactionsConfig?.reactions,
  ].find((m) => m && typeof m === "object") as Record<string, unknown> | undefined;

  const aliasByKey = new Map<string, { kind: "custom" | "unicode"; name?: string; host?: string; char?: string }>();
  if (maps) {
    for (const [k, val] of Object.entries(maps)) {
      if (typeof val !== "string") continue;
      const s = val.trim();
      const normKeys = new Set<string>();
      // 키 자체도 여러 변형으로 인덱싱 (콜론제거/소문자/언더스코어↔하이픈)
      for (const vk of variantsOfName(k)) normKeys.add(vk);
      for (const nk of normKeys) {
        if (/^:.*:$/.test(s)) {
          const body = s.slice(1, -1);
          const [name, host] = body.split("@");
          aliasByKey.set(nk, { kind: "custom", name: normalizeName(name), host: normalizeHost(host) || undefined });
        } else {
          aliasByKey.set(nk, { kind: "unicode", char: s });
        }
      }
    }
  }

  (meta as any)._emojiByName = emojiByName;
  (meta as any)._aliasByKey = aliasByKey;
  return meta;
}

function resolveEmojiUrlFromMeta(meta: any, name: string) {
  const idx = meta?._emojiByName as Map<string, string> | undefined;
  if (!idx) return null;
  for (const v of variantsOfName(name)) {
    const url = idx.get(v);
    if (url) return url;
  }
  return null;
}

function resolveEmojiUrlFromApTag(apObject: any, name: string): string | null {
  const target = normalizeName(name);
  const tags = Array.isArray(apObject?.object?.tag)
    ? apObject.object.tag
    : Array.isArray(apObject?.tag)
    ? apObject.tag
    : [];
  for (const t of tags) {
    const tname = typeof t?.name === "string" ? normalizeName(t.name) : "";
    const url = t?.icon?.url || t?.icon?.href || t?.icon;
    if (t?.type === "Emoji" && tname === target && typeof url === "string") return url;
  }
  return null;
}

function extractMisskeyNoteIdFromApUri(apUri: string): string | null {
  try {
    const u = new URL(apUri);
    const m = u.pathname.match(/^\/notes\/([a-zA-Z0-9]+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function getNotesShow(env: Env, host: string, noteId: string) {
  host = normalizeHost(host)!;
  const key = `mk:note:byid:${host}:${noteId}`;
  const cached = await env.FEDIOAUTH_KV.get(key);
  if (cached) {
    try {
      return { status: 200, data: JSON.parse(cached) };
    } catch {}
  }

  const res = await fetchWithTimeout(
    `https://${host}/api/notes/show`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ noteId }),
    },
    1500,
  );

  if (!res.ok) return { status: res.status, data: null };

  const data = await res.json();
  await env.FEDIOAUTH_KV.put(key, JSON.stringify(data), { expirationTtl: 120 });
  return { status: 200, data };
}

// ---------- main ----------
// ... (파일 상단 유틸/정규화/인덱싱 함수들은 네가 올린 그대로 유지)

// ---------- main ----------
export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const t0 = Date.now();
  const { request, env } = ctx;
  const cookies = parseCookies(request);
  const apToken = cookies["ap_token"];
  const apInst  = cookies["ap_inst"];

  if (!apToken || !apInst) {
    return new Response(JSON.stringify({ error: "not logged in" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const url   = new URL(request.url);
  const max_id = url.searchParams.get("max_id") || "";
  const debug  = url.searchParams.get("debug") === "1" || url.searchParams.get("debug") === "2";
  const trace  = url.searchParams.get("debug") === "2" || url.searchParams.get("mktrace") === "1";

  // 병합 on/off, 병합 최대 개수
  const merge       = url.searchParams.get("merge") !== "0"; // 기본 on
  const mergeLimit  = Math.max(0, Number(url.searchParams.get("merge_limit") || "6")); // 기본 6

  // 1) Mastodon 홈
  const mastoURL = new URL(`https://${apInst}/api/v1/timelines/home`);
  if (max_id) mastoURL.searchParams.set("max_id", max_id);
  const res = await fetchWithTimeout(mastoURL.toString(), {
    headers: { authorization: `Bearer ${apToken}` },
  }, 5000);

  if (!res.ok) {
    return new Response(JSON.stringify({ error: `mastodon ${res.status}` }), {
      status: 502, headers: { "content-type": "application/json" },
    });
  }

  const statuses: any[] = await res.json();
  const linkHeader = res.headers.get("Link");
  const next_max_id =
    parseLinkForNextMaxId(linkHeader) ||
    (statuses.length ? statuses[statuses.length - 1].id : null);

  // 2) Misskey 리액션 병합
  let mergedCount = 0, triedCount = 0, errorCount = 0;

  // 디버그 카운터(헤더용)
  const counters = {
    alias_hits: 0,
    meta_hits: 0,
    remote_hits: 0,
    tag_hits: 0,
    unicode_pass: 0,
    custom_without_url: 0,
  };

  if (merge) {
    type Job = { st: any; apUri: string; host: string; noteId: string | null };
    const allJobs: Job[] = [];
    for (const st of statuses) {
      const apUri: string | undefined = st?.reblog?.uri || st?.uri;
      if (!apUri || !/^https?:\/\//i.test(apUri)) {
        if (debug) st._mkDebug = { stage: "skip_no_ap_uri" };
        continue;
      }
      const host = new URL(apUri).host.toLowerCase();
      const noteId = extractMisskeyNoteIdFromApUri(apUri);
      if (!noteId) {
        if (debug) st._mkDebug = { stage: "skip_non_misskey_shape", apUri, host };
        continue;
      }
      allJobs.push({ st, apUri, host, noteId });
    }

    const jobs = allJobs.slice(0, mergeLimit);

    const uniqueHosts = Array.from(new Set(jobs.map(j => j.host)));
    await Promise.all(uniqueHosts.map(h => getMisskeyMeta(env, h).catch(() => null)));

    const run = limiter(6);

    await Promise.all(jobs.map(job => run(async () => {
      const st = job.st;
      triedCount++;
      try {
        let apRes = await getApShow(env, job.host, job.apUri);
        let obj   = apRes.data?.object || apRes.data || null;

        if (!obj && job.noteId) {
          const { status, data } = await getNotesShow(env, job.host, job.noteId);
          if (status === 200 && data) {
            obj = data;
            if (debug) st._mkDebug = {
              stage: "fallback_notes_show_ok",
              apUri: job.apUri, host: job.host, noteId: job.noteId,
            };
          } else if (debug) {
            st._mkDebug = {
              stage: "no_ap_object_and_notes_show_failed",
              apUri: job.apUri, host: job.host, noteId: job.noteId, status,
            };
          }
        } else if (debug && !st._mkDebug) {
          st._mkDebug = {
            stage: apRes.status === 200 ? "ap_show_ok" : "ap_show_failed",
            status: apRes.status, apUri: job.apUri, host: job.host,
          };
        }

        if (!obj) return;

        const reactions = (obj as any)?.reactions || (obj as any)?.reactionCounts || null;
        if (!reactions || typeof reactions !== "object") {
          if (debug) st._mkDebug = { ...(st._mkDebug||{}), stage: "no_reactions" };
          return;
        }

        const meta = metaMem.get(job.host) || null;
        const out: Array<{ name: string; url: string | null; count: number; char?: string }> = [];
        const traceArr: any[] = []; // 리액션별 디버그

        for (const rawKey of Object.keys(reactions)) {
          const count = (reactions as any)[rawKey] ?? 0;
          if (!count) continue;

          const step: any = { key: rawKey, count };
          try {
            const keyNorm = normalizeName(rawKey);
            step.keyNorm = keyNorm;

            let kindInfo = parseMkReactionKey(rawKey);  // 내부에서 정규화
            step.parsed = kindInfo;

            // ① 별칭
            const alias = meta ? resolveAliasFromMeta(meta, keyNorm) : null;
            if (alias) step.alias = alias;

            if (alias?.kind === "unicode") {
              counters.alias_hits++;
              counters.unicode_pass++;
              out.push({ name: alias.char!, url: null, count, char: alias.char! });
              step.decision = "alias_unicode";
              trace && traceArr.push(step);
              continue;
            }
            if (alias?.kind === "custom") {
              counters.alias_hits++;
              kindInfo = {
                kind: "custom",
                name: normalizeName(alias.name!),
                host: normalizeHost(alias.host) || kindInfo.host,
              };
              step.decision = "alias_custom";
            }

            // ② 콜론 없이도 메타에 있으면 custom
            if (kindInfo.kind === "unicode" && meta && resolveEmojiUrlFromMeta(meta, keyNorm)) {
              kindInfo = { kind: "custom", name: keyNorm, host: null };
              step.metaSuggestsCustom = true;
            }

            if (kindInfo.kind === "unicode") {
              counters.unicode_pass++;
              out.push({ name: kindInfo.name, url: null, count, char: kindInfo.name });
              step.decision ??= "unicode";
              trace && traceArr.push(step);
              continue;
            }

            // custom: URL 해석 시도
            const name = normalizeName(kindInfo.name);
            step.name = name;

            // 1) 원글 호스트 meta
            let urlHit: string | null = meta ? resolveEmojiUrlFromMeta(meta, name) : null;
            if (urlHit) {
              counters.meta_hits++;
              step.urlFrom = "meta";
              step.url = urlHit;
            }

            // 2) 별칭/키에 호스트 있으면 그 호스트 meta
            if (!urlHit && kindInfo.host) {
              const h = normalizeHost(kindInfo.host)!;
              urlHit = await getEmojiUrlFromHost(env, h, name);
              if (urlHit) {
                counters.remote_hits++;
                step.urlFrom = "remote_meta";
                step.remoteHostTried = h;
                step.url = urlHit;
              }
            }

            // 3) AP 태그
            if (!urlHit) {
              const tagUrl = resolveEmojiUrlFromApTag(obj, name);
              if (tagUrl) {
                counters.tag_hits++;
                step.urlFrom = "ap_tag";
                step.url = tagUrl;
                urlHit = tagUrl;
              }
            }

            if (!urlHit) {
              counters.custom_without_url++;
              step.urlFrom = "none";
              step.reason = "no_url_from_meta_remote_tag";
            }

            out.push({ name, url: urlHit || null, count });
            trace && traceArr.push(step);
          } catch (err) {
            step.error = String(err);
            trace && traceArr.push(step);
          }
        }

        if (out.length) {
          st._mkReactions = out;
          st._mkHost      = job.host.toLowerCase();
          mergedCount++;
          if (debug) {
            st._mkDebug = { ...(st._mkDebug||{}), stage: st._mkDebug?.stage ?? "ok", merged: out.length, host: job.host };
            if (trace) st._mkTrace = traceArr; // ← ✨ 리액션별 상세 트레이스
          }
        } else if (debug) {
          st._mkDebug = { ...(st._mkDebug||{}), stage: "empty_after_parse" };
          if (trace) st._mkTrace = traceArr;
        }
      } catch (e:any) {
        errorCount++;
        if (debug) st._mkDebug = { stage: "error", message: String(e) };
      }
    })));
  } // merge

  const elapsed = Date.now() - t0;
  const body = JSON.stringify({ items: statuses, next_max_id });
  return new Response(body, {
    headers: {
      "content-type": "application/json",
      "x-mk-merge-summary": `tried=${triedCount}; merged=${mergedCount}; errors=${errorCount}`,
      "x-mk-merge-counters": JSON.stringify(counters),                 // ← ✨ 경로별 히트 통계
      "x-mk-merge-ms": String(elapsed),
    },
  });
};

