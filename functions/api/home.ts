/// <reference types="@cloudflare/workers-types" />
import type { PagesFunction } from "@cloudflare/workers-types";

type Env = { FEDIOAUTH_KV: KVNamespace };

// ---------- utils ----------
function parseCookies(req: Request) {
  const h = req.headers.get("Cookie") || "";
  const out: Record<string, string> = {};
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

// ---------- Misskey helpers (KV cached) ----------
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
async function getApShow(env: Env, host: string, apUri: string) {
  const digest = await sha256Hex(apUri);
  const key = `mk:note:${host}:${digest}`;
  const cached = await env.FEDIOAUTH_KV.get(key);
  if (cached) { try { return JSON.parse(cached); } catch {} }

  const res = await fetch(`https://${host}/api/ap/show`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uri: apUri }),
  });
  if (!res.ok) return null;

  const data = await res.json();
  await env.FEDIOAUTH_KV.put(key, JSON.stringify(data), { expirationTtl: 120 });
  return data;
}
// 키 정규화 (":name:", ":name@host:", "👍")
function parseMkReactionKey(key: string) {
  if (!key.includes(":")) return { kind: "unicode" as const, name: key, host: null };
  const trimmed = key.replace(/^:/, "").replace(/:$/, "");
  const [name, host] = trimmed.split("@");
  return { kind: "custom" as const, name, host: host || null };
}
// meta.emojis에서 URL 찾기
function resolveEmojiUrlFromMeta(meta: any, name: string): string | null {
  const list = Array.isArray(meta?.emojis) ? meta.emojis : [];
  const found = list.find((e: any) => e?.name === name);
  return found?.url || null;
}
// AP 객체의 tag[]에서 URL 찾기 (type=Emoji, name=":foo:", icon.url)
function resolveEmojiUrlFromApTag(apObject: any, name: string): string | null {
  const tags = Array.isArray(apObject?.tag) ? apObject.tag : [];
  for (const t of tags) {
    const tname = typeof t?.name === "string" ? t.name.replace(/^:/,"").replace(/:$/,"") : "";
    const url = t?.icon?.url || t?.icon?.href || t?.icon;
    if (t?.type === "Emoji" && tname === name && typeof url === "string") return url;
  }
  return null;
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

  // 2) Misskey 리액션 병합 (meta 판정 없이 ap/show 먼저 시도 → 실패 시 스킵)
  for (const st of statuses) {
    try {
      // AP 원본(부스트면 reblog.uri 우선)
      const apUri: string | undefined = st?.reblog?.uri || st?.uri;
      if (!apUri || !/^https?:\/\//i.test(apUri)) continue;

      const originHost = new URL(apUri).host;

      // ap/show 조회
      const ap = await getApShow(env, originHost, apUri);
      const obj = ap?.object || ap;
      if (!obj) { if (debug) st._mkDebug = { stage: "no_ap_object", apUri }; continue; }

      // reactions/Counts 다양한 케이스 시도
      const reactions =
        obj?.reactions ||
        obj?.reactionCounts ||
        ap?.reactions ||
        ap?.reactionCounts ||
        null;

      if (!reactions || typeof reactions !== "object") {
        if (debug) st._mkDebug = { stage: "no_reactions", apUri };
        continue;
      }

      // 메타는 이모지 URL 해상에만 사용 (없어도 태그로 보조)
      const meta = await getMisskeyMeta(env, originHost).catch(() => null);

      const out: Array<{ name: string; url: string|null; count: number }> = [];
      for (const k of Object.keys(reactions)) {
        const count = reactions[k] ?? 0;
        if (!count) continue;

        const { kind, name } = parseMkReactionKey(k);
        if (kind === "unicode") {
          out.push({ name, url: null, count });
        } else {
          // 1) meta.emojis  2) AP tag(Emoji)  둘 다 시도
          const url1 = meta ? resolveEmojiUrlFromMeta(meta, name) : null;
          const url2 = resolveEmojiUrlFromApTag(obj, name);
          out.push({ name, url: url1 || url2 || null, count });
        }
      }

      if (out.length) {
        st._mkReactions = out;
        if (debug) st._mkDebug = { stage: "ok", apUri, host: originHost, merged: out.length };
      } else if (debug) {
        st._mkDebug = { stage: "empty_after_parse", apUri, keys: Object.keys(reactions) };
      }
    } catch (e: any) {
      if (debug) st._mkDebug = { stage: "error", message: String(e) };
    }
  }

  return new Response(JSON.stringify({ items: statuses, next_max_id }), {
    headers: { "content-type": "application/json" }
  });
};
