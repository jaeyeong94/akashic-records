# 아카식 레코드 — 설계 문서 (DESIGN)

- 작성일: 2026-07-13
- 상태: 초안 v0.2 (리뷰 지적사항 반영)
- 상위 문서: PRD.md (v0.3) — 모든 결정의 상위 문서. 본 문서와 모순 시 PRD 우선.
- 근거 자료: `docs/research/01-competitors.md` · `docs/research/02-archiving-feasibility.md` · `docs/research/03-ai-pipeline.md`

---

## 1. 개요와 전제

### 1.1 범위

Phase 1(1a+1b)의 구현 가능한 설계 전량: 데이터 모델(DDL), 스토리지, 인제스트 파이프라인·잡 큐, AI 파이프라인, 하이브리드 검색, API 계약, 웹앱 구조, Chrome 확장, 인증, Export/Import, 배포. Phase 2+ 는 "막지 않는 결정"(§1.4)까지만 다룬다.

### 1.2 설계 원칙

1. **동기 구간에는 외부 네트워크가 없다.** 저장 API는 판별→INSERT→enqueue만 수행한다. 외부 API 지연이 저장 UX(체감 2초, PRD 수용 기준 4)를 인질로 잡지 않는다.
2. **잡 페이로드는 포인터, 진실은 DB.** 메시지에는 ID만 싣고 워커는 DB 행을 읽어 일한다 → 모든 워커가 멱등이 되고 at-least-once 재전달이 안전하다.
3. **실패는 반드시 행(row)으로 남는다.** 모든 처리 스테이지는 `item_jobs`에 `succeeded | skipped | failed`로 종결된다. 조용히 삼켜지는 경로가 구조적으로 없다(PRD 수용 기준 3).
4. **부분 실패는 항목 전체를 죽이지 않는다.** 본문이 확보됐으면 스냅샷·임베딩이 실패해도 항목은 검색·열람 가능한 `partial`로 산다.
5. **읽기 경로 기준 분리.** 카드 그리드 목록 쿼리는 `items`만 스캔한다. 본문(`item_contents`)과 바이너리(Storage)는 상세 뷰에서만 로드.
6. **모든 테이블 `user_id` + RLS.** 단일 사용자지만 멀티테넌시를 막는 결정 금지(PRD §2).
7. **큰 바이너리는 Vercel을 거치지 않는다.** 업로드 파일은 Storage 서명 URL로 클라이언트가 직접 업로드. API 본문에는 텍스트·메타데이터만(확장 스냅샷은 gzip 인라인 예외 — 필드별 상한은 §8.5 표 참조).
8. **Phase 1 규모 전제**: 단일 사용자, 항목 수천~수만 건. 이 규모에서 무의미한 최적화(파티셔닝, 카운터 캐시, 임베딩 청킹)는 하지 않는다.

### 1.3 확정 결정 (재론 금지)

- 스택: Next.js(Vercel) + Supabase(Postgres+pgvector+tsvector, Storage, Auth, Queues/pgmq)
- 개인용 시작(단일 계정 인증 첫날부터) → 멀티테넌시 여지
- 저장 수준은 소스 유형별 자동 차등, 미디어는 캡처 시점 즉시 자체 스토리지 복제
- AI: 소형 모델 태깅·요약(기존 태그 주입), 임베딩, 본문 ~2K 토큰 트렁케이션, '처리 중' 상태 노출
- SingleFile(AGPL-3.0) 라이브러리 내장 금지 — 프로세스 격리 호출(monolith CLI) 또는 대체 구현만(PRD §8)

### 1.4 막지 않는 결정 (Phase 2+ 대비 — 여기까지만)

| 미래 요구 | 현 설계가 막지 않는 이유 |
|---|---|
| 멀티테넌시 | 전 테이블 user_id + RLS + Storage user_id 프리픽스가 이미 파티션 축 |
| 긴 문서 청킹 다중 임베딩 | `item_chunks(item_id, seq, embedding)` 테이블 추가로 대응, items.embedding은 대표 벡터 유지 |
| TnT-LLM 사용자별 분류체계 (Phase 3) | 자유형 tags 위에 `taxonomies` 테이블 신설 — 기존 태그 스키마 무변경 |
| 새 소스 유형 (텔레그램 메모 등, Phase 2) | type CHECK 재정의 + metadata 계약 추가만 |
| 한국어 FTS 품질 | PGroonga 인덱스 추가(스키마 무변경) |
| 유튜브 STT 옵트인 (Phase 2) | content_md에 트랜스크립트가 들어가는 구조 그대로 |
| 리서페이싱/관련 항목 (Phase 3) | 임베딩 유사도 self-join으로 가능 |
| X 스레드 캡처 | 캡처 페이로드 `post` 자기동형 구조 + `metadata.posts[]` 예약 (§10.3) |
| LinkedIn 캡처 (1b 후반) | 확장의 인터셉터+ISOLATED 패턴·엔벨로프·완결성 검증 프레임 재사용 |
| 실시간 상태 반영 | 상태는 DB 컬럼 — 폴링을 Realtime `postgres_changes` 구독으로 교체는 클라이언트 훅 교체 작업 |
| 워커 런타임 이관 | 페이로드·pgmq·item_jobs는 런타임 중립 — 특정 큐만 Edge Function/컨테이너로 분리 가능 |
| Firefox/Safari 확장 | WXT 크로스브라우저 빌드 — MV3 전용 API 직접 호출 대신 WXT 추상화 사용 |
| 레이트리밋 | 멀티유저 전환 시 미들웨어 한 겹 추가 |
| Import의 API/UI 승격 | Phase 1은 CLI 스크립트(§12.2) — 멀티유저 전환 시 uploads 버킷 서명 URL + import 잡으로 승격, 업로드 경로가 이미 존재 |

의도적으로 **하지 않은 것**: 소프트 삭제(휴지통), 태그 카운터 캐시, 항목 버전 히스토리, 스냅샷 버저닝, 파티셔닝, 사용자 커스텀 AI 프롬프트 설정면 — 전부 Phase 1 요구에 없고 추후 추가가 스키마를 깨지 않는다.

---

## 2. 시스템 구성도

```
[사용자 브라우저]                [Vercel]                              [Supabase]
┌─────────────────┐   HTTPS   ┌────────────────────────┐   SQL/RPC   ┌──────────────────────────┐
│ 웹앱 (Next.js)   │──────────▶│ Next.js App Router      │────────────▶│ Postgres                 │
│  RSC + 클라이언트│           │  ├ 페이지 (RSC 직접조회) │             │  ├ items/item_contents/… │
│                 │           │  ├ /api/* Route Handler │             │  ├ pgvector·tsvector     │
│ Chrome 확장(1b) │──PAT─────▶│  │  (ingest·items·search│             │  ├ pgmq (잡 큐)          │
│  WXT/MV3        │           │  │   ·export·tokens…)   │             │  └ RLS (전 테이블)        │
└─────────────────┘           │  ├ /api/jobs/drain      │             │ Storage (private 4버킷)   │
                              │  │  = 워커 본체 (Node)   │◀───────────│ Auth (단일 계정)          │
                              │  └ /api/jobs/export     │  cron 킥    │ Cron (pg_cron+pg_net,    │
                              │     = export 전용 워커   │   매 1분    │  1분마다 drain POST)      │
                              └───────────┬────────────┘             └──────────────────────────┘
                                          ▼ (비동기 워커에서만 외부 접근)
                              원본 사이트 fetch · YouTube oEmbed/timedtext · Odesli
                              · X oEmbed/FxTwitter · LLM/임베딩 API (Vercel AI SDK)
```

- **저장의 동기 경로**: 클라이언트 → `/api/ingest` → 판별·중복검사 → `save_item()` RPC(트랜잭션: items INSERT + item_jobs 씨드 + pgmq.send) → 즉시 응답 → `after()`로 drain 킥.
- **비동기 경로**: Supabase Cron(백스톱, 1분) 또는 킥 → `/api/jobs/drain` → pgmq 소비 → 어댑터/AI 실행 → DB·Storage 기록. export만 전용 `/api/jobs/export`(§12.1).
- **워커 본체는 Vercel Node 단일 런타임**. PRD §8은 "Edge Function/cron 트리거"로 스케치했으나, monolith(네이티브 바이너리 — Deno 서브프로세스 불가)와 Defuddle+JSDOM(Node 전용) 제약으로 편차를 제안한다(§15 승인 필요). 큐 저장·전달 보장은 확정대로 Supabase pgmq.

---

## 3. 데이터 모델 (DDL)

### 3.1 핵심 결정

**결정 A — 단일 `items` 테이블 + `metadata` JSONB (유형별 테이블 분리 기각)**

- 6개 유형의 공통 필드(URL·제목·요약·상태·태그·임베딩·저장 시각)가 지배적이며, 검색·목록·파이프라인이 다루는 축은 전부 공통이다.
- 유형별 고유 필드(채널명, 아티스트, 작성자 핸들 등)는 표시용 read-only — WHERE/조인/FK 대상이 아니므로 컬럼일 필요가 없다.
- 유형별 테이블이면 목록·검색이 6-way UNION, RLS·마이그레이션·export가 6벌. Karakeep·Linkwarden 등 동종 제품도 전부 단일 테이블.
- 경계: **쿼리 축 필드는 실컬럼**(type, status, canonical_url, title, lang, saved_at), **JSONB는 표시용**. JSONB 키 계약은 §3.4에 고정, 앱 경계(zod)에서 검증.

**결정 B — 요약·임베딩은 `items` 컬럼 (별도 테이블 기각)**

- 요약은 카드 그리드 상시 표시 필드 — 목록 쿼리가 조인 없이 읽어야 한다.
- Phase 1은 ~2K 토큰 트렁케이션 전제라 항목당 벡터 1개(1:1). 별도 테이블의 실익(청킹 다중 벡터, 모델 병행)은 Phase 1 밖이고, 필요 시 `item_chunks` 추가로 대응 가능. 재임베딩은 전 행 UPDATE + 인덱스 재빌드(수만 행에서 분 단위).

**결정 C — 스테이지 상태는 `item_jobs` 테이블, `items.status`는 트리거 파생**

- 실패를 삼키지 않으려면(원칙 3) 스테이지별 종결 기록이 필요하고, 카드 그리드는 단일 status 컬럼으로 단순해야 한다. 둘을 분리해 양쪽 요구를 충족한다(§5.5).

### 3.2 스키마

전제 확장: `vector`(pgvector), `pg_trgm`, `moddatetime`, `pgmq`, `pg_cron`, `pg_net` — 전부 Supabase 기본 제공. `type`/`status`는 enum 대신 **text + CHECK**(값 추가가 CHECK 재정의 한 번으로 끝남).

```sql
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
  metadata      jsonb not null default '{}'::jsonb,  -- 유형별 계약: §3.4
  error         text,            -- status='failed' 사유 (사용자가 읽을 수 있는 문장)
  embedding     vector(1536),    -- null = 미처리. 모델·차원은 §6.3
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
  content_md     text,   -- 유형별 대표 텍스트: §3.4 표의 content_md 열
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

-- 스테이지 상태의 영속 기록 (실패를 삼키지 않는 구조의 핵심)
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
```

주의: `default auth.uid()`는 클라이언트 경로용 편의다. 워커(service role)는 `auth.uid()`가 null이므로 **삽입 시 user_id를 반드시 명시**한다.

### 3.3 RLS 정책

`items, item_contents, media_assets, tags, item_tags, item_jobs, api_tokens, exports` 전 테이블 `enable row level security` 후:

```sql
create policy owner_all on items
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
-- items·item_contents·media_assets·tags·item_tags·exports 동일 패턴 반복
-- item_jobs: select만 (쓰기는 워커 service role 전용)
-- api_tokens: select/delete만 (발급·검증은 서버가 service role로 수행)
```

