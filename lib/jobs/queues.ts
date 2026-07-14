/** 잡 큐 파라미터 (DESIGN §5.6 표) */
export const QUEUES = {
  media_replicate: { vt: 300, maxAttempts: 5, stage: "media" },
  ingest: { vt: 120, maxAttempts: 4, stage: "ingest" },
  ai_enrich: { vt: 120, maxAttempts: 5, stage: "enrich" },
  embed: { vt: 60, maxAttempts: 5, stage: "embed" },
  snapshot: { vt: 300, maxAttempts: 3, stage: "snapshot" },
} as const;

export type QueueName = keyof typeof QUEUES;

/** drain 소비 우선순위 (§5.6): FxTwitter 미디어 URL 단명 → 미디어 최우선, snapshot은 느긋 */
export const DRAIN_ORDER: QueueName[] = [
  "media_replicate",
  "ingest",
  "ai_enrich",
  "embed",
  "snapshot",
];

/** 백오프: min(30s × 2^read_ct, 1h) + jitter (§5.6) */
export function backoffSeconds(readCt: number, minSeconds = 0): number {
  const base = Math.min(30 * 2 ** readCt, 3600);
  const jitter = Math.floor(Math.random() * 15);
  return Math.max(base + jitter, minSeconds);
}

export function kickDrain(): void {
  const url = process.env.APP_URL;
  const secret = process.env.CRON_SECRET;
  if (!url || !secret) return;
  void fetch(`${url}/api/jobs/drain`, {
    method: "POST",
    headers: { "x-cron-secret": secret },
  }).catch(() => {});
}
