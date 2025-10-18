/// <reference types="@cloudflare/workers-types" />
import type { PagesFunction } from "@cloudflare/workers-types";

type Env = { FEDIOAUTH_KV: KVNamespace };

// Misskey /api/meta 응답의 최소 타입(우리가 쓰는 필드만 선언)
type MisskeyMeta = {
  emojis?: Array<{ name?: string; url?: string; uri?: string; publicUrl?: string }>;
  // 포크 호환용 별칭 맵들(있을 수도 있고 없을 수도 있음)
  reactionEmojis?: Record<string, string>;
  reactions?: Record<string, string>;
  reactionsConfig?: { reactions?: Record<string, string> };
};

function validHost(h: string) {
  return /^[a-z0-9.-]+$/.test(h);
}

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const url = new URL(ctx.request.url);
  const host = (url.searchParams.get("host") || "").trim().toLowerCase();

  if (!host || !validHost(host)) {
    return new Response(JSON.stringify({ error: "invalid host" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const kvKey = `mkmeta:${host}`;

  // 1) KV 캐시 조회
  const cached = await ctx.env.FEDIOAUTH_KV.get(kvKey);
  if (cached) {
    try {
      const meta = JSON.parse(cached) as MisskeyMeta;
      const list =
        Array.isArray(meta?.emojis)
          ? meta.emojis
              .map((e) => ({
                name: e?.name,
                url: e?.url || e?.uri || e?.publicUrl || null,
              }))
              .filter((x) => x.name && x.url)
          : [];
      return new Response(JSON.stringify({ emojis: list }), {
        headers: { "content-type": "application/json", "cache-control": "max-age=3600" },
      });
    } catch {
      // 캐시 파싱 실패 시 계속 진행
    }
  }

  // 2) Misskey /api/meta 페치
  const metaRes = await fetch(`https://${host}/api/meta`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });

  if (!metaRes.ok) {
    const body = await metaRes.text().catch(() => "");
    return new Response(JSON.stringify({ error: `meta ${metaRes.status}`, body }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }

  const meta = (await metaRes.json()) as MisskeyMeta;

  // 3) KV 캐시 저장 (1일)
  await ctx.env.FEDIOAUTH_KV.put(kvKey, JSON.stringify(meta), { expirationTtl: 86400 });

  // 4) {name,url} 리스트로 정규화하여 반환
  const emojis =
    Array.isArray(meta?.emojis)
      ? meta.emojis
          .map((e) => ({
            name: e?.name,
            url: e?.url || e?.uri || e?.publicUrl || null,
          }))
          .filter((x) => x.name && x.url)
      : [];

  return new Response(JSON.stringify({ emojis }), {
    headers: { "content-type": "application/json", "cache-control": "max-age=3600" },
  });
};
