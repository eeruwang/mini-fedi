/// <reference types="@cloudflare/workers-types" />
import type { PagesFunction } from "@cloudflare/workers-types";

function getCookie(req: Request, key: string): string | null {
  const m = (`${req.headers.get("cookie") || ""}`).match(
    new RegExp(`(?:^|;\\s*)${key}=([^;]+)`)
  );
  return m ? decodeURIComponent(m[1]) : null;
}

// 우리가 실제로 쓰는 최소 필드만 선언 (optional로 안전)
type MastoMe = { id?: string | number };
type MastoStatus = { id?: string | number };

export const onRequestGet: PagesFunction = async ({ request }) => {
  try {
    const token = getCookie(request, "ap_token");
    const inst  = getCookie(request, "ap_inst");
    if (!token || !inst) {
      return new Response(JSON.stringify({ error: "not logged in" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }

    const u = new URL(request.url);
    const max_id = u.searchParams.get("max_id") || "";

    // 1) 내 계정 id
    const meRes = await fetch(`https://${inst}/api/v1/accounts/verify_credentials`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!meRes.ok) {
      const body = await meRes.text().catch(()=> "");
      return new Response(JSON.stringify({ error: "verify_credentials failed", status: meRes.status, body }), {
        status: meRes.status, headers: { "content-type": "application/json" },
      });
    }
    const me = (await meRes.json()) as unknown as MastoMe;
    const myId = me?.id != null ? String(me.id) : null;
    if (!myId) {
      return new Response(JSON.stringify({ error: "no id from verify_credentials" }), {
        status: 502, headers: { "content-type": "application/json" },
      });
    }

    // 2) 내 글 목록
    const api = new URL(`https://${inst}/api/v1/accounts/${encodeURIComponent(myId)}/statuses`);
    api.searchParams.set("limit", "20");
    // 필요 시 필터 옵션:
    // api.searchParams.set("exclude_replies","true");
    // api.searchParams.set("exclude_reblogs","true");
    if (max_id) api.searchParams.set("max_id", max_id);

    const listRes = await fetch(api.toString(), {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!listRes.ok) {
      const body = await listRes.text().catch(()=>"");
      return new Response(JSON.stringify({ error: "statuses failed", status: listRes.status, body }), {
        status: listRes.status, headers: { "content-type": "application/json" },
      });
    }

    // ⬇️ TS가 {}로 잡지 않게: unknown → 배열로 단언 + 런타임 검사
    const raw = (await listRes.json()) as unknown;
    if (!Array.isArray(raw)) {
      return new Response(JSON.stringify({ error: "unexpected response shape" }), {
        status: 502, headers: { "content-type": "application/json" },
      });
    }
    const items = raw as MastoStatus[];
    const next_max_id =
      items.length > 0 ? (items[items.length - 1]?.id != null ? String(items[items.length - 1]!.id) : null) : null;

    return new Response(JSON.stringify({ items, next_max_id }), {
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
