// functions/api/mk/callback.ts
export const onRequestGet: PagesFunction<{ FEDIOAUTH_KV: KVNamespace }> = async ({ request, env }) => {
  const u = new URL(request.url)
  const session = u.searchParams.get('session')
  if (!session) return new Response('Bad Request', { status: 400 })

  const map = await env.FEDIOAUTH_KV.get(`mksess:${session}`, { type:'json' }) as any | null
  if (!map) return new Response('Session not found/expired', { status: 400 })
  const { host, appSecret } = map

  const res = await fetch(`https://${host}/api/auth/session/userkey`, {
    method: 'POST',
    headers: { 'content-type':'application/json' },
    body: JSON.stringify({ appSecret, token: session })
  })
  if (!res.ok) return new Response('Token exchange failed', { status: 401 })
  const data = await res.json() // { accessToken, user }

  // 세션 매핑 정리
  await env.FEDIOAUTH_KV.delete(`mksess:${session}`)

  const base = 'Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400'
  const h = new Headers({ location: '/app.html' })
  h.append('set-cookie', `mk_host=${host}; ${base}`)
  h.append('set-cookie', `mk_token=${data.accessToken}; ${base}`)
  return new Response(null, { status: 302, headers: h })
}