import Link from "next/link";
import { SaveBar } from "./save-bar";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-neutral-200 bg-white/80 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/80">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
          <Link href="/" className="shrink-0 font-semibold">
            아카식 레코드
          </Link>
          <SaveBar />
          <div className="ml-auto flex items-center gap-3 text-sm text-neutral-500">
            <Link href="/search" className="hover:text-neutral-900 dark:hover:text-white">
              검색
            </Link>
            <Link href="/settings" className="hover:text-neutral-900 dark:hover:text-white">
              설정
            </Link>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
