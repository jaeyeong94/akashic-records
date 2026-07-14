-- 아카식 레코드 — 핵심 스키마 (DESIGN §3.2)
-- type/status는 enum 대신 text + CHECK: 값 추가가 CHECK 재정의 한 번으로 끝남

-- 저장 항목 (목록·검색의 단일 진실)
create table items (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  type          text not null check (type in ('article','social_post','youtube','music','image','file')),
  status        text not null default 'processing'
                check (status in ('processing','partial','ready','failed')),
  source_url    text,            -- 사용자가 넣은 원본 URL (업로드 파일은 null)
  canonical_url text,            -- 정규화 URL: 중복 감지 키 (§5.2)
  title         text,
  summary       text,            -- AI 3~4문장 요약 (사용자 언어)
  note          text,            -- 사용자 메모
  lang          text,            -- 감지된 콘텐츠 언어 (ko/en/…)
  metadata      jsonb not null default '{}'::jsonb,  -- 유형별 계약: DESIGN §3.4
  error         text,            -- status='failed' 사유 (사용자가 읽을 수 있는 문장)
  embedding     vector(1536),    -- null = 미처리 (gemini-embedding-001, 1536 절단)
  embedding_model text,          -- 모델 교체 시 재임베딩 대상 식별
  client_request_id uuid,        -- 인제스트 멱등 키 (§8.2)
  fts tsvector generated always as (
    setweight(to_tsvector('simple', coalesce(title,'')), 'A') ||
    setweight(to_tsvector('simple',
      coalesce(metadata->>'author_name','') || ' ' || coalesce(metadata->>'artist','') || ' ' ||
      coalesce(metadata->>'channel_name','') || ' ' || coalesce(metadata->>'site_name','')), 'B') ||
    setweight(to_tsvector('simple', coalesce(summary,'')), 'C')
  ) stored,
  saved_at      timestamptz not null default now(),  -- 사용자 관점 저장 시각 (정렬축, 재임포트 시 보존)
  processed_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index items_user_canonical_uq on items (user_id, canonical_url)
  where canonical_url is not null;                    -- 중복 저장 방지 (재저장 = 재캡처 갱신)
create unique index items_user_reqid_uq on items (user_id, client_request_id)
  where client_request_id is not null;                -- 확장 재시도 멱등
create index items_user_saved_idx on items (user_id, saved_at desc);   -- 라이브러리 피드
create index items_user_type_idx  on items (user_id, type, saved_at desc);
create index items_fts_idx        on items using gin (fts);
create index items_title_trgm_idx on items using gin (title gin_trgm_ops);  -- 한국어 부분일치 (§7.1)
create index items_embedding_idx  on items using hnsw (embedding vector_cosine_ops);
create trigger items_touch before update on items
  for each row execute procedure moddatetime(updated_at);

-- 본문/스냅샷 (items와 1:1 — 목록 쿼리에서 본문 로드를 차단하기 위한 분리)
create table item_contents (
  item_id        uuid primary key references items(id) on delete cascade,
  user_id        uuid not null default auth.uid(),
  content_md     text,   -- 유형별 대표 텍스트: DESIGN §3.4 표의 content_md 열
  content_source text check (content_source in
    ('defuddle','monolith','extension_xhr','extension_dom','oembed','fxtwitter','youtube_caption','vision_llm','import')),
  source_raw     jsonb,  -- oEmbed/FxTwitter/Odesli 등 원본 API 응답 (재처리 대비)
  snapshot_path  text,   -- snapshots 버킷 내 경로 (§4). null = 스냅샷 없는 유형
  snapshot_bytes bigint,
  fts tsvector generated always as (
    to_tsvector('simple', left(coalesce(content_md,''), 200000))  -- to_tsvector 1MB 한도 가드
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index item_contents_fts_idx  on item_contents using gin (fts);
create index item_contents_user_idx on item_contents (user_id);
create trigger item_contents_touch before update on item_contents
  for each row execute procedure moddatetime(updated_at);

-- 복제 미디어 (PRD §5: 캡처 시점 즉시 자체 스토리지 복제)
create table media_assets (
  id            uuid primary key default gen_random_uuid(),
  item_id       uuid not null references items(id) on delete cascade,
  user_id       uuid not null default auth.uid(),
  kind          text not null check (kind in ('image','video','thumbnail','artwork','avatar','file')),
  status        text not null default 'pending' check (status in ('pending','stored','failed')),
  storage_bucket text not null check (storage_bucket in ('media','uploads')),
  storage_path  text,            -- status='stored' 이후 확정
  original_url  text,            -- 복제 출처 (업로드는 null)
  original_filename text,        -- 업로드 원본 파일명 (경로에는 쓰지 않음)
  mime_type     text,
  size_bytes    bigint,
  sha256        text,            -- 스트리밍 중 계산 (무결성·중복 식별)
  width int, height int,
  position      int not null default 0,   -- 트윗 내 이미지 순서 등
  error         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index media_assets_item_idx    on media_assets (item_id, position);
create index media_assets_user_idx    on media_assets (user_id);
create index media_assets_pending_idx on media_assets (status) where status <> 'stored';
create trigger media_assets_touch before update on media_assets
  for each row execute procedure moddatetime(updated_at);

-- 태그 (AI 자유 태깅 + 기존 태그 주입 재사용 — PRD §7)
create table tags (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name       text not null,      -- 정규화 저장: NFKC + trim + 라틴 소문자화 (한글 원형 유지)
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

create table item_tags (
  item_id    uuid not null references items(id) on delete cascade,
  tag_id     uuid not null references tags(id) on delete cascade,
  user_id    uuid not null default auth.uid(),
  source     text not null default 'ai' check (source in ('ai','user')),  -- 재태깅 시 user 태그 불가침
  created_at timestamptz not null default now(),
  primary key (item_id, tag_id)
);
create index item_tags_tag_idx  on item_tags (tag_id);
create index item_tags_user_idx on item_tags (user_id);

-- 스테이지 상태의 영속 기록 (실패를 삼키지 않는 구조의 핵심 — 원칙 3)
create table item_jobs (
  item_id      uuid not null references items(id) on delete cascade,
  user_id      uuid not null,
  stage        text not null check (stage in ('ingest','snapshot','media','enrich','embed')),
  status       text not null default 'pending'
               check (status in ('pending','running','succeeded','skipped','failed')),
  attempts     int  not null default 0,      -- UI용 미러 (진실원은 pgmq read_ct)
  error_code   text,                          -- §5.7 분류
  error_detail text,
  updated_at   timestamptz not null default now(),
  primary key (item_id, stage)
);
create index item_jobs_failed_idx on item_jobs (user_id) where status = 'failed';

-- 개인 액세스 토큰 (확장 인증, Phase 1b — §11.2)
create table api_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  name         text not null,
  token_hash   text not null unique,     -- sha256(평문). 평문은 발급 시 1회만 노출
  last_used_at timestamptz,
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz
);

-- export 잡 상태 (비동기 zip 생성의 UI 노출용 — §12)
create table exports (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  status       text not null default 'processing' check (status in ('processing','ready','failed')),
  storage_path text,
  size_bytes   bigint,
  item_count   int,
  progress     jsonb,            -- 체크포인트: {last_item_id, upload_url} — §12.1 실행 모델
  error        text,
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);
