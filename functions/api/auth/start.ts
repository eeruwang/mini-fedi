/// <reference types="@cloudflare/workers-types" />
import type { PagesFunction, KVNamespace } from "@cloudflare/workers-types";
type Env = { FEDIOAUTH_KV: KVNamespace };

async function sha256(buf: ArrayBuffer) {
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return new Uint8Array(hash);
}
function b64u(bytes: Uint8Array) {
  let s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
async function pkcePair() {
  const vBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = b64u(vBytes);
  const enc = new TextEncoder().encode(verifier);
  const challenge = b64u(await sha256(enc.buffer));
  return { verifier, challenge };
}
function validHost(h: string) { return /^[a-z0-9.-]+$/.test(h); }

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const u = new URL(request.url);
  const iss = (u.searchParams.get('iss') || '').toLowerCase().trim();
  if (!iss || !validHost(iss)) return new Response('Invalid instance host', { status: 400 });

  const kvKey = `app:${iss}`;
  let app = await env.FEDIOAUTH_KV.get(kvKey, { type: 'json' }) as any | null;
  if (!app) {
    const reg = await fetch(`https://${iss}/api/v1/apps`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_name: 'Mini Fedi Viewer',
        redirect_uris: `${u.origin}/api/auth/callback`,
        scopes: 'read',
        website: `${u.origin}`
      })
    });
    if (!reg.ok) return new Response(`App registration failed: ${reg.status}`, { status: 502 });
    app = await reg.json();
    await env.FEDIOAUTH_KV.put(kvKey, JSON.stringify(app), { expirationTtl: 604800 });
  }

  const { verifier, challenge } = await pkcePair();
  const state = crypto.randomUUID();
  await env.FEDIOAUTH_KV.put(`state:${state}`, JSON.stringify({ iss, verifier }), { expirationTtl: 600 });

  const auth = new URL(`https://${iss}/oauth/authorize`);
  auth.searchParams.set('client_id', app.client_id);
  auth.searchParams.set('redirect_uri', `${u.origin}/api/auth/callback`);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('scope', 'read');
  auth.searchParams.set('code_challenge', challenge);
  auth.searchParams.set('code_challenge_method', 'S256');
  auth.searchParams.set('state', state);

  return new Response(null, { status: 302, headers: { location: auth.toString() } });
};
