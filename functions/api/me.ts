// functions/api/me.ts
export const onRequestGet: PagesFunction = async ({ request }) => {
  const cookie = request.headers.get('cookie') || ''
  const token = /ap_token=([^;]+)/.exec(cookie)?.[1]
  const iss   = /ap_inst=([^;]+)/.exec(cookie)?.[1]
  if (!token || !iss) return new Response('Unauthorized', { status: 401 })

  const meRes = await fetch(`https://${iss}/api/v1/accounts/verify_credentials`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' }
  })
  if (!meRes.ok) return new Response('Upstream error', { status: 502 })
  return new Response(await meRes.text(), { headers: { 'content-type': 'application/json' } })
}