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
const metaMem = new Map<string, any>();          // host -> meta
const apMem   = new Map<string, any>();          // host|uri -> apObject

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
  });
  if (!res.ok) return null;
  const meta = await res.json();
  metaMem.set(host, meta);
  await env.FEDIOAUTH_KV.put(kvKey, JSON.stringify(meta), { expirationTtl: 86400 });
  return meta;
}
// 교체: ap/show 호출 함수
async function getApShow(env: Env, host: string, apUri: string) {
  const digest = await sha256Hex(apUri);
  const key = `mk:note:${host}:${digest}`;
  const cached = await env.FEDIOAUTH_KV.get(key);
  if (cached) { try { return { status: 200, data: JSON.parse(cached) }; } catch {} }

  const res = await fetch(`https://${host}/api/ap/show`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uri: apUri }),
  });

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

  const res = await fetch(`https://${host}/api/notes/show`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ noteId }),
  });

  if (!res.ok) return { status: res.status, data: null };

  const data = await res.json();
  await env.FEDIOAUTH_KV.put(key, JSON.stringify(data), { expirationTtl: 120 });
  return { status: 200, data };
}


function looksClearlyMastodonHost(host: string) {
  // 아주 러프한 스킵 규칙: mastodon/pleroma/akkoma 등은 Misskey 아님
  return /mastodon|pleroma|akkoma/i.test(host);
}

// ---------- main ----------
export const onRequestGet: PagesFunction<Env> = async (ctx) => {
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

  // 1) Mastodon 홈
  const mastoURL = new URL(`https://${apInst}/api/v1/timelines/home`);
  if (max_id) mastoURL.searchParams.set("max_id", max_id);

  const res = await fetch(mastoURL.toString(), {
    headers: { authorization: `Bearer ${apToken}` }
  });
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

  let mergedCount = 0, triedCount = 0, errorCount = 0;

  // 2) Misskey 리액션 병합 (디버그 기록 포함)
  for (const st of statuses) {
    try {
      const apUri: string | undefined = st?.reblog?.uri || st?.uri;
      if (!apUri || !/^https?:\/\//i.test(apUri)) { if (debug) st._mkDebug = { stage: "skip_no_ap_uri" }; continue; }
      const originHost = new URL(apUri).host;

      // 1) ap/show 먼저 시도
      let apShowResp = await getApShow(env, originHost, apUri);
      let obj = apShowResp.data?.object || apShowResp.data || null;

      // 2) ap/show 실패(예: 401) → notes/show 폴백
      if (!obj) {
        const noteId = extractMisskeyNoteIdFromApUri(apUri);
        if (noteId) {
          const { status, data } = await getNotesShow(env, originHost, noteId);
          if (status === 200 && data) {
            obj = data; // notes/show는 note 객체를 바로 반환
            if (debug) st._mkDebug = { stage: "fallback_notes_show_ok", apUri, host: originHost, noteId };
          } else if (debug) {
            st._mkDebug = { stage: "no_ap_object_and_notes_show_failed", apUri, host: originHost, noteId, status };
          }
        } else if (debug) {
          st._mkDebug = { stage: "no_ap_object_no_noteid", apUri, host: originHost, apShowStatus: apShowResp.status };
        }
      }

      if (!obj) continue;

      // 3) 리액션 추출 (여러 변형 지원)
      const reactions =
        obj?.reactions ||
        obj?.reactionCounts ||
        null;

      if (!reactions || typeof reactions !== "object") {
        if (debug) st._mkDebug = { ...(st._mkDebug||{}), stage: "no_reactions", keys: Object.keys(obj||{}) };
        continue;
      }

      // 4) 이모지 URL 해상 (meta + AP tag)
      const meta = await getMisskeyMeta(env, originHost).catch(()=>null);
      const out: Array<{ name: string; url: string|null; count: number }> = [];

      for (const k of Object.keys(reactions)) {
        const count = reactions[k] ?? 0;
        if (!count) continue;
        const { kind, name } = parseMkReactionKey(k);
        if (kind === "unicode") {
          out.push({ name, url: null, count });
        } else {
          const url1 = meta ? resolveEmojiUrlFromMeta(meta, name) : null;
          const url2 = resolveEmojiUrlFromApTag(obj, name); // obj에 tag가 있으면 그걸로도 해상
          out.push({ name, url: url1 || url2 || null, count });
        }
      }

      if (out.length) {
        st._mkReactions = out;
        if (debug) st._mkDebug = { ...(st._mkDebug||{}), stage: (st._mkDebug?.stage ?? "ok"), merged: out.length };
      } else if (debug) {
        st._mkDebug = { ...(st._mkDebug||{}), stage: "empty_after_parse", keys: Object.keys(reactions) };
      }
    } catch (e: any) {
      if (debug) st._mkDebug = { stage: "error", message: String(e) };
    }
  }


  const body = JSON.stringify({ items: statuses, next_max_id });
  return new Response(body, {
    headers: {
      "content-type": "application/json",
      "x-mk-merge-summary": `tried=${triedCount}; merged=${mergedCount}; errors=${errorCount}`
    }
  });
};
