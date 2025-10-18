/// <reference types="@cloudflare/workers-types" />
import type { PagesFunction } from "@cloudflare/workers-types";

function getCookie(req: Request, key: string): string | null {
  const m = (`${req.headers.get("cookie") || ""}`).match(new RegExp(`(?:^|;\\s*)${key}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

export const onRequestGet: PagesFunction = async ({ request }) => {
  const inst  = getCookie(request, "ap_inst");
  const token = getCookie(request, "ap_token");
  if (!inst || !token) return new Response("Unauthorized", { status: 401 });

  const u = new URL(request.url);
  const id = u.searchParams.get("id");
  if (!id) return new Response("Missing id", { status: 400 });

  const upstream = await fetch(`https://${inst}/api/v1/statuses/${encodeURIComponent(id)}/favourited_by`, {
    headers: {
      "accept": "application/json",
      "authorization": `Bearer ${token}`,
    },
  });

  if (!upstream.ok) {
    const body = await upstream.text().catch(() => "");
    return new Response(`upstream ${upstream.status}\n${body}`, { status: 502 });
  }

  return new Response(await upstream.text(), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
