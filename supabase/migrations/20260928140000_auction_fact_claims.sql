begin;

-- A claim is one observed value for one canonical field.  It is deliberately
-- additive: legacy auction_sales/properties/judicial_sales remain the source
-- used by the existing application until a later, reviewed projection adopts
-- this read model.
--
-- This migration intentionally does not backfill legacy rows.  The existing
-- flattened fields do not carry field-level provenance, so a safe backfill
-- belongs in a separately reviewed service-role job that inserts candidate
-- claims only when an HTTPS source_url is present and never upgrades them to
-- accepted without an explicit resolution.
create table public.auction_fact_claims (
  id uuid primary key default gen_random_uuid(),
  auction_sale_id uuid references public.auction_sales(id) on delete set null,
  lot_id uuid references public.auction_lots(id) on delete set null,
  field_key text not null check (
    char_length(field_key) between 2 and 128
    and field_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,3}$'
  ),
  value_jsonb jsonb not null check (jsonb_typeof(value_jsonb) <> 'null'),
  claim_status text not null default 'candidate' check (
    claim_status in (
      'candidate', 'accepted', 'rejected', 'superseded', 'conflicted', 'withdrawn'
    )
  ),
  conflict_group text check (
    conflict_group is null
    or (
      char_length(conflict_group) between 1 and 200
      and nullif(btrim(conflict_group), '') is not null
    )
  ),

  -- Evidence points at the existing Outcome Graph ingestion records whenever
  -- possible.  source_url/evidence_locator also support a later portal or
  -- email adapter without pretending that an unverified value is canonical.
  -- Outcome retention currently purges private Storage objects and keeps the
  -- append-only database evidence plus its purge ledger.  Keep these links
  -- restrictive so a future physical database purge cannot silently erase
  -- claim provenance; that policy change needs a reviewed snapshot/detach
  -- migration before these foreign keys are relaxed.
  evidence_kind text not null check (
    evidence_kind in (
      'source_listing', 'source_document', 'source_record', 'email_attachment',
      'portal_upload', 'manual_review', 'agent_research', 'other'
    )
  ),
  source_id uuid references public.data_sources(id) on delete restrict,
  raw_artifact_id uuid references public.raw_artifacts(id) on delete restrict,
  source_record_id uuid references public.judicial_source_records(id) on delete restrict,
  artifact_extraction_id uuid references public.artifact_extractions(id) on delete restrict,
  source_url text check (
    source_url is null
    or (char_length(source_url) between 1 and 4096 and source_url ~ '^https://')
  ),
  evidence_locator jsonb not null default '{}'::jsonb check (
    jsonb_typeof(evidence_locator) = 'object'
  ),
  confidence_score numeric(5,4) check (
    confidence_score is null or confidence_score between 0 and 1
  ),
  extractor_name text,
  extractor_version text,
  captured_at timestamptz not null default now(),
  -- Auth accounts may be removed.  The FK cascade is narrowly accepted by
  -- the mutation guard below and leaves a redaction timestamp on the claim.
  created_by uuid references auth.users(id) on delete set null,
  created_by_redacted_at timestamptz,

  -- Resolution metadata is mutable only while a candidate is unresolved.
  -- Once a claim is resolved, its observation and decision are immutable.
  resolution_actor_type text check (
    resolution_actor_type is null
    or resolution_actor_type in ('human', 'rule', 'agent', 'source_update', 'system')
  ),
  resolution_actor_id uuid references auth.users(id) on delete set null,
  resolution_actor_redacted_at timestamptz,
  resolution_note text,
  resolved_at timestamptz,
  supersedes_claim_id uuid references public.auction_fact_claims(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint auction_fact_claims_raw_artifact_source_check check (
    raw_artifact_id is null or source_id is not null
  ),
  constraint auction_fact_claims_source_record_source_check check (
    source_record_id is null or source_id is not null
  ),
  constraint auction_fact_claims_extraction_artifact_check check (
    artifact_extraction_id is null or raw_artifact_id is not null
  ),
  constraint auction_fact_claims_provenance_check check (
    source_id is not null
    or raw_artifact_id is not null
    or source_record_id is not null
    or artifact_extraction_id is not null
    or source_url is not null
    or created_by is not null
    or created_by_redacted_at is not null
  ),
  constraint auction_fact_claims_created_by_redaction_check check (
    created_by_redacted_at is null or created_by is null
  ),
  constraint auction_fact_claims_resolution_actor_redaction_check check (
    resolution_actor_redacted_at is null or resolution_actor_id is null
  ),
  constraint auction_fact_claims_extractor_pair_check check (
    (extractor_name is null and extractor_version is null)
    or (
      nullif(btrim(extractor_name), '') is not null
      and nullif(btrim(extractor_version), '') is not null
    )
  ),
  constraint auction_fact_claims_resolution_check check (
    (
      claim_status = 'candidate'
      and resolved_at is null
      and resolution_actor_type is null
      and resolution_actor_id is null
    )
    or (
      claim_status <> 'candidate'
      and resolved_at is not null
      and resolution_actor_type is not null
    )
  ),
  constraint auction_fact_claims_resolution_note_check check (
    claim_status not in ('rejected', 'superseded', 'conflicted', 'withdrawn')
    or nullif(btrim(resolution_note), '') is not null
  ),
  constraint auction_fact_claims_conflict_check check (
    claim_status <> 'conflicted' or conflict_group is not null
  ),
  constraint auction_fact_claims_supersession_check check (
    (claim_status = 'superseded' and supersedes_claim_id is not null)
    or (claim_status <> 'superseded' and supersedes_claim_id is null)
  ),
  constraint auction_fact_claims_no_self_supersession_check check (
    supersedes_claim_id is null or supersedes_claim_id <> id
  ),
  constraint auction_fact_claims_raw_artifact_source_fk
    foreign key (raw_artifact_id, source_id)
    references public.raw_artifacts(id, source_id)
    on delete restrict
);

