/// <reference types="@cloudflare/workers-types" />
import type { PagesFunction } from "@cloudflare/workers-types";

type Env = { FEDIOAUTH_KV: KVNamespace };

// ---------- small utils ----------
function parseCookies(req: Request) {
  const h = req.headers.get("Cookie") || "";
  const out: Record<string, string> = {};
  h.split(/;\s*/).forEach((p) => {
    const i = p.indexOf("=");
    if (i > -1) out[p.slice(0, i)] = decodeURIComponent(p.slice(i + 1));
  });
  return out;
}

async function sha256Hex(s: string) {
  const data = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function parseLinkForNextMaxId(link: string | null): string | null {
  if (!link) return null;
  const m = link.match(/<[^>]*[?&]max_id=([^&>]+)[^>]*>;\s*rel="next"/);
  return m ? decodeURIComponent(m[1]) : null;
}

// 이모지 URL 캐시 키
function emojiUrlCacheKey(host: string, name: string) {
  return `mk:emojiurl:${host}:${name}`;
}

// meta/AP tag에서 못 찾을 때, 공개 경로 패턴을 빠르게 프로브해서 URL을 알아낸다.
// 성공하면 KV에 길게 캐시한다(기본 7일).
async function probeEmojiUrl(env: Env, host: string, name: string): Promise<string | null> {
  host = (host || "").trim().toLowerCase();
  name = (name || "").trim().toLowerCase();
  if (!host || !name) return null;

  const kvKey = emojiUrlCacheKey(host, name);
  const cached = await env.FEDIOAUTH_KV.get(kvKey);
  if (cached) {
    try { return JSON.parse(cached); } catch {}
  }

  // Misskey 쪽에서 자주 쓰이는 공개 경로 패턴들 (우선순위대로 시도)
  const candidates = [
    `https://${host}/emoji/${name}.webp`,
    `https://${host}/emoji/${name}.png`,
    `https://${host}/emoji/${name}.gif`,
    // 일부 포크/리버스프록시 경로들
    `https://${host}/assets/emoji/${name}.webp`,
    `https://${host}/assets/emoji/${name}.png`,
    `https://${host}/assets/emoji/${name}.gif`,
  ];

  // 너무 많은 네트워크를 막으려고 짧은 타임아웃 + 첫 성공만 사용
  for (const url of candidates) {
    try {
      const res = await fetchWithTimeout(url, { method: "GET", redirect: "follow" }, 1200);
      const ok = res.ok && /^image\//i.test(res.headers.get("content-type") || "");
      if (ok) {
        await env.FEDIOAUTH_KV.put(kvKey, JSON.stringify(url), { expirationTtl: 60 * 60 * 24 * 7 });
        return url;
      }
    } catch {
      // 타임아웃/네트워크 실패는 다음 후보로
    }
  }
  // 못 찾았다는 것도 잠깐 캐시(스톰 막기)
  await env.FEDIOAUTH_KV.put(kvKey, JSON.stringify(null), { expirationTtl: 60 * 15 });
  return null;
}

async function fetchWithTimeout(input: RequestInfo, init: RequestInit = {}, ms = 1500) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(input, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

/**
 * fetchRetry: 타임아웃 + 재시도 (지수 백오프)
 * - timeoutMs: 시도당 타임아웃
 * - retries: 추가 재시도 횟수 (0이면 한 번만 시도)
 * - backoffMs: 기본 백오프 시작값 (지수로 증가)
 * - retryOn: 상태코드/에러에 따라 재시도할지 결정
 */
async function fetchRetry(
  input: RequestInfo,
  init: RequestInit = {},
  opts: {
    timeoutMs?: number;
    retries?: number;
    backoffMs?: number;
    retryOn?: (attempt: number, res: Response | null, err: unknown) => boolean;
  } = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 1500;
  const retries = Math.max(0, opts.retries ?? 1);
  const backoffMs = Math.max(0, opts.backoffMs ?? 250);
  const retryOn =
    opts.retryOn ??
    ((attempt, res, err) => {
      if (err) return true; // AbortError/네트워크 에러
      if (!res) return true;
      // 5xx/429 은 재시도
      if ((res.status >= 500 && res.status <= 599) || res.status === 429) return true;
      // 408 Request Timeout
      if (res.status === 408) return true;
      return false;
    });

  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response | null = null;
    try {
      res = await fetch(input, { ...init, signal: ctrl.signal });
      if (!retryOn(attempt, res, null)) return res;
      // 재시도 조건이지만 더 이상 시도 없으면 반환
      if (attempt === retries) return res;
    } catch (err) {
      lastErr = err;
      // 재시도 불가?
      if (!retryOn(attempt, null, err) || attempt === retries) {
        throw err;
      }
    } finally {
      clearTimeout(timer);
    }
    // 백오프 (attempt 0 → backoffMs, 1 → 2*backoffMs, ...)
    const delay = backoffMs * Math.pow(2, attempt);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  }
  // 여기에 올 일은 없지만 타입 만족용
  if (lastErr) throw lastErr;
  throw new Error("fetchRetry: unknown failure");
}

function limiter(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    const fn = queue.shift();
    if (fn) fn();
  };
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= concurrency) {
      await new Promise<void>((r) => queue.push(r));
    }
    active++;
    try {
      return await task();
    } finally {
      next();
    }
  };
}

