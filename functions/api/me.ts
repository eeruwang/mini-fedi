//functions/api/me.ts
/// <reference types="@cloudflare/workers-types" />
import type { PagesFunction } from "@cloudflare/workers-types";

function getCookie(req: Request, key: string): string | null {
  const m = (`${req.headers.get("cookie") || ""}`).match(
    new RegExp(`(?:^|;\\s*)${key}=([^;]+)`)
  );
  return m ? decodeURIComponent(m[1]) : null;
}

export const onRequestGet: PagesFunction = async ({ request }) => {
  const token = getCookie(request, "ap_token");
  const iss   = getCookie(request, "ap_inst");

  if (!token || !iss) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const meRes = await fetch(`https://${iss}/api/v1/accounts/verify_credentials`, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/json",
    },
  });

  if (!meRes.ok) {
    const body = await meRes.text().catch(() => "");
    return new Response(JSON.stringify({ error: "Upstream error", status: meRes.status, body }), {
      status: meRes.status,
      headers: { "content-type": "application/json" },
    });
  }

  // 업스트림 JSON을 그대로 패스스루
  return new Response(await meRes.text(), {
    headers: { "content-type": "application/json" },
  });
};
