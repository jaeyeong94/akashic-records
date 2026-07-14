import { NextResponse } from "next/server";

/** 공통 에러 포맷 (DESIGN §8.1): 코드는 소문자 스네이크 고정 문자열 */
export function jsonError(
  status: number,
  code: string,
  message: string,
  details?: unknown
) {
  return NextResponse.json(
    { error: { code, message, ...(details !== undefined ? { details } : {}) } },
    { status }
  );
}
