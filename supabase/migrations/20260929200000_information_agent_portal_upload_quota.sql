begin;

-- A signed Storage upload URL can be used before /submit records an asset.
-- Keep every reservation in the database so repeated bearer-link requests
-- cannot accumulate unbounded private objects for one shared case. A signed
-- URL consumes the bucket's full 40 MiB capacity permanently; an abandoned
-- object is therefore still bounded before asynchronous cleanup runs.
create table if not exists public.information_agent_portal_upload_reservations (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.information_agent_cases(id) on delete cascade,
  storage_path text not null unique,
  -- size_bytes is the quota charge, not the caller's declared file size.
  size_bytes bigint not null check (size_bytes between 1 and 41943040),
  requested_size_bytes bigint not null check (requested_size_bytes between 1 and 20971520),
  status text not null default 'reserved' check (status in ('reserved', 'consumed', 'released')),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint information_agent_portal_upload_reservations_consumed_at_check
    check ((status = 'consumed') = (consumed_at is not null))
);

create index if not exists information_agent_portal_upload_reservations_active_idx
  on public.information_agent_portal_upload_reservations (case_id, expires_at)
  where status = 'reserved';

alter table public.information_agent_portal_upload_reservations enable row level security;
revoke all on table public.information_agent_portal_upload_reservations from public, anon, authenticated;
grant select, insert, update, delete on table public.information_agent_portal_upload_reservations
  to service_role;

-- Keep already persisted portal assets idempotent across the migration. The
-- wider column check accepts the historical 40 MiB evidence bound; new signed
-- reservations are charged at the full 40 MiB bucket limit below.
insert into public.information_agent_portal_upload_reservations (
  case_id,
  storage_path,
  size_bytes,
  requested_size_bytes,
  status,
  expires_at,
  consumed_at,
  created_at
)
select
  asset.case_id,
  asset.storage_path,
  asset.size_bytes,
  least(asset.size_bytes, 20971520),
  'consumed',
  asset.created_at,
  asset.created_at,
  asset.created_at
from public.information_agent_evidence_assets asset
where asset.storage_bucket = 'information-agent-evidence'
  and asset.storage_path ~ ('^' || asset.case_id::text || '/portal/[0-9a-f-]{36}/[^/]+$')
on conflict (storage_path) do nothing;

-- Return the post-reservation counters so the API can expose them to the
-- contribution form without another race-prone read.
create or replace function public.reserve_information_agent_portal_upload(
  p_case_id uuid,
  p_storage_path text,
  p_size_bytes bigint,
  p_expires_at timestamptz
)
returns table (
  used_bytes bigint,
  used_files bigint,
  remaining_bytes bigint,
  remaining_files bigint
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_max_bytes constant bigint := 503316480;
  v_max_files constant bigint := 12;
  v_storage_object_bytes constant bigint := 41943040;
  v_case_exists boolean;
  v_used_bytes bigint;
  v_used_files bigint;
  v_reserved_bytes bigint;
  v_reserved_files bigint;
begin
  if p_case_id is null
     or p_storage_path is null
     or p_size_bytes is null
     or p_expires_at is null
     or p_size_bytes < 1
     or p_size_bytes > 20971520
     or p_expires_at <= v_now
     or p_expires_at > v_now + interval '2 hours'
     or p_storage_path !~ ('^' || p_case_id::text || '/portal/[0-9a-f-]{36}/[^/]+$') then
    raise exception using
      errcode = '22023',
      message = 'Invalid information-agent portal upload reservation.';
  end if;

  -- All counters for a case move under one transaction-level lock. This
  -- prevents concurrent prepare calls from observing the same free space.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('immojudis:information-agent:portal-quota:' || p_case_id::text, 0)
  );

  select exists (
    select 1
    from public.information_agent_cases shared_case
    where shared_case.id = p_case_id
  )
  into v_case_exists;
  if not v_case_exists then
    raise exception using
      errcode = 'P0002',
      message = 'Information-agent case not found.';
  end if;

  -- Count each signed reservation once, regardless of whether its object has
  -- already been submitted. This closes the abandoned-upload gap: an expired
  -- URL cannot reopen quota while its private object is waiting for cleanup.
  select
    coalesce(sum(reservation.size_bytes), 0)::bigint,
    count(*)::bigint
  into v_reserved_bytes, v_reserved_files
  from public.information_agent_portal_upload_reservations reservation
  where reservation.case_id = p_case_id
    and reservation.status in ('reserved', 'consumed');

  v_used_bytes := v_reserved_bytes;
  v_used_files := v_reserved_files;

  if v_used_bytes + v_storage_object_bytes > v_max_bytes
     or v_used_files + 1 > v_max_files then
    raise exception using
      errcode = '54000',
      message = 'INFORMATION_AGENT_PORTAL_QUOTA_EXCEEDED';
  end if;

  insert into public.information_agent_portal_upload_reservations (
    case_id,
    storage_path,
    size_bytes,
    requested_size_bytes,
    expires_at
  ) values (
    p_case_id,
    p_storage_path,
    v_storage_object_bytes,
    p_size_bytes,
    p_expires_at
  );

  used_bytes := v_used_bytes + v_storage_object_bytes;
  used_files := v_used_files + 1;
  remaining_bytes := v_max_bytes - used_bytes;
  remaining_files := v_max_files - used_files;
  return next;
