// functions/api/mk/me.ts
export const onRequestGet: PagesFunction = async ({ request }) => {
  const cookie = request.headers.get('cookie')||''
  const host = /mk_host=([^;]+)/.exec(cookie)?.[1]
  const token = /mk_token=([^;]+)/.exec(cookie)?.[1]
  if (!host || !token) return new Response('Unauthorized', { status: 401 })

  const res = await fetch(`https://${host}/api/i`, {
    method:'POST',
    headers:{'content-type':'application/json'},
    body: JSON.stringify({ i: token })
  })
  if (!res.ok) return new Response('Upstream error', { status: 502 })
  return new Response(await res.text(), { headers:{'content-type':'application/json'} })
}