-- 아카식 레코드 — pgmq 잡 큐 (DESIGN §5.6)
select pgmq.create('ingest');
select pgmq.create('snapshot');
select pgmq.create('media_replicate');
select pgmq.create('ai_enrich');
select pgmq.create('embed');
select pgmq.create('export_archive');