create index auction_fact_claims_sale_field_idx
  on public.auction_fact_claims(auction_sale_id, field_key, claim_status, created_at desc)
  where auction_sale_id is not null;

create index auction_fact_claims_lot_field_idx
  on public.auction_fact_claims(lot_id, field_key, claim_status, created_at desc)
  where lot_id is not null;

create index auction_fact_claims_conflict_idx
  on public.auction_fact_claims(conflict_group, field_key, created_at desc)
  where conflict_group is not null;

create index auction_fact_claims_source_record_idx
  on public.auction_fact_claims(source_record_id)
  where source_record_id is not null;

create or replace function app_private.validate_auction_fact_claim()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  lot_sale_id uuid;
  record_source_id uuid;
  extraction_artifact_id uuid;
begin
  -- A fresh observation must have a canonical target.  Retention may later
  -- detach a legacy auction_sale row through ON DELETE SET NULL; the raw
  -- artifact/source pointers remain the durable evidence in that case.
  if tg_op = 'INSERT' and new.auction_sale_id is null and new.lot_id is null then
    raise exception using
      errcode = '23514',
      message = 'A fact claim must target an auction sale or Outcome Graph lot.';
  end if;

  if tg_op = 'UPDATE'
    and new.auction_sale_id is null
    and new.lot_id is null
    and not (
      (old.auction_sale_id is not null and new.auction_sale_id is null)
      or (old.lot_id is not null and new.lot_id is null)
    ) then
    raise exception using
      errcode = '23514',
      message = 'A fact claim must retain an auction sale or Outcome Graph lot target.';
  end if;

  -- ON DELETE SET NULL on auth.users is an internal FK-triggered update. Keep
  -- the claim when an account disappears, but retain an explicit redaction
  -- marker so the row does not lose its audit history silently.
  if tg_op = 'UPDATE' and pg_trigger_depth() > 1 then
    if old.created_by is not null and new.created_by is null then
      new.created_by_redacted_at := coalesce(new.created_by_redacted_at, pg_catalog.now());
    end if;
    if old.resolution_actor_id is not null and new.resolution_actor_id is null then
      new.resolution_actor_redacted_at := coalesce(
        new.resolution_actor_redacted_at,
        pg_catalog.now()
      );
    end if;
  end if;

  if new.source_id is null
    and new.raw_artifact_id is null
    and new.source_record_id is null
    and new.artifact_extraction_id is null
    and new.source_url is null
    and new.created_by is null
    and new.created_by_redacted_at is null then
    raise exception using
      errcode = '23514',
      message = 'Fact claims require at least one provenance pointer.';
  end if;

  if new.claim_status = 'conflicted' and new.conflict_group is null then
    raise exception using
      errcode = '23514',
      message = 'Fact claim conflict groups require a non-empty identifier.';
  end if;

  if new.source_url is not null and new.source_url !~ '^https://' then
    raise exception using
      errcode = '23514',
      message = 'Fact claim evidence links must use HTTPS.';
  end if;

  if new.auction_sale_id is not null and new.lot_id is not null then
    select lot.auction_sale_id
    into lot_sale_id
    from public.auction_lots lot
    where lot.id = new.lot_id;

    if lot_sale_id is distinct from new.auction_sale_id then
      raise exception using
        errcode = '23514',
        message = 'A fact claim sale target must match the Outcome Graph lot sale.';
    end if;
  end if;

  if new.source_record_id is not null then
    select record.source_id
    into record_source_id
    from public.judicial_source_records record
    where record.id = new.source_record_id;

    if record_source_id is distinct from new.source_id then
      raise exception using
        errcode = '23514',
        message = 'A fact claim source must match its judicial source record.';
    end if;
  end if;

  if new.artifact_extraction_id is not null then
    select extraction.raw_artifact_id
    into extraction_artifact_id
    from public.artifact_extractions extraction
    where extraction.id = new.artifact_extraction_id;

    if extraction_artifact_id is distinct from new.raw_artifact_id then
      raise exception using
        errcode = '23514',
        message = 'A fact claim extraction must match its raw artifact.';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    new.updated_at := pg_catalog.now();
  end if;
  return new;
