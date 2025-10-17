/// <reference types="@cloudflare/workers-types" />
import type { PagesFunction } from "@cloudflare/workers-types";

type Env = { FEDIOAUTH_KV: KVNamespace };

// ===== utils =====
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
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2,"0")).join("");
}
function parseLinkForNextMaxId(link: string | null): string | null {
  if (!link) return null;
  // e.g. <https://mastodon.example/api/v1/timelines/home?max_id=12345>; rel="next", ...
  const m = link.match(/<[^>]*[?&]max_id=([^&>]+)[^>]*>;\s*rel="next"/);
  return m ? decodeURIComponent(m[1]) : null;
}

// ===== Misskey helpers (KV cached) =====
async function getMisskeyMeta(env: Env, host: string) {
  const key = `mkmeta:${host}`;
  const cached = await env.FEDIOAUTH_KV.get(key);
  if (cached) { try { return JSON.parse(cached); } catch {} }
  const res = await fetch(`https://${host}/api/meta`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) return null;
  const meta = await res.json();
  await env.FEDIOAUTH_KV.put(key, JSON.stringify(meta), { expirationTtl: 86400 });
  return meta;
}
function looksLikeMisskey(meta: any) {
  const n = String(meta?.softwareName || meta?.name || "").toLowerCase();
  return n.includes("misskey") || n.includes("foundkey") || n.includes("calckey");
}
async function getApShow(env: Env, host: string, uri: string) {
  const digest = await sha256Hex(uri);
  const key = `mk:note:${host}:${digest}`;
  const cached = await env.FEDIOAUTH_KV.get(key);
  if (cached) { try { return JSON.parse(cached); } catch {} }
  const res = await fetch(`https://${host}/api/ap/show`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uri }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  await env.FEDIOAUTH_KV.put(key, JSON.stringify(data), { expirationTtl: 120 });
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

// ===== main handler =====
export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const { request, env } = ctx;
  const cookies = parseCookies(request);
  const apToken = cookies["ap_token"];
  const apInst  = cookies["ap_inst"]; // e.g. mastodon.social

  if (!apToken || !apInst) {
    return new Response(JSON.stringify({ error: "not logged in" }), {
      status: 401, headers: { "content-type": "application/json" }
    });
  }

  const url = new URL(request.url);
  const max_id = url.searchParams.get("max_id") || "";

  // 1) fetch Mastodon home
  const mastoURL = new URL(`https://${apInst}/api/v1/timelines/home`);
  if (max_id) mastoURL.searchParams.set("max_id", max_id);

  const res = await fetch(mastoURL.toString(), {
    headers: { "authorization": `Bearer ${apToken}` }
  });
  if (!res.ok) {
    return new Response(JSON.stringify({ error: `mastodon ${res.status}` }), {
      status: 502, headers: { "content-type": "application/json" }
    });
  }
  const statuses: any[] = await res.json();
  const linkHeader = res.headers.get("Link");
  const next_max_id = parseLinkForNextMaxId(linkHeader) || (statuses.length ? statuses[statuses.length-1].id : null);

  // 2) merge Misskey reactions into each status as _mkReactions
  for (const st of statuses) {
    try {
      const uri: string | undefined = st?.url;
      if (!uri) continue;
      const u = new URL(uri);
      const originHost = u.host;

      const meta = await getMisskeyMeta(env, originHost);
      if (!meta || !looksLikeMisskey(meta)) continue;

      const ap = await getApShow(env, originHost, uri);
      const reactions = ap?.object?.reactions || ap?.reactions || null;
      if (!reactions || typeof reactions !== "object") continue;

      const out: Array<{ name: string; url: string|null; count: number }> = [];
      for (const k of Object.keys(reactions)) {
        const count = reactions[k] ?? 0;
        if (!count) continue;
        const { kind, name } = parseMkReactionKey(k);
        if (kind === "unicode") {
          out.push({ name, url: null, count });
        } else {
          const url = resolveEmojiUrlFromMeta(meta, name) || null;
          out.push({ name, url, count });
        }
      }
      if (out.length) st._mkReactions = out;
    } catch {
      // ignore per-status failures
    }
  }

  return new Response(JSON.stringify({ items: statuses, next_max_id }), {
    headers: { "content-type": "application/json" }
  });
};
