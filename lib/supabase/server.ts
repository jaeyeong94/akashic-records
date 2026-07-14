import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/** RSC·Route Handler용 쿠키 세션 클라이언트 (RLS 적용) */
export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // RSC에서 호출 시 쿠키 쓰기 불가 — proxy.ts가 세션 갱신을 담당
          }
        },
      },
    }
  );
}