end;
$function$;

create or replace function app_private.guard_auction_fact_claim_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception using
      errcode = '55000',
      message = 'Fact claims cannot be deleted; supersede or withdraw them.';
  end if;

  -- Trigger names run in lexical order, so stamp the redaction before the
  -- immutability comparison (the validation trigger stamps it as well for
  -- the final row constraint check).
  if tg_op = 'UPDATE' and pg_trigger_depth() > 1 then
    if old.created_by is not null and new.created_by is null then
      new.created_by_redacted_at := coalesce(new.created_by_redacted_at, pg_catalog.now());
    end if;
    if old.resolution_actor_id is not null and new.resolution_actor_id is null then
      new.resolution_actor_redacted_at := coalesce(
        new.resolution_actor_redacted_at,
        pg_catalog.now()
      );
    end if;
  end if;

  -- An auth.users deletion invokes ON DELETE SET NULL as a nested FK trigger.
  -- Permit that narrow redaction only when the actor pointers are the only
  -- changed observation metadata and the parent account is already gone.
  if tg_op = 'UPDATE'
    and pg_trigger_depth() > 1
    and (
      (old.created_by is not null and new.created_by is null
       and new.created_by_redacted_at is not null)
      or (old.resolution_actor_id is not null and new.resolution_actor_id is null
          and new.resolution_actor_redacted_at is not null)
    )
    and (pg_catalog.to_jsonb(new) - array[
      'created_by', 'created_by_redacted_at', 'resolution_actor_id',
      'resolution_actor_redacted_at', 'updated_at'
    ]) = (pg_catalog.to_jsonb(old) - array[
      'created_by', 'created_by_redacted_at', 'resolution_actor_id',
      'resolution_actor_redacted_at', 'updated_at'
    ])
    and (
      old.created_by is null
      or exists (select 1 from auth.users where id = old.created_by) is not true
    )
    and (
      old.resolution_actor_id is null
      or exists (select 1 from auth.users where id = old.resolution_actor_id)
        is not true
    ) then
    return new;
  end if;

  if (pg_catalog.to_jsonb(new) - array[
      'claim_status', 'conflict_group', 'resolution_actor_type',
      'resolution_actor_id', 'resolution_note', 'resolved_at',
      'supersedes_claim_id', 'updated_at'
    ]) <> (pg_catalog.to_jsonb(old) - array[
      'claim_status', 'conflict_group', 'resolution_actor_type',
      'resolution_actor_id', 'resolution_note', 'resolved_at',
      'supersedes_claim_id', 'updated_at'
    ]) then
    -- Retention is allowed to detach only canonical target foreign keys. It
    -- leaves the claim and its immutable source evidence in place, while the
    -- read model filters detached rows from listing output.
    if not (
      tg_op = 'UPDATE'
      and (
        (old.auction_sale_id is not null and new.auction_sale_id is null)
        or (old.lot_id is not null and new.lot_id is null)
      )
      and (pg_catalog.to_jsonb(new) - array[
        'auction_sale_id', 'lot_id', 'updated_at'
      ]) = (pg_catalog.to_jsonb(old) - array[
        'auction_sale_id', 'lot_id', 'updated_at'
      ])
      and pg_trigger_depth() > 1
      and (
        new.created_by is not distinct from old.created_by
        and new.created_by_redacted_at is not distinct from old.created_by_redacted_at
        and new.resolution_actor_id is not distinct from old.resolution_actor_id
        and new.resolution_actor_redacted_at is not distinct from old.resolution_actor_redacted_at
      )
    ) then
      raise exception using
        errcode = '55000',
        message = 'Fact claim observations and provenance are immutable.';
    end if;
  end if;

  if old.claim_status <> 'candidate' and (
    new.claim_status is distinct from old.claim_status
    or new.conflict_group is distinct from old.conflict_group
    or new.resolution_actor_type is distinct from old.resolution_actor_type
    or new.resolution_actor_id is distinct from old.resolution_actor_id
    or new.resolution_note is distinct from old.resolution_note
    or new.resolved_at is distinct from old.resolved_at
    or new.supersedes_claim_id is distinct from old.supersedes_claim_id
  ) then
    raise exception using
      errcode = '55000',
      message = 'A resolved fact claim decision is immutable.';
  end if;

  return new;
