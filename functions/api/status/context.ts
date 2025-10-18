/// <reference types="@cloudflare/workers-types" />
import type { PagesFunction } from "@cloudflare/workers-types";

function cookie(req: Request, key: string): string | null {
  const m = (`${req.headers.get('cookie') || ''}`).match(new RegExp(`(?:^|;\\s*)${key}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

export const onRequestGet: PagesFunction = async ({ request }) => {
  try {
    const inst = cookie(request, 'ap_inst');
    const token = cookie(request, 'ap_token');
    const u = new URL(request.url);
    const id = (u.searchParams.get('id') || '').trim();

    if (!inst || !token) {
      return new Response(JSON.stringify({ error: 'not logged in' }), {
        status: 401, headers: { 'content-type': 'application/json' },
      });
    }
    if (!id) {
      return new Response(JSON.stringify({ error: 'missing id' }), {
        status: 400, headers: { 'content-type': 'application/json' },
      });
    }

    const res = await fetch(`https://${inst}/api/v1/statuses/${encodeURIComponent(id)}/context`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });

    if (!res.ok) {
      const txt = await res.text().catch(()=> '');
      return new Response(JSON.stringify({ error: 'upstream', status: res.status, body: txt }), {
        status: res.status, headers: { 'content-type': 'application/json' },
      });
    }

    // { ancestors: [...], descendants: [...] }
    const body = await res.text();
    return new Response(body, {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { 'content-type': 'application/json' },
    });
  }
};
