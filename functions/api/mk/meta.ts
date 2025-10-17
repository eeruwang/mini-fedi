/// <reference types="@cloudflare/workers-types" />
import type { PagesFunction } from "@cloudflare/workers-types";

type Env = {
  FEDIOAUTH_KV: KVNamespace;
};

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const url = new URL(ctx.request.url);
  const host = url.searchParams.get("host") || "";

  if (!host) {
    return new Response(JSON.stringify({ error: "missing host" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const kvKey = `mkmeta:${host}`;
  // 1) KV 캐시 조회
  const cached = await ctx.env.FEDIOAUTH_KV.get(kvKey);
  if (cached) {
    try {
      const meta = JSON.parse(cached);
      return new Response(JSON.stringify({ emojis: meta?.emojis || [] }), {
        headers: { "content-type": "application/json" },
      });
    } catch {
      // 캐시 파싱 실패 시 계속 진행
    }
  }

  // 2) Misskey /api/meta 페치
  const metaRes = await fetch(`https://${host}/api/meta`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}), // Misskey meta는 POST로 호출 (빈 바디 허용)
  });

  if (!metaRes.ok) {
    return new Response(JSON.stringify({ error: `meta ${metaRes.status}` }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }

  const meta = await metaRes.json();
  // 3) KV 캐시 저장 (1일)
  await ctx.env.FEDIOAUTH_KV.put(kvKey, JSON.stringify(meta), { expirationTtl: 86400 });

  return new Response(JSON.stringify({ emojis: meta?.emojis || [] }), {
    headers: { "content-type": "application/json" },
  });
};