end;
$function$;

create trigger auction_fact_claims_validate_write
before insert or update on public.auction_fact_claims
for each row execute function app_private.validate_auction_fact_claim();

create trigger auction_fact_claims_guard_mutation
before update or delete on public.auction_fact_claims
for each row execute function app_private.guard_auction_fact_claim_mutation();

alter table public.auction_fact_claims enable row level security;

revoke all on table public.auction_fact_claims
from public, anon, authenticated;
grant select, insert, update on table public.auction_fact_claims to service_role;

-- This is the first stable application contract. It keeps unresolved and
-- explicit conflicts visible to a trusted reviewer, while rejected,
-- superseded and withdrawn observations stay out of listing projections.
create or replace view public.v_auction_fact_claims_read_model
with (security_invoker = true)
as
select
  claim.id as claim_id,
  claim.auction_sale_id,
  claim.lot_id,
  claim.field_key,
  claim.value_jsonb,
  claim.claim_status as fact_status,
  (claim.claim_status = 'accepted') as is_publishable,
  claim.conflict_group,
  claim.evidence_kind,
  claim.source_id,
  claim.raw_artifact_id,
  claim.source_record_id,
  claim.artifact_extraction_id,
  claim.source_url,
  claim.evidence_locator,
  claim.confidence_score,
  claim.captured_at,
  claim.resolved_at,
  claim.resolution_note,
  claim.created_at,
  claim.updated_at
from public.auction_fact_claims claim
where claim.claim_status in ('candidate', 'accepted', 'conflicted')
  and (claim.auction_sale_id is not null or claim.lot_id is not null);

revoke all on table public.v_auction_fact_claims_read_model
from public, anon, authenticated;
grant select on table public.v_auction_fact_claims_read_model to service_role;

comment on table public.auction_fact_claims is
  'Additive, source-backed observations for canonical auction facts; legacy catalogue tables remain unchanged.';
comment on view public.v_auction_fact_claims_read_model is
  'Trusted read model exposing unresolved, accepted and conflicting fact claims for later listing projections.';

revoke all on function app_private.validate_auction_fact_claim()
from public, anon, authenticated;
revoke all on function app_private.guard_auction_fact_claim_mutation()
from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
