begin;

-- Preserve separate provenance when two attachments in one message propose the
-- same value. The previous unique key silently discarded the later asset.
-- NULLS NOT DISTINCT keeps the same replay semantics for text facts, whose
-- attachment and page provenance are both null.
do $$
declare
  v_constraint_name text;
begin
  select constraint_name.conname into v_constraint_name
  from pg_constraint constraint_name
  where constraint_name.conrelid = 'public.information_agent_fact_candidates'::regclass
    and constraint_name.contype = 'u'
    and pg_get_constraintdef(constraint_name.oid) =
      'UNIQUE (message_id, fact_key, display_value)';

  if v_constraint_name is not null then
    execute format(
      'alter table public.information_agent_fact_candidates drop constraint %I',
      v_constraint_name
    );
  end if;
end;
$$;

alter table public.information_agent_fact_candidates
  add constraint information_agent_fact_candidates_provenance_key
  unique nulls not distinct (message_id, fact_key, evidence_asset_id, source_page, display_value);

-- An extraction is enqueued from its asset. These associations must remain
-- stable after creation, or a later rights check can refer to another sale.
create or replace function app_private.guard_information_agent_evidence_associations()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_case_sale_id uuid;
  v_message_case_id uuid;
  v_asset public.information_agent_evidence_assets%rowtype;
begin
  if tg_op = 'UPDATE' and (
    new.case_id is distinct from old.case_id
    or new.message_id is distinct from old.message_id
    or new.sale_id is distinct from old.sale_id
    or (tg_table_name = 'information_agent_evidence_extractions'
      and to_jsonb(new)->>'asset_id' is distinct from to_jsonb(old)->>'asset_id')
  ) then
    raise exception using errcode = '23514',
      message = 'Information-agent evidence association cannot change.';
  end if;

  select shared_case.sale_id into v_case_sale_id
  from public.information_agent_cases shared_case
  where shared_case.id = new.case_id;
  select message.case_id into v_message_case_id
  from public.information_agent_messages message
  where message.id = new.message_id;
  if v_case_sale_id is distinct from new.sale_id
    or v_message_case_id is distinct from new.case_id
  then
    raise exception using errcode = '23514',
      message = 'Information-agent evidence case, message and sale must match.';
  end if;

  if tg_table_name = 'information_agent_evidence_extractions' then
    select * into v_asset
    from public.information_agent_evidence_assets asset
    where asset.id = new.asset_id;
    if v_asset.id is null
      or v_asset.case_id is distinct from new.case_id
      or v_asset.message_id is distinct from new.message_id
      or v_asset.sale_id is distinct from new.sale_id
    then
      raise exception using errcode = '23514',
        message = 'Information-agent extraction asset association must match.';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function app_private.guard_information_agent_evidence_associations()
from public, anon, authenticated;

create trigger information_agent_evidence_assets_association_guard
before insert or update of case_id, message_id, sale_id
on public.information_agent_evidence_assets
for each row execute function app_private.guard_information_agent_evidence_associations();

create trigger information_agent_evidence_extractions_association_guard
before insert or update of asset_id, case_id, message_id, sale_id
on public.information_agent_evidence_extractions
for each row execute function app_private.guard_information_agent_evidence_associations();

-- A rights review may have read an asset before another request staged or
-- accepted it. Enforce the fail-closed decision on the current row in SQL.
create or replace function app_private.guard_information_agent_rights_restriction()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.rights_status = 'restricted'
    and old.rights_status is distinct from 'restricted'
    and (
      old.review_status = 'accepted'
      or old.metadata ? 'approved_public_path'
      or old.metadata ? 'approved_public_url'
      or old.metadata ? 'publication_staged_at'
    )
  then
    raise exception using errcode = '55000',
      message = 'Published or staged evidence must be unpublished before restricting rights.';
  end if;
  return new;
end;
$$;

revoke all on function app_private.guard_information_agent_rights_restriction()
from public, anon, authenticated;

