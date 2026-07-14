-- 아카식 레코드 — RLS 정책 (DESIGN §3.3)
-- anon에는 아무 정책도 없음 = 전면 차단. 인증 게이트(PRD §2)의 DB층 방어선.
-- 워커(service role)는 RLS 우회 — 모든 쓰기 행에 user_id를 명시 기입.

alter table items         enable row level security;
alter table item_contents enable row level security;
alter table media_assets  enable row level security;
alter table tags          enable row level security;
alter table item_tags     enable row level security;
alter table item_jobs     enable row level security;
alter table api_tokens    enable row level security;
alter table exports       enable row level security;

-- (select auth.uid()) 래핑: Supabase 권장 — 쿼리당 1회 평가 캐시
create policy owner_all on items
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy owner_all on item_contents
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy owner_all on media_assets
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy owner_all on tags
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy owner_all on item_tags
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- item_jobs: select만 (쓰기는 워커 service role 전용)
create policy owner_select on item_jobs
  for select to authenticated
  using (user_id = (select auth.uid()));

-- api_tokens: select/delete만 (발급·검증은 서버가 service role로 수행)
create policy owner_select on api_tokens
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy owner_delete on api_tokens
  for delete to authenticated
  using (user_id = (select auth.uid()));

create policy owner_all on exports
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