- `(select auth.uid())` 래핑은 Supabase 권장(쿼리당 1회 평가 캐시).
- `anon`에는 아무 정책도 없음 = 전면 차단. 인증 게이트(PRD §2)의 DB층 방어선.
- 워커(service role)는 RLS 우회 — 큐 페이로드의 ID로만 동작하고 모든 쓰기 행에 user_id를 명시 기입.
- pgmq 큐 스키마는 anon/authenticated에 노출하지 않는다 — 큐 접근은 service role 전용. 유일한 예외는 `save_item`(**security definer** + `set search_path` 고정 — §5.1)이 함수 내부에서 수행하는 `pgmq.send`: 함수가 큐 접근을 캡슐화하므로 스키마 비노출 원칙은 유지된다.
- PAT 경로(§11.2)는 서버가 토큰→user_id 해석 후 모든 쿼리를 user_id로 명시 스코프.

### 3.4 유형별 metadata JSONB 계약

모든 키는 optional(수집 실패 허용). 앱 경계에서 zod로 검증. `content_md`는 item_contents에 들어갈 대표 텍스트의 정의.

| type | metadata 키 | content_md | 스냅샷 |
|---|---|---|---|
| `article` | `site_name, author_name, published_at, favicon_url, word_count` | Defuddle 마크다운 본문 | ○ (단일 HTML) |
| `social_post` | `platform('x'\|'linkedin'), author_name, author_handle, author_avatar_url, posted_at, capture_method('extension_xhr'\|'extension_dom'\|'oembed'\|'fxtwitter'), post_id, is_thread, posts[]`(스레드 확장 대비 예약) | 포스트 텍스트(인용 포함 병합) | × (미디어는 media_assets) |
| `youtube` | `video_id, channel_name, channel_url, duration_seconds, published_at, caption_lang, caption_source('uploader'\|'auto'), has_captions` | 자막/트랜스크립트 전문 | × (썸네일은 media_assets) |
| `music` | `artist, album, isrc, release_date, origin_platform, links{spotify, appleMusic, youtube, …}`(Odesli 크로스플랫폼 세트) | null | × (아트워크는 media_assets) |
| `image` | `original_filename` | 비전 LLM 설명 + OCR 텍스트 — 본문 파이프라인(FTS·임베딩)을 그대로 재사용 | × |
| `file` | `original_filename` | null (PDF 등 텍스트 추출은 Phase 2 — 자리만 확보) | × |

- **공통 키**: `thumbnail_path` — media 워커가 대표 썸네일 복제 성공 시 역정규화 기입(§5.4). 목록 쿼리가 items만으로 그리드 썸네일을 서명할 수 있게 한다(원칙 5 유지, §8.3).
- favicon·아바타는 URL만 저장하고 복제하지 않는다(표시 보조일 뿐 보존 대상 아님). 복제 대상은 PRD §5의 콘텐츠 미디어(트윗 이미지/영상, 썸네일, 아트워크, 업로드 원본).
- 스레드(추후): 단일 item — content_md에 전체 텍스트 병합, `metadata.posts[]`에 구조 보존. 포스트별 항목 분리는 하지 않는다.

---

## 4. 스토리지 레이아웃

전 버킷 **private**. 표시용 접근은 signed URL(상세 뷰 진입 시 발급, TTL 1시간). 경로 1번째 세그먼트는 항상 `{user_id}` — Storage RLS의 파티션 키.

