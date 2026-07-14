import { z } from "zod";

/** 크기 상한 단일 표 (DESIGN §8.5) — 상한 서술 분산 금지, 전부 여기 참조 */
export const LIMITS = {
  BODY_MAX: 4 * 1024 * 1024, // 요청 바디 전체 (gzip 해제 전) — Vercel 4.5MB 한도 내
  SNAPSHOT_HTML_MAX: 3 * 1024 * 1024, // 원문 기준
  CONTENT_MD_MAX: 1 * 1024 * 1024,
  TEXT_MAX: 64 * 1024, // 포스트 본문·note·title 등 기타 텍스트
  URL_MAX: 2048,
  X_MEDIA_MAX: 20,
  CAPTURE_ASSETS_MAX: 50,
  UPLOAD_MAX: 500 * 1024 * 1024, // uploads 버킷 상한 (§4)
} as const;

const urlField = z
  .string()
  .max(LIMITS.URL_MAX)
  .regex(/^https?:\/\//i, "http/https URL만 지원합니다");

export const ingestUrlSchema = z.object({
  kind: z.literal("url"),
  url: urlField,
  client_request_id: z.uuid().optional(),
});

export const ingestFileSchema = z.object({
  kind: z.literal("file"),
  filename: z.string().min(1).max(255),
  content_type: z.string().min(1).max(255),
  size: z.number().int().positive().max(LIMITS.UPLOAD_MAX),
  client_request_id: z.uuid().optional(),
});

// kind=capture(확장)는 Phase 1b에서 추가 (§10.4)
export const ingestRequestSchema = z.discriminatedUnion("kind", [
  ingestUrlSchema,
  ingestFileSchema,
]);

export type IngestRequest = z.infer<typeof ingestRequestSchema>;
