-- 아카식 레코드 — 함수·트리거 (DESIGN §5.1, §5.5, §5.6, §7.2)

-- ─────────────────────────────────────────────────────────────
-- items.status 파생 트리거 (§5.5 — item_jobs 변경 시 재계산)
-- failed는 '본문조차 없는' 항목에만 적용 (원칙 4)
-- ─────────────────────────────────────────────────────────────
create or replace function derive_item_status() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_item uuid := coalesce(new.item_id, old.item_id);
  v_has_active  bool;
  v_any_failed  bool;
  v_ingest_failed bool;
  v_has_body    bool;
  v_new_status  text;
begin
  select
    coalesce(bool_or(status in ('pending','running')), false),
    coalesce(bool_or(status = 'failed'), false),
    coalesce(bool_or(stage = 'ingest' and status = 'failed'), false)
  into v_has_active, v_any_failed, v_ingest_failed
  from item_jobs where item_id = v_item;

  select exists (
    select 1 from item_contents where item_id = v_item and content_md is not null
  ) into v_has_body;

  if v_ingest_failed and not v_has_body then
    v_new_status := 'failed';
  elsif v_has_active then
    v_new_status := 'processing';
  elsif v_any_failed then
    v_new_status := 'partial';
  else
    v_new_status := 'ready';
  end if;

  update items set
    status = v_new_status,
    processed_at = case
      when v_new_status in ('ready','partial','failed') then now()
      else null
    end
  where id = v_item
    and (status is distinct from v_new_status
         or (v_new_status in ('ready','partial','failed') and processed_at is null));
  return null;
end $$;

create trigger item_jobs_derive_status
  after insert or update or delete on item_jobs
  for each row execute function derive_item_status();

-- ─────────────────────────────────────────────────────────────
-- save_item — 저장의 동기 트랜잭션 (§5.1 ⑤)
-- security definer: 쿠키 세션(authenticated)은 pgmq 스키마 권한이 없으므로
-- 함수 권한으로 pgmq.send를 캡슐화 (§3.3)
-- ─────────────────────────────────────────────────────────────
create or replace function save_item(
  p_type              text,
  p_source_url        text,
  p_canonical_url     text,
  p_title             text  default null,
  p_metadata          jsonb default '{}'::jsonb,
  p_client_request_id uuid  default null,
  p_seed_stages       jsonb default '{"ingest":"pending","enrich":"pending","embed":"pending"}'::jsonb,
  p_enqueue           text[] default array['ingest'],
  p_user_id           uuid  default null
) returns jsonb
language plpgsql security definer
set search_path = public, pgmq, extensions
as $$
declare
  v_user   uuid := coalesce(auth.uid(), p_user_id);
  v_item   uuid;
  v_action text := 'created';
  s record;
  q text;
begin
  if v_user is null then
    raise exception 'save_item: user_id required (auth.uid() null이면 p_user_id 필수)';
  end if;
  -- 씨드 값 검증 (pending/skipped만 허용)
  if exists (select 1 from jsonb_each_text(p_seed_stages) e
             where e.value not in ('pending','skipped')) then
    raise exception 'save_item: seed stage 값은 pending|skipped만 허용';
  end if;

  -- 멱등 키: 동일 요청 재수신은 무변경 반환 (§5.3)
  if p_client_request_id is not null then
    select id into v_item from items
      where user_id = v_user and client_request_id = p_client_request_id;
    if found then
      return jsonb_build_object('item_id', v_item, 'action', 'duplicate');
    end if;
  end if;

  -- 재저장 = 기존 항목 재캡처 (§5.3, saved_at 유지)
  if p_canonical_url is not null then
    select id into v_item from items
      where user_id = v_user and canonical_url = p_canonical_url;
    if found then
      v_action := 'updated';
    end if;
  end if;

  if v_action = 'created' then
    begin
      insert into items (user_id, type, status, source_url, canonical_url, title, metadata, client_request_id)
      values (v_user, p_type, 'processing', p_source_url, p_canonical_url, p_title, p_metadata, p_client_request_id)
      returning id into v_item;
    exception when unique_violation then
      -- 동시 저장 레이스: 갱신 경로로 전환
      select id into v_item from items
        where user_id = v_user and canonical_url = p_canonical_url;
      if v_item is null then raise; end if;
      v_action := 'updated';
    end;
  end if;

  if v_action = 'updated' then
    update items set
      status   = 'processing',
      title    = coalesce(p_title, title),
      metadata = metadata || p_metadata,
      error    = null
    where id = v_item;
  end if;

  -- 스테이지 씨드 (upsert — 재캡처 시 리셋)
  for s in select key, value from jsonb_each_text(p_seed_stages) loop
    insert into item_jobs (item_id, user_id, stage, status)
    values (v_item, v_user, s.key, s.value)
    on conflict (item_id, stage) do update
      set status = excluded.status, attempts = 0,
          error_code = null, error_detail = null, updated_at = now();
  end loop;

  foreach q in array coalesce(p_enqueue, '{}'::text[]) loop
    perform pgmq.send(q, jsonb_build_object('item_id', v_item, 'user_id', v_user));
  end loop;

  return jsonb_build_object('item_id', v_item, 'action', v_action);