| 버킷 | 경로 규칙 | 내용 | 쓰기 주체 | 제안 상한/MIME |
|---|---|---|---|---|
| `snapshots` | `{user_id}/{item_id}.html` | 단일 HTML 스냅샷. 재캡처 시 덮어쓰기, 버저닝 없음 | 서버(service role)만 | 50MB, text/html |
| `media` | `{user_id}/{item_id}/{asset_id}.{ext}` | 복제 미디어: 트윗 이미지·영상, 썸네일, 아트워크 | 서버만 | 200MB, image/*·video/* |
| `uploads` | `{user_id}/{item_id}/{asset_id}.{ext}` | 사용자 업로드 원본 (이미지·파일 유형의 1급 자산) | 클라이언트 직접(서명 URL) | 500MB, 제한 없음 |
| `exports` | `{user_id}/{export_id}.zip` | export 아카이브 | 서버만 | 5GB, application/zip |

- 경로에 사용자 입력을 넣지 않는다(경로 인젝션 차단) — 원본 파일명은 `media_assets.original_filename`에만.
- Storage RLS: `uploads`는 `(storage.foldername(name))[1] = auth.uid()::text` 조건으로 사용자 insert/select/delete 허용. `snapshots`·`media`·`exports`는 동일 조건으로 **select만**(쓰기는 service role 전용).
- **삭제 정합**: DB cascade는 Storage 객체를 지우지 못한다. 항목 삭제는 `DELETE /api/items/:id` 처리에서 ① DB delete(cascade) ② `snapshots/{u}/{item_id}.html` + `media/{u}/{item_id}/` + `uploads/{u}/{item_id}/` prefix 제거의 2단계. 2단계 실패로 남는 고아 파일은 개인 규모에서 무시 가능 — 주기 정리 잡은 Phase 2로 미룸.

---

## 5. 인제스트 파이프라인과 잡 큐

### 5.1 저장 플로우 — 동기/비동기 경계

**동기 구간** (`POST /api/ingest`, 목표 p95 < 500ms):

```
① 인증 (쿠키 세션 또는 PAT — §11)
② 입력 검증 (zod — 필드별 크기 상한은 §8.5 표. URL은 http/https만)
③ URL 정규화 + 소스 유형 판별 (순수 함수 detectSource, §5.2)
④ 중복 검사: (user_id, canonical_url) UNIQUE
   → 기존 항목이면 200 { item_id, action:'updated'|'duplicate' } (§5.3)
⑤ RPC save_item(): 단일 트랜잭션으로
   items INSERT (status='processing') + item_jobs 씨드 행 + pgmq.send
⑥ 응답 201 { item_id, action:'created', status:'processing' }
⑦ after(): 워커 킥 — fetch(/api/jobs/drain) fire-and-forget
```

- ⑤를 단일 Postgres 함수로 묶는 이유: "INSERT는 됐는데 메시지 유실"인 반쪽 저장이 트랜잭션 수준에서 불가능해진다.
- `save_item`은 **security definer**(+ `set search_path` 고정)로 선언한다 — 쿠키 세션(authenticated) 컨텍스트는 pgmq 스키마 권한이 없으므로(§3.3) 함수 권한으로 `pgmq.send`를 수행한다. user_id는 `auth.uid()` 우선, null이면(service role 호출 — PAT 경로) 명시 파라미터를 필수로 요구한다.
- 파일/이미지 업로드는 2단계: `POST /api/ingest {kind:'file'}` → 서명 업로드 URL 발급 → 클라이언트 직접 PUT → `POST /api/ingest/:id/complete`. 파일 바이트가 Vercel 함수를 경유하지 않는다.
- 확장 캡처(kind='capture', 1b)는 본문·미디어 URL을 요청에 담아 오므로 ingest 스테이지를 건너뛰고(`skipped`) media_replicate + ai_enrich로 직행. `capture_status != 'complete'`면 서버 폴백 잡(ingest)을 함께 투입 — 단 폴백 실패는 이미 저장된 확장 캡처 본문을 죽이지 않는다(§5.5의 failed 도출 조건 참조).

**비동기 구간**: 외부 네트워크·LLM·미디어 다운로드·스냅샷 생성 전부. UI는 status 배지 + 폴링(§9.3)으로 반영.

```
ingest ──(소스 어댑터 실행)──┬─ snapshot           (article만)
                             ├─ media_replicate ×N (미디어 자산별 fan-out)
                             └─ ai_enrich ──종결 시──▶ embed
```

### 5.2 URL 정규화·소스 유형 판별

순수 함수 `detectSource(url) → { type, canonical_url, external_id? }`. 웹앱·확장(1b)이 공유(§8.6).

**공통 정규화**: scheme/host 소문자화 → fragment 제거 → 추적 파라미터 제거(`utm_*`, `fbclid`, `gclid`, `si`, `igsh`, `ref_src`, X·유튜브·스포티파이 공유 파라미터 포함) → 쿼리 정렬 → 트레일링 슬래시 정규화. 원본 `source_url`은 그대로 보존(fetch는 원본으로).

**판별 규칙** (위에서부터 첫 매치):

| items.type | 매치 조건 | canonical 형태 | 추출 ID |
|---|---|---|---|
| `social_post` (platform='x') | host ∈ {x.com, twitter.com, mobile.twitter.com} AND path `~ /status/(\d+)` (`/i/web/status/` 포함) | `https://x.com/i/status/{id}` | post_id |
| `youtube` | `youtu.be/{id}` · `*.youtube.com`의 `/watch?v=` `/shorts/` `/live/` `/embed/` | `https://www.youtube.com/watch?v={id}` | video_id |
| `music` | `open.spotify.com/(intl-*/)?{track\|album\|…}/` · `music.apple.com/*` · `music.youtube.com/*` · `spotify.link/*` | 정규화 URL (Odesli pageUrl 확보 후 갱신) | platform+entity_id |
| `article` | 그 외 http/https 전부 | 정규화 URL | — |

업로드는 mime으로 `image`/`file`.

**단축 URL**(t.co, bit.ly 등): 판별 시점엔 `article`. ingest 워커가 리다이렉트 추적 후 최종 URL로 재판별 → type 변경 시 items 갱신 후 같은 잡 안에서 올바른 어댑터로 처리. 갱신된 canonical이 기존 항목과 유니크 충돌하면 `DUPLICATE_URL` 종결(기존 항목 ID를 error_detail에 기록, 병합 없음).

### 5.3 중복·재저장 정책

- 동일 canonical_url 재저장 = 신규 행이 아니라 **기존 항목 재캡처**: 본문·스냅샷·미디어 갱신, `saved_at` 유지. unique 인덱스가 레이스를 막는다.
- 응답 `action`: `created`(신규) / `updated`(기존 항목 갱신 — URL 재저장 재캡처, 또는 폴백 저장을 확장 캡처가 승격 병합) / `duplicate`(멱등 키 재수신 등 무변경 반환).
- 확장 재캡처 병합 우선순위: **확장 캡처 값 > 폴백(oEmbed/FxTwitter) 값**. 폴백은 `missing_fields`에 명시된 필드만 채운다.
- 멱등성: 동일 `(user_id, client_request_id)` 재수신 시 기존 항목을 200으로 반환 — 확장 네트워크 재시도가 중복을 만들지 않는다.

### 5.4 소스별 인제스트 어댑터

공통 계약 — 입력: `item_id`(DB에서 URL/type 로드). 출력(전부 upsert — 재실행 안전): items 갱신(title, lang, metadata) / item_contents upsert(content_md, content_source, source_raw) / media_assets 행 생성 + `media_replicate` fan-out / 후속 enqueue(article이면 `snapshot`, 공통 `ai_enrich`).

**공통 fetch 가드(신뢰 경계 — 생략 불가)**: http/https만, 리다이렉트 ≤5회, 타임아웃 15s, HTML 응답 ≤5MB, **DNS 해석 후 사설 IP·localhost·링크로컬(169.254.0.0/16) 대역 차단(SSRF)** — 리다이렉트 추적 후 최종 IP 기준이며, **검증한 IP로 직접 연결한다(resolved IP pin — 검증 시점과 연결 시점 사이의 DNS 재바인딩 차단)**. 미디어 다운로드 워커에도 동일 적용.

**article — 2계층 저장**
1. HTML fetch(브라우저급 UA) → Defuddle(+JSDOM) → content_md + title/author/published 메타.
2. 본문 완결성 검증: 마크다운 200자 미만이면 succeeded로 종결하되 경고 `EMPTY_BODY` 기록 → UI 칩 "본문 추출 실패 — 스냅샷으로 보존됨"(페이월 페이지의 정상 경로: 1b 확장이 해결).
3. OG 이미지 → media_assets(thumbnail) fan-out.
4. `snapshot` 잡 enqueue → 스냅샷 워커가 **monolith CLI**(프로세스 격리 호출 — PRD §8 준수)로 단일 HTML 생성 → snapshots 버킷 업로드 → item_contents.snapshot_path 갱신. 본문 추출과 분리된 잡인 이유: 느리고 무겁고(수십 초·수 MB) 실패해도 본문·AI 파이프라인을 막으면 안 됨.

**youtube — 메타 + 자막**
1. oEmbed(무인증) → title, channel_name, thumbnail_url.
2. 썸네일 media_replicate fan-out (maxresdefault → hqdefault 폴백).
3. 자막: timedtext/InnerTube 경로 시도 → content_md. **클라우드 IP 차단이 일상**이므로 차단(403/봇체크) 시 재시도하지 않고 `skipped` + `CAPTION_BLOCKED` 종결, UI 칩 "자막 미확보". 선택 knob `CAPTION_PROXY_URL` 설정 시에만 프록시 경유 재시도. 서버 자막은 best-effort(§15).
4. 영상 원본은 저장하지 않음 (PRD Out of Scope).

**music — 메타 + 크로스플랫폼**
1. Odesli 우선(한 호출로 title/artist/artwork + 전 플랫폼 URL 세트) → metadata.links + source_raw. 429(무키 10req/min) 시 90s 이상 백오프.
2. 실패 시 폴백: Spotify oEmbed(무인증). Apple Music은 Odesli 단일 경로(공개 oEmbed 부재).
3. 아트워크 → media_replicate fan-out.

**social_post(x) — 서버 폴백 경로 (1a의 주 경로이자 1b 확장의 폴백)**
PRD 신뢰 순서(oEmbed → FxTwitter)를 신뢰 순위로 해석해 **병행 호출·독립 실패 허용**(§15 확인 필요):
1. oEmbed(`publish.twitter.com/oembed`, 무인증) → blockquote 파싱 → 포스트 텍스트·작성자 → content_md. 텍스트의 신뢰원.
2. FxTwitter(`api.fxtwitter.com/status/{id}`) → 구조화 JSON: 미디어 직링크(이미지 `:orig`, 비디오 최고 비트레이트 mp4), 인용 트윗, 작성자 메타 → media_assets fan-out + source_raw.
3. oEmbed 실패 시 FxTwitter 텍스트로 대체. FxTwitter 실패 시 텍스트만 저장 + `MEDIA_SOURCE_UNAVAILABLE` 경고(비공식 API 단절 리스크의 사용자 노출).

**업로드 (image / file)**
원본이 이미 uploads 버킷에 있으므로 ingest 스테이지는 `skipped` 씨드. 이미지는 ai_enrich에서 비전 처리(§6.2). 일반 파일(PDF 등) 텍스트 추출은 Phase 1a 제외 — 파일명·mime 기반 태깅만.

**media_replicate 워커 (미디어 즉시 복제)**
- 입력: `asset_id`. source_url을 스트리밍 다운로드(이미지 ≤25MB, 비디오 ≤300MB — §15 상한 확정) → 스트리밍 중 sha256 계산 → `media/{user_id}/{item_id}/{asset_id}.{ext}` 업로드 → 행 갱신(status='stored').
- 404/410 = 원본 소멸 → 즉시 terminal failed(NOT_FOUND). 5xx/타임아웃 = 재시도. FxTwitter 미디어 URL은 단명 가능 → drain 최우선 처리(§5.6).
- 항목 대표 썸네일(kind='thumbnail', 없으면 첫 이미지) 저장 성공 시 `items.metadata.thumbnail_path`를 역정규화 기입 — 그리드 목록 쿼리가 items만으로 썸네일 서명 URL을 구성한다(원칙 5 유지, §8.3).
- 항목의 media 스테이지(item_jobs)는 소속 자산 전체 종결 시 집계: 전부 stored → succeeded, 하나라도 terminal failed → failed(→ items.status='partial'). **집계 종결 시 해당 항목이 재작성 대기 확장 스냅샷(§5.5)을 보유하면 `snapshot` 잡(재작성 모드)을 enqueue** — 재작성 워커는 stored 자산을 `data:` URI로 스냅샷에 인라인하고, 실패 자산은 참조를 제거한 뒤(§10.5) 스냅샷을 덮어쓰기 업로드하고 snapshot='succeeded'로 종결한다.

### 5.5 항목 상태 머신

**item_jobs 스테이지 전이**: `pending → running → succeeded | skipped | failed`, retry 시 `failed → pending`.

**씨드 규칙**(save_item): 소스에 적용되는 스테이지 행만 생성 —
- URL 저장: `ingest, enrich, embed` (+article 확정 시 ingest 워커가 `snapshot` 추가, 미디어 발견 시 `media` 추가)
- 업로드: `ingest='skipped'` + `enrich, embed`
- 확장 complete 캡처: `ingest='skipped'` + `media(자산 있으면), enrich, embed`. 스냅샷 수신 시: 원문 스냅샷을 즉시 snapshots 버킷에 저장(유실 방지)하되, `assets[]`가 있으면 `snapshot='pending'`(media 집계 후 자산 인라인 재작성 대기 — §5.4·§10.5), 자산이 없으면 `snapshot='succeeded'` 즉시 기록.

**items.status 파생** (item_jobs 변경 트리거로 재계산 — 카드 그리드 쿼리를 단순하게 유지):

```
ingest = failed 그리고 본문 부재(item_contents.content_md 없음)
                                   → failed   ──(사용자 retry)──▶ processing
아니고 pending/running 존재         → processing
아니고 failed 존재                  → partial  ──(해당 스테이지 retry)──▶ processing
그 외 (전부 succeeded/skipped)      → ready    ──(재캡처/재처리)──▶ processing
```

- **failed는 '본문조차 없는' 항목에만 적용된다** — 확장 캡처로 본문이 이미 저장된 항목은 서버 폴백(ingest) 실패만으로 죽지 않고 partial로 산다(원칙 4; DOM 폴백 partial 캡처가 대표 케이스). 파생 트리거는 item_jobs 변경 시 item_contents의 본문 존재 여부를 함께 조회한다.
- 경고(error_code 있는 succeeded/skipped — EMPTY_BODY 등)는 status를 바꾸지 않고 UI 칩으로만 노출.
- 항목은 저장 즉시(`processing`) 그리드에 노출된다(제목·URL·업로드 미디어는 있음). AI 산출물과 벡터 검색 노출만 뒤따른다.

**부분 실패 매트릭스**:

| 실패 스테이지 | 항목에 남는 것 | 상태 |
|---|---|---|
| enrich 실패 | 본문·FTS 검색·(body 기반) 벡터 검색 | partial — "태그/요약 없음" 칩 + 재시도 |
| embed 실패 | 본문·태그·요약·FTS 검색 | partial — 벡터 팔만 결손 |
| snapshot 실패 | 본문·AI 전체 | partial — "원본 스냅샷 없음" 칩 |
| media 일부 실패 | 텍스트 전체 + 성공한 자산 | partial — "미디어 n/m" 칩 |
| ingest 폴백 실패 (확장 캡처 본문 보유) | 확장 캡처 본문·미디어 | partial — "폴백 보강 실패" 칩 |
| ingest 실패 (본문 부재) | URL만 | failed — 재시도 버튼 |

### 5.6 잡 큐 (pgmq — 소문자 스네이크)

```sql
select pgmq.create('ingest');
select pgmq.create('snapshot');
select pgmq.create('media_replicate');
select pgmq.create('ai_enrich');
select pgmq.create('embed');
select pgmq.create('export_archive');
```

| 큐 | 페이로드 (포인터만) | vt(가시성 타임아웃) | 최대 시도 | 비고 |
|---|---|---|---|---|
| `ingest` | `{item_id, user_id}` | 120s | 4 | 소스 어댑터 실행 (처리 데드라인 90s) |
| `snapshot` | `{item_id, user_id}` | 300s | 3 | monolith(article) / 확장 스냅샷 자산 인라인 재작성(capture, §5.4·§10.5). 처리 중 set_vt 연장 |
| `media_replicate` | `{asset_id, item_id, user_id}` | 300s | 5 | 자산별 1메시지 (부분 실패 격리) |
| `ai_enrich` | `{item_id, user_id}` | 120s | 5 | 태깅+요약 단일 LLM 호출 |
| `embed` | `{item_id, user_id}` | 60s | 5 | 임베딩. 재임포트는 embed만 재큐잉 |
| `export_archive` | `{export_id, user_id}` | 600s + 처리 중 set_vt 연장 | 2 | export zip 조립 — **전용 `/api/jobs/export`가 처리, drain 미소비** (§12.1) |

**워커 실행 토폴로지**:

| 역할 | 담당 |
|---|---|
| 큐 저장·전달 보장 | Supabase pgmq (확정) |
| 주기 트리거(백스톱) | Supabase Cron(pg_cron + pg_net) — 매 1분 `POST /api/jobs/drain` (`x-cron-secret` 헤더). Vercel Hobby cron은 일 1회 제한이라 폴링 불가 |
| 즉시 트리거 | 저장 API의 `after()` fire-and-forget 킥 — 저장→처리 시작 지연 ≈ 0 |
| 워커 본체 (일반 큐) | Vercel Node Function (`/api/jobs/drain`) — monolith 바이너리 spawn, Defuddle+JSDOM(Node 전용), Vercel AI SDK 공유, 배포 파이프라인 단일화. §15 승인 필요 |
| export 워커 | 전용 Vercel Node Function (`/api/jobs/export`, maxDuration 800s) — §12.1 |

**drain 루프**:

```
POST /api/jobs/drain  (cron 또는 킥, x-cron-secret 검증)
 시작 시 스위프: /complete 미호출 24h 경과 kind=file 항목 → failed(UPLOAD_ABANDONED) 일괄 전환 (§8.2)
 우선순위: media_replicate → ingest → ai_enrich → embed → snapshot
   (FxTwitter 미디어 URL 단명 → 미디어 최우선; snapshot은 느긋.
    export_archive는 drain이 소비하지 않는다 — 잔량 발견 시 /api/jobs/export 킥만, §12.1)
 각 큐: pgmq.read(queue, vt, qty) 배치 → 제한 동시성(4-way)으로 처리
   성공             → pgmq.delete + item_jobs succeeded
   재시도 가능 실패  → job_delay RPC(pgmq.set_vt 래퍼, service role 전용)로 백오프 재예약
   terminal 실패    → pgmq.archive + item_jobs failed
 시간 예산 ~250s(Vercel 300s 한도 내) 소진 시 중단, 큐 잔량 있으면 self re-kick
```

- 동시 drain 호출의 안전성은 vt 의미론에 기댄다 — **단, 이는 메시지별 처리 시간 < vt일 때만 성립한다.** 각 메시지에 vt보다 짧은 처리 데드라인을 강제하고(예: ingest 90s < vt 120s), 장시간 잡(snapshot 재작성·export)은 처리 중 `pgmq.set_vt` 연장으로 재출현을 차단한다. 워커가 멱등이므로 경계를 넘는 드문 이중 실행도 정합성은 깨지 않는다(낭비일 뿐). 워커 크래시 시 메시지가 vt 후 재출현 → 멱등 재실행. 별도 스위퍼 불필요.
- 시도 횟수의 진실원은 pgmq `read_ct`, `item_jobs.attempts`는 UI용 미러.

**재시도·백오프·데드레터**:
- 백오프: `vt_next = min(30s × 2^read_ct, 1h) + jitter`. 단 `RATE_LIMITED`(429)는 소스별 최소치 우선(Odesli 90s).
- `read_ct > 최대 시도` → 데드레터 = pgmq archive 테이블(`pgmq.a_{queue}`, 이력 보존) + item_jobs failed. 자동 재기동 없음.
- 재기동은 retry API(§8.3) — 새 메시지 send(read_ct 리셋 = 새 시도 예산) + item_jobs pending 리셋.

### 5.7 에러 분류 (error_code)

| 분류 | 코드 | 처리 |
|---|---|---|
| 재시도 | `FETCH_TIMEOUT` `UPSTREAM_5XX` `RATE_LIMITED` `NETWORK` | 백오프 재시도 |
| terminal | `NOT_FOUND`(404/410) `TOO_LARGE` `SSRF_BLOCKED` `PARSE_FAILED` `DUPLICATE_URL` `UPLOAD_ABANDONED` | archive + failed |
| 경고(비치명) | `EMPTY_BODY` `CAPTION_BLOCKED` `MEDIA_SOURCE_UNAVAILABLE` | succeeded/skipped + error_code 기록, UI 칩 |
| LLM 특수 | `LLM_INVALID_OUTPUT` | 인프로세스 1회 즉시 재호출 → 실패 시 잡 재시도 체계 편입 |

**실패의 사용자 노출**(PRD 수용 기준 3): 카드 그리드는 items.status 배지, 상세 뷰는 item_jobs 행별 칩(예: "본문 저장됨 · 스냅샷 실패(재시도) · 미디어 2/3 복제됨 · 자막 미확보") + 실패 스테이지별 재시도 버튼.

---

## 6. AI 파이프라인

### 6.1 잡 분할: enrich(태깅+요약) 1개 + embed 1개

- **태깅과 요약은 단일 LLM 호출**(구조화 출력 `{tags[], summary, lang}`) — 호출 수·비용·실패 도메인이 절반. 나눠 얻는 것이 없다.
- **embed는 별도 잡**: 다른 프로바이더/모델, 다른 실패 모드(차원 불일치·모델 교체), enrich 결과에 의존하는 입력.
- enrich 종결 시(성공 **또는** terminal 실패 모두) embed enqueue — enrich가 죽어도 body만으로 임베딩해 시맨틱 검색을 확보한다.

### 6.2 ai_enrich 워커

1. 입력 조립: title + author + (content_md | 음악 메타) **~2K 토큰 트렁케이션**(비용 상한 고정, 리서치 실측 기준).
2. **기존 태그 주입**: 사용자 태그 중 사용 빈도 상위 200개를 프롬프트에 주입 — "가급적 이 목록에서 재사용, 없을 때만 신규"(태그 파편화 방지, Karakeep 패턴).
3. 프롬프트 규칙: 태그 3~8개, 콘텐츠 언어 따르기, 요약 3~4문장 한국어(사용자 언어), 보일러플레이트/에러 페이지 감지 시 태깅 거부 신호. 프롬프트는 코드 상수 3벌(태깅·요약/비전/재시도) — 사용자 커스텀 설정면은 Phase 1 제외.
4. 이미지 항목: 비전 모델 저해상도 모드 단일 호출로 `{tags, summary(설명), ocr_text}` 통합 → 설명+OCR을 content_md(content_source='vision_llm')에 저장해 본문 파이프라인 재사용.
5. 결과 반영: items.summary 갱신; 태그는 정규화(NFKC + trim + 라틴 소문자화, 한글 원형 유지) 후 tags find-or-create + item_tags 연결. **source='ai' 링크만 삭제 후 재삽입** — 사용자 수동 태그(source='user')는 불가침.

### 6.3 embed 워커

- 입력: `title + tags + summary + content_md 선두` 합성 후 ~2K 토큰 트렁케이션. 항목당 벡터 1개.
- `items.embedding` + `embedding_model` 기록 — 모델 교체 시 재임베딩 대상 식별.
- 차원 **1536 고정**: gemini-embedding-001(Matryoshka 1536 절단)과 text-embedding-3-small 양쪽 호환 — 모델 결정을 스키마가 선점하지 않는다. 주의: `vector` 타입 HNSW는 2,000차원 상한 — 3072 풀차원이 필요해지면 `halfvec(3072)` 전환이 필요하나 1536 절단이면 해당 없음. 모델 확정은 §15.
- 모델 교체 시 전 행 재임베딩 후 `reindex index items_embedding_idx`.

### 6.4 모델 호출 추상화 — 최소 수준

커스텀 인터페이스를 만들지 않는다. **이미 스택에 있는 Vercel AI SDK가 프로바이더 추상화층이다.**
- 교체 노브는 환경변수 3개: `AI_ENRICH_MODEL`(기본: Gemini Flash급 소형), `AI_EMBED_MODEL`, `AI_EMBED_DIM`.
- 구조화 출력: `generateObject` + zod 스키마. 스키마 불일치는 `LLM_INVALID_OUTPUT` 1회 즉시 재호출.

---

## 7. 검색

### 7.1 키워드 레그 — tsvector + pg_trgm, 한국어 대응

한국어 형태소 분석기(mecab 기반 textsearch_ko)는 Supabase에서 설치 불가(커스텀 C 확장 미지원) — 처음부터 배제. 대응은 3겹:

1. **`simple` config tsvector**(items.fts: 제목A/저자B/요약C 가중, item_contents.fts: 본문): 어절(공백) 단위 표면형 매칭. "서울"로 "서울에서"를 못 잡는 조사 문제가 본질적 한계.
2. **pg_trgm GIN**(items.title): 조사 붙은 형태·부분 문자열을 트라이그램 유사도로 보완. 본문 전체 trgm 인덱스는 크기 대비 이득이 불확실해 제외(제목·요약이 고유명사 검색의 주 타깃).
3. **벡터 레그가 의미·활용형 매칭을 흡수** — 하이브리드에서 FTS의 임무는 "정확 키워드·고유명사"로 한정.

업그레이드 경로: **PGroonga**(Supabase 지원 확장) — 스키마 무변경, 인덱스 추가만으로 도입 가능. 한국어 리콜 불만이 실측되면 켠다(§15).

### 7.2 하이브리드 검색 RPC 계약

Supabase 공식 하이브리드 검색 가이드의 RRF 패턴 준용. SQL 함수 하나:

```
search_items(
  p_query      text,           -- 원 질의 (키워드 레그용)
  p_embedding  vector(1536),   -- 서버에서 질의 임베딩 후 전달. null = 벡터 레그 생략(§7.4 폴백)
  p_limit      int  default 20,
  p_type       text default null    -- 유형 필터
) returns table (item_id uuid, score float)
language sql security invoker   -- RLS 자동 적용 (p_user_id 파라미터 불필요)
```

의미론:
- **키워드 레그**: `websearch_to_tsquery('simple', p_query)`를 items.fts와 item_contents.fts에 OR 매치, `ts_rank` 합산 순위 + `similarity(title, p_query)` 트라이그램 상위 합집합.
- **벡터 레그**: `embedding <=> p_embedding` 오름차순 (`embedding is null` 행은 자연 제외). `p_embedding`이 null이면 벡터 레그 자체를 생략하고 키워드 레그 순위만 반환.
- **융합**: 각 레그 상위 N(=p_limit×2)의 순위만 취해 RRF `Σ weight/(k + rank)` 합산 후 상위 p_limit. type 필터는 두 레그 안에서 적용(융합 후 필터링하면 결과 수 부족).
- RRF `k=50`·레그 가중치 1.0은 **함수 내 상수** — 단일 사용자 Phase 1에 튜닝 파라미터 표면은 과잉(필요 시 함수 교체가 마이그레이션 한 번).
- 카드 데이터는 반환된 item_id로 items 재조회(요약·태그·썸네일 조인) — 검색 함수는 순위만 책임진다.

### 7.3 검색 가시성 (최종 일관성 — 점진적 색인)

- FTS: content_md 저장 즉시(=ingest 완료 시) 생성 컬럼으로 검색 가능. processing 항목도 키워드 레그에는 잡힐 수 있다 — 점진적 색인으로 취급, 차단하지 않는다.
- 벡터: embed 성공 후. enrich/embed 실패가 검색 완전 불능으로 번지지 않는다(FTS 레그 유지).
- 저장 직후 미색인 항목은 PRD대로 '처리 중' 배지로 설명된다.

### 7.4 호출 흐름 (`GET /api/search`)

1. **제출형 검색**(Enter/버튼) — 타이핑마다 검색하지 않는다. 질의 임베딩 호출이 검색당 1회로 고정.
2. 라우트 핸들러가 `q`를 요청 시점에 임베딩 — 문서 임베딩과 동일 모델·차원. 질의 캐시 없음(단일 사용자).
3. `supabase.rpc('search_items', …)` 1회 — FTS·벡터·RRF가 DB 왕복 한 번에 끝난다.
4. item_id로 카드 데이터 조인 조회. 지연 예산: 임베딩 ~100ms + RPC ~100ms → 체감 0.5초 내.
5. **임베딩 API 실패 폴백**: 질의 임베딩 호출이 실패하면 `p_embedding=null`로 RPC를 호출해 **FTS 단독 결과**를 반환하고 응답에 `degraded: true`를 표기 — 검색 가용성이 임베딩 프로바이더 장애에 인질 잡히지 않는다.

---

## 8. API 설계

### 8.1 원칙과 공통 규약

- **API 스타일은 Route Handler 단일.** Server Actions 미사용 — 확장이 호출할 엔드포인트는 HTTP 계약이 필요하고, 패턴 하나가 단일 개발자 운영에 낫다. 페이지의 읽기 전용 데이터는 RSC에서 Supabase 서버 클라이언트로 직접 조회(내부 API 우회 호출 없음).
- **에러 포맷**: `{ "error": { "code": "invalid_payload", "message": "…", "details"?: […] } }`. 코드는 소문자 스네이크 고정 문자열(확장이 분기 가능).
- **페이지네이션**: keyset 커서(`saved_at,id` base64) 단일 방식. offset 없음.
- **날짜**: ISO 8601 UTC. **검증**: 모든 쓰기 엔드포인트 zod → 400 + 이슈 배열.
- **레이트리밋 없음**: 인증 뒤 단일 사용자(막지 않는 결정 — §1.4).

### 8.2 인제스트

**`POST /api/ingest`** — 웹앱 붙여넣기·드롭·확장 캡처 공용 단일 엔드포인트. 인증: 쿠키 세션 또는 PAT. `kind` 태그드 유니언:

```jsonc
// 공통
{ "kind": "url" | "capture" | "file",
  "client_request_id": "uuid-v4" }        // 멱등 키(확장은 필수, 웹앱은 선택)

// kind=url — 웹앱 붙여넣기. 서버가 판별(§5.2) 후 유형별 서버 인제스트를 잡 큐로 위임
{ "kind": "url", "url": "https://..." }

// kind=file — 웹앱 파일 드롭. 본문 미포함(서명 URL 업로드)
{ "kind": "file", "filename": "…", "content_type": "image/png", "size": 123456 }

// kind=capture — 확장 캡처(1b). 상세 스키마는 §10.4
{ "kind": "capture",
  "source_url": "https://x.com/a/status/123",
  "source_type": "x_post" | "web_page",    // items.type 매핑: x_post→social_post, web_page→article
  "capture": { /* XCapture 또는 WebPageCapture, §10.4 */ },
  "client": { "app": "extension", "version": "0.1.0", "schema_version": 1 } }
