// functions/mk/emoji.ts
// Cloudflare Pages Functions (TypeScript)

type EmojiEntry = { name: string; url?: string; static_url?: string };
type Source = "misskey" | "mastodon" | "unknown";

// 간단 메모리 캐시 (워커 인스턴스 살아있는 동안 유지)
const CACHE = new Map<string, { at: number; list: EmojiEntry[] }>();
const TTL_MS = 10 * 60 * 1000; // 10분

const toBase = (h: string) => (h.startsWith("http") ? h : `https://${h}`);
const normHost = (h: string) => h.replace(/^https?:\/\//, "").replace(/\/+$/, "");

async function fetchFromMisskey(host: string): Promise<EmojiEntry[] | null> {
  // 1) POST /api/emojis (신형)
  try {
    const r = await fetch(`${toBase(host)}/api/emojis`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (r.ok) {
      const data = await r.json<any>();
      const arr = Array.isArray(data) ? data
                : Array.isArray(data?.emojis) ? data.emojis
                : [];
      return arr.map((e: any) => ({ name: e.name, url: e.url, static_url: e.url }));
    }
  } catch {}
  // 2) GET /api/emojis (구형)
  try {
    const r = await fetch(`${toBase(host)}/api/emojis`);
    if (r.ok) {
      const data = await r.json<any>();
      const arr = Array.isArray(data) ? data
                : Array.isArray(data?.emojis) ? data.emojis
                : [];
      return arr.map((e: any) => ({ name: e.name, url: e.url, static_url: e.url }));
    }
  } catch {}
  return null;
}

async function fetchFromMastodon(host: string): Promise<EmojiEntry[] | null> {
  try {
    const r = await fetch(`${toBase(host)}/api/v1/custom_emojis`);
    if (r.ok) {
      const data = await r.json<any[]>();
      return data.map((e) => ({ name: e.shortcode, url: e.url, static_url: e.static_url ?? e.url }));
    }
  } catch {}
  return null;
}

async function fetchEmojiList(host: string): Promise<{ source: Source; list: EmojiEntry[] }> {
  // 캐시
  const key = normHost(host);
  const now = Date.now();
  const hit = CACHE.get(key);
  if (hit && now - hit.at < TTL_MS) return { source: "unknown", list: hit.list };

  // Misskey → Mastodon 순으로 시도
  const mk = await fetchFromMisskey(key);
  if (mk) {
    CACHE.set(key, { at: now, list: mk });
    return { source: "misskey", list: mk };
  }
  const md = await fetchFromMastodon(key);
  if (md) {
    CACHE.set(key, { at: now, list: md });
    return { source: "mastodon", list: md };
  }
  CACHE.set(key, { at: now, list: [] });
  return { source: "unknown", list: [] };
}

export const onRequestGet: PagesFunction = async (ctx) => {
  const url = new URL(ctx.request.url);
  // host=…  (필수)  예: host=misskey.io / host=fedibird.com
  let host = url.searchParams.get("host") || "";
  if (!host) return new Response("missing host", { status: 400 });

  host = normHost(host);
  const { list } = await fetchEmojiList(host);

  // shortcode -> {url, static_url} 로 바로 쓰기 좋게 축약
  const map: Record<string, { url?: string; static_url?: string }> = {};
  for (const e of list) map[e.name] = { url: e.url, static_url: e.static_url };

  return new Response(JSON.stringify({ host, map }), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      // 브라우저 캐시도 약하게 허용
      "cache-control": "public, max-age=300",
    },
  });
};
