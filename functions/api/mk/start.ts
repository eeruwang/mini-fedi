// functions/api/mk/start.ts
/// <reference types="@cloudflare/workers-types" />
import type { PagesFunction } from "@cloudflare/workers-types";

function validHost(h: string) { return /^[a-z0-9.-]+$/.test(h) }

// 퍼미션 세트 버전(퍼미션 바꾸면 숫자 올려 KV 키가 달라지게)
const PERM_VERSION = 2;

// Misskey 사용자 토큰에서 실사용되는 광범위 퍼미션 세트
// (노트/리액션/팔로우/즐겨찾기/알림/드라이브/페이지/채널/갤러리/DM/차단·뮤트 등)
const PERMISSIONS: string[] = [
  // Account
  "read:account", "write:account",

  // Notes & timeline
  "read:notes", "write:notes",

  // Reactions / Favourites (Misskey는 favourites 대신 reactions이 핵심)
  "read:reactions", "write:reactions",
  "read:favorites", "write:favorites",

  // Following
  "read:following", "write:following",

  // Notifications
  "read:notifications", "write:notifications",

  // Drive (업로드/첨부)
  "read:drive", "write:drive",

  // Pages (Misskey Pages CMS)
  "read:pages", "write:pages",
  "read:page-likes", "write:page-likes",

  // Channels
  "read:channels", "write:channels",

  // Gallery
  "read:gallery", "write:gallery",
  "read:gallery-likes", "write:gallery-likes",

  // Messaging (DM)
  "read:messaging", "write:messaging",

  // Mute / Block
  "read:mutes", "write:mutes",
  "read:blocks", "write:blocks",
];

type Env = { FEDIOAUTH_KV: KVNamespace };

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const u = new URL(request.url);
  const host = u.searchParams.get("host")?.trim().toLowerCase();
  if (!host || !validHost(host)) return new Response("Invalid host", { status: 400 });

  // 1) 앱 등록 캐시 (퍼미션 버전을 키에 포함)
  const appKey = `mkapp:v${PERM_VERSION}:${host}`;
  let app = await env.FEDIOAUTH_KV.get(appKey, { type: "json" }) as any | null;

  if (!app) {
    const res = await fetch(`https://${host}/api/app/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Mini Fedi Viewer",
        description: "Viewer for Misskey & Mastodon",
        permission: PERMISSIONS,
        callbackUrl: `${u.origin}/api/mk/callback`,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return new Response(`App create failed: ${res.status}\n${body}`, { status: 502 });
    }
    app = await res.json();
    await env.FEDIOAUTH_KV.put(appKey, JSON.stringify(app), { expirationTtl: 60 * 60 * 24 * 7 }); // 7일
  }

  // 2) 세션 생성
  const gen = await fetch(`https://${host}/api/auth/session/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appSecret: app.secret }),
  });
  if (!gen.ok) return new Response("Session generate failed", { status: 502 });
  const g = (await gen.json()) as { token: string; url: string };

  // 3) 세션 토큰 매핑 저장 (콜백 처리용)
  await env.FEDIOAUTH_KV.put(
    `mksess:${g.token}`,
    JSON.stringify({ host, appSecret: app.secret }),
    { expirationTtl: 600 },
  );

  // 4) 승인 URL로 리다이렉트
  return new Response(null, { status: 302, headers: { location: g.url } });
};