```

공통 헤더: `Content-Type: application/json`, 선택 `Content-Encoding: gzip`(확장 스냅샷). 크기 상한은 §8.5 표.

**응답** (201 신규 / 200 기존):

```jsonc
{
  "item_id": "uuid",
  "action": "created" | "updated" | "duplicate",   // §5.3
  "status": "processing",
  "warnings": ["fallback_enqueued", "thin_extraction"],  // 선택
  "uploads": {                                     // kind=file일 때만: 서명 URL(유효 1시간)
    "file": { "url": "https://…storage…", "method": "PUT", "headers": { … } }
  }
}
```

**에러**: 400(zod 이슈 배열) · 401 · 413(크기 상한 초과) · 422(지원하지 않는 URL 스킴/스키마 위반 — 확장에는 버전 스큐 신호).

**`POST /api/ingest/:id/complete`** — kind=file 업로드 완료 통지. 서버가 Storage 객체 존재 확인 후 `ai_enrich` 큐 등록(파일 없이는 처리 불가). 서명 URL 만료 후엔 `{"reissue": true}`로 재발급. **24시간 내 `/complete`가 호출되지 않은 kind=file 항목은 drain 시작 시 스위프(§5.6)가 `failed`(`UPLOAD_ABANDONED`)로 전환** — processing 영구 잔류를 막는다(삭제는 기존 `DELETE /api/items/:id` 경로).

### 8.3 항목

| 엔드포인트 | 계약 |
|---|---|
| `GET /api/items` | `?cursor=&limit=30(≤100)&type=&tag=&status=processing&view=status` → `{ items: […], next_cursor }`. `view=status`는 폴링용 **고정 경량 응답**(`{id,status}`만 — §9.3; 범용 fields 파라미터는 Phase 1 과잉). 그리드 썸네일은 `items.metadata.thumbnail_path`(§5.4 역정규화)를 `createSignedUrls` 배치 서명 — 목록 쿼리는 items만 스캔(원칙 5) |
| `GET /api/items/:id` | items + item_contents(content_md, 요약) + tags + media_assets + item_jobs 스테이지 배열(처리 중/실패 칩 렌더링용). **미디어는 서명 URL로 변환해 반환**(`{url, expires_at}`, 1시간) — 클라이언트는 Storage 경로를 모른다 |
| `PATCH /api/items/:id` | 수정 가능: `title`, `note`, `tags`(전체 교체 배열 — 미존재 태그명은 자동 생성, 이 경로의 태그는 source='user') |
| `DELETE /api/items/:id` | DB delete(cascade) + Storage prefix 제거 2단계(§4) |
| `POST /api/items/:id/retry` | `{ stages?: string[] }` (생략 시 failed 전체) → 202. 해당 스테이지 pending 리셋 + 재enqueue. AI 재처리(재요약 등)는 `{stages:['enrich','embed']}` |
| `GET /api/items/:id/snapshot` | 스냅샷 HTML 인증 스트리밍(CSP 격리 — §9.4) |
| `GET /api/tags` | 태그 목록(`?q=` 자동완성) |

### 8.4 검색·Export·토큰·내부

| 엔드포인트 | 계약 |
|---|---|
| `GET /api/search` | `?q=&type=&limit=20` → `{ results: [{ item: {…카드 형태}, score }], took_ms, degraded? }` (§7.4) |
| `POST /api/export` | export 잡 생성 + `export_archive` 큐 → `{ export_id, status:'processing' }` + after()로 `/api/jobs/export` 킥(§12.1). **동시 1건 제한** — 진행 중이면 409 + 기존 export_id. 이력 목록 API는 없음 — 설정 페이지 RSC가 exports 테이블 직접 조회(단일 사용자 Phase 1 과잉 제거) |
| `GET /api/export/:id` | `{ status, download?: { url(서명 24h), expires_at, size } }` — ready일 때만 download |
| `POST /api/tokens` | PAT 발급 `{name}` → `{ token }`(평문 1회 노출) — 1b |
| `GET /api/tokens` / `DELETE /api/tokens/:id` | 목록 / 즉시 폐기 — 1b |
| `GET /api/me` | PAT 검증용. `200 { user_id }` / `401` — 1b |
| `POST /api/jobs/drain` | 내부 전용, `x-cron-secret` 헤더 검증 (§5.6) |
| `POST /api/jobs/export` | 내부 전용, `x-cron-secret` 검증 — export 스트리밍 조립 전용 워커 (§12.1) |

### 8.5 트러스트 바운더리와 크기 상한

인제스트는 외부(확장) 입력을 받는 유일한 쓰기 경로. zod로 전 필드 검증. 크기 상한은 아래 **단일 표**로 고정한다 — §1.2 원칙 7·§5.1 ②·§10.5 크기 가드는 전부 이 표를 참조한다(문서 내 상한 서술 분산 금지):

| 필드 | 상한 (zod) | 초과 시 |
|---|---|---|
| 요청 바디 전체 | 4MB (gzip 해제 전 전송 크기 — Vercel 4.5MB 한도 내) | 413 |
| `snapshot_html` | **원문 3MB** (gzip 압축 후는 바디 상한이 커버) | 확장이 `too_large` 강등(§10.5) / 서버 413 |
| `content_markdown` (content_md 계열 본문) | 1MB | 413 |
| `text`(포스트 본문)·`note`·`title` 등 기타 텍스트 필드 | 64KB | 400 |
| `post.media[]` (X 캡처 미디어 선언) | 20개 | 400 |
| `assets[]` (WebPageCapture — 본문 이미지+스타일시트+og_image) | 50개 | 초과분 절단 — 우선순위: og_image > 본문 이미지 > 스타일시트 |
| URL 필드 | http/https만, ≤2KB | 400/422 |

SSRF 가드는 인제스트 검증이 아니라 **페치 시점**(리다이렉트 추적 후 최종 IP, resolved IP pin)에 건다(§5.4).

### 8.6 스키마 공유

zod 스키마·detectSource는 별도 패키지가 아닌 단일 파일(`lib/schemas.ts`, `lib/detect-source.ts`)로 — 1b에서 확장 저장소가 복사해 쓴다(모노레포 여부는 §15).

---

## 9. 웹앱 구조

### 9.1 App Router 트리

```
app/
├── (auth)/login/page.tsx         # 로그인 (이메일+비밀번호)
├── (app)/                        # 인증 필수 구역
│   ├── layout.tsx                # 앱 셸(헤더·검색바·저장 버튼)
│   ├── page.tsx                  # 라이브러리 그리드 (홈)
│   ├── items/[id]/page.tsx       # 항목 상세
│   ├── search/page.tsx           # 검색 결과 (?q= 공유 가능 URL)
│   └── settings/page.tsx         # Export + 액세스 토큰 관리
├── api/                          # §8의 Route Handlers
└── middleware.ts                 # 세션 갱신 + 페이지 가드
```

### 9.2 페이지별 데이터 전략

| 페이지 | 초기 로드 | 클라이언트 상호작용 |
|---|---|---|
| 라이브러리 그리드 | RSC 직접 조회(첫 페이지) | 무한 스크롤·상태 폴링은 `GET /api/items` |
| 항목 상세 | RSC 직접 조회 | 태그 편집 `PATCH`, 처리 중이면 폴링 |
| 검색 | 클라이언트 컴포넌트(제출형) | `GET /api/search` |
| 설정 | RSC (export 이력은 exports 테이블 직접 조회) | Export 트리거·폴링, 토큰 발급 |

그리드 필터는 searchParams(`?type=`, `?tag=`). 라이브러리 브라우징(필터·최신순)과 검색(질의)은 별개 경로 — 그리드는 DB 쿼리, 검색은 search_items RPC.

### 9.3 '처리 중' 상태 — 폴링 채택

1. 단일 사용자 + 항목당 처리 수 초~수십 초. 사용자가 상태를 지켜보는 시간은 저장 직후 잠깐 — 웹소켓 상시 연결·Realtime 채널 관리는 과잉.
2. 화면에 `processing` 항목이 보일 때만 `GET /api/items?status=processing&view=status`를 4초 간격 호출, 전부 끝나면 중지(SWR `refreshInterval` 조건부). 새 인프라 0. 상세 페이지 동일 패턴.
3. 막지 않는 결정: 멀티유저 전환 시 Supabase Realtime `postgres_changes` 구독으로 교체는 클라이언트 훅 교체 작업.

### 9.4 HTML 스냅샷 렌더링 보안

원칙: **스냅샷 HTML은 절대 앱 DOM에 직접 삽입하지 않는다.** DOMPurify 인라인 렌더 기각(완전한 문서의 보존 충실도 파괴, 수 MB 클라이언트 sanitize 지연, sanitizer 우회 상시 리스크). 격리 렌더링:

1. 스냅샷은 private 버킷 저장, `GET /api/items/:id/snapshot`이 인증 확인 후 스트리밍.
2. 응답 헤더: `Content-Security-Policy: sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; media-src data: blob:` (`script-src` 부재 = JS 전면 차단; 외부 요청 차단은 트래킹 픽셀 차단 겸용) + `X-Content-Type-Options: nosniff`.
3. 상세 페이지에서 `<iframe sandbox src="…">` — **sandbox 속성값 비움**(no allow-scripts, no allow-same-origin). CSP `sandbox` 지시어와 iframe 속성의 이중 방어.
4. 스냅샷 내 링크 클릭은 sandbox가 내비게이션 차단 → 기본 무동작(의도된 동작 — 스냅샷은 열람용).
5. 이 CSP가 성립하는 전제: 스냅샷은 **자기완결 문서**다 — monolith 산출물(자산 내장)과 확장 스냅샷의 서버 재작성 결과(stored 자산 `data:` URI 인라인 — §10.5)만 이 뷰어를 통과한다. 외부 절대 URL 자산은 CSP에 의해 로드되지 않는다(의도된 미표시).

### 9.5 소스 유형별 상세 뷰

공통 골격: 헤더(제목·원본 URL·저장일·소스 뱃지) + AI 요약 + 태그(인라인 편집) + 본문 영역 + 액션(원문 열기·삭제·재시도) + item_jobs 상태 칩.

| type | 본문 영역 |
|---|---|
| `article` | 기본 **읽기 뷰**: content_md를 마크다운 렌더러로 표시(raw HTML 패스스루 비활성). 탭 토글로 **스냅샷 뷰**(§9.4 iframe). 스냅샷 미보유 시 토글 숨김 |
| `social_post` | 트윗 카드형: 작성자(아바타·핸들)·본문·미디어 갤러리(media_assets 서명 URL, 라이트박스)·타임스탬프. 원본 링크 사망과 무관하게 자체 데이터만으로 렌더(PRD 수용 기준 1) |
| `youtube` | 자체 복제 썸네일 + 재생 버튼 → 클릭 시 `youtube-nocookie.com` embed 로드(사전 로드 안 함). 접이식 트랜스크립트 전문. 영상 삭제 시 embed는 죽지만 메타·썸네일·자막·요약은 남는다는 안내 |
| `music` | 아트워크(자체 복제) + 트랙/아티스트/앨범 메타 + Odesli 크로스플랫폼 링크 버튼 목록 |
| `image` | 이미지 뷰어(서명 URL) + AI 설명 + OCR 텍스트(접이식) |
| `file` | 파일 아이콘·이름·크기·MIME + 다운로드 버튼(서명 URL). PDF는 브라우저 네이티브 뷰어(새 탭) — 자체 미리보기 없음 |

---

## 10. Chrome 확장 (Phase 1b)

### 10.1 결정 요약

| # | 결정 | 근거 요약 |
|---|---|---|
| D1 | X 캡처 1순위는 **내부 XHR(GraphQL) 응답 인터셉트**, 2순위 DOM 파싱 | 비디오 mp4 URL·장문(note_tweet) 전문·인용 트윗 구조는 DOM에서 확보 불가/불안정(DOM은 blob: URL만 노출) |
| D2 | 캡처 범위는 **단일 포스트 + 인용 1단계**. 작성자 연속 스레드는 1b 제외 | 스레드는 스크롤/페이지네이션 + 완결성 판정 불가. 페이로드는 확장 가능(자기동형 구조 — §1.4) |
| D3 | 일반 페이지 스냅샷은 **SingleFile 미사용, 자체 경량 구현** | 확장 런타임에 프로세스 격리가 없음 → SingleFile 사용 = 번들 내장 = AGPL 전파 = PRD §8 금지. 품질 목표를 "본문을 읽을 수 있는 보존"으로 명시적으로 낮춤(1급 읽기 계층은 Defuddle 마크다운) |
| D4 | 스냅샷 이미지 자산은 **인라인하지 않고 URL 목록 전달, 서버가 복제 후 인라인 재작성** | 요청 바디 경량화 + 미디어 복제 파이프라인(media_assets) 단일화. 최종 자기완결화는 서버 재작성 단계(§10.5) |
| D5 | 확장→서버 인증은 **PAT** (§11.2) | MV3 SW에서 Supabase 세션 유지(refresh 회전·storage adapter) 복잡도 회피 |
| D6 | 인제스트는 웹앱과 공용 `POST /api/ingest`, `capture` 유무로 분기 | 계약 1개. 캡처 실패 시 capture 없이 보내면 그대로 서버 폴백 |
| D7 | 캡처 실패/부분 캡처 시에도 **항상 전송** + `capture_status` 표시, 서버가 폴백 보완 | PRD 수용 기준 3 + "URL이라도 남긴다" |
| D8 | 타임라인 인라인 버튼 미주입. 진입점은 **팝업 + 우클릭 메뉴 + 단축키** | X DOM에 UI 주입 시 셀렉터 파손 표면적 2배 |
| D9 | 일반 페이지 스크립트는 상시 주입 없이 **저장 시점 `chrome.scripting` 온디맨드**(`activeTab`) | `<all_urls>` 회피(심사·프라이버시), 번들 낭비 제거 |

### 10.2 WXT/MV3 구조

```
extension/
  entrypoints/
    background.ts              # SW: API 호출(유일한 네트워크 출구), PAT 접근, 재시도 큐,
    │                          #     컨텍스트 메뉴, 온디맨드 주입, 배지, gzip(CompressionStream)
    popup/                     # 탭 컨텍스트 판별, 저장 트리거, 최근 10건 상태, 재시도, PAT 설정
    x-interceptor.content.ts   # x.com·twitter.com, world:MAIN, document_start — fetch/XHR 패치
    x.content.ts               # 〃, world:ISOLATED — 트윗 캐시·DOM 폴백 파서·캡처 오케스트레이션
    page-capture.ts            # 일반 페이지 캡처 — scripting.executeScript 온디맨드
  lib/
    capture-schema.ts          # 페이로드 타입 (서버 lib/schemas.ts와 동기화)
    x-selectors.ts             # DOM 셀렉터 단일 집약 모듈
```

권한: `storage, scripting, activeTab, contextMenus, alarms` + host_permissions `https://x.com/*, https://twitter.com/*`만. 단축키 `save-current`(기본 Alt+Shift+S). `<all_urls>` 없음.

### 10.3 X 캡처

**XHR 인터셉트(1순위)**:
- MAIN world에서 페이지 스크립트보다 먼저 fetch/XHR 패치. 훅 대상: `/i/api/graphql/<hash>/<OperationName>` (TweetDetail, TweetResultByRestId, HomeTimeline, UserTweets, Bookmarks, SearchTimeline 등).
- **정규화는 경로 기반이 아니라 타입 기반**: 응답 JSON 트리를 재귀 순회하며 `__typename: "Tweet"|"TweetWithVisibilityResults"` 노드 수집 — operation별 응답 경로가 바뀌어도 살아남는 구조(셀렉터 파손 리스크 완화의 핵심, PRD §11).
- 캐시: ISOLATED 측 `Map<post_id, NormalizedPost>`, 탭당 LRU 500건. MAIN→ISOLATED 메시지는 스키마 검증 후 수용(페이지 위조 리스크는 DOM 파싱과 동급 — 수용).
- 미디어 URL 규칙: 이미지 `name=orig` 강제 재작성, 비디오 `video_info.variants` 중 mp4 최고 bitrate 1개(HLS 버림), GIF는 mp4, 아바타 `_400x400`. **다운로드·복제는 서버 수행**(pbs/video.twimg.com은 무인증 공개 CDN) — 확장은 URL만 전달.

