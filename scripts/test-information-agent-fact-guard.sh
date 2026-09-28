#!/usr/bin/env bash
set -euo pipefail

for command_name in initdb pg_ctl psql; do
  command -v "$command_name" >/dev/null || {
    printf 'Missing local PostgreSQL command: %s\n' "$command_name" >&2
    exit 1
  }
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
db_dir="$(mktemp -d "${TMPDIR:-/tmp}/immojudis-agent-db.XXXXXX")"
port=55439
cleanup() {
  pg_ctl -D "$db_dir" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$db_dir"
}
trap cleanup EXIT

initdb -D "$db_dir" -A trust -U postgres >/dev/null
# mmap avoids requiring a system-wide shared-memory segment on macOS sandboxes.
pg_ctl -D "$db_dir" -o "-k $db_dir -p $port -h '' -c shared_memory_type=mmap -c dynamic_shared_memory_type=mmap" -l "$db_dir/server.log" start >/dev/null

psql -h "$db_dir" -p "$port" -U postgres -d postgres -v ON_ERROR_STOP=1 -q <<'SQL'
create schema app_private;
create table public.information_agent_cases (
  id uuid primary key, sale_id uuid not null, status text not null default 'replied'
);
create table public.information_agent_messages (id uuid primary key, case_id uuid);
create table public.information_agent_evidence_assets (
  id uuid primary key, case_id uuid not null, message_id uuid not null, sale_id uuid not null,
  rights_status text not null default 'unverified',
  review_status text not null default 'pending',
  metadata jsonb not null default '{}'::jsonb
);
create table public.information_agent_evidence_extractions (
  asset_id uuid primary key, case_id uuid not null, message_id uuid not null, sale_id uuid not null,
  status text not null
);
create table public.information_agent_fact_candidates (
  id uuid primary key, case_id uuid not null, message_id uuid not null, sale_id uuid not null,
  evidence_asset_id uuid, status text not null, fact_key text not null, proposed_value jsonb not null,
  display_value text not null default 'attachment', source_page integer default 1,
  metadata jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now(),
  unique (message_id, fact_key, display_value)
);
create function public.review_information_agent_fact_candidate(
  p_reviewer_id uuid, p_fact_id uuid, p_decision text, p_notes text
) returns jsonb language plpgsql as $$
begin
  update public.information_agent_fact_candidates
  set status = p_decision
  where id = p_fact_id;
  return jsonb_build_object('fact_id', p_fact_id, 'status', p_decision);
end;
$$;
create role anon;
create role authenticated;
create role service_role;
SQL

psql -h "$db_dir" -p "$port" -U postgres -d postgres -v ON_ERROR_STOP=1 -q \
  -f "$repo_root/supabase/migrations/20260923131500_guard_information_agent_fact_associations.sql"

psql -h "$db_dir" -p "$port" -U postgres -d postgres -v ON_ERROR_STOP=1 -q <<'SQL'
insert into information_agent_cases (id, sale_id, status) values
('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','replied'),
('22222222-2222-4222-8222-222222222222','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','completed');
insert into information_agent_messages values
('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111'),
('44444444-4444-4444-8444-444444444444','22222222-2222-4222-8222-222222222222');
insert into information_agent_evidence_assets
  (id, case_id, message_id, sale_id, rights_status) values
