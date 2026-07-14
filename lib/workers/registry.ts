import type { QueueName } from "@/lib/jobs/queues";
import type { WorkerHandler } from "./types";

/**
 * 큐 → 워커 매핑. 어댑터가 구현되는 대로 등록된다 (1a-3 article → 1a-4 AI → 1a-5 나머지).
 * 미등록 큐는 drain이 소비하지 않는다 — 메시지는 큐에 남아 워커 등록 후 처리된다.
 */
export const WORKERS: Partial<Record<QueueName, WorkerHandler>> = {};
