import { NextResponse, after } from "next/server";
import { requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { detectSource } from "@/lib/detect-source";
import { ingestRequestSchema, LIMITS } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { kickDrain } from "@/lib/jobs/queues";

export const maxDuration = 30;

/**
 * 저장의 동기 경로 (DESIGN §5.1) — 판별→중복검사→save_item RPC→즉시 응답.
 * 동기 구간에는 외부 네트워크가 없다 (원칙 1).
 */
export async function POST(req: Request) {
  const auth = await requireUser(req, { allowPat: true });
  if (auth instanceof Response) return auth;

  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (contentLength > LIMITS.BODY_MAX) {
    return jsonError(413, "payload_too_large", "요청이 너무 큽니다");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "invalid_payload", "JSON 파싱에 실패했습니다");
  }
  const parsed = ingestRequestSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, "invalid_payload", "요청 검증 실패", parsed.error.issues);
  }
  const input = parsed.data;

  if (input.kind === "file") {
    // 서명 URL 업로드 플로우는 1a-7에서 활성화 (§8.2)
    return jsonError(422, "unsupported_kind", "파일 업로드는 아직 지원하지 않습니다");
  }

  let detected;
  try {
    detected = detectSource(input.url);
  } catch {
    return jsonError(422, "unsupported_url", "지원하지 않는 URL입니다");
  }

  // 유형별 metadata 초기값 (§3.4 계약의 키 이름)
  const metadata =
    detected.type === "social_post"
      ? { platform: detected.platform, post_id: detected.externalId }
      : detected.type === "music"
        ? { origin_platform: detected.platform }
        : detected.type === "youtube"
          ? { video_id: detected.externalId }
          : {};

  const rpcArgs = {
    p_type: detected.type,
    p_source_url: input.url,
    p_canonical_url: detected.canonicalUrl,
    p_title: null,
    p_metadata: metadata,
    p_client_request_id: input.client_request_id ?? null,
    p_seed_stages: { ingest: "pending", enrich: "pending", embed: "pending" },
    p_enqueue: ["ingest"],
  };

  let data: { item_id: string; action: string } | null = null;
  let error: { message: string } | null = null;
  if (auth.via === "session") {
    const supabase = await createClient();
    ({ data, error } = await supabase.rpc("save_item", rpcArgs));
  } else {
    // PAT 경로: service role + 해석된 user_id 명시 스코프 (§11.2)
    const svc = createServiceClient();
    ({ data, error } = await svc.rpc("save_item", { ...rpcArgs, p_user_id: auth.userId }));
  }
  if (error || !data) {
    console.error("save_item failed:", error?.message);
    return jsonError(500, "save_failed", "저장에 실패했습니다");
  }

  after(() => kickDrain()); // 저장→처리 시작 지연 ≈ 0 (§5.6)

  return NextResponse.json(
    { item_id: data.item_id, action: data.action, status: "processing" },
    { status: data.action === "created" ? 201 : 200 }
  );
}
