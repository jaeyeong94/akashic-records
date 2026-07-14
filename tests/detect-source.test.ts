import { test } from "node:test";
import assert from "node:assert/strict";
import { detectSource } from "../lib/detect-source.ts";

test("X 포스트 — 핸들 무관 canonical, 공유 파라미터 무시", () => {
  const a = detectSource("https://x.com/someuser/status/1234567890?s=20&t=abc");
  assert.equal(a.type, "social_post");
  assert.equal(a.platform, "x");
  assert.equal(a.canonicalUrl, "https://x.com/i/status/1234567890");
  const b = detectSource("https://twitter.com/i/web/status/1234567890");
  assert.equal(b.canonicalUrl, a.canonicalUrl);
});

test("유튜브 — youtu.be/shorts/watch 전부 watch?v= 로 수렴", () => {
  const expected = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  assert.equal(detectSource("https://youtu.be/dQw4w9WgXcQ?si=xyz").canonicalUrl, expected);
  assert.equal(detectSource("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s").canonicalUrl, expected);
  assert.equal(detectSource("https://www.youtube.com/shorts/dQw4w9WgXcQ").canonicalUrl, expected);
  assert.equal(detectSource("https://youtu.be/dQw4w9WgXcQ").type, "youtube");
});

test("스포티파이 트랙 — intl 경로·si 제거", () => {
  const a = detectSource("https://open.spotify.com/intl-ko/track/4cOdK2wGLETKBW3PvgPWqT?si=abc123");
  assert.equal(a.type, "music");
  assert.equal(a.canonicalUrl, "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT");
});

test("애플뮤직 — si만 제거, 트랙 식별자 i는 보존", () => {
  const a = detectSource("https://music.apple.com/kr/album/xx/123?i=456&si=share");
  assert.equal(a.type, "music");
  assert.equal(a.platform, "apple_music");
  assert.ok(a.canonicalUrl.includes("i=456"));
  assert.ok(!a.canonicalUrl.includes("si="));
});

test("일반 웹 — utm 제거·쿼리 정렬·트레일링 슬래시, 의미 파라미터 보존", () => {
  const a = detectSource("https://example.com/post/?b=2&a=1&utm_source=news&fbclid=x");
  assert.equal(a.type, "article");
  assert.equal(a.canonicalUrl, "https://example.com/post?a=1&b=2");
  // 유튜브가 아닌 사이트의 t= 는 보존되어야 한다
  const b = detectSource("https://example.com/video?t=42");
  assert.ok(b.canonicalUrl.includes("t=42"));
});

test("비 http 스킴 거부", () => {
  assert.throws(() => detectSource("ftp://example.com/x"));
  assert.throws(() => detectSource("javascript:alert(1)"));
});
