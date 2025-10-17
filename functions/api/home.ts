// functions/api/home.ts
// - 확장 필드(emoji_reactions, pleroma.emoji_reactions) 흡수
// - 원본이 Misskey면 /api/ap/show { uri } 역조회하여 reactions 병합
// - KV 캐시: mkmeta:<host> (1d), mk:note:<host>:<sha256(uri)> (120s)
// - 페이지네이션: ?limit, ?max_id, ?since_id 파라미터 그대로 Mastodon에 전달
import type { PagesFunction, KVNamespace } from "@cloudflare/workers-types";

function toHex(bytes: Uint8Array) { return Array.from(bytes).map(b=>b.toString(16).padStart(2,'0')).join('') }
async function sha256Hex(s: string) {
  const data = new TextEncoder().encode(s)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return toHex(new Uint8Array(hash))
}
async function isMisskey(host: string, kv: KVNamespace) {
  const key = `mkmeta:${host}`
  const hit = await kv.get(key)
  if (hit) return hit === '1'
  try {
    const r = await fetch(`https://${host}/api/meta`, { method:'POST', headers:{'content-type':'application/json'}, body:'{}' })
    const j = await r.json().catch(()=>null)
    const ok = !!j && (j.softwareName?.toLowerCase?.() === 'misskey' || String(j.version||'').toLowerCase().includes('misskey'))
    await kv.put(key, ok ? '1' : '0', { expirationTtl: 86400 })
    return ok
  } catch {
    await kv.put(key, '0', { expirationTtl: 86400 })
    return false
  }
}
async function fetchMisskeyReactionsByUri(host: string, uri: string, kv: KVNamespace) {
  const cacheKey = `mk:note:${host}:${await sha256Hex(uri)}`
  const c = await kv.get(cacheKey, { type:'json' }) as any | null
  if (c?.reactions) return c.reactions
  const res = await fetch(`https://${host}/api/ap/show`, {
    method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ uri })
  })
  if (!res.ok) return null
  const apObj = await res.json().catch(()=>null)
  const note = apObj?.object || apObj
  const reactions = note?.reactions || null
  await kv.put(cacheKey, JSON.stringify({ reactions }), { expirationTtl: 120 })
  return reactions
}
function absorbExtensions(s: any) {
  const pl = s.pleroma || s.firefish || s._pleroma
  if (pl?.emoji_reactions?.length) {
    s.mkReactions = Object.fromEntries(pl.emoji_reactions.map((r: any)=>[r.name, r.count]))
  }
  if (Array.isArray(s.emoji_reactions)) {
    const m: Record<string, number> = s.mkReactions || {}
    for (const r of s.emoji_reactions) m[r.name] = (m[r.name]||0) + (r.count||0)
    s.mkReactions = m
  }
  return s
}

export const onRequestGet: PagesFunction<{ OAUTH_KV: KVNamespace }> = async ({ request, env }) => {
  const cookie = request.headers.get('cookie') || ''
  const token = /ap_token=([^;]+)/.exec(cookie)?.[1]
  const iss   = /ap_inst=([^;]+)/.exec(cookie)?.[1]
  if (!token || !iss) return new Response('Unauthorized', { status: 401 })

  const url = new URL(request.url)
  const limit = url.searchParams.get('limit') || '20'
  const since_id = url.searchParams.get('since_id')
  const max_id = url.searchParams.get('max_id')

  const apiUrl = new URL(`https://${iss}/api/v1/timelines/home`)
  apiUrl.searchParams.set('limit', limit)
  if (since_id) apiUrl.searchParams.set('since_id', since_id)
  if (max_id) apiUrl.searchParams.set('max_id', max_id)

  const r = await fetch(apiUrl.toString(), {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' }
  })
  if (!r.ok) return new Response('Upstream error', { status: 502 })
  const list = await r.json() as any[]

  const enriched = await Promise.all(list.map(async (s) => {
    absorbExtensions(s)

    const originUri = s.uri || s.url
    if (!originUri) return s

    let originHost = ''
    try {
      // 절대 URL 우선
      originHost = new URL(originUri).host
    } catch {
      try {
        // 상대 URL이면 현재 인스턴스를 베이스로 보정
        originHost = new URL(originUri, `https://${iss}`).host
      } catch {}
    }
    if (!originHost) return s

    if (await isMisskey(originHost, env.OAUTH_KV)) {
      const rx = await fetchMisskeyReactionsByUri(originHost, originUri, env.OAUTH_KV)
      if (rx) {
        const merged: Record<string, number> = { ...(s.mkReactions || {}) }
        for (const [k, v] of Object.entries(rx)) merged[k] = (merged[k]||0) + (v as number)
        s.mkReactions = merged
      }
    }
    return s
  }))

  return new Response(JSON.stringify(enriched), { headers: { 'content-type': 'application/json' } })
}