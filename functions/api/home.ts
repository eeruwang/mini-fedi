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
async function getApShow(env: Env, host: string, apUri: string) {
  const memKey = `${host}|${apUri}`;
  if (apMem.has(memKey)) return apMem.get(memKey);

  const digest = await sha256Hex(apUri);
  const kvKey = `mk:note:${host}:${digest}`;
  const cached = await env.FEDIOAUTH_KV.get(kvKey);
  if (cached) {
    try { const v = JSON.parse(cached); apMem.set(memKey, v); return v; } catch {}
  }

  const res = await fetchWithTimeout(`https://${host}/api/ap/show`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uri: apUri }),
  });
  if (!res.ok) return null;

  const data = await res.json();
  apMem.set(memKey, data);
  await env.FEDIOAUTH_KV.put(kvKey, JSON.stringify(data), { expirationTtl: 120 });
  return data;
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

  // 2) 리액션 병합 준비: 대상만 추려서 병렬 처리
  type Job = { st: any; host: string; apUri: string };
  const jobs: Job[] = [];

  for (const st of statuses) {
    const apUri: string | undefined = st?.reblog?.uri || st?.uri;
    if (!apUri || !/^https?:\/\//i.test(apUri)) continue;
    const host = new URL(apUri).host;
    if (looksClearlyMastodonHost(host)) continue; // 마스토돈/플레로마/아코마는 스킵(속도↑)
    jobs.push({ st, host, apUri });
  }

  // 호스트별 meta는 미리 병렬로 받아두기 (dedupe)
  const uniqueHosts = Array.from(new Set(jobs.map(j => j.host)));
  await Promise.all(uniqueHosts.map(h => getMisskeyMeta(env, h).catch(() => null)));

  // ap/show 병렬 처리 (동시 6개 제한)
  const run = limiter(6);
  await Promise.all(jobs.map(job => run(async () => {
    try {
      const ap = await getApShow(env, job.host, job.apUri);
      const obj = ap?.object || ap;
      if (!obj) return;

      const reactions =
        obj?.reactions ||
        obj?.reactionCounts ||
        ap?.reactions ||
        ap?.reactionCounts ||
        null;
      if (!reactions || typeof reactions !== "object") return;

      const meta = metaMem.get(job.host) || null;
      const out: Array<{ name: string; url: string|null; count: number }> = [];

      for (const k of Object.keys(reactions)) {
        const count = reactions[k] ?? 0;
        if (!count) continue;
        const { kind, name } = parseMkReactionKey(k);
        if (kind === "unicode") {
          out.push({ name, url: null, count });
        } else {
          const url1 = meta ? resolveEmojiUrlFromMeta(meta, name) : null;
          const url2 = resolveEmojiUrlFromApTag(ap, name);
          out.push({ name, url: url1 || url2 || null, count });
        }
      }
      if (out.length) job.st._mkReactions = out;
    } catch {
      // 개별 실패 무시
    }
  })));

  return new Response(JSON.stringify({ items: statuses, next_max_id }), {
    headers: { "content-type": "application/json" }
  });
};
