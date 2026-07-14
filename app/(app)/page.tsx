import { createClient } from "@/lib/supabase/server";

export default async function LibraryPage() {
  const supabase = await createClient();
  const { data: items } = await supabase
    .from("items")
    .select("id, type, status, title, summary, source_url, saved_at")
    .order("saved_at", { ascending: false })
    .limit(30);

  if (!items?.length) {
    return (
      <div className="flex flex-col items-center gap-2 py-24 text-center text-neutral-500">
        <p className="text-lg">도서관이 비어 있습니다</p>
        <p className="text-sm">URL을 저장하면 여기에 쌓입니다.</p>
      </div>
    );
  }

  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => (
        <li
          key={item.id}
          className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
        >
          <div className="mb-1 flex items-center gap-2 text-xs text-neutral-500">
            <span>{item.type}</span>
            {item.status !== "ready" && <span>· {item.status}</span>}
          </div>
          <p className="line-clamp-2 font-medium">{item.title ?? item.source_url}</p>
          {item.summary && (
            <p className="mt-1 line-clamp-3 text-sm text-neutral-500">{item.summary}</p>
          )}
        </li>
      ))}
    </ul>
  );
}