// ---------- Misskey helpers (KV + memory cached) ----------
const metaMem = new Map<string, any>(); // host -> meta

function normalizeName(s: string) {
  return String(s || "").replace(/^:|:$/g, "").trim().toLowerCase();
}
function normalizeHost(h: string | null | undefined) {
  return (h || "").trim().toLowerCase() || null;
}
function variantsOfName(n: string) {
  const base = normalizeName(n);
  const underscore = base.replace(/-/g, "_");
  const hyphen = base.replace(/_/g, "-");
  return Array.from(new Set([base, underscore, hyphen]));
}

/**
 * 별칭을 메타 인덱스에서 찾는다.
 * - key는 정규화된(소문자, 콜론 제거) 값으로 넘겨야 정확도↑
 */
function resolveAliasFromMeta(meta: any, keyNorm: string) {
  const idx = meta?._aliasByKey as Map<
    string,
    { kind: "custom" | "unicode"; name?: string; host?: string; char?: string }
  > | undefined;
  if (!idx) return null;
  for (const v of variantsOfName(keyNorm)) {
    const hit = idx.get(v);
    if (hit) return hit;
  }
  return null;
}

// ap/show (타임아웃 + KV 캐시) — fetchRetry 적용
export async function getApShow(env: Env, host: string, apUri: string, timeoutMs = 1500) {
  const digest = await sha256Hex(apUri);
  const key = `mk:note:${host}:${digest}`;
  const cached = await env.FEDIOAUTH_KV.get(key);
  if (cached) {
    try {
      return { status: 200, data: JSON.parse(cached) };
    } catch {}
  }

  const res = await fetchRetry(
    `https://${host}/api/ap/show`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uri: apUri }),
    },
    { timeoutMs, retries: 0, backoffMs: 200 },
  );

  if (!res.ok) return { status: res.status, data: null };

  const data = await res.json();
  await env.FEDIOAUTH_KV.put(key, JSON.stringify(data), { expirationTtl: 120 });
  return { status: 200, data };
}

function parseMkReactionKey(key: string) {
  if (!key.includes(":")) return { kind: "unicode" as const, name: normalizeName(key), host: null };
  const trimmed = key.replace(/^:/, "").replace(/:$/, "");
  const [name, host] = trimmed.split("@");
  return { kind: "custom" as const, name: normalizeName(name), host: normalizeHost(host) };
}