create trigger information_agent_rights_restriction_guard
before update of rights_status on public.information_agent_evidence_assets
for each row execute function app_private.guard_information_agent_rights_restriction();

-- Keep candidate provenance tied to one conversation and one sale, including
-- when a privileged worker or a webhook retry writes an inconsistent row.
create or replace function app_private.guard_information_agent_fact_associations()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_case_sale_id uuid;
  v_case_status text;
  v_message_case_id uuid;
  v_asset public.information_agent_evidence_assets%rowtype;
  v_extraction public.information_agent_evidence_extractions%rowtype;
begin
  select shared_case.sale_id, shared_case.status into v_case_sale_id, v_case_status
  from public.information_agent_cases shared_case
  where shared_case.id = new.case_id
  for share;
  select message.case_id into v_message_case_id
  from public.information_agent_messages message
  where message.id = new.message_id;

  if v_case_sale_id is distinct from new.sale_id
    or v_message_case_id is distinct from new.case_id
  then
    raise exception using errcode = '23514',
      message = 'Information-agent fact case, message and sale must match.';
  end if;

  if new.evidence_asset_id is not null then
    select * into v_asset
    from public.information_agent_evidence_assets asset
    where asset.id = new.evidence_asset_id
    for share;
    if v_asset.id is null
      or v_asset.case_id is distinct from new.case_id
      or v_asset.message_id is distinct from new.message_id
      or v_asset.sale_id is distinct from new.sale_id
    then
      raise exception using errcode = '23514',
        message = 'Information-agent evidence asset association must match.';
    end if;

    select * into v_extraction
    from public.information_agent_evidence_extractions extraction
    where extraction.asset_id = new.evidence_asset_id
    for share;
    -- Inbound candidates are created before the async extraction job.
    -- A missing row is allowed while pending, but a present row must agree.
    if v_extraction.asset_id is not null and (
      v_extraction.case_id is distinct from new.case_id
      or v_extraction.message_id is distinct from new.message_id
      or v_extraction.sale_id is distinct from new.sale_id
    )
    then
      raise exception using errcode = '23514',
        message = 'Information-agent evidence extraction association must match.';
    end if;
  end if;

  -- The row lock serializes candidate writes with a terminal case transition.
  -- That transition rejects still-pending candidates in the same transaction.
  if new.status in ('pending', 'conflict', 'accepted') then
    if v_case_status is null or v_case_status not in ('sending', 'sent', 'replied', 'review') then
      raise exception using errcode = '55000',
        message = 'Information-agent case is no longer accepting candidates.';
    end if;
  end if;

  if new.status = 'accepted' and new.fact_key in ('document', 'photo') then
    if new.evidence_asset_id is null then
      raise exception using errcode = '55000',
        message = 'Attachment evidence is required for publication.';
    end if;
    if v_asset.rights_status is distinct from 'authorized' then
      raise exception using errcode = '55000',
        message = 'Attachment rights must be authorized before publication.';
    end if;
    if v_extraction.asset_id is null or v_extraction.status is distinct from 'completed' then
      raise exception using errcode = '55000',
        message = 'Attachment analysis must complete before publication.';
    end if;
    if new.proposed_value->>'public_url' is null
      or (new.proposed_value->>'public_url') !~ '^https://[a-z0-9]+[.]supabase[.]co/storage/v1/object/public/information-agent-approved/'
    then
      raise exception using errcode = '55000',
        message = 'Attachment publication must be staged before acceptance.';
    end if;
    if new.proposed_value->>'public_path' is null
      or (new.proposed_value->>'public_path') not like new.sale_id::text || '/' || v_asset.id::text || '/%'
    then
      raise exception using errcode = '55000',
        message = 'Attachment publication path must be staged before acceptance.';
    end if;
    if split_part(
      new.proposed_value->>'public_url',
      '/storage/v1/object/public/information-agent-approved/',
      2
    ) is distinct from new.proposed_value->>'public_path' then
      raise exception using errcode = '55000',
        message = 'Attachment publication URL must match its staged path.';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function app_private.guard_information_agent_fact_associations()
from public, anon, authenticated;