end $$;

revoke execute on function save_item from public, anon;
grant execute on function save_item to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────
-- pgmq 래퍼 RPC — service role 전용 (§3.3: 큐 스키마 비노출 원칙)
-- 워커(/api/jobs/*)가 PostgREST rpc()로 큐를 소비하기 위한 경계
-- ─────────────────────────────────────────────────────────────
create or replace function queue_send(p_queue text, p_message jsonb, p_delay int default 0)
returns bigint language sql security definer set search_path = pgmq, public as
$$ select pgmq.send(p_queue, p_message, p_delay) $$;

create or replace function queue_read(p_queue text, p_vt int, p_qty int)
returns setof pgmq.message_record language sql security definer set search_path = pgmq, public as
$$ select * from pgmq.read(p_queue, p_vt, p_qty) $$;

create or replace function queue_delete(p_queue text, p_msg_id bigint)
returns boolean language sql security definer set search_path = pgmq, public as
$$ select pgmq.delete(p_queue, p_msg_id) $$;

create or replace function queue_archive(p_queue text, p_msg_id bigint)
returns boolean language sql security definer set search_path = pgmq, public as
$$ select pgmq.archive(p_queue, p_msg_id) $$;

-- job_delay: 백오프 재예약 (pgmq.set_vt 래퍼 — §5.6)
create or replace function job_delay(p_queue text, p_msg_id bigint, p_delay_seconds int)
returns setof pgmq.message_record language sql security definer set search_path = pgmq, public as
$$ select * from pgmq.set_vt(p_queue, p_msg_id, p_delay_seconds) $$;

-- 큐 잔량 확인 (drain re-kick 판단용)
create or replace function queue_metrics(p_queue text)
returns table (queue_length bigint, total_messages bigint)
language sql security definer set search_path = pgmq, public as
$$ select queue_length, total_messages from pgmq.metrics(p_queue) $$;

do $$
declare fn text;
begin
  foreach fn in array array['queue_send','queue_read','queue_delete','queue_archive','job_delay','queue_metrics'] loop
    execute format('revoke execute on function %I from public, anon, authenticated', fn);
    execute format('grant execute on function %I to service_role', fn);
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────
-- search_items — 하이브리드 검색 (§7.2)
-- security invoker: RLS 자동 적용. RRF k=50, 레그 가중 1.0 (함수 내 상수)
-- p_embedding null이면 벡터 레그 생략 = FTS 단독 폴백 (§7.4)
-- ─────────────────────────────────────────────────────────────
create or replace function search_items(
  p_query     text,
  p_embedding vector(1536) default null,
  p_limit     int  default 20,
  p_type      text default null
) returns table (item_id uuid, score double precision)
language sql stable security invoker as $$
with q as (
  select websearch_to_tsquery('simple', p_query) as tsq
),
kw as (
  select ranked.id, row_number() over (order by ranked.rank desc) as rn
  from (
    select i.id,
      coalesce(ts_rank(i.fts, q.tsq), 0)
      + coalesce(ts_rank(c.fts, q.tsq), 0)
      + coalesce(similarity(i.title, p_query), 0) as rank
    from items i
    left join item_contents c on c.item_id = i.id
    cross join q
    where (p_type is null or i.type = p_type)
      and (i.fts @@ q.tsq or c.fts @@ q.tsq or i.title % p_query)
    order by rank desc
    limit greatest(p_limit * 2, 20)
  ) ranked
),
vec as (
  select i.id, row_number() over (order by i.embedding <=> p_embedding) as rn
  from items i
  where p_embedding is not null
    and i.embedding is not null
    and (p_type is null or i.type = p_type)
  order by i.embedding <=> p_embedding
  limit greatest(p_limit * 2, 20)
)
select
  coalesce(kw.id, vec.id) as item_id,
  coalesce(1.0 / (50 + kw.rn), 0) + coalesce(1.0 / (50 + vec.rn), 0) as score
from kw full outer join vec on kw.id = vec.id
order by score desc
limit p_limit;
$$;

revoke execute on function search_items from public, anon;
grant execute on function search_items to authenticated, service_role;
