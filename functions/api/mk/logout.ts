// functions/api/mk/logout.ts
export const onRequestPost: PagesFunction = async () => {
  const del = 'Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
  const h = new Headers()
  h.append('set-cookie', `mk_host=; ${del}`)
  h.append('set-cookie', `mk_token=; ${del}`)
  return new Response(null, { status: 204, headers: h })
}