**DOM 파싱 폴백(2순위)** — 캐시 미스(설치 전 로드된 탭, GraphQL 형태 변경) 시:
- 규칙: `data-testid` 속성만 사용(외형 클래스 금지), 셀렉터는 `x-selectors.ts`에 primary/fallback 배열로 집약, 파손 감지는 완결성 검증이 담당.
- 구조적 한계: 비디오는 존재 감지만 가능(URL 추출 불가) → `missing_fields: ["media.video_url"]`, 장문 잘림 가능 → `capture_status: "partial"` → 서버 폴백이 보완.

**완결성 검증** (PRD 수용 기준 3): `post_id`(필수 — URL 복원도 실패 시 capture 없이 전송 = 전면 폴백), `author.handle`·`posted_at` 필수, `text`(미디어 있으면 선택), 미디어 개수 일치 — 누락 시 `partial` + `missing_fields`.

**확장 측 캡처 상태 머신**:

```
idle → capturing(캐시 조회→DOM 폴백) → validating
  validating ─ 전부 충족 ──────▶ submitting(capture_status=complete)
             ─ 필수 일부 누락 ──▶ submitting(capture_status=partial, missing_fields)
  capturing 전면 실패(post_id 불가) → submitting(capture 없이 URL만 = 서버 폴백 전면 위임)
  submitting ─ 2xx ─→ done(배지 ✓, 팝업에 결과·warnings)
             ─ 401 ─→ auth_required(팝업 재연결 화면)
             ─ 4xx(401 외) ─→ failed(재시도 안 함, 팝업 노출)
             ─ 429/5xx/네트워크 ─→ queued(재시도 큐, §10.6)
```

### 10.4 capture 페이로드 스키마 (`POST /api/ingest`의 kind=capture)

**XCapture**:

```jsonc
{
  "kind": "x_post",
  "capture_method": "xhr" | "dom",
  "capture_status": "complete" | "partial",
  "missing_fields": ["media.video_url"],   // partial일 때 폴백이 채울 대상
  "post": {
    "post_id": "1234567890",
    "author": { "handle": "user", "display_name": "User", "avatar_url": "…" },
    "text": "전문 (note_tweet 포함)",
    "lang": "ko",
    "posted_at": "2026-07-13T09:00:00Z",
    "media": [
      { "type": "image", "url": "https://pbs.twimg.com/media/x?format=jpg&name=orig",
        "width": 1200, "height": 800, "alt": null },
      { "type": "video", "url": "https://video.twimg.com/….mp4",
        "thumbnail_url": "…", "duration_ms": 30000, "bitrate": 2176000 }
    ],
    "quoted_post": { /* post와 동일 구조, 1단계만 */ }
  }
}
```

(인터셉터가 얻는 `metrics`·`card`는 페이로드에 싣지 않는다 — §3.4 계약에 목적지가 없고 Phase 1 렌더링도 없다. 필요해지면 metadata 키 추가로 대응.)

**WebPageCapture**:

```jsonc
{
  "kind": "web_page",
  "capture_status": "complete" | "partial",
  "missing_fields": [],
  "meta": { "title": "…", "description": null, "author": null, "published_at": null,
            "site_name": null, "favicon_url": null, "og_image_url": null,
            "canonical_url": null, "lang": "ko" },
  "content_markdown": "…",       // Defuddle+Turndown. null 가능
  "snapshot_html": "…",          // 자체 스냅샷(§10.5). null 가능 (markdown과 둘 중 하나는 필수)
  "snapshot_status": "inline" | "too_large" | "failed",
  "assets": [ { "url": "https://cdn…/img.png", "role": "image"|"og_image"|"favicon"|"stylesheet" } ]
}
```

서버 측 기대 동작: 2xx = items 행 생성/병합까지 보장(체감 2초). 본문 저장·미디어 복제·폴백 보강·스냅샷 재작성·AI는 전부 비동기(§5). `capture_status != "complete"` 또는 capture 부재 시 소스별 폴백 잡 자동 투입. 병합 우선순위: 확장 캡처 값 > 폴백 값(§5.3).

### 10.5 일반 페이지 자체 스냅샷 스펙

입력: 렌더링 완료된 현재 DOM(페이월 통과 상태 그대로).

1. `documentElement.cloneNode(true)` 후 `script`/`noscript`/`template`/인라인 `on*` 속성 제거. `iframe`은 절대 URL 플레이스홀더 링크로 치환.
2. CSS: `document.styleSheets` 순회, 접근 가능한 `cssRules` 직렬화 → 단일 `<style>` 인라인. CORS로 읽기 불가한 시트는 절대 URL로 `assets[]`(role='stylesheet')에 등록 — 서버 재작성 단계(아래 4)가 복제본을 `<style>`로 인라인하고, 복제 실패 시 해당 `<link>`를 **제거**한다(§9.4 CSP가 외부 스타일 로드를 차단하므로 남겨두면 열화가 아니라 파손).
3. 모든 `href/src/srcset/poster`·CSS `url()`을 절대 URL로 재작성(서버 복제·재작성 단계의 매칭 키).
4. 이미지는 확장에서 인라인하지 않는다(D4) — `assets[]`로 전달 → 서버가 media_assets로 복제하고, **media 스테이지 집계 종결 후 스냅샷 재작성 잡(§5.4·§5.5)이 stored 자산을 `data:` URI로 인라인**해 자기완결 문서로 만든다(서명 URL 경로 재작성은 TTL 1시간이라 불가; §9.4 CSP `img-src data: blob:`과 정합 — monolith 산출물과 동일한 성질). 복제 실패 자산은 참조를 제거하고 원본 URL을 `data-original-src` 속성으로만 보존한다(**의식적 결정: 미표시** — `img-src https:` 완화는 트래킹 픽셀 차단을 깨므로 기각). 인라인 후 크기는 snapshots 버킷 상한 50MB(§4)가 가드.
5. open shadow DOM·canvas는 1b 미지원(한계 명시 — Defuddle 계층이 보완).
6. **크기 가드**: 직렬화 결과가 §8.5 상한(`snapshot_html` 원문 3MB) 초과 → `snapshot_html` 생략, `snapshot_status:"too_large"`, 마크다운+assets만 전송. 서버는 공개 페이지에 한해 monolith 스냅샷 폴백. 전송은 항상 gzip(CompressionStream) — 압축 후는 §8.5의 바디 4MB 상한이 커버.
7. 스냅샷 뷰어의 무해화·샌드박스 렌더링은 웹앱 책임(§9.4). 확장은 `on*` 제거까지만.
8. 마크다운 계층: Defuddle(MIT) + Turndown(GFM) — Obsidian Web Clipper와 동일 스택. 메타 추출: title, og:*, article:published_time, canonical, favicon, lang.

일반 페이지 완결성: `meta.title` 필수 AND (`content_markdown` OR `snapshot_html`) 필수. 마크다운 200자 미만 + 스냅샷 존재 → warning `thin_extraction`.

### 10.6 오프라인·실패 재시도 큐 (background)

