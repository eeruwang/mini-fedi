// functions/api/mk/home.ts
// 페이지네이션: ?limit(기본20), ?untilId, ?sinceId 전달
export const onRequestGet: PagesFunction = async ({ request }) => {
  const cookie = request.headers.get('cookie')||''
  const host = /mk_host=([^;]+)/.exec(cookie)?.[1]
  const token = /mk_token=([^;]+)/.exec(cookie)?.[1]
  if (!host || !token) return new Response('Unauthorized', { status: 401 })

  const url = new URL(request.url)
  const limit = Number(url.searchParams.get('limit') || '20')
  const untilId = url.searchParams.get('untilId') || undefined
  const sinceId = url.searchParams.get('sinceId') || undefined

  const body: any = { i: token, limit, withRenotes: true }
  if (untilId) body.untilId = untilId
  if (sinceId) body.sinceId = sinceId

  const res = await fetch(`https://${host}/api/notes/timeline`, {
    method:'POST',
    headers:{'content-type':'application/json'},
    body: JSON.stringify(body)
  })
  if (!res.ok) return new Response('Upstream error', { status: 502 })
  return new Response(await res.text(), { headers:{'content-type':'application/json'} })
}