/**
 * URL 정규화 + 소스 유형 판별 (DESIGN §5.2) — 순수 함수.
 * 웹앱·확장(1b)이 공유한다. 원본 source_url은 호출부가 그대로 보존할 것.
 */

export type DetectedSource = {
  type: "article" | "social_post" | "youtube" | "music";
  canonicalUrl: string;
  externalId?: string;
  platform?: "x" | "spotify" | "apple_music" | "youtube_music";
};

// 전역 제거: 의미가 추적뿐인 파라미터만 (사이트별 의미가 있을 수 있는 s/t/si는 제외)
const GLOBAL_TRACKING = new Set([
  "fbclid", "gclid", "dclid", "msclkid", "twclid",
  "igsh", "ref_src", "ref_url", "cmpid", "mc_cid", "mc_eid",
]);

function normalize(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported scheme: ${url.protocol}`);
  }
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  const params = [...url.searchParams.entries()].filter(
    ([k]) => !GLOBAL_TRACKING.has(k) && !k.startsWith("utm_")
  );
  params.sort(([a], [b]) => a.localeCompare(b));
  url.search = new URLSearchParams(params).toString();
  // 루트가 아닌 경로의 트레일링 슬래시 제거
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url;
}

/** 공유 ID 등 호스트별 무의미 파라미터 제거 (canonical을 재구성하지 않는 유형용) */
function stripParams(url: URL, names: string[]): string {
  for (const n of names) url.searchParams.delete(n);
  return url.toString();
}

const X_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"]);
const SPOTIFY_PATH = /^\/(?:intl-[a-z-]+\/)?(track|album|playlist|artist|episode|show)\/([A-Za-z0-9]+)/;

function youtubeVideoId(url: URL): string | null {
  const host = url.hostname;
  if (host === "youtu.be") {
    const id = url.pathname.slice(1).split("/")[0];
    return id || null;
  }
  if (host === "youtube.com" || host.endsWith(".youtube.com")) {
    if (host === "music.youtube.com") return null; // music으로 판별
    if (url.pathname === "/watch") return url.searchParams.get("v");
    const m = url.pathname.match(/^\/(shorts|live|embed)\/([A-Za-z0-9_-]{6,})/);
    if (m) return m[2];
  }
  return null;
}

/** 첫 매치 우선 판별 (§5.2 표). image/file은 업로드 mime으로 별도 판별. */
export function detectSource(rawUrl: string): DetectedSource {
  const url = normalize(rawUrl);
  const host = url.hostname;

  // social_post (X) — canonical은 ID로 재구성 (핸들 변경에 안전)
  if (X_HOSTS.has(host)) {
    const m = url.pathname.match(/\/status(?:es)?\/(\d+)/);
    if (m) {
      return {
        type: "social_post",
        platform: "x",
        externalId: m[1],
        canonicalUrl: `https://x.com/i/status/${m[1]}`,
      };
    }
  }

  // youtube — canonical은 video_id로 재구성
  const videoId = youtubeVideoId(url);
  if (videoId) {
    return {
      type: "youtube",
      externalId: videoId,
      canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    };
  }

  // music
  if (host === "open.spotify.com") {
    const m = url.pathname.match(SPOTIFY_PATH);
    if (m) {
      return {
        type: "music",
        platform: "spotify",
        externalId: `spotify:${m[1]}:${m[2]}`,
        canonicalUrl: `https://open.spotify.com/${m[1]}/${m[2]}`,
      };
    }
  }
  if (host === "spotify.link") {
    // 단축 링크 — ingest 워커가 리다이렉트 추적 후 재판별 (§5.2)
    return { type: "music", platform: "spotify", canonicalUrl: url.toString() };
  }
  if (host === "music.apple.com") {
    return { type: "music", platform: "apple_music", canonicalUrl: stripParams(url, ["si"]) };
  }
  if (host === "music.youtube.com") {
    return { type: "music", platform: "youtube_music", canonicalUrl: stripParams(url, ["si", "feature"]) };
  }

  // 그 외 전부 article (단축 URL은 ingest 워커가 리다이렉트 추적 후 재판별)
  return { type: "article", canonicalUrl: url.toString() };
}