- 429/5xx/네트워크 실패 페이로드를 `chrome.storage.local`의 `pending_captures`에 저장(최대 50건). MV3 SW는 수면하므로 storage 영속 필수.
- 1MB 초과 페이로드는 `snapshot_html`을 떼고 마크다운만 큐잉(storage.local 10MB 한도 보호), `snapshot_status:"failed"` 강등.
- `chrome.alarms` 1분 주기 → 백오프(1·5·15·60분, 최대 5회) → 초과 시 `failed_captures` 이동, 배지 `!`, 팝업에서 수동 재시도/폐기.
- 멱등 키(`client_request_id`) 덕에 "전송됐는데 응답 유실"도 중복 생성 없음.
- 확장은 폴링하지 않는다(fire-and-forget) — 보완 결과는 웹앱의 '처리 중' UI가 담당.

### 10.7 Phase 1b 수용 기준 (확장 도메인)

1. x.com 상세·타임라인(우클릭)에서 텍스트+이미지+비디오 포스트가 complete로 저장되고, 서버에 미디어 원본 URL(orig/mp4)이 전달된다.
2. GraphQL 캐시 미스에서 DOM 폴백 저장 시 비디오 포스트가 partial로 표시되고 서버 폴백 경고가 팝업에 노출된다.
3. 페이월 페이지(로그인 상태)에서 마크다운+스냅샷 2계층이 저장되고 웹앱 상세뷰에서 열린다.
4. 오프라인 저장 → 온라인 복귀 후 자동 재전송되며 중복 항목이 생기지 않는다.
5. 토큰 폐기 후 저장 시도 시 조용한 실패 없이 재연결 화면이 뜬다.

---

## 11. 인증

### 11.1 웹앱 — Supabase Auth 단일 계정

- 이메일+비밀번호, **단일 계정**(시드로 1개 생성, 대시보드에서 신규 가입 비활성화). 소셜 로그인 없음.
- `@supabase/ssr` 쿠키 세션. `middleware.ts`가 `(app)` 페이지의 세션 갱신 + 미인증 시 `/login` 리다이렉트(matcher는 `/login`·`/api/*`·정적 자산 제외).
- API 라우트는 리다이렉트 대신 자체 헬퍼 `requireUser(req)`가 401 JSON 반환. 두 자격 수용: ① 쿠키 세션(RLS 자동 적용) ② `Authorization: Bearer <PAT>`(1b).
- **CSRF**: 쿠키 세션의 상태변경 요청(POST/PATCH/DELETE)은 `requireUser`가 **Origin 헤더 검증**(허용 오리진 불일치 시 403) — SameSite=Lax 위에 방어층 한 겹. PAT 경로는 쿠키가 없어 해당 없음.

### 11.2 확장 — 개인 액세스 토큰 (PAT)

MV3 SW에서 Supabase 세션 유지는 refresh 회전·custom storage adapter·수면 중 만료 처리를 확장이 떠안는 구조 — 단일 사용자 제품에서 살 이유가 없는 복잡도. **PAT 확정** (PRD §8은 양쪽 허용).

- **형식**: `akr_` + 32바이트 난수 base64url(~47자). 평문은 발급 시 1회만 노출, DB에는 SHA-256 해시만(`api_tokens`, §3.2).
- **발급**: 웹앱 설정 페이지(`POST /api/tokens`, 이름 부여).
- **저장**: 확장은 `chrome.storage.local`(sync 아님 — 비밀을 Google 계정 동기화에 태우지 않음). 팝업 설정 뷰에 붙여넣기 → `GET /api/me`로 즉시 검증 후 저장.
- **사용**: 서버는 해시 조회로 user_id 해석, `last_used_at` 갱신. PAT 경로는 Supabase Auth 세션이 없으므로 **service-role 클라이언트 + 해석된 user_id로 모든 쿼리를 명시 스코프**. RLS 우회 경로이므로 PAT 수용 라우트는 **인제스트 계열(`/api/ingest*`) + `GET /api/me`로 한정**.
- **갱신·폐기**: 자동 갱신 없음(장기 토큰). 유출 대응은 revoke(`revoked_at` 세팅 → 즉시 무효) + 재발급. 401 수신 시 확장은 배지 `!` + 재연결 화면.

---

## 12. Export / Import (PRD 수용 기준 5: 재임포트 가능)

### 12.1 Export

비동기 잡(`export_archive`)이 zip을 조립해 exports 버킷에 쓰고, exports 행으로 상태를 노출한다(설정 페이지 4초 폴링).

```
akashic-export-{YYYYMMDD-HHmm}.zip
├─ manifest.json                 # {format: "akashic-export", format_version: 1,
│                                #  exported_at, item_count, includes_embeddings: false}
├─ items.jsonl                   # 1행 = 항목 1건
├─ contents/{item_id}.md         # content_md (있는 항목만)
├─ snapshots/{item_id}.html
└─ media/{item_id}/{asset_id}.{ext}
```

`items.jsonl` 행 스키마 — DB의 논리적 전량, zip 내 파일을 상대경로로 참조:

```
{ id, type, status, source_url, canonical_url, title, summary, note, lang, metadata,
  saved_at, processed_at,
  tags: [{name, source}],
  content: {path: "contents/{id}.md", content_source} | null,
  snapshot: {path: "snapshots/{id}.html"} | null,
  media: [{id, kind, path, original_url, original_filename, mime_type, width, height, position}] }
```

- **임베딩 제외** — 모델 종속적이고 재생성 가능. 재임포트 시 `embed` 잡만 재실행(태그·요약은 파일에서 복원 — 사용자 자산이므로 AI 재실행으로 덮지 않는다).
- `format_version`으로 전방 호환. 마크다운·HTML·원본 미디어라는 열린 포맷 — 본 서비스 없이도 열람 가능(신뢰 서사, PRD §3).

**실행 모델** — 서버리스 제약(수 GB zip을 단일 함수 실행·메모리·tmp 안에서 조립 불가) 대응:

- `export_archive` 큐는 drain(§5.6)이 소비하지 않는다 — **전용 `POST /api/jobs/export`**(maxDuration 800s, Fluid Compute 상한 — §13.1)가 처리. 트리거는 `POST /api/export`의 `after()` 킥 + cron 백스톱(drain이 큐 잔량 발견 시 재킥).
- zip을 메모리/tmp에 통째로 만들지 않는다 — 항목 단위로 zip 스트림을 exports 버킷에 **resumable upload(TUS)** 로 이어쓴다(미디어·스냅샷은 Storage에서 스트리밍 통과 — 함수 메모리에 전체 적재 없음).
- `exports.progress`(jsonb: `{last_item_id, upload_url}`)에 **항목 단위 체크포인트** — 시간 예산(~700s) 소진 시 체크포인트 기록 후 self re-kick으로 이어서 재개. 크래시·vt 만료로 메시지가 재출현해도 체크포인트부터 재개 — "처음부터 재시작하는 무한 루프"가 구조적으로 없다.
- 처리 중 주기적 `pgmq.set_vt` 연장으로 vt(600s) 만료에 의한 이중 실행을 차단(§5.6의 vt 규율과 동일).

### 12.2 Import (재임포트)

Phase 1은 **service-role CLI 스크립트**(`scripts/import.ts`)로 제공한다 — 단일 사용자의 복구·이전 시나리오는 운영자 작업이므로 전용 API·큐·UI를 만들지 않는다(승격 경로는 §1.4).

```
scripts/import.ts <export.zip 경로> --user <user_id>
```

