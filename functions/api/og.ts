/// <reference types="@cloudflare/workers-types" />
import type { PagesFunction } from "@cloudflare/workers-types";

type Env = { FEDIOAUTH_KV: KVNamespace };

type Og =
  | { ok: true; url: string; finalUrl: string; title?: string; desc?: string; site?: string; image?: string; favicon?: string }
  | { ok: false; url: string; reason: string };

const ORIGIN_TIMEOUT = 2000;         // 원본 응답 타임아웃(짧게)
const CACHE_TTL_OK = 60 * 60 * 12;   // 12시간 캐시
const CACHE_TTL_NG = 60 * 20;        // 실패 20분 부정 캐시

async function fetchWithTimeout(input: RequestInfo, init: RequestInit = {}, ms = ORIGIN_TIMEOUT) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(input, { ...init, signal: ctrl.signal, redirect: "follow" });
  } finally { clearTimeout(id); }
}

function abs(u: string, base: string) {
  try { return new URL(u, base).toString(); } catch { return undefined; }
}

function pickOg(html: string, finalUrl: string) {
  // 매우 가벼운 정규식 파서 (cheerio 없이)
  const m = (p: RegExp) => html.match(p)?.[1]?.trim();
  const get = (name: string) => m(new RegExp(`<meta[^>]+property=["']${name}["'][^>]+content=["']([^"']+)["']`, "i"))
                 || m(new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, "i"));

  const title = get("og:title") || m(/<title[^>]*>([^<]+)<\/title>/i);
  const desc  = get("og:description") || get("description");
  const site  = get("og:site_name");
  const image = get("og:image") || get("twitter:image");
  const icon  = m(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]+href=["']([^"']+)["']/i);

  return {
    title,
    desc,
    site,
    image: image ? abs(image, finalUrl) : undefined,
    favicon: icon ? abs(icon, finalUrl) : undefined,
  };
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url).searchParams.get("url") || "";
  if (!/^https?:\/\//i.test(url)) {
    return new Response(JSON.stringify(<Og>{ ok: false, url, reason: "invalid_url" }), { status: 400 });
  }

  const kvKey = `og:${url}`;
  const cached = await env.FEDIOAUTH_KV.get(kvKey);
  if (cached) {
    return new Response(cached, { headers: { "content-type": "application/json", "cache-control": "public, max-age=600" } });
  }

  try {
    const res = await fetchWithTimeout(url, { headers: { "user-agent": "mini-fediview/og-fetch" } });
    if (!res.ok) {
      const body = JSON.stringify(<Og>{ ok: false, url, reason: `upstream_${res.status}` });
      await env.FEDIOAUTH_KV.put(kvKey, body, { expirationTtl: CACHE_TTL_NG });
      return new Response(body, { status: 502, headers: { "content-type": "application/json" } });
    }
    const finalUrl = res.url || url;
    const ct = res.headers.get("content-type") || "";
    if (!/text\/html/i.test(ct)) {
      const body = JSON.stringify(<Og>{ ok: false, url, reason: "not_html" });
      await env.FEDIOAUTH_KV.put(kvKey, body, { expirationTtl: CACHE_TTL_NG });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }
    const html = await res.text();
    const og = pickOg(html, finalUrl);
    const body = JSON.stringify(<Og>{
      ok: true,
      url,
      finalUrl,
      title: og.title,
      desc: og.desc,
      site: og.site,
      image: og.image,
      favicon: og.favicon,
    });
    await env.FEDIOAUTH_KV.put(kvKey, body, { expirationTtl: CACHE_TTL_OK });
    return new Response(body, {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=900" },
    });
  } catch (e) {
    const body = JSON.stringify(<Og>{ ok: false, url, reason: "timeout_or_network" });
    await env.FEDIOAUTH_KV.put(kvKey, body, { expirationTtl: CACHE_TTL_NG });
    return new Response(body, { status: 504, headers: { "content-type": "application/json" } });
  }
};
