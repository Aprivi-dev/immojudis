-- MANUAL PRODUCTION MAINTENANCE. Do not place this file in supabase/migrations.
--
-- Run only after 20260929124000_source_detail_exclusion_guard.sql has been
-- applied and after reviewing every result emitted by the verification
-- queries. The transaction is deliberately bounded to the six audited job
-- IDs and one exact AGRASC seller sale ID. The five source-not-found rows are
-- valid only before their seven-day expiry; rerun an inventory recheck before
-- renewing or reactivating them.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

create temporary table _expected_source_detail_exclusions (
  job_id uuid primary key,
  source_name text not null,
  source_url text not null
) on commit drop;

insert into _expected_source_detail_exclusions (job_id, source_name, source_url)
values
  (
    'c4be8774-db69-4323-aa3e-6e0841de8fb5',
    'agrasc',
    'https://www.agorastore.fr/ventes-occasions/vendeur/agrascimmo'
  ),
  (
    '9f608de1-0a22-409d-9847-11d6963ae276',
    'cessions_etat',
    'https://cessions.immobilier-etat.gouv.fr/biens/maison-dhabitation-au-mans-72-villa-de-la-cote'
  ),
  (
    '5a830a8f-b0e5-4388-8a9d-575e75f94e7f',
    'notaires',
    'https://www.immo-interactif.fr/encheres-en-ligne/appartement/paris-03-75003/2041438'
  ),
  (
    '46abb2a7-f3b6-4e5f-b74c-6d0b00b7c0a7',
    'notaires',
    'https://www.immo-interactif.fr/encheres-en-ligne/appartement/paris-09-75009/2059508'
  ),
  (
    '4f02febf-ec48-4165-9e37-da711d42c86e',
    'notaires',
    'https://www.immo-interactif.fr/encheres-en-ligne/maison/caumont-sur-durance-84/2080922'
  ),
  (
    '8337251f-aa38-4ccc-84cc-e1f675e39547',
    'notaires',
    'https://www.immo-interactif.fr/encheres-en-ligne/maison/les-corvees-les-yys-28/2025069'
  );

do $preflight$
declare
  registry_count integer;
  job_count integer;
  mismatched_jobs integer;
  seller_count integer;
begin
  select count(*)
    into registry_count
    from _expected_source_detail_exclusions expected
    join public.source_detail_exclusions exclusion
      on exclusion.source_name = expected.source_name
     and exclusion.source_url = expected.source_url
     and exclusion.active
     and (
       exclusion.expires_at is null
       or exclusion.expires_at > statement_timestamp()
     );
  if registry_count <> 6 then
    raise exception
      'Expected six active source_detail exclusions, found %',
      registry_count;
  end if;

  select count(*)
    into job_count
    from _expected_source_detail_exclusions expected
    join public.auction_enrichment_jobs job
      on job.id = expected.job_id
     and job.job_type = 'source_detail'
     and job.detail_source_name = expected.source_name
     and job.detail_source_url = expected.source_url;
  if job_count <> 6 then
    raise exception
      'Expected six exact audited source_detail jobs, found %',
      job_count;
  end if;

  select count(*)
    into mismatched_jobs
    from _expected_source_detail_exclusions expected
    join public.auction_enrichment_jobs job on job.id = expected.job_id
    where job.source_url is distinct from expected.source_url;
  if mismatched_jobs <> 0 then
    raise exception
      'An audited job ID is attached to an unexpected canonical source URL';
  end if;

  select count(*)
    into seller_count
    from public.auction_sales sale
    where sale.id = '98e9df19-1075-4a98-ae17-f7106400cf54'
      and sale.source_name = 'agrasc'
      and sale.source_url = (
        select source_url
        from _expected_source_detail_exclusions
        where job_id = 'c4be8774-db69-4323-aa3e-6e0841de8fb5'
      );
  if seller_count <> 1 then
    raise exception
      'The expected AGRASC seller sale identity was not found exactly once';
  end if;
end;
$preflight$;

-- Preserve the current raw payload and marker history, while forcing the
-- canonical row out of both authenticated catalogue views.
update public.auction_sales sale
set status = 'quarantined',
    raw_payload = coalesce(sale.raw_payload, '{}'::jsonb)
      || jsonb_build_object(
        'publication_quarantine', coalesce(
          nullif(sale.raw_payload->>'publication_quarantine', ''),
          'source_detail_excluded'
        ),
        'publication_quarantine_reason',
          'operator_seller_catalogue_without_listing_identity',
        'publication_quarantine_source_url', sale.source_url,
        'publication_quarantine_at', statement_timestamp()
      ),
    updated_at = statement_timestamp()
where sale.id = '98e9df19-1075-4a98-ae17-f7106400cf54'
  and sale.source_name = 'agrasc'
  and sale.source_url = 'https://www.agorastore.fr/ventes-occasions/vendeur/agrascimmo';

-- Close only the six audited queue rows. A completed historical row is left
-- terminal and untouched; the expired four-attempt rows retain this audit note.
update public.auction_enrichment_jobs job
set status = 'cancelled',
    locked_at = null,
    last_error = 'Audited source detail exclusion: endpoint unavailable or no listing identity; temporary URLs require inventory recheck after seven days',
    updated_at = statement_timestamp()
from _expected_source_detail_exclusions expected
where job.id = expected.job_id
  and job.job_type = 'source_detail'
  and job.status in ('queued', 'running', 'failed');

do $verify$
declare
  seller_status text;
  seller_marker text;
  active_jobs integer;
begin
  select sale.status, sale.raw_payload->>'publication_quarantine'
    into seller_status, seller_marker
    from public.auction_sales sale
   where sale.id = '98e9df19-1075-4a98-ae17-f7106400cf54';
  if seller_status <> 'quarantined' or nullif(btrim(seller_marker), '') is null then
    raise exception
      'AGRASC seller quarantine verification failed (status %, marker %)',
      seller_status,
      seller_marker;
  end if;

  select count(*)
    into active_jobs
    from _expected_source_detail_exclusions expected
    join public.auction_enrichment_jobs job on job.id = expected.job_id
   where job.status in ('queued', 'running', 'failed');
  if active_jobs <> 0 then
    raise exception
      'Audited source-detail jobs remain nonterminal: %',
      active_jobs;
  end if;
end;
$verify$;

select sale.id,
       sale.source_name,
       sale.source_url,
       sale.status,
       sale.raw_payload->>'publication_quarantine' as publication_quarantine,
       (select count(*)
        from public.v_auction_sales_app app
        where app.source_url = sale.source_url) as app_view_rows,
       (select count(*)
        from public.v_auction_sales_discovery discovery
        where discovery.id = sale.id) as discovery_view_rows
from public.auction_sales sale
where sale.id = '98e9df19-1075-4a98-ae17-f7106400cf54';

select job.id,
       job.source_url,
       job.status,
       job.last_error
from public.auction_enrichment_jobs job
join _expected_source_detail_exclusions expected on expected.job_id = job.id
order by job.id;

commit;
