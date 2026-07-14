import type { SupabaseClient } from "@supabase/supabase-js";

export type JobMessage = {
  user_id: string;
  item_id?: string;
  asset_id?: string;
};

/** 워커 결과 (DESIGN §5.7 에러 분류와 대응) */
export type JobOutcome =
  | { ok: true }
  | { ok: false; retryable: boolean; code: string; detail?: string; minDelaySeconds?: number };

export type WorkerHandler = (msg: JobMessage, svc: SupabaseClient) => Promise<JobOutcome>;
