/// <reference types="@cloudflare/workers-types" />
import type { PagesFunction, KVNamespace } from "@cloudflare/workers-types";

type Env = { FEDIOAUTH_KV: KVNamespace };

type MastodonToken = {
  access_token: string;
  token_type?: string;
  scope?: string;
  created_at?: number;
};

function isMastoToken(x: any): x is MastodonToken {
  return x && typeof x.access_token === "string";
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const u = new URL(request.url);
  const code = u.searchParams.get("code");
  const state = u.searchParams.get("state");
  if (!code || !state) return new Response("Bad Request", { status: 400 });

  const entry = await env.FEDIOAUTH_KV.get(`state:${state}`, { type: "json" }) as any | null;
  if (!entry) return new Response("State expired", { status: 400 });
  const { iss, verifier } = entry as { iss: string; verifier: string };
  await env.FEDIOAUTH_KV.delete(`state:${state}`);

  const app = await env.FEDIOAUTH_KV.get(`app:${iss}`, { type: "json" }) as any | null;
  if (!app) return new Response("App not found", { status: 400 });

  const tok = await fetch(`https://${iss}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: app.client_id,
      client_secret: app.client_secret,
      redirect_uri: `${u.origin}/api/auth/callback`,
      code,
      code_verifier: verifier,
    }),
  });
  if (!tok.ok) return new Response(`Token exchange failed: ${tok.status}`, { status: 401 });

  const tokenJson = await tok.json();                 // unknown
  const token = tokenJson as unknown as MastodonToken; // ← 명시 캐스팅


  if (!isMastoToken(token)) {
    return new Response("Token shape invalid", { status: 502 });
  }

  const meRes = await fetch(`https://${iss}/api/v1/accounts/verify_credentials`, {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  if (!meRes.ok) return new Response(`Verify failed: ${meRes.status}`, { status: 401 });
  // ⬇️ 추가: 마스토돈 계정 타입
  type MastoAccount = {
    id: string;
    username: string;
    acct: string;
    display_name?: string;
    avatar?: string;
    url?: string;
  };

  // ⬇️ 교체: unknown → 명시 캐스팅
  const me = (await meRes.json()) as MastoAccount;

  const base = "Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400";
  const h = new Headers({ location: "/app.html" });
  h.append("set-cookie", `ap_token=${encodeURIComponent(token.access_token)}; ${base}`);
  h.append("set-cookie", `ap_inst=${encodeURIComponent(iss)}; ${base}`);
  h.append("set-cookie", `ap_acct=${encodeURIComponent(me.acct ?? "")}; ${base}`);

  return new Response(null, { status: 302, headers: h });
};
