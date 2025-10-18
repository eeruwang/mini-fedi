// functions/api/auth/callback.ts
/// <reference types="@cloudflare/workers-types" />
import type { PagesFunction, KVNamespace } from "@cloudflare/workers-types";

// start.ts에 쓴 버전과 반드시 동일해야 함!
const APP_VER = 2;

type Env = { FEDIOAUTH_KV: KVNamespace };

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return new Response("Missing code/state", { status: 400 });
  }

  // 1) state에서 iss, verifier 복구
  const saved = await env.FEDIOAUTH_KV.get(`state:${state}`, { type: "json" }) as
    | { iss?: string; verifier?: string }
    | null;

  if (!saved?.iss || !saved?.verifier) {
    return new Response("Invalid or expired state", { status: 400 });
  }
  const iss = saved.iss;
  const verifier = saved.verifier;

  // 2) 앱 등록 정보 로드 (start.ts와 동일 키)
  const appKey = `app:v${APP_VER}:${iss}`;
  const app = (await env.FEDIOAUTH_KV.get(appKey, { type: "json" })) as
    | { client_id: string; client_secret?: string }
    | null;

  if (!app?.client_id) {
    return new Response("App not found (re-register app)", { status: 500 });
  }

  // 3) 토큰 교환 (PKCE: code_verifier 포함!)
  const redirectUri = `${new URL(request.url).origin}/api/auth/callback`; // start.ts와 동일해야 함

  const tokenRes = await fetch(`https://${iss}/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "accept": "application/json",
    },
    body: new URLSearchParams({
      client_id: app.client_id,
      // Mastodon는 public client(PKCE)라도 client_secret을 받아주는 인스턴스가 많음 — 있으면 넣어줌
      ...(app.client_secret ? { client_secret: app.client_secret } : {}),
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => "");
    // 400이면 보통 invalid_grant(= code_verifier/redirect_uri 문제) 메시지가 담겨있음
    return new Response(`Token exchange failed: ${tokenRes.status}\n${body}`, { status: 502 });
  }

  const tok = await tokenRes.json() as {
    access_token: string;
    token_type?: string;
    scope?: string;
    created_at?: number;
    expires_in?: number;
  };

  // 4) 세션 쿠키 설정
  const maxAge = tok.expires_in ?? 60 * 60 * 24 * 30; // 30일 기본
  const headers = new Headers({ Location: "/app.html" });
  headers.append(
    "Set-Cookie",
    `ap_token=${tok.access_token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`
  );
  headers.append(
    "Set-Cookie",
    `ap_inst=${iss}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`
  );

  // state는 1회용 — 굳이 삭제 안 해도 TTL로 만료되지만, 깔끔하게 제거해도 됨
  // await env.FEDIOAUTH_KV.delete(`state:${state}`);

  return new Response(null, { status: 302, headers });
};
