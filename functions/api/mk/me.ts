/// <reference types="@cloudflare/workers-types" />
import type { PagesFunction } from "@cloudflare/workers-types";

function getCookie(req: Request, key: string): string | null {
  const m = (`${req.headers.get("cookie") || ""}`).match(
    new RegExp(`(?:^|;\\s*)${key}=([^;]+)`)
  );
  return m ? decodeURIComponent(m[1]) : null;
}

export const onRequestGet: PagesFunction = async ({ request }) => {
  const host  = getCookie(request, "mk_host");
  const token = getCookie(request, "mk_token");

  if (!host || !token) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const res = await fetch(`https://${host}/api/i`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json",
    },
    body: JSON.stringify({ i: token }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return new Response(JSON.stringify({ error: "Upstream error", status: res.status, body }), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  }

  // 업스트림 JSON을 그대로 패스스루
  return new Response(await res.text(), {
    headers: { "content-type": "application/json" },
  });
};
