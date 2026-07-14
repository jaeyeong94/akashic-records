import { createHash } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api";

export type AuthedUser = {
  userId: string;
  via: "session" | "pat";
};

/**
 * API 라우트 인증 (DESIGN §11.1) — 두 자격 수용:
 *  ① 쿠키 세션 (RLS 자동 적용)
 *  ② Authorization: Bearer <PAT> — 인제스트 계열 + /api/me 한정 (§11.2)
 * 쿠키 세션의 상태변경 요청은 Origin 헤더 검증 (CSRF 방어층).
 * 실패 시 Response(401/403)를 반환 — 호출부는 instanceof Response로 분기.
 */
export async function requireUser(
  req: Request,
  opts: { allowPat?: boolean } = {}
): Promise<AuthedUser | Response> {
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];

  if (bearer) {
    if (!opts.allowPat) return jsonError(401, "unauthorized", "PAT 미지원 엔드포인트");
    const tokenHash = createHash("sha256").update(bearer).digest("hex");
    const svc = createServiceClient();
    const { data: token } = await svc
      .from("api_tokens")
      .select("id, user_id, revoked_at")
      .eq("token_hash", tokenHash)
      .maybeSingle();
    if (!token || token.revoked_at) {
      return jsonError(401, "unauthorized", "유효하지 않은 토큰");
    }
    // last_used_at 갱신은 응답을 막지 않는다 (fire-and-forget)
    void svc.from("api_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", token.id);
    return { userId: token.user_id, via: "pat" };
  }

  // 쿠키 세션 경로 — 상태변경 요청은 Origin 검증 (SameSite=Lax 위 방어층 한 겹)
  if (["POST", "PATCH", "PUT", "DELETE"].includes(req.method)) {
    const origin = req.headers.get("origin");
    if (origin && process.env.APP_URL && origin !== process.env.APP_URL) {
      return jsonError(403, "forbidden", "Origin 불일치");
    }
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return jsonError(401, "unauthorized", "로그인이 필요합니다");
  return { userId: user.id, via: "session" };
}
