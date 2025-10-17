// functions/api/favourites.ts
export const onRequestGet: PagesFunction = async ({ request }) => {
  const cookie = request.headers.get('cookie') || ''
  const token = /ap_token=([^;]+)/.exec(cookie)?.[1]
  const iss   = /ap_inst=([^;]+)/.exec(cookie)?.[1]
  if (!token || !iss) return new Response('Unauthorized', { status: 401 })

  const res = await fetch(`https://${iss}/api/v1/favourites?limit=20`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' }
  })
  if (!res.ok) return new Response('Upstream error', { status: 502 })
  return new Response(await res.text(), { headers: { 'content-type': 'application/json' } })
}