// --- 메타 인덱스 빌더 ---
function buildMetaIndex(metaRaw: any) {
  const meta = metaRaw || {};
  // 1) 이모지 이름→URL
  const emojiByName = new Map<string, string>();
  const list = Array.isArray(meta?.emojis) ? meta.emojis : [];
  for (const e of list) {
    const url = e?.url || e?.uri || e?.publicUrl || null;
    const name = e?.name;
    if (!url || !name) continue;
    for (const v of variantsOfName(name)) {
      emojiByName.set(v, url);
    }
  }
  // 2) 별칭키→타입(custom/unicode)
  const maps = [
    meta?.reactionEmojis,             // Misskey
    meta?.reactions,                  // 일부 포크
    meta?.reactionsConfig?.reactions, // 또 다른 포크
  ].find((m) => m && typeof m === "object") as Record<string, unknown> | undefined;

  const aliasByKey = new Map<
    string,
    { kind: "custom" | "unicode"; name?: string; host?: string; char?: string }
  >();

  if (maps) {
    for (const [k, val] of Object.entries(maps)) {
      if (typeof val !== "string") continue;
      const s = val.trim();
      const normKeys = new Set<string>();
      for (const vk of variantsOfName(k)) normKeys.add(vk); // 키 변형 매핑
      for (const nk of normKeys) {
        if (/^:.*:$/.test(s)) {
          const body = s.slice(1, -1); // ":name@host:" → "name@host"
          const [name, host] = body.split("@");
          aliasByKey.set(nk, {
            kind: "custom",
            name: normalizeName(name),
            host: normalizeHost(host) || undefined,
          });
        } else {
          aliasByKey.set(nk, { kind: "unicode", char: s });
        }
      }
    }
  }
  (meta as any)._emojiByName = emojiByName;
  (meta as any)._aliasByKey = aliasByKey;
  return meta;
}

function resolveEmojiUrlFromMeta(meta: any, name: string) {
  const idx = meta?._emojiByName as Map<string, string> | undefined;
  if (!idx) return null;
  for (const v of variantsOfName(name)) {
    const url = idx.get(v);
    if (url) return url;
  }
  return null;
}

function resolveEmojiUrlFromApTag(apObject: any, name: string): string | null {
  const tags = Array.isArray(apObject?.object?.tag)
    ? apObject.object.tag
    : Array.isArray(apObject?.tag)
    ? apObject.tag
    : [];
  for (const t of tags) {
    const tname =
      typeof t?.name === "string" ? t.name.replace(/^:/, "").replace(/:$/, "") : "";
    const url = t?.icon?.url || t?.icon?.href || t?.icon;
    if (t?.type === "Emoji" && normalizeName(tname) === normalizeName(name) && typeof url === "string") {
      return url;
    }
  }
  return null;
}

function extractMisskeyNoteIdFromApUri(apUri: string): string | null {
  try {
    const u = new URL(apUri);
    const m = u.pathname.match(/^\/notes\/([a-zA-Z0-9]+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// 메타 가져오기 — fetchRetry 적용
async function getMisskeyMeta(env: Env, host: string, timeoutMs = 1200) {
  host = normalizeHost(host)!;
  if (metaMem.has(host)) return metaMem.get(host);

  const kvKey = `mkmeta:${host}`;
  const cached = await env.FEDIOAUTH_KV.get(kvKey);
  if (cached) {
    try {
      const v = JSON.parse(cached);
      const withIndex = buildMetaIndex(v);
      metaMem.set(host, withIndex);
      return withIndex;
    } catch {}
  }

  const res = await fetchRetry(
    `https://${host}/api/meta`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    },
    { timeoutMs, retries: 0, backoffMs: 200 },
  );

  if (!res.ok) return null;
  const meta = await res.json();
  const withIndex = buildMetaIndex(meta);
  metaMem.set(host, withIndex);
  await env.FEDIOAUTH_KV.put(kvKey, JSON.stringify(meta), { expirationTtl: 86400 });
  return withIndex;
}

// 원격 호스트 이모지 URL 조회
async function getEmojiUrlFromHost(env: Env, host: string, name: string): Promise<string | null> {
  host = normalizeHost(host)!;
  name = normalizeName(name);

  const m = await getMisskeyMeta(env, host).catch(() => null);
  const byMeta = m ? resolveEmojiUrlFromMeta(m, name) : null;
  if (byMeta) return byMeta;

  // ▼ 추가: 메타에 없으면 공개 경로 프로브까지 바로 시도
  return await probeEmojiUrl(env, host, name);
}


// /api/notes/show — fetchRetry 적용
async function getNotesShow(env: Env, host: string, noteId: string, timeoutMs = 1500) {
  const key = `mk:note:byid:${host}:${noteId}`;
  const cached = await env.FEDIOAUTH_KV.get(key);
  if (cached) {
    try {
      return { status: 200, data: JSON.parse(cached) };
    } catch {}
  }

  const res = await fetchRetry(
    `https://${host}/api/notes/show`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ noteId }),
    },
    { timeoutMs, retries: 0, backoffMs: 200 },
  );

  if (!res.ok) return { status: res.status, data: null };

  const data = await res.json();
  await env.FEDIOAUTH_KV.put(key, JSON.stringify(data), { expirationTtl: 120 });
  return { status: 200, data };
}

