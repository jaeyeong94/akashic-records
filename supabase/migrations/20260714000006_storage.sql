-- 아카식 레코드 — Storage 버킷 + RLS (DESIGN §4)
-- 전 버킷 private. 경로 1번째 세그먼트는 항상 {user_id} — Storage RLS의 파티션 키.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('snapshots', 'snapshots', false,   52428800, array['text/html']),                -- 50MB
  ('media',     'media',     false,  209715200, array['image/*','video/*']),        -- 200MB
  ('uploads',   'uploads',   false,  524288000, null),                              -- 500MB, MIME 제한 없음
  ('exports',   'exports',   false, 5368709120, array['application/zip'])           -- 5GB
on conflict (id) do nothing;

-- uploads: 사용자 직접 업로드 (서명 URL 경유) — insert/select/delete 허용
create policy uploads_owner_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'uploads' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy uploads_owner_select on storage.objects
  for select to authenticated
  using (bucket_id = 'uploads' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy uploads_owner_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'uploads' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- snapshots/media/exports: select만 (쓰기는 service role 전용)
create policy server_buckets_owner_select on storage.objects
  for select to authenticated
  using (bucket_id in ('snapshots','media','exports')
         and (storage.foldername(name))[1] = (select auth.uid())::text);
