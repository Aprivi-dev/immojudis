-- P4-11: the bucket of approved evidence is no longer public, and no attachment can be accepted for
-- publication without a recorded redaction check.
--
-- * information-agent-approved becomes private. Files are served through short-lived signed URLs
--   created on demand by /api/information-agent/evidence (10 minutes). The bucket held no object and
--   no fact referenced a public URL when this migration was written. The `public_url` strings kept in
--   fact payloads follow the historical /object/public/ shape because earlier guards validate it; they
--   identify the object and are no longer fetchable.
-- * A BEFORE trigger refuses to accept a document/photo fact unless its evidence asset carries
--   redaction_verified_at and redaction_verified_by in its metadata (recorded by the admin review step
--   "Caviardage vérifié"). Facts already accepted are not re-checked.
begin;
set local lock_timeout = '5s';

update storage.buckets
   set public = false
 where id = 'information-agent-approved';

create or replace function app_private.guard_information_agent_redaction_verified()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_metadata jsonb;
begin
  if new.status is distinct from 'accepted' or new.fact_key not in ('document', 'photo') then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = 'accepted' then
    return new;
  end if;

  select asset.metadata
    into v_metadata
    from public.information_agent_evidence_assets asset
   where asset.id = new.evidence_asset_id;

  if v_metadata is null
    or nullif(pg_catalog.btrim(v_metadata ->> 'redaction_verified_at'), '') is null
    or nullif(pg_catalog.btrim(v_metadata ->> 'redaction_verified_by'), '') is null then
    raise exception using errcode = '55000',
      message = 'Redaction must be verified before publication.';
  end if;

  return new;
end;
$$;

revoke all on function app_private.guard_information_agent_redaction_verified()
  from public, anon, authenticated;

create trigger information_agent_fact_redaction_guard
before insert or update of status on public.information_agent_fact_candidates
for each row execute function app_private.guard_information_agent_redaction_verified();

commit;
