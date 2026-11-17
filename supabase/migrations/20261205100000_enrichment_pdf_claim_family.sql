begin;

set local lock_timeout = '5s';

-- Famille de revendication enrichment_pdf : les lectures de pièces seules (17/11/2026).
--
-- Première unité de la voie parallèle en production (17/11, 15:30-15:54 UTC) : les deux processus généraux se sont
-- arrêtés au premier refus du plafond horaire d'appels IA (60 par heure, reserve_llm_request), l'unité s'est terminée
-- en « file vide » au bout de 24 minutes, et 189 lectures de pièces échues sont restées en file. La lecture des pièces
-- (téléchargement, OCR local) n'appelle pas l'IA ; seules les passes de faits (fact_extraction) l'appellent. La
-- famille enrichment mélange les deux : un travailleur ne pouvait pas demander « des pièces seulement ».
--
-- enrichment_pdf prend les mêmes tâches que enrichment (mêmes filtres : conservation, révision, bail en cours ; bail
-- expiré repris, dernière tentative passée en échec ; même ordre par score), restreintes au type pdf. Le travailleur
-- (services/data-pipeline/src/general_lane_claims.py, queued_runner.py) la demande :
-- * après un refus du budget IA (plafond horaire, budget du jour ou plafond de l'exécution), jusqu'à l'essai suivant
--   des faits, 5 minutes plus tard : les pièces avancent, les faits restent en file sans perdre d'essai ;
-- * en premier, pour l'un des processus généraux quand il y en a au moins deux : les pièces ont toujours un processus
--   qui les sert d'abord, les faits gardent l'autre.
--
-- Rien d'autre ne change : enrichment, enrichment_oldest et source_detail gardent exactement leurs tâches et leur
-- ordre. Mêmes signatures (aucune surcharge PostgREST nouvelle).
--
-- ORDRE DE DÉPLOIEMENT : indifférent. Une base sans cette migration refuse la famille (SQLSTATE 22023) : le
-- travailleur revient, jusqu'à la fin de son passage, à la règle d'avant (plus aucune prise générale après le premier
-- refus du budget IA ; prise enrichment pour le processus « pièces d'abord ») et le note dans son journal.
--
-- RETOUR ARRIÈRE : sans objet côté base (la famille n'est demandée que par le travailleur) ; côté travailleur,
-- PIPELINE_ENRICHMENT_GENERAL_WORKERS (docs/runbooks/pipeline-enrichment-stalled.md).

-- Gardes de départ, avant toute écriture : empreinte md5 du corps en place (pg_proc.prosrc), vérifiée en rejouant
-- toutes les migrations depuis zéro sur une base jetable (corps posés par 20261201100000), ou celle de cette
-- migration (migration rejouée). Tout autre corps fait échouer la migration au lieu d'écraser une modification faite
-- hors migration.
do $guard$
declare
  found_md5 text;
  expected record;
begin
  for expected in
    select * from (values
      -- (signature, point de départ vérifié par rejeu depuis zéro, cette migration déjà appliquée)
      ('public.claim_auction_enrichment_jobs_family(text,integer)',
        '6792bdd62a20c6f72147ca0eb206e3a2', '20108537d27d530956d85d9178ceec4f'),
      ('public.claim_auction_enrichment_jobs_request(uuid,text,integer)',
        'a05bc13d7786d27f322c7b76fff6bd4f', '4348ca29ded06805f3f0134913d666ac')
    ) as t(signature, start_md5, applied_md5)
  loop
    select md5(procedure_row.prosrc) into found_md5
      from pg_catalog.pg_proc procedure_row
     where procedure_row.oid = expected.signature::regprocedure;
    if found_md5 is distinct from expected.start_md5 and found_md5 is distinct from expected.applied_md5 then
      raise exception using
        errcode = '55000',
        message = format(
          'Unexpected body for %s (md5 %s); refusing the enrichment_pdf claim family.', expected.signature, found_md5
        );
    end if;
  end loop;
end;
$guard$;

-- Les reçus d'idempotence de la revendication admettent la nouvelle famille. La contrainte change ici, juste après
-- les gardes et avant les fonctions (même ordre de verrous que 20261201100000). La liste ne fait que s'élargir : les
-- lignes en place la respectent déjà, la contrainte est posée not valid (pas de relecture des reçus sous ce verrou) ;
-- elle s'applique pleinement à toute nouvelle ligne.
alter table app_private.auction_enrichment_claim_receipts
  drop constraint if exists auction_enrichment_claim_receipts_family_check;
alter table app_private.auction_enrichment_claim_receipts
  add constraint auction_enrichment_claim_receipts_family_check
  check (family in ('source_detail', 'enrichment', 'enrichment_oldest', 'enrichment_pdf')) not valid;

-- Redéfinition COMPLÈTE de public.claim_auction_enrichment_jobs_family, recopiée À L'IDENTIQUE de 20261201100000
-- (garde md5 de tête). Seuls changent la liste des familles admises et le filtre de type de la famille enrichment_pdf.
create or replace function public.claim_auction_enrichment_jobs_family(
  p_family text,
  p_limit integer default 10
)
returns setof public.auction_enrichment_jobs
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_family text := lower(trim(coalesce(p_family, '')));
  v_claim_limit integer := greatest(1, least(coalesce(p_limit, 10), 100));
begin
  if v_family not in ('source_detail', 'enrichment', 'enrichment_oldest', 'enrichment_pdf', 'all') then
    raise exception 'Unknown enrichment queue family: %', p_family
      using errcode = '22023';
  end if;

  -- Detail work can also be claimed through the historical all-family RPC.
  -- Serialize only the short SQL claim section; the worker performs HTTP and
  -- OCR after this transaction has returned its leases.
  if v_family in ('source_detail', 'all') then
    perform pg_advisory_xact_lock(
      hashtextextended('immojudis-enrichment-source-detail-claim', 0)
    );
  end if;

  -- Retain an audit trail; obsolete work must never consume a retry or a
  -- network/LLM call. A fenced row is authoritative: NULL means the policy
  -- keeps the sale, while a non-materialized row is conservatively kept until
  -- the bounded backfill/trigger has made its deadline ready.
  update public.auction_enrichment_jobs j
     set status = 'cancelled',
         locked_at = null,
         updated_at = now(),
         last_error = 'Listing removed, expired or explicitly cancelled'
   where (j.status in ('queued', 'failed')
       or (j.status = 'running'
           and coalesce(j.locked_at, j.updated_at) < now() - interval '30 minutes'))
     and not exists (
       select 1
         from public.auction_sales s
        where s.source_url = j.source_url
          and s.status in ('active', 'unknown', 'upcoming', 'postponed', 'past')
          and (
            not s.retention_deadline_materialized
            or s.retention_deadline is null
            or s.retention_deadline > now()
          )
     );

  with ranked as (
    select id,
           row_number() over (
             partition by source_url, job_type, detail_source_name, detail_source_url
             order by created_at desc, (input_hash like 'pipeline_v2:%') desc, id desc
           ) as revision_rank
      from public.auction_enrichment_jobs
     where status <> 'cancelled'
  )
  update public.auction_enrichment_jobs j
     set status = 'cancelled',
         locked_at = null,
         updated_at = now(),
         last_error = 'Superseded by a newer input revision'
    from ranked r
   where r.id = j.id
     and r.revision_rank > 1
     and (
       j.status in ('queued', 'failed')
       or (j.status = 'running'
           and coalesce(j.locked_at, j.updated_at) < now() - interval '30 minutes')
     );

  update public.auction_enrichment_jobs
     set status = 'failed',
         locked_at = null,
         updated_at = now(),
         last_error = 'Worker lease expired and retry budget exhausted'
   where status = 'running'
     and coalesce(locked_at, updated_at) < now() - interval '30 minutes'
     and attempt_count >= max_attempts;

  if v_family = 'source_detail' then
    -- Rank within every source first. Ordering those first rows by the
    -- source's last claim gives a round-robin batch: with N sources, ranks
    -- 1..N are selected before rank N+1 is considered. The outer join back to
    -- jobs/sales is deliberate so FOR UPDATE can retain the old row locks.
    return query
    with eligible as (
      select j.id,
             j.source_url,
             j.detail_source_name,
             j.priority,
             j.created_at,
             state.last_detail_claim_at,
             coalesce((s.sale_date between now() and now() + interval '7 days'), false) as is_near
        from public.auction_enrichment_jobs j
        join public.auction_sales s on s.source_url = j.source_url
        join public.auction_source_state state
          on state.source_name = j.detail_source_name
       where (
         j.status in ('queued', 'failed')
         or (j.status = 'running'
             and coalesce(j.locked_at, j.updated_at) < now() - interval '30 minutes')
       )
         and j.next_attempt_at <= now()
         and j.attempt_count < j.max_attempts
         and j.job_type = 'source_detail'
         and exists (
           select 1
             from public.auction_pipeline_control c
            where c.id and c.enabled and c.source_details_enabled
         )
         and state.enabled
         and (state.suspended_until is null or state.suspended_until <= now())
         and s.status in ('active', 'unknown', 'upcoming', 'postponed', 'past')
         and s.retention_deadline_materialized
         and (s.retention_deadline is null or s.retention_deadline > now())
         and not exists (
           select 1
             from public.auction_enrichment_jobs active
            where active.source_url = j.source_url
              and active.status = 'running'
              and coalesce(active.locked_at, active.updated_at) >= now() - interval '30 minutes'
         )
    ), ranked_details as (
      select e.*,
             row_number() over (
               partition by e.detail_source_name
               order by e.is_near desc,
                        e.priority + extract(epoch from (now() - e.created_at)) / 3600 desc,
                        e.created_at,
                        e.id
             ) as source_rank
        from eligible e
    ), candidates as (
      select j.id
        from ranked_details r
        join public.auction_enrichment_jobs j on j.id = r.id
        join public.auction_sales s on s.source_url = j.source_url
       order by r.source_rank,
                r.last_detail_claim_at nulls first,
                r.detail_source_name,
                r.is_near desc,
                r.priority + extract(epoch from (now() - r.created_at)) / 3600 desc,
                r.created_at,
                r.id
       for update of j, s skip locked
       limit v_claim_limit
    ), claimed as (
      update public.auction_enrichment_jobs j
         set status = 'running',
             attempt_count = j.attempt_count + 1,
             locked_at = statement_timestamp(),
             updated_at = statement_timestamp(),
             last_error = null
        from candidates c
       where c.id = j.id
      returning j.*
    ), touched_sources as (
      update public.auction_source_state state
         set last_detail_claim_at = statement_timestamp(),
             updated_at = statement_timestamp()
       where state.source_name in (
         select c.detail_source_name
           from claimed c
          where c.detail_source_name is not null
       )
      returning state.source_name
    )
    select c.*
      from claimed c
      cross join (select count(*) from touched_sources) touched;
    return;
  end if;

  -- Keep the enrichment and historical all-family order and eligibility
  -- unchanged. The all-family claim still records detail sources that it
  -- happens to lease, so legacy callers participate in the same fairness clock.
  return query
  with candidates as (
    select j.id
      from public.auction_enrichment_jobs j
      join public.auction_sales s on s.source_url = j.source_url
     where (
       j.status in ('queued', 'failed')
       or (j.status = 'running'
           and coalesce(j.locked_at, j.updated_at) < now() - interval '30 minutes')
     )
       and j.next_attempt_at <= now()
       and j.attempt_count < j.max_attempts
       and (
         v_family = 'all'
         or (v_family = 'source_detail' and j.job_type = 'source_detail')
         or ((v_family = 'enrichment' or v_family = 'enrichment_oldest') and j.job_type <> 'source_detail')
         -- Lectures de pièces seules (20261205100000) : aucune n'appelle l'IA, même ordre que enrichment.
         or (v_family = 'enrichment_pdf' and j.job_type = 'pdf')
       )
       and (
         j.job_type <> 'source_detail'
         or (
           exists (
             select 1
               from public.auction_pipeline_control c
              where c.id and c.enabled and c.source_details_enabled
           )
           and exists (
             select 1
               from public.auction_source_state state
              where state.source_name = j.detail_source_name
                and state.enabled
                and (state.suspended_until is null or state.suspended_until <= now())
           )
         )
       )
       and s.status in ('active', 'unknown', 'upcoming', 'postponed', 'past')
       and s.retention_deadline_materialized
       and (s.retention_deadline is null or s.retention_deadline > now())
       and not exists (
         select 1
           from public.auction_enrichment_jobs active
          where active.source_url = j.source_url
            and active.status = 'running'
            and coalesce(active.locked_at, active.updated_at) >= now() - interval '30 minutes'
       )
       -- Description et faits attendent la lecture des pièces de leur vente (has_eligible_pdf_job_for_sale).
       and (
         j.job_type not in ('display_description', 'fact_extraction')
         or not exists (
           select 1
             from public.auction_enrichment_jobs pdf
            where pdf.source_url = j.source_url
              and pdf.job_type = 'pdf'
              and pdf.status in ('queued', 'running', 'failed')
              and (pdf.status = 'running' or pdf.attempt_count < pdf.max_attempts)
         )
       )
     order by (v_family = 'all' and j.job_type = 'source_detail') desc,
              -- Part réservée à l'ancienneté (20261201100000) : enrichment_oldest sert d'abord la tâche échue depuis
              -- le plus longtemps, quel que soit son score ; ailleurs cette clé vaut null partout et l'ordre ne change
              -- pas.
              case when v_family = 'enrichment_oldest' then j.next_attempt_at end nulls last,
              j.priority
                + case when j.job_type = 'pdf' then 24 else 0 end
                + extract(epoch from (now() - j.created_at)) / 3600
                + case
                    when coalesce((s.sale_date between now() and now() + interval '7 days'), false)
                      then 168
                    else 0
                  end desc,
              j.created_at,
              j.id
     for update of j, s skip locked
     limit v_claim_limit
  ), claimed as (
    update public.auction_enrichment_jobs j
       set status = 'running',
           attempt_count = j.attempt_count + 1,
           locked_at = statement_timestamp(),
           updated_at = statement_timestamp(),
           last_error = null
      from candidates c
     where c.id = j.id
    returning j.*
  ), touched_sources as (
    update public.auction_source_state state
       set last_detail_claim_at = statement_timestamp(),
           updated_at = statement_timestamp()
     where state.source_name in (
       select c.detail_source_name
         from claimed c
        where c.job_type = 'source_detail'
          and c.detail_source_name is not null
     )
    returning state.source_name
  )
  select c.*
    from claimed c
    cross join (select count(*) from touched_sources) touched;
end;
$function$;

revoke all on function public.claim_auction_enrichment_jobs_family(text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_auction_enrichment_jobs_family(text, integer)
  to service_role;

-- Redéfinition COMPLÈTE de public.claim_auction_enrichment_jobs_request, recopiée À L'IDENTIQUE de 20261201100000
-- (garde md5 de tête) : seule la liste des familles admises change.
create or replace function public.claim_auction_enrichment_jobs_request(
  p_request_id uuid,
  p_family text,
  p_limit integer default 1
)
returns setof public.auction_enrichment_jobs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_family text := lower(trim(coalesce(p_family, '')));
  v_limit integer := p_limit;
  v_receipt app_private.auction_enrichment_claim_receipts%rowtype;
  v_snapshot jsonb;
  v_snapshot_count integer;
  v_valid_count integer;
  v_queue_claim_not_before timestamptz;
begin
  if p_request_id is null
     or v_family not in ('source_detail', 'enrichment', 'enrichment_oldest', 'enrichment_pdf')
     or v_limit is null
     or v_limit < 1
     or v_limit > 100 then
    raise exception 'Invalid queue claim request arguments'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('immojudis:queue-claim-request:' || p_request_id::text, 0)
  );

  select *
    into v_receipt
    from app_private.auction_enrichment_claim_receipts
   where request_id = p_request_id;

  if found then
    if v_receipt.family <> v_family or v_receipt.claim_limit <> v_limit then
      raise exception 'Queue claim request id already used with different family or limit'
        using errcode = '22023';
    end if;

    -- A request UUID is never allowed to reserve another slot.  Return the
    -- original leases only while every lease is still an exact live lease;
    -- if any member is obsolete, replay is intentionally empty.
    select count(*)
      into v_snapshot_count
      from jsonb_array_elements(v_receipt.snapshot);
    if v_snapshot_count = 0 then
      return;
    end if;

    select count(*)
      into v_valid_count
      from jsonb_array_elements(v_receipt.snapshot) with ordinality as item(value, ordinal)
      join public.auction_enrichment_jobs j
        on j.id = (item.value->>'id')::uuid
       and j.status = 'running'
       and j.attempt_count = (item.value->>'attempt_count')::integer
       and j.locked_at = (item.value->>'locked_at')::timestamptz
       and j.locked_at >= statement_timestamp() - interval '30 minutes';
    if v_valid_count <> v_snapshot_count then
      return;
    end if;

    return query
    select j.*
      from jsonb_array_elements(v_receipt.snapshot) with ordinality as item(value, ordinal)
      join public.auction_enrichment_jobs j
        on j.id = (item.value->>'id')::uuid
       and j.status = 'running'
       and j.attempt_count = (item.value->>'attempt_count')::integer
       and j.locked_at = (item.value->>'locked_at')::timestamptz
       and j.locked_at >= statement_timestamp() - interval '30 minutes'
     order by item.ordinal;
    return;
  end if;

  -- A long provider backoff is persisted outside the worker process.  The
  -- direct DB writer and this RPC use the same short transaction lock, so a
  -- new request cannot slip between the backoff check and the family claim.
  perform pg_advisory_xact_lock(
    hashtextextended('immojudis:queue-claim-backoff', 0)
  );
  select queue_claim_not_before
    into v_queue_claim_not_before
    from public.auction_pipeline_control
   where id;
  if v_queue_claim_not_before is not null
     and v_queue_claim_not_before > statement_timestamp() then
    return;
  end if;

  -- The family RPC and receipt insert are in this same transaction.  A
  -- rollback before the insert leaves the request reusable; once the receipt
  -- commits, all later deliveries are replay-only.
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'ordinal', claimed.ordinal,
               'id', claimed.id,
               'attempt_count', claimed.attempt_count,
               'locked_at', claimed.locked_at
             ) order by claimed.ordinal
           ),
           '[]'::jsonb
         )
    into v_snapshot
    from (
      select row_number() over () as ordinal, claimed.*
        from public.claim_auction_enrichment_jobs_family(v_family, v_limit) as claimed
    ) claimed;

  insert into app_private.auction_enrichment_claim_receipts
    (request_id, family, claim_limit, snapshot)
  values (p_request_id, v_family, v_limit, v_snapshot);

  -- Return the same live leases that were recorded in the receipt.  This also
  -- keeps an empty claim a normal successful response.
  select count(*)
    into v_snapshot_count
    from jsonb_array_elements(v_snapshot);
  if v_snapshot_count = 0 then
    return;
  end if;

  return query
  select j.*
    from jsonb_array_elements(v_snapshot) with ordinality as item(value, ordinal)
    join public.auction_enrichment_jobs j
      on j.id = (item.value->>'id')::uuid
     and j.status = 'running'
     and j.attempt_count = (item.value->>'attempt_count')::integer
     and j.locked_at = (item.value->>'locked_at')::timestamptz
     and j.locked_at >= statement_timestamp() - interval '30 minutes'
   order by item.ordinal;
end;
$$;

revoke all on function public.claim_auction_enrichment_jobs_request(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_auction_enrichment_jobs_request(uuid, text, integer)
  to service_role;

notify pgrst, 'reload schema';

commit;
