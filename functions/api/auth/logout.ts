// functions/api/auth/callback.ts
import type { PagesFunction, KVNamespace } from "@cloudflare/workers-types";

export const onRequestGet: PagesFunction<{ FEDIOAUTH_KV: KVNamespace }> = async ({ request, env }) => {
  const u = new URL(request.url)
  const code = u.searchParams.get('code')
  const state = u.searchParams.get('state')
  if (!code || !state) return new Response('Bad Request', { status: 400 })

  const entry = await env.FEDIOAUTH_KV.get(`state:${state}`, { type: 'json' }) as any | null
  if (!entry) return new Response('State expired', { status: 400 })
  const { iss, verifier } = entry
  await env.FEDIOAUTH_KV.delete(`state:${state}`)

  const app = await env.FEDIOAUTH_KV.get(`app:${iss}`, { type: 'json' }) as any | null
  if (!app) return new Response('App not found', { status: 400 })

  const tok = await fetch(`https://${iss}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: app.client_id,
      client_secret: app.client_secret,
      redirect_uri: `${u.origin}/api/auth/callback`,
      code,
      code_verifier: verifier
    })
  })
  if (!tok.ok) return new Response('Token exchange failed', { status: 401 })
  const token = await tok.json()

  const meRes = await fetch(`https://${iss}/api/v1/accounts/verify_credentials`, {
    headers: { authorization: `Bearer ${token.access_token}` }
  })
  if (!meRes.ok) return new Response('Verify failed', { status: 401 })
  const me = await meRes.json()

  const base = 'Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400'
  const h = new Headers({ location: '/app.html' })
  h.append('set-cookie', `ap_token=${token.access_token}; ${base}`)
  h.append('set-cookie', `ap_inst=${iss}; ${base}`)
  h.append('set-cookie', `ap_acct=${encodeURIComponent(me.acct)}; ${base}`)
  return new Response(null, { status: 302, headers: h })
}