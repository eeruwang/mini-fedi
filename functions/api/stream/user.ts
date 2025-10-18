/// <reference types="@cloudflare/workers-types" />
import type { PagesFunction } from "@cloudflare/workers-types";

function getCookie(req: Request, key: string): string | null {
  const m = (`${req.headers.get("cookie") || ""}`).match(new RegExp(`(?:^|;\\s*)${key}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

export const onRequestGet: PagesFunction = async ({ request }) => {
  const inst  = getCookie(request, "ap_inst");
  const token = getCookie(request, "ap_token");
  if (!inst || !token) {
    return new Response("Unauthorized", { status: 401 });
  }

  // 1) 인스턴스가 알려주는 streaming_api 가져오기
  const info = await fetch(`https://${inst}/api/v1/instance`, {
    headers: { accept: "application/json" },
  });
  if (!info.ok) {
    return new Response(`instance meta ${info.status}`, { status: 502 });
  }

  // ✅ 타입 정의 추가
  type InstanceMeta = {
    urls?: {
      streaming_api?: string;
    };
  };

  const meta = (await info.json()) as InstanceMeta;
  let streamingBase: string = meta.urls?.streaming_api || `https://${inst}`; // fallback

  // 2) SSE는 http(s) 필요. wss:// 로 오면 https:// 로 치환
  streamingBase = streamingBase.replace(/^wss:\/\//i, "https://");

  // 3) user 스트림 URL 구성 (access_token 쿼리로 전달)
  const target = new URL("/api/v1/streaming", streamingBase);
  target.searchParams.set("stream", "user");
  target.searchParams.set("access_token", token);

  // 4) 업스트림 SSE를 그대로 파이프로 전달
  const upstream = await fetch(target.toString(), {
    headers: { accept: "text/event-stream" },
    // Cloudflare는 기본적으로 스트림 패스스루 지원
  });
  if (!upstream.ok || !upstream.body) {
    const body = await upstream.text().catch(() => "");
    return new Response(`stream upstream ${upstream.status}\n${body}`, { status: 502 });
  }

  // keep-alive, no-store, CORS는 동일 오리진이라 불필요
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "connection": "keep-alive",
      // 일부 프록시가 버퍼링 못하게:
      "x-accel-buffering": "no",
    },
  });
};