('55555555-5555-4555-8555-555555555555','11111111-1111-4111-8111-111111111111',
 '33333333-3333-4333-8333-333333333333','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'unverified');
insert into information_agent_evidence_extractions values
('55555555-5555-4555-8555-555555555555','11111111-1111-4111-8111-111111111111',
 '33333333-3333-4333-8333-333333333333','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','processing');
insert into information_agent_fact_candidates
  (id, case_id, message_id, sale_id, evidence_asset_id, status, fact_key, proposed_value)
values
('66666666-6666-4666-8666-666666666666','11111111-1111-4111-8111-111111111111',
 '33333333-3333-4333-8333-333333333333','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 '55555555-5555-4555-8555-555555555555','pending','document',
 '{"public_url":"https://example.supabase.co/storage/v1/object/public/information-agent-approved/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/55555555-5555-4555-8555-555555555555/document.pdf", "public_path":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/55555555-5555-4555-8555-555555555555/document.pdf"}');

-- Receiving a piece creates its candidate before the extraction worker has run.
insert into information_agent_evidence_assets
  (id, case_id, message_id, sale_id, rights_status) values
('99999999-9999-4999-8999-999999999999','11111111-1111-4111-8111-111111111111',
 '33333333-3333-4333-8333-333333333333','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'authorized');
insert into information_agent_fact_candidates
  (id, case_id, message_id, sale_id, evidence_asset_id, status, fact_key, proposed_value)
values
('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111',
 '33333333-3333-4333-8333-333333333333','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 '99999999-9999-4999-8999-999999999999','pending','document',
 '{"public_url":"https://example.supabase.co/storage/v1/object/public/information-agent-approved/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/99999999-9999-4999-8999-999999999999/document.pdf", "public_path":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/99999999-9999-4999-8999-999999999999/document.pdf"}');

insert into information_agent_fact_candidates
  (id, case_id, message_id, sale_id, evidence_asset_id, status, fact_key, proposed_value, display_value, source_page)
values
('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','11111111-1111-4111-8111-111111111111',
 '33333333-3333-4333-8333-333333333333','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 null,'pending','surface_m2','{"value":"87"}','87 m2',null);

do $test$
begin
  begin
    insert into information_agent_fact_candidates
      (id, case_id, message_id, sale_id, evidence_asset_id, status, fact_key, proposed_value, display_value, source_page)
    values
    ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','11111111-1111-4111-8111-111111111111',
     '33333333-3333-4333-8333-333333333333','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
     null,'pending','surface_m2','{"value":"87"}','87 m2',null);
    raise exception 'text candidate replay unexpectedly succeeded';
  exception when sqlstate '23505' then null;
  end;

  begin
    update information_agent_fact_candidates set status='accepted'
    where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    raise exception 'acceptance without an extraction unexpectedly succeeded';
  exception when sqlstate '55000' then null;
  end;

  begin
    insert into information_agent_fact_candidates
      (id, case_id, message_id, sale_id, evidence_asset_id, status, fact_key, proposed_value)
    values
    ('77777777-7777-4777-8777-777777777777','11111111-1111-4111-8111-111111111111',
     '33333333-3333-4333-8333-333333333333','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
     null,'pending','surface_m2','{"value":"87"}');
    raise exception 'cross-sale insert unexpectedly succeeded';
  exception when sqlstate '23514' then null;
  end;

  begin
    insert into information_agent_fact_candidates
      (id, case_id, message_id, sale_id, evidence_asset_id, status, fact_key, proposed_value)
    values
    ('88888888-8888-4888-8888-888888888888','22222222-2222-4222-8222-222222222222',
     '44444444-4444-4444-8444-444444444444','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
     '55555555-5555-4555-8555-555555555555','pending','surface_m2','{"value":"87"}');
    raise exception 'cross-case evidence asset insert unexpectedly succeeded';
  exception when sqlstate '23514' then null;
  end;

  begin
    update information_agent_fact_candidates set status='accepted'
    where id='66666666-6666-4666-8666-666666666666';
    raise exception 'unauthorized attachment acceptance unexpectedly succeeded';
  exception when sqlstate '55000' then null;
  end;

  update information_agent_evidence_assets set rights_status='authorized'
  where id='55555555-5555-4555-8555-555555555555';

  update information_agent_evidence_assets
  set metadata='{"approved_public_path":"staged/path.pdf"}'
  where id='55555555-5555-4555-8555-555555555555';
  begin
    update information_agent_evidence_assets
    set rights_status='restricted', metadata='{}'
    where id='55555555-5555-4555-8555-555555555555';
    raise exception 'staged evidence rights restriction unexpectedly succeeded';
  exception when sqlstate '55000' then null;
  end;
  update information_agent_evidence_assets set metadata='{}'
  where id='55555555-5555-4555-8555-555555555555';

  begin
    update information_agent_fact_candidates set status='accepted'
    where id='66666666-6666-4666-8666-666666666666';
    raise exception 'premature acceptance unexpectedly succeeded';
  exception when sqlstate '55000' then null;
  end;

  begin
    update information_agent_evidence_extractions
    set sale_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    where asset_id='55555555-5555-4555-8555-555555555555';
    raise exception 'cross-sale extraction mutation unexpectedly succeeded';
  exception when sqlstate '23514' then null;
  end;
  begin
    update information_agent_evidence_assets
    set sale_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    where id='55555555-5555-4555-8555-555555555555';
    raise exception 'cross-sale asset mutation unexpectedly succeeded';
  exception when sqlstate '23514' then null;
  end;

  update information_agent_evidence_extractions
  set status='completed'
  where asset_id='55555555-5555-4555-8555-555555555555';
  update information_agent_fact_candidates set proposed_value='{"public_url":"https://example.supabase.co/storage/v1/object/public/other-bucket/file.pdf", "public_path":"wrong/file.pdf"}'
  where id='66666666-6666-4666-8666-666666666666';
  begin
    update information_agent_fact_candidates set status='accepted'
    where id='66666666-6666-4666-8666-666666666666';
    raise exception 'unstaged attachment acceptance unexpectedly succeeded';
  exception when sqlstate '55000' then null;
  end;

  update information_agent_fact_candidates set proposed_value='{"public_url":"https://example.supabase.co/storage/v1/object/public/information-agent-approved/another/path.pdf", "public_path":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/55555555-5555-4555-8555-555555555555/document.pdf"}'
  where id='66666666-6666-4666-8666-666666666666';
  begin
    update information_agent_fact_candidates set status='accepted'
    where id='66666666-6666-4666-8666-666666666666';
    raise exception 'mismatched public URL and path unexpectedly passed';
  exception when sqlstate '55000' then null;
  end;

  update information_agent_fact_candidates set proposed_value='{"public_url":"https://example.supabase.co/storage/v1/object/public/information-agent-approved/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/55555555-5555-4555-8555-555555555555/document.pdf", "public_path":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/55555555-5555-4555-8555-555555555555/document.pdf"}'
  where id='66666666-6666-4666-8666-666666666666';
  begin
    perform public.review_information_agent_fact_candidate_with_path(
      null,
      '66666666-6666-4666-8666-666666666666',
      'accepted', null, 'wrong/path.pdf'
    );
    raise exception 'wrong staged path unexpectedly passed review';
  exception when sqlstate '55000' then null;
  end;
  perform public.review_information_agent_fact_candidate_with_path(
    null,
    '66666666-6666-4666-8666-666666666666',
    'accepted', null,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/55555555-5555-4555-8555-555555555555/document.pdf'
  );
  if (select status from information_agent_fact_candidates
      where id='66666666-6666-4666-8666-666666666666') <> 'accepted' then
    raise exception 'completed attachment acceptance failed';
  end if;
  update information_agent_evidence_assets set review_status='accepted'
  where id='55555555-5555-4555-8555-555555555555';
  begin
    update information_agent_evidence_assets set rights_status='restricted'
    where id='55555555-5555-4555-8555-555555555555';
    raise exception 'accepted evidence rights restriction unexpectedly succeeded';
  exception when sqlstate '55000' then null;
  end;
  if public.abort_information_agent_evidence_publication(
      '66666666-6666-4666-8666-666666666666',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/55555555-5555-4555-8555-555555555555/document.pdf'
    ) then
    raise exception 'abort allowed deletion of accepted attachment';
  end if;
  if not public.abort_information_agent_evidence_publication(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/99999999-9999-4999-8999-999999999999/document.pdf'
    ) then
    raise exception 'abort rejected an unreviewed attachment';
  end if;
  if (select proposed_value ? 'public_path' from information_agent_fact_candidates
      where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') then
    raise exception 'abort left stale staged path on candidate';
  end if;

  update information_agent_cases set status='completed'
  where id='11111111-1111-4111-8111-111111111111';
  if (select count(*) from information_agent_fact_candidates
      where case_id='11111111-1111-4111-8111-111111111111'
        and status in ('pending', 'conflict')) <> 0 then
    raise exception 'case closure left unresolved candidates';
  end if;
  if (select metadata->>'automatically_rejected_case_status'
      from information_agent_fact_candidates
      where id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') <> 'completed' then
    raise exception 'case closure did not record candidate rejection';
  end if;
  if (select status from information_agent_fact_candidates
      where id='66666666-6666-4666-8666-666666666666') <> 'accepted' then
    raise exception 'case closure rewrote already accepted evidence';
  end if;

  begin
    insert into information_agent_fact_candidates
      (id, case_id, message_id, sale_id, status, fact_key, proposed_value, display_value, source_page)
    values
    ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','11111111-1111-4111-8111-111111111111',
     '33333333-3333-4333-8333-333333333333','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
     'pending','rooms_count','{"value":3}','3 rooms',null);
    raise exception 'closed-case candidate insert unexpectedly succeeded';
  exception when sqlstate '55000' then null;
  end;
  begin
    update information_agent_fact_candidates set status='accepted'
    where id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    raise exception 'closed-case text acceptance unexpectedly succeeded';
  exception when sqlstate '55000' then null;
  end;
  begin
    update information_agent_fact_candidates set status='accepted'
    where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    raise exception 'closed-case attachment acceptance unexpectedly succeeded';
  exception when sqlstate '55000' then null;
  end;
end
$test$;
SQL

printf 'Information-agent SQL association guard: verified on disposable PostgreSQL.\n'
