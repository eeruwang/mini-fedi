/// <reference types="@cloudflare/workers-types" />
import type { PagesFunction } from "@cloudflare/workers-types";

type Env = { FEDIOAUTH_KV: KVNamespace };

type MastoStatusMinimal = {
  id: string;
  favourited?: boolean;
  favourites_count?: number;
};

function parseCookies(req: Request) {
  const h = req.headers.get("Cookie") || "";
  const out: Record<string, string> = {};
  h.split(/;\s*/).forEach((p) => {
    const i = p.indexOf("=");
    if (i > -1) out[p.slice(0, i)] = decodeURIComponent(p.slice(i + 1));
  });
  return out;
}

export const onRequestPost: PagesFunction<Env> = async ({ request }) => {
  try {
    const cookies = parseCookies(request);
    const token = cookies["ap_token"];
    const inst = cookies["ap_inst"];

    if (!token || !inst) {
      return new Response(JSON.stringify({ error: "not logged in" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }

    const body = (await request.json().catch(() => null)) as
      | { id?: string }
      | null;
    const id = body?.id;
    if (!id) {
      return new Response(JSON.stringify({ error: "missing id" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    const res = await fetch(`https://${inst}/api/v1/statuses/${id}/favourite`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return new Response(
        JSON.stringify({
          error: "favourite failed",
          status: res.status,
          body: txt,
        }),
        { status: res.status, headers: { "content-type": "application/json" } }
      );
    }

    // ⬇️ 핵심: unknown → 명시 캐스팅 + 안전 폴백
    const json = (await res.json()) as unknown as Partial<MastoStatusMinimal>;
    const data: Partial<MastoStatusMinimal> = json ?? {};
    return new Response(
      JSON.stringify({
        ok: true,
        id: data.id ?? id, // 서버가 안 주면 요청 id로 폴백
        favourited: data.favourited ?? true,
        favourites_count: data.favourites_count,
      }),
      { headers: { "content-type": "application/json" } }
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
};
