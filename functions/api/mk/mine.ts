/// <reference types="@cloudflare/workers-types" />
import type { PagesFunction } from "@cloudflare/workers-types";

function getCookie(req: Request, key: string): string | null {
  const m = (`${req.headers.get("cookie") || ""}`).match(
    new RegExp(`(?:^|;\\s*)${key}=([^;]+)`)
  );
  return m ? decodeURIComponent(m[1]) : null;
}

// 최소 필드만 정의
type MkNote = { id?: string };

export const onRequestGet: PagesFunction = async ({ request }) => {
  try {
    const host  = getCookie(request, "mk_host");
    const token = getCookie(request, "mk_token");
    if (!host || !token) {
      return new Response(JSON.stringify({ error: "not logged in" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }

    const u = new URL(request.url);
    const untilId = u.searchParams.get("untilId") || "";

    // 내 글: /api/i/notes
    const body: Record<string, unknown> = { i: token, limit: 20 };
    if (untilId) body.untilId = untilId;

    const r = await fetch(`https://${host}/api/i/notes`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const txt = await r.text().catch(()=> "");
      return new Response(JSON.stringify({ error: "i/notes failed", status: r.status, body: txt }), {
        status: r.status, headers: { "content-type": "application/json" },
      });
    }

    // ⬇️ TS가 {}로 잡지 않게: unknown → 배열로 단언 + 런타임 검사
    const raw = (await r.json()) as unknown;
    if (!Array.isArray(raw)) {
      return new Response(JSON.stringify({ error: "unexpected response shape" }), {
        status: 502, headers: { "content-type": "application/json" },
      });
    }
    const items = raw as MkNote[];
    const next = items.length > 0 ? (items[items.length - 1]?.id ?? null) : null;

    return new Response(JSON.stringify({ items, next }), {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { "content-type": "application/json" },
    });
  }
};
