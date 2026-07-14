import { NextResponse, after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { jsonError } from "@/lib/api";
import { createServiceClient } from "@/lib/supabase/service";
import { QUEUES, DRAIN_ORDER, backoffSeconds, kickDrain, type QueueName } from "@/lib/jobs/queues";
import { WORKERS } from "@/lib/workers/registry";
import type { JobMessage, JobOutcome } from "@/lib/workers/types";

export const maxDuration = 300;

const TIME_BUDGET_MS = 250_000; // Vercel 300s 한도 내 (§5.6)
const BATCH_SIZE = 8;
const CONCURRENCY = 4;

type PgmqMessage = {
  msg_id: number;
  read_ct: number;
  message: JobMessage;
};

/**
 * 워커 본체 (DESIGN §5.6) — cron 백스톱(1분) 또는 저장 API의 after() 킥으로 실행.
 * pgmq 소비 → 핸들러 실행 → delete/archive/재예약. 동시 실행 안전성은 vt 의미론.
 */
export async function POST(req: Request) {
  if (req.headers.get("x-cron-secret") !== process.env.CRON_SECRET) {
    return jsonError(401, "unauthorized", "internal only");
  }

  const svc = createServiceClient();
  const deadline = Date.now() + TIME_BUDGET_MS;
  const stats: Record<string, { done: number; failed: number; delayed: number }> = {};

  await sweepAbandonedUploads(svc);

  for (const queue of DRAIN_ORDER) {
    const handler = WORKERS[queue];
    if (!handler) continue; // 미등록 큐는 소비하지 않는다 — 메시지는 남는다

    stats[queue] = { done: 0, failed: 0, delayed: 0 };
    while (Date.now() < deadline) {
      const { data: msgs, error } = await svc.rpc("queue_read", {
        p_queue: queue,
        p_vt: QUEUES[queue].vt,
        p_qty: BATCH_SIZE,
      });
      if (error) {
        console.error(`queue_read(${queue}) failed:`, error.message);
        break;
      }
      const batch = (msgs ?? []) as PgmqMessage[];
      if (!batch.length) break;

      // 제한 동시성 (4-way)
      for (let i = 0; i < batch.length; i += CONCURRENCY) {
        await Promise.all(
          batch.slice(i, i + CONCURRENCY).map((m) => processMessage(svc, queue, m, stats[queue]))
        );
        if (Date.now() >= deadline) break;
      }
    }
  }

  // 시간 예산 소진 후 큐 잔량 있으면 self re-kick
  if (Date.now() >= deadline) {
    after(() => kickDrain());
  }

  return NextResponse.json({ ok: true, stats });
}

async function processMessage(
  svc: SupabaseClient,
  queue: QueueName,
  msg: PgmqMessage,
  stat: { done: number; failed: number; delayed: number }
) {
  const { stage, maxAttempts } = QUEUES[queue];
  const handler = WORKERS[queue]!;

  await setJobStage(svc, msg.message, stage, { status: "running", attempts: msg.read_ct });

  let outcome: JobOutcome;
  try {
    outcome = await handler(msg.message, svc);
  } catch (e) {
    outcome = {
      ok: false,
      retryable: true,
      code: "NETWORK",
      detail: e instanceof Error ? e.message : String(e),
    };
  }

  if (outcome.ok) {
    await svc.rpc("queue_delete", { p_queue: queue, p_msg_id: msg.msg_id });
    stat.done++;
    return;
  }

  const exhausted = msg.read_ct >= maxAttempts;
  if (!outcome.retryable || exhausted) {
    // terminal: 데드레터(pgmq archive, 이력 보존) + item_jobs failed (§5.6, §5.7)
    await svc.rpc("queue_archive", { p_queue: queue, p_msg_id: msg.msg_id });
    await setJobStage(svc, msg.message, stage, {
      status: "failed",
      error_code: outcome.code,
      error_detail: outcome.detail ?? null,
      attempts: msg.read_ct,
    });
    stat.failed++;
  } else {
    await svc.rpc("job_delay", {
      p_queue: queue,
      p_msg_id: msg.msg_id,
      p_delay_seconds: backoffSeconds(msg.read_ct, outcome.minDelaySeconds),
    });
    await setJobStage(svc, msg.message, stage, {
      status: "pending",
      error_code: outcome.code,
      error_detail: outcome.detail ?? null,
      attempts: msg.read_ct,
    });
    stat.delayed++;
  }
}

async function setJobStage(
  svc: SupabaseClient,
  msg: JobMessage,
  stage: string,
  fields: Record<string, unknown>
) {
  if (!msg.item_id) return; // asset 단위 메시지의 집계는 media 워커가 담당 (§5.4)
  await svc
    .from("item_jobs")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("item_id", msg.item_id)
    .eq("stage", stage);
}

/** /complete 미호출 24h 경과 업로드 항목 → failed(UPLOAD_ABANDONED) (§5.6, §8.2) */
async function sweepAbandonedUploads(svc: SupabaseClient) {
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: stale } = await svc
    .from("items")
    .select("id, user_id")
    .in("type", ["image", "file"])
    .eq("status", "processing")
    .lt("created_at", cutoff);
  if (!stale?.length) return;

  for (const item of stale) {
    // 원본이 저장된 항목은 대상이 아니다 (업로드 완료 = media_assets stored)
    const { count } = await svc
      .from("media_assets")
      .select("id", { count: "exact", head: true })
      .eq("item_id", item.id)
      .eq("status", "stored");
    if (count) continue;

    await svc
      .from("item_jobs")
      .upsert(
        {
          item_id: item.id,
          user_id: item.user_id,
          stage: "ingest",
          status: "failed",
          error_code: "UPLOAD_ABANDONED",
          error_detail: "24시간 내 업로드가 완료되지 않았습니다",
        },
        { onConflict: "item_id,stage" }
      );
    await svc
      .from("item_jobs")
      .update({ status: "skipped" })
      .eq("item_id", item.id)
      .in("stage", ["enrich", "embed"])
      .eq("status", "pending");
  }
}