1. `manifest.json`의 `format`·`format_version` 검증(미지원 버전은 즉시 중단).
2. `items.jsonl` 순회 — **항목 `id`(uuid) 기준 upsert**: items(`saved_at` 보존) · item_contents(contents/*.md → content_md, content_source 보존) · tags(name 기준 find-or-create) · item_tags(source 보존).
3. 미디어·스냅샷: zip 상대경로 → §4의 동일 Storage 경로 규칙으로 업로드(동일 경로 객체 존재 시 스킵 — 멱등), media_assets 행 upsert(status='stored'), item_contents.snapshot_path 복원.
4. **`embed`만 재큐잉**(pgmq.send). item_jobs는 `ingest/snapshot/media/enrich='skipped'` + `embed='pending'` 씨드 — 태그·요약을 AI 재실행으로 덮지 않는다.
5. 종료 시 대사(對査) 출력: 항목·콘텐츠·미디어 파일 수 일치 확인. **같은 zip 재실행 = 무변경, 부분 실패 후 재실행 = 안전** — 수용 기준 5의 멱등성을 이 스크립트로 검증한다(§14-8).

---

## 13. 배포 구성

### 13.1 Vercel (Next.js 앱 + API + 워커)

- 단일 Next.js 리포·단일 배포. `/api/jobs/drain`은 `maxDuration` 300s, `/api/jobs/export`는 `maxDuration` 800s(둘 다 Fluid Compute — export 스트리밍 조립 전용 분리는 §12.1).
- monolith CLI 바이너리를 함수 번들에 포함(프로세스 spawn — AGPL 격리 호출 요건 충족).
- 환경변수: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `AI_ENRICH_MODEL`, `AI_EMBED_MODEL`, `AI_EMBED_DIM`(=1536), LLM 프로바이더 API 키, 선택 `CAPTION_PROXY_URL`.

### 13.2 Supabase

- 확장 활성: `vector`, `pg_trgm`, `moddatetime`, `pgmq`, `pg_cron`, `pg_net`.
- 마이그레이션: Supabase CLI(`supabase/migrations/`)로 §3 DDL + RLS + `save_item`(security definer — §5.1)·`search_items`·`job_delay` 함수 + items.status 파생 트리거 관리.
- Cron: pg_cron 1분 주기 → pg_net으로 `POST {APP_URL}/api/jobs/drain` (`x-cron-secret` 헤더). **CRON_SECRET을 마이그레이션 SQL에 평문으로 넣지 않는다** — Supabase Vault에 저장 후 잡 정의에서 `vault.decrypted_secrets` 참조(또는 대시보드에서 잡 수동 생성). 리포에 비밀이 커밋되는 경로를 차단.
- Storage: §4의 4버킷 생성 + Storage RLS 정책.
- Auth: 이메일 가입 비활성화, 계정 1개 시드.

### 13.3 백업

Supabase 자동 백업은 DB만 커버 — Storage(미디어)는 별도. Phase 1은 주기적 export 실행으로 갈음할지, rclone/S3 sync 크론을 둘지 미정(§15). PRD 리스크 표의 "정기 자동 백업(미디어 포함)"이 서사의 전제 조건이므로 구현 착수 전 확정 필요.

---

## 14. 구현 순서 제안

Phase 1a (각 단계는 배포 가능한 수직 슬라이스):

1. **기반**: Supabase 프로젝트 + §3 스키마 마이그레이션 + RLS + 버킷 + 확장 활성. Next.js 셸 + 인증(로그인·미들웨어·단일 계정 시드).
2. **저장 골격**: `detectSource` + `POST /api/ingest`(kind=url) + `save_item` RPC + `/api/jobs/drain` 골격 + Supabase Cron. URL 저장 → processing 카드가 그리드에 뜨는 것까지.
3. **article 어댑터**: Defuddle 본문 추출 + monolith 스냅샷 + 그리드/상세 뷰 최소 구현 + 상태 폴링. "일반 웹페이지가 2계층으로 남는다" 검증.
4. **AI 파이프라인**: ai_enrich + embed + 태그·요약 표시 + item_jobs 칩·재시도. 기존 태그 주입 확인.
5. **나머지 어댑터**: youtube(메타+자막 best-effort) → music(Odesli) → social_post(oEmbed/FxTwitter) + media_replicate(썸네일 역정규화 포함). 수용 기준 1의 6종 저장 충족.
6. **검색**: `search_items` RPC + `GET /api/search`(FTS 단독 폴백 포함) + 검색 UI. 한국어 질의 실측(수용 기준 2).
7. **업로드·상세 뷰 완성**: kind=file 서명 URL 플로우(+미완료 업로드 만료 스위프) + 이미지 비전 처리 + 유형별 상세 뷰 6종 + 스냅샷 iframe 격리.
8. **Export/Import**: export 스트리밍 워커(§12.1, 전용 엔드포인트·체크포인트) + 설정 페이지 + `scripts/import.ts`(§12.2) + **왕복 검증**: export → 빈 프로젝트에 import → 재export 대사 + 같은 zip 2회 import 무변경 확인(수용 기준 5).

Phase 1b:

9. **PAT**: api_tokens + `/api/tokens` + `GET /api/me` + `requireUser` PAT 분기.
10. **확장 — X 캡처**: WXT 골격 + XHR 인터셉터 + DOM 폴백 + 완결성 검증 + kind=capture 서버 병합 로직 + 재시도 큐.
11. **확장 — 일반 페이지**: page-capture(Defuddle+Turndown+자체 스냅샷) + 서버 자산 복제·스냅샷 인라인 재작성(§5.4·§10.5).
12. (이후) LinkedIn 캡처 — X 캡처 안정화 후(PRD §9).

---

## 15. 미해결 질문

**결정 필요 (구현 착수 전)**

1. **임베딩 모델 확정**: gemini-embedding-001(1536 절단, 한국어 우위, $0.15/1M) vs text-embedding-3-small(1536, $0.02/1M). 스키마는 1536 고정으로 양쪽 호환이나 교체 시 전량 재임베딩 — 한국어 비중 고려 시 gemini 우선이 리서치 결론.
2. **워커 런타임 편차 승인**: PRD §8은 "Edge Function/cron 트리거" 스케치이나 monolith(Deno 서브프로세스 불가)·Defuddle+JSDOM(Node 전용) 제약으로 전 워커를 Vercel Node 단일 런타임으로 제안(§5.6). 거부 시 대안: snapshot/ingest만 Vercel, 나머지 Edge Function 이원 운용.
3. **동일 URL 재저장 정책 확인**: (user_id, canonical_url) UNIQUE + "재저장 = 기존 항목 재캡처(saved_at 유지)"가 기본. "같은 글을 다른 시점 스냅샷으로 두 번 저장"을 허용하려면 unique 제거 + UX 재설계 필요.
4. **X 폴백 병행 호출 해석 확인**: PRD의 "oEmbed → FxTwitter"를 순차가 아닌 신뢰 순위로 해석해 병행 호출(텍스트=oEmbed, 미디어=FxTwitter)로 설계함.
5. **미디어 스토리지 백업 방식**: 주기적 export로 갈음 vs rclone/S3 sync 크론(§13.3).
6. **파일 크기 상한 확정**: snapshots 50MB / media 200MB(X 이미지 25MB·비디오 300MB 다운로드 상한 포함) / uploads 500MB / exports 5GB는 제안값 — 스토리지 비용 상한 정책(PRD 리스크 표)과 직결.

**구현 중 결정 가능**

7. 태그 하이픈 연결(machine-learning) 강제 여부 — enrich 프롬프트 설계와 함께 확정.
8. exports zip 보관 기간(TTL)·자동 정리 정책 — 미정리 시 export 반복 실행으로 스토리지 이중 점유.
9. PGroonga 도입 시점 — tsvector(simple)+pg_trgm으로 시작, 한국어 리콜 불만 실측 시 도입.
10. 유튜브 자막 서버 확보 기대 수준 — best-effort(차단 시 '자막 미확보' 종결)로 설계. residential proxy(`CAPTION_PROXY_URL`) 도입 여부/시점, PRD 수용 기준 1의 유튜브 항목이 "메타+썸네일만 복원"도 충족으로 보는지.
11. 일반 파일(PDF 등) 텍스트 추출 Phase 1a 제외(파일명·mime 태깅만) 확인.
12. FxTwitter 공용 api.fxtwitter.com 의존 vs 셀프호스트 — 확장의 missing_fields 설계가 폴백 커버리지(특히 video URL)를 전제.

**Phase 1b 착수 전 결정**

13. YouTube 자막 확장 캡처의 Phase 위치 — PRD §5는 확장 캡처를 유튜브 확보 1순위로 명시하나 Phase 1b 목록에 없음. 서버 폴백은 proxy 비용 전제라 확장 캡처가 실질 1순위 — 1b 포함 vs Phase 2.
14. 타임라인 인라인 저장 버튼 — 우클릭 메뉴로 시작(셀렉터 파손 표면적 최소화), 본인 사용 경험 후 재검토 vs 처음부터 주입.
15. 서버가 미디어 다운로드에 실패하는 경우(보호 계정 등)의 확장 직접 업로드 폴백 — 1b 미구현 + media 불완전 플래그로 두는 안.
16. 스냅샷 자산 복제 범위 — assets[] 전체 vs og_image+본문 이미지만(나머지 절대 URL 보존은 §10.5 미표시 정책과 함께 판단) — 스토리지 비용 vs 보존 충실도.
17. PAT의 chrome.storage.sync 동기화 여부 — local 결정(비밀의 클라우드 동기화 회피) vs 다기기 편의.
18. 422(스키마 버전 스큐) 시 서버가 관용 수용(알 수 없는 필드 무시+경고) vs 엄격 거부.
19. zod 스키마 웹앱-확장 공유 방식 — 모노레포(패키지) vs 별도 저장소(파일 복사).

**상위 문서 갱신 기록**

20. PRD §5의 "확장(SingleFile…)" 문구는 확장 결정 D3(자체 경량 구현)와 표면 불일치 — 설계는 PRD §8(AGPL 격리 원칙)을 따르므로 설계 변경은 없으나, **PRD §5 문구 갱신 필요**를 기록해 상위 문서와의 표면 불일치를 남기지 않는다.

---

## 부록. 통합 시 조정된 사항

도메인 설계 간 충돌을 아래와 같이 해소했다(각 1줄):

1. `items.status` 통일: API 도메인의 `pending` 제거(processing에 흡수 — 세부 단계는 item_jobs가 제공), 파이프라인의 `partial` 채택 → `processing/partial/ready/failed`.
2. 유형 컬럼 통일: 데이터 모델 기준 `items.type ∈ {article, social_post, youtube, music, image, file}` — 파이프라인의 source_type/content_type 이원 축, API의 `web|x` 값, 확장의 `x_post/web_page`는 type+`metadata.platform` 매핑으로 흡수(x_post→social_post, web_page→article).
3. 잡 큐 이름 통일: `ingest, snapshot, media_replicate, ai_enrich, embed, export_archive` — content_fetch/ingest_fetch/export_bundle 명명 폐기, 데이터 모델의 단일 ai_enrich(tasks) 대신 파이프라인의 enrich/embed 분리 채택.
4. `storage_cleanup` 큐 제거 — 항목 삭제는 데이터 모델 방식(서버 처리 내 DB delete + Storage prefix 제거 2단계, 고아 파일은 개인 규모에서 수용).
5. `item_contents` 구조: 파이프라인의 kind별 다행(body_markdown/snapshot_html/transcript/ocr/source_raw) 대신 데이터 모델의 1:1 단일 행 채택 — transcript/ocr은 content_md로 수렴, 원본 API 응답은 `source_raw jsonb` 컬럼 추가로 흡수.
6. `item_tags` 컬럼명: 파이프라인의 `origin` → 데이터 모델의 `source`로 통일.
7. `media_assets.status`: 파이프라인의 `replicated` → 데이터 모델의 `stored`로 통일, 파이프라인 요구인 `sha256` 컬럼은 추가.
8. 인제스트 엔드포인트 통일: 확장의 `POST /api/v1/ingest`·`GET /api/v1/me` → `POST /api/ingest`·`GET /api/me` — API 도메인의 kind 태그드 유니언에 확장의 capture 스키마(capture_status/missing_fields)를 병합.
9. 확장 스냅샷 전송: API 도메인의 서명 URL 선언 방식 대신 확장 도메인의 인라인 gzip(원문 ≤3MB — §8.5 표, 초과 시 too_large 강등) 채택 — 서명 URL 2단계는 kind=file(웹앱 업로드) 전용.
10. 검색 함수: API의 `hybrid_search(p_user_id, …)` → 데이터 모델의 `search_items` 채택 — security invoker + RLS로 p_user_id 파라미터 제거, 차원은 1536 확정.
11. 처리 상태 UI: 파이프라인의 Supabase Realtime 구독 대신 API 도메인의 폴링(4초 조건부) 채택 — Realtime은 멀티유저 전환 시 교체 경로로만 명시.
12. canonical URL 형태: 파이프라인 규칙 채택 — X는 `x.com/i/status/{id}`(핸들 변경에 안전), 유튜브는 `www.youtube.com/watch?v={id}`.
13. 미디어 복제 실패 시 상태: 데이터 모델의 "ready 유지 + 배지" 대신 파이프라인의 `partial` 채택(item_jobs media 스테이지 집계).
14. `items`에 `note`(API 요구), `client_request_id`+부분 유니크 인덱스(확장 멱등 키), `embedding_model`(파이프라인 요구) 컬럼 추가.
15. 재시도·재처리 API 통합: 파이프라인의 `retry {stages?}`와 API의 `reprocess`를 `POST /api/items/:id/retry {stages?}` 하나로 단일화.
16. 실패 사유 컬럼: API의 `failure_reason` → 데이터 모델의 `items.error`로 통일.
17. 페이지네이션 커서: API의 `created_at,id` → `saved_at,id`(라이브러리 정렬축·재임포트 시각 보존과 일치).
18. 중복 저장 응답 통일: `action ∈ {created, updated, duplicate}` — URL 재저장은 기존 항목 재캡처(updated), 확장 재캡처는 폴백 저장 승격 병합, 멱등 키 재수신은 duplicate.
19. 스토리지: 파이프라인의 단일 `archive` 버킷 대신 데이터 모델의 4버킷(snapshots/media/uploads/exports) 채택.
20. 유형별 표시 필드: 파이프라인이 요구한 items 실컬럼(author_name/site_name/published_at/source_meta) 대신 데이터 모델의 metadata JSONB 계약 유지("컬럼은 쿼리용, JSONB는 표시용" 경계).
21. 검색 가시성: 데이터 모델의 "processing 항목은 검색 제외" 대신 API·파이프라인의 점진적 색인(FTS는 본문 저장 즉시 노출) 채택.
22. `exports.status`: API의 pending 포함 4값 → 데이터 모델의 `processing/ready/failed` 3값으로 통일.
23. capture_method 값: 데이터 모델의 `extension_dom` 단일 값에 확장의 XHR 경로를 반영해 `extension_xhr` 추가(item_contents.content_source CHECK에도 동일 반영 — §3.2).

---

## 반영하지 않은 제안

없음 — 리뷰 suggestions 12건 전부 타당하여 반영했다. 양자택일형 제안에서의 선택만 기록한다:

- **그리드 썸네일 소스 모순**: 원칙 5 문구 완화 대신 `items.metadata.thumbnail_path` 역정규화 채택(§5.4) — "목록 쿼리는 items만 스캔" 원칙을 그대로 유지하는 쪽이 구현·성능 양면에서 우세.
- **XCapture의 metrics·card**: metadata 계약에 키를 추가하는 대신 페이로드에서 제거(§10.4) — §9.5 상세 뷰에 렌더링 목적지가 없고, 캡처 시점 지표는 즉시 낡는 값이라 보존 가치도 낮음(YAGNI). 필요해지면 metadata 키 추가로 대응.
- (mustFix 항목이지만 선택 기록) **스냅샷 복제 실패 자산**: `img-src https:` 완화 대신 '미표시' 채택(§10.5) — 외부 요청 전면 차단(트래킹 픽셀 차단)이라는 §9.4 CSP의 성질을 보존. 원본 URL은 `data-original-src`로 남겨 정보 손실은 없음.
