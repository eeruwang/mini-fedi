// functions/api/auth/start.ts
import type { PagesFunction, KVNamespace } from "@cloudflare/workers-types";

// ✅ OAuth 권한 스코프 (좋아요, 글쓰기, 팔로우, 알림 푸시까지 포함)
const APP_VER = 2;
const SCOPE = "read write follow push";

// ✅ BufferSource 를 받도록
async function sha256(data: BufferSource) {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hash);
}

function b64u(bytes: Uint8Array) {
  const s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function pkcePair() {
  const vBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = b64u(vBytes);
  const enc = new TextEncoder().encode(verifier);
  const challenge = b64u(await sha256(enc));
  return { verifier, challenge };
}

function validHost(h: string) {
  return /^[a-z0-9.-]+$/.test(h);
}

export const onRequestGet: PagesFunction<{ FEDIOAUTH_KV: KVNamespace }> = async ({ request, env }) => {
  const u = new URL(request.url);
  const iss = (u.searchParams.get("iss") || "").toLowerCase().trim();
  if (!iss || !validHost(iss)) return new Response("Invalid instance host", { status: 400 });

  const kvKey = `app:v${APP_VER}:${iss}`; // ← 기존 'app:${iss}' 대신 버전 포함
  let app = (await env.FEDIOAUTH_KV.get(kvKey, { type: "json" })) as any | null;

  // 1) 앱 등록 (없으면 새로 생성)
  if (!app) {
    const reg = await fetch(`https://${iss}/api/v1/apps`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_name: "Mini Fedi Viewer",
        redirect_uris: `${u.origin}/api/auth/callback`,
        scopes: SCOPE, // ✅ 여기에 적용
        website: `${u.origin}`,
      }),
    });
    if (!reg.ok) return new Response(`App registration failed: ${reg.status}`, { status: 502 });
    app = await reg.json();
    await env.FEDIOAUTH_KV.put(kvKey, JSON.stringify(app), { expirationTtl: 604800 });
  }

  // 2) PKCE 페어 및 state 저장
  const { verifier, challenge } = await pkcePair();
  const state = crypto.randomUUID();
  await env.FEDIOAUTH_KV.put(`state:${state}`, JSON.stringify({ iss, verifier }), { expirationTtl: 600 });

  // 3) 인가 URL 구성
  const auth = new URL(`https://${iss}/oauth/authorize`);
  auth.searchParams.set("client_id", app.client_id);
  auth.searchParams.set("redirect_uri", `${u.origin}/api/auth/callback`);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("scope", SCOPE); // ✅ 여기도 적용
  auth.searchParams.set("code_challenge", challenge);
  auth.searchParams.set("code_challenge_method", "S256");
  auth.searchParams.set("state", state);

  return new Response(null, { status: 302, headers: { location: auth.toString() } });
};