// ---------- main ----------
export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const t0 = Date.now();
  const { request, env } = ctx;
  const cookies = parseCookies(request);
  const apToken = cookies["ap_token"];
  const apInst = cookies["ap_inst"];

  if (!apToken || !apInst) {
    return new Response(JSON.stringify({ error: "not logged in" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const url = new URL(request.url);
  const max_id = url.searchParams.get("max_id") || "";
  const debug = url.searchParams.get("debug") === "1";
  const trace = url.searchParams.get("trace") === "1";
  const forceAllReactions = url.searchParams.get("mk_force") === "1"; // ⬅️ 추가

  // 병합 on/off, 병합 최대 개수
  const merge = url.searchParams.get("merge") !== "0"; // 기본 on
  const mergeLimit = Math.max(0, Number(url.searchParams.get("merge_limit") || "6")); // 기본 6
  const budgetMs = Math.max(0, Number(url.searchParams.get("mk_budget_ms") || "0")); // 0=무한
  const prefetchMeta = url.searchParams.get("mk_prefetch") !== "0"; // 기본 true

  // ⏱️ 글로벌 예산 헬퍼
  const hardStart = Date.now();
  const timeLeft = () => (budgetMs ? Math.max(0, budgetMs - (Date.now() - hardStart)) : Infinity);
  const budgetExpired = () => timeLeft() <= 0;

  // 1) Mastodon 홈 타임라인
  const mastoURL = new URL(`https://${apInst}/api/v1/timelines/home`);
  if (max_id) mastoURL.searchParams.set("max_id", max_id);

  const res = await fetchWithTimeout(
    mastoURL.toString(),
    { headers: { authorization: `Bearer ${apToken}` } },
    5000,
  );
  if (!res.ok) {
    return new Response(JSON.stringify({ error: `mastodon ${res.status}` }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }

  const statuses: any[] = await res.json();
  const linkHeader = res.headers.get("Link");
  const next_max_id =
    parseLinkForNextMaxId(linkHeader) ||
    (statuses.length ? statuses[statuses.length - 1].id : null);

  // 2) Misskey 리액션 병합
  let mergedCount = 0,
    triedCount = 0,
    errorCount = 0;

  // 디버그 카운터(헤더용)
  const counters = {
    alias_hits: 0,
    meta_hits: 0,
    remote_hits: 0,
    tag_hits: 0,
    unicode_pass: 0,
    custom_without_url: 0,
  };

  if (merge) {
    type Job = { st: any; apUri: string; host: string; noteId: string | null };
    const allJobs: Job[] = [];
    for (const st of statuses) {
      const apUri: string | undefined = st?.reblog?.uri || st?.uri;
      if (!apUri || !/^https?:\/\//i.test(apUri)) {
        if (debug) st._mkDebug = { stage: "skip_no_ap_uri" };
        continue;
      }
      const host = new URL(apUri).host.toLowerCase();
      const noteId = extractMisskeyNoteIdFromApUri(apUri);
      if (!noteId) {
        if (debug) st._mkDebug = { stage: "skip_non_misskey_shape", apUri, host };
        continue;
      }
      allJobs.push({ st, apUri, host, noteId });
    }

    const jobs = allJobs.slice(0, mergeLimit);

    const uniqueHosts = Array.from(new Set(jobs.map((j) => j.host)));
    if (!budgetExpired() && prefetchMeta) {
      // 예산 안에서만, 그리고 너무 오래 끌지 않게 race with timeout
      const tl = timeLeft();
      await Promise.race([
        Promise.all(
          uniqueHosts.map((h) =>
            getMisskeyMeta(env, h, Math.min(600, tl)).catch(() => null),
          ),
        ),
        new Promise((r) => setTimeout(r, Math.min(600, tl))), // 프리페치 상한 600ms
      ]).catch(() => {});
    }


    const run = limiter(6);

    await Promise.all(
      jobs.map((job) =>
        run(async () => {
          if (budgetExpired()) return; // ⏹️ 예산 소진이면 합성 중단
          const st = job.st;
          triedCount++;
          try {
            // 남은 예산을 기준으로 타임아웃을 줄여서 호출
            const perTryTimeout = Math.max(350, Math.min(900, timeLeft()));
            let apRes = await getApShow(env, job.host, job.apUri, perTryTimeout);
            let obj = apRes.data?.object || apRes.data || null;

            if (!obj && job.noteId) {
              if (budgetExpired()) return;
              const { status, data } = await getNotesShow(env, job.host, job.noteId, perTryTimeout);
              if (status === 200 && data) {
                obj = data;
                if (debug)
                  st._mkDebug = {
                    stage: "fallback_notes_show_ok",
                    apUri: job.apUri,
                    host: job.host,
                    noteId: job.noteId,
                  };
              } else if (debug) {
                st._mkDebug = {
                  stage: "no_ap_object_and_notes_show_failed",
                  apUri: job.apUri,
                  host: job.host,
                  noteId: job.noteId,
                  status,
                };
              }
            } else if (debug && !st._mkDebug) {
              st._mkDebug = {
                stage: apRes.status === 200 ? "ap_show_ok" : "ap_show_failed",
                status: apRes.status,
                apUri: job.apUri,
                host: job.host,
              };
            }

            if (!obj) return;

            const reactions = (obj as any)?.reactions || (obj as any)?.reactionCounts || null;
            if (!reactions || typeof reactions !== "object") {
              if (debug) st._mkDebug = { ...(st._mkDebug || {}), stage: "no_reactions" };
              return;
            }

            // ✅ 여기서 reactions 객체가 존재함을 확인했으므로 바로 아래에 추가!
            if (debug) {
              st._mkDebug = { ...(st._mkDebug || {}), reactions_raw: reactions };
            }

            const meta = prefetchMeta ? (metaMem.get(job.host) || null) : null;

            // ---------- 교체된 리액션 파싱 블록 (host 포함/정규화/트레이스) ----------
            type MkRx = {
              name: string;
              url: string | null;
              count: number;
              char?: string;
              host: string | null; // 이 리액션 이모지의 출처 호스트
            };

            const out: MkRx[] = [];
            const traceArr: any[] = []; // 리액션별 디버그

            for (const rawKey of Object.keys(reactions)) {
              const count = (reactions as any)[rawKey] ?? 0;
              if (!count && !forceAllReactions) continue;

              const step: any = { key: rawKey, count };
              try {
                const keyNorm = normalizeName(rawKey);
                step.keyNorm = keyNorm;

                let kindInfo = parseMkReactionKey(rawKey);
                step.parsed = kindInfo;

                // ① 별칭 조회(정규화된 키로)
                const alias = meta ? resolveAliasFromMeta(meta, keyNorm) : null;
                if (alias) step.alias = alias;

                if (alias?.kind === "unicode") {
                  counters.alias_hits++;
                  counters.unicode_pass++;
                  out.push({ name: alias.char!, url: null, count, char: alias.char!, host: null });
                  step.decision = "alias_unicode";
                  if (trace) traceArr.push(step);
                  continue;
                }
                if (alias?.kind === "custom") {
                  counters.alias_hits++;
                  kindInfo = {
                    kind: "custom",
                    name: normalizeName(alias.name!),
                    host: normalizeHost(alias.host) || kindInfo.host,
                  };
                  step.decision = "alias_custom";
                }

                // ② 콜론 없이도 meta에 있으면 custom로 간주
                if (kindInfo.kind === "unicode" && meta && resolveEmojiUrlFromMeta(meta, keyNorm)) {
                  kindInfo = { kind: "custom", name: keyNorm, host: null };
                  step.metaSuggestsCustom = true;
                }

                // 유니코드면 그대로 통과
                if (kindInfo.kind === "unicode") {
                  counters.unicode_pass++;
                  out.push({ name: kindInfo.name, url: null, count, char: kindInfo.name, host: null });
                  step.decision ??= "unicode";
                  if (trace) traceArr.push(step);
                  continue;
                }

                // custom: URL 해석 시도
                const name = normalizeName(kindInfo.name);
                step.name = name;

                let urlHit: string | null = meta ? resolveEmojiUrlFromMeta(meta, name) : null;
                if (urlHit) {
                  counters.meta_hits++;
                  step.urlFrom = "meta";
                  step.url = urlHit;
                }

                // 별칭/키에 host 있으면 그 호스트 meta 시도
                if (!urlHit && kindInfo.host) {
                  const h = normalizeHost(kindInfo.host)!;
                  urlHit = await getEmojiUrlFromHost(env, h, name);
                  if (urlHit) {
                    counters.remote_hits++;
                    step.urlFrom = "remote_meta";
                    step.remoteHostTried = h;
                    step.url = urlHit;
                  }
                }

                // AP tag 에서도 시도
                if (!urlHit) {
                  const tagUrl = resolveEmojiUrlFromApTag(obj, name);
                  if (tagUrl) {
                    counters.tag_hits++;
                    step.urlFrom = "ap_tag";
                    step.url = tagUrl;
                    urlHit = tagUrl;
                  }
                }
                /** === (신규 4) 공개 경로 프로브 — AP tag까지 실패했을 때 마지막 보강 ===
                 *  - 우선순위: alias/키에서 지정된 host → 없으면 원글 host
                 *  - 성공 시 7일 캐시(KV), 실패는 15분 동안 부정 캐시
                 */
                if (!urlHit) {
                  const probeHost = normalizeHost(kindInfo.host) || (st._mkHost || job.host);
                  if (probeHost) {
                    const probed = await probeEmojiUrl(env, probeHost, name);
                    if (probed) {
                      urlHit = probed;
                      counters.remote_hits++;           // 프로브도 원격 조회로 집계
                      step.urlFrom = "probe";
                      step.probeHost = probeHost;
                      step.url = probed;
                    }
                  }
                }


                // host 결정 로직
                let itemHost: string | null = null;
                if (step.urlFrom === "remote_meta" && step.remoteHostTried) {
                  itemHost = step.remoteHostTried;
                } else if (urlHit) {
                  try {
                    itemHost = new URL(urlHit).host.toLowerCase();
                  } catch {
                    itemHost = job.host.toLowerCase();
                  }
                } else if (kindInfo.host) {
                  itemHost = normalizeHost(kindInfo.host);
                } else {
                  itemHost = job.host.toLowerCase();
                }
                // 3) AP tag
                if (!urlHit) {
                  counters.custom_without_url++;
                  step.urlFrom = "none";
                  step.reason = "no_url_from_meta_remote_tag";
                }

                out.push({ name, url: urlHit || null, count, host: itemHost });
                if (trace) traceArr.push(step);
              } catch (err) {
                step.error = String(err);
                if (trace) traceArr.push(step);
              }
            }

            if (out.length) {
              st._mkReactions = out; // 각 항목에 host 포함됨
              st._mkHost = job.host.toLowerCase(); // 전체 원글 호스트(프론트 편의)
              mergedCount++;
              if (debug) {
                st._mkDebug = {
                  ...(st._mkDebug || {}),
                  stage: st._mkDebug?.stage ?? "ok",
                  merged: out.length,
                  host: job.host,
                };
                if (trace) st._mkTrace = traceArr; // 리액션별 상세 트레이스
              }
            } else if (debug) {
              st._mkDebug = { ...(st._mkDebug || {}), stage: "empty_after_parse" };
              if (trace) st._mkTrace = traceArr;
            }
            // ---------- 리액션 파싱 블록 끝 ----------
          } catch (e: any) {
            errorCount++;
            if (debug) st._mkDebug = { stage: "error", message: String(e) };
          }
        }),
      ),
    );
  } // if(merge)

  const elapsed = Date.now() - t0;
  const body = JSON.stringify({ items: statuses, next_max_id });
  return new Response(body, {
    headers: {
      "content-type": "application/json",
      "x-mk-merge-summary": `tried=${triedCount}; merged=${mergedCount}; errors=${errorCount}`,
      "x-mk-merge-ms": String(elapsed),
      "x-mk-merge-counters": JSON.stringify(counters),
    },
  });
};
