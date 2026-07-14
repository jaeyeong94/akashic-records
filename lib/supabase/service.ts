import { createClient } from "@supabase/supabase-js";

/**
 * service role 클라이언트 — RLS 우회. 워커(/api/jobs/*)와 PAT 경로 전용.
 * 모든 쿼리를 해석된 user_id로 명시 스코프할 것 (DESIGN §3.3, §11.2).
 */
export function createServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}