create trigger information_agent_fact_associations_guard
before insert or update
on public.information_agent_fact_candidates
for each row execute function app_private.guard_information_agent_fact_associations();

create or replace function app_private.reject_information_agent_candidates_on_case_close()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status in ('completed', 'failed')
    and old.status is distinct from new.status
  then
    update public.information_agent_fact_candidates fact
    set status = 'rejected',
        metadata = fact.metadata || jsonb_build_object(
          'automatically_rejected_case_status', new.status
        ),
        updated_at = statement_timestamp()
    where fact.case_id = new.id
      and fact.status in ('pending', 'conflict');
  end if;
  return new;
end;
$$;

revoke all on function app_private.reject_information_agent_candidates_on_case_close()
from public, anon, authenticated;

create trigger information_agent_reject_candidates_on_case_close
after update of status on public.information_agent_cases
for each row execute function app_private.reject_information_agent_candidates_on_case_close();

-- Bind the final review to the exact object uploaded by this request. The
-- existing review function performs the sale update while this row lock is
-- held, so a concurrent reviewer cannot substitute another staged object.
create or replace function public.review_information_agent_fact_candidate_with_path(
  p_reviewer_id uuid,
  p_fact_id uuid,
  p_decision text,
  p_notes text,
  p_expected_public_path text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fact public.information_agent_fact_candidates%rowtype;
begin
  if p_decision <> 'accepted' then
    raise exception using errcode = '22023',
      message = 'Path-bound review only supports acceptance.';
  end if;
  select * into v_fact
  from public.information_agent_fact_candidates fact
  where fact.id = p_fact_id
  for update;
  if v_fact.id is null
    or v_fact.fact_key not in ('document', 'photo')
    or v_fact.status not in ('pending', 'conflict')
    or v_fact.proposed_value->>'public_path' is distinct from p_expected_public_path
  then
    raise exception using errcode = '55000',
      message = 'The staged evidence changed during review.';
  end if;
  return public.review_information_agent_fact_candidate(
    p_reviewer_id, p_fact_id, p_decision, p_notes
  );
end;
$$;

revoke all on function public.review_information_agent_fact_candidate_with_path(
  uuid, uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.review_information_agent_fact_candidate_with_path(
  uuid, uuid, text, text, text
) to service_role;

-- Resolve ambiguous network failures before deleting an attempt's public
-- object. This CAS clears the staged reference only while it is unreviewed.
-- The caller may delete the unique object path only when true is returned.
create or replace function public.abort_information_agent_evidence_publication(
  p_fact_id uuid,
  p_public_path text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fact public.information_agent_fact_candidates%rowtype;
begin
  select * into v_fact
  from public.information_agent_fact_candidates fact
  where fact.id = p_fact_id
  for update;
  if v_fact.id is null or v_fact.fact_key not in ('document', 'photo') then
    return false;
  end if;
  if v_fact.status = 'accepted' and v_fact.proposed_value->>'public_path' = p_public_path then
    return false;
  end if;
  if exists (
    select 1 from public.information_agent_fact_candidates fact
    where fact.status = 'accepted'
      and fact.proposed_value->>'public_path' = p_public_path
  ) then
    return false;
  end if;

  if v_fact.proposed_value->>'public_path' = p_public_path then
    update public.information_agent_fact_candidates fact
    set proposed_value = fact.proposed_value - 'public_url' - 'public_path',
        updated_at = statement_timestamp()
    where fact.id = p_fact_id;
  end if;
  update public.information_agent_evidence_assets asset
  set metadata = asset.metadata
      - 'approved_public_url' - 'approved_public_path' - 'publication_staged_at'
  where asset.id = v_fact.evidence_asset_id
    and asset.metadata->>'approved_public_path' = p_public_path;
  return true;
end;
$$;

revoke all on function public.abort_information_agent_evidence_publication(uuid, text)
from public, anon, authenticated;
grant execute on function public.abort_information_agent_evidence_publication(uuid, text)
to service_role;

commit;

notify pgrst, 'reload schema';