end;
$$;

revoke all on function public.reserve_information_agent_portal_upload(uuid, text, bigint, timestamptz)
  from public, anon, authenticated;
grant execute on function public.reserve_information_agent_portal_upload(uuid, text, bigint, timestamptz)
  to service_role;

-- Mark a validated object as consumed. The operation is intentionally
-- idempotent: a browser retry after a successful first submission may reuse
-- the same path and the unique asset path check will reconcile it safely.
create or replace function public.consume_information_agent_portal_upload(
  p_case_id uuid,
  p_storage_path text,
  p_size_bytes bigint
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_reservation public.information_agent_portal_upload_reservations%rowtype;
  v_asset_case_id uuid;
  v_asset_size bigint;
begin
  if p_case_id is null
     or p_storage_path is null
     or p_size_bytes is null
     or p_size_bytes < 1
     or p_size_bytes > 20971520 then
    raise exception using
      errcode = '22023',
      message = 'Invalid information-agent portal upload.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('immojudis:information-agent:portal-quota:' || p_case_id::text, 0)
  );

  select *
  into v_reservation
  from public.information_agent_portal_upload_reservations reservation
  where reservation.case_id = p_case_id
    and reservation.storage_path = p_storage_path
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Information-agent portal upload reservation not found.';
  end if;

  if v_reservation.requested_size_bytes <> p_size_bytes then
    raise exception using
      errcode = '23514',
      message = 'Information-agent portal upload size mismatch.';
  end if;

  if v_reservation.status = 'released'
     or (v_reservation.status = 'reserved' and v_reservation.expires_at <= v_now) then
    raise exception using
      errcode = '22023',
      message = 'Information-agent portal upload reservation expired.';
  end if;

  if v_reservation.status = 'consumed' then
    select asset.case_id, asset.size_bytes
    into v_asset_case_id, v_asset_size
    from public.information_agent_evidence_assets asset
    where asset.storage_path = p_storage_path;
    if found and (v_asset_case_id <> p_case_id or v_asset_size <> p_size_bytes) then
      raise exception using
        errcode = '23514',
        message = 'Information-agent portal upload asset mismatch.';
    end if;
    return;
  end if;

  update public.information_agent_portal_upload_reservations reservation
  set status = 'consumed',
      consumed_at = v_now
  where reservation.id = v_reservation.id;
end;
$$;

revoke all on function public.consume_information_agent_portal_upload(uuid, text, bigint)
  from public, anon, authenticated;
grant execute on function public.consume_information_agent_portal_upload(uuid, text, bigint)
  to service_role;

comment on table public.information_agent_portal_upload_reservations is
  'Service-only reservations bounding public contribution Storage uploads per shared case; each signed URL reserves the full 40 MiB bucket capacity once.';
comment on column public.information_agent_portal_upload_reservations.size_bytes is
  'Quota charge for the signed object; new portal reservations always charge the 40 MiB Storage bucket limit.';
comment on column public.information_agent_portal_upload_reservations.requested_size_bytes is
  'File size declared when the signed upload ticket was issued; new tickets are limited to 20 MiB.';
comment on column public.information_agent_portal_upload_reservations.status is
  'reserved while a signed URL may still be used, consumed after validation, or released only by an explicit administrative cleanup.';

notify pgrst, 'reload schema';

commit;
