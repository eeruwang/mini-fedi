// functions/api/mk/start.ts
function validHost(h: string) { return /^[a-z0-9.-]+$/.test(h) }

export const onRequestGet: PagesFunction<{ FEDIOAUTH_KV: KVNamespace }> = async ({ request, env }) => {
  const u = new URL(request.url)
  const host = u.searchParams.get('host')?.trim().toLowerCase()
  if (!host || !validHost(host)) return new Response('Invalid host', { status: 400 })

  // 1) 앱 등록 캐시
  const appKey = `mkapp:${host}`
  let app = await env.FEDIOAUTH_KV.get(appKey, { type: 'json' }) as any | null
  if (!app) {
    const res = await fetch(`https://${host}/api/app/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Mini Fedi Viewer',
        description: 'Viewer for Misskey & Mastodon',
        permission: ['read:account', 'read:notes'],
        callbackUrl: `${u.origin}/api/mk/callback`
      })
    })
    if (!res.ok) return new Response('App create failed', { status: 502 })
    app = await res.json()
    await env.FEDIOAUTH_KV.put(appKey, JSON.stringify(app), { expirationTtl: 604800 })
  }

  // 2) 세션 생성
  const gen = await fetch(`https://${host}/api/auth/session/generate`, {
    method: 'POST',
    headers: {'content-type':'application/json'},
    body: JSON.stringify({ appSecret: app.secret })
  })
  if (!gen.ok) return new Response('Session generate failed', { status: 502 })
  const g = await gen.json() // { token, url }

  // 3) 세션 토큰 매핑 저장 (콜백에서 host/appSecret 조회)
  await env.FEDIOAUTH_KV.put(`mksess:${g.token}`, JSON.stringify({ host, appSecret: app.secret }), { expirationTtl: 600 })

  // 4) 승인 URL로 리다이렉트
  return new Response(null, { status: 302, headers: { location: g.url } })
}