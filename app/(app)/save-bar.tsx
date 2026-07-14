"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function SaveBar() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const url = String(new FormData(form).get("url") ?? "").trim();
    if (!url) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "url", url }),
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      const detail = await res?.json().catch(() => null);
      setError(detail?.error?.message ?? "저장에 실패했습니다");
      return;
    }
    form.reset();
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex min-w-0 flex-1 items-center gap-2">
      <input
        name="url"
        type="url"
        placeholder="URL을 붙여넣어 저장…"
        className="w-full min-w-0 rounded-md border border-neutral-300 px-3 py-1.5 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900"
      />
      <button
        type="submit"
        disabled={busy}
        className="shrink-0 rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-neutral-900"
      >
        {busy ? "저장 중…" : "저장"}
      </button>
      {error && <span className="shrink-0 text-xs text-red-600">{error}</span>}
    </form>
  );
}
