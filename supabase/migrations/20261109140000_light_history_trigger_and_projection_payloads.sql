begin;

set local lock_timeout = '5s';

-- Allègement des écritures d'auction_sales, suite des arrêts de la base pour manque de mémoire (27-29/10/2026,
-- migration 20261109100000).
--
-- 1. log_auction_sale_change convertissait l'ancienne et la nouvelle ligne entières en jsonb (to_jsonb(old),
--    to_jsonb(new)), données brutes comprises, puis écartait raw_payload, observations et raw_text de la
--    comparaison. Les colonnes écartées sont maintenant vidées sur une copie locale avant la conversion : le
--    journal reste identique (mêmes colonnes comparées, mêmes empreintes), sans recopier quelques centaines de Ko
--    de JSON deux fois par écriture.
-- 2. properties et judicial_sales recopiaient raw_payload d'auction_sales à chaque publication. Rien ne le lit
--    (ni l'application, ni les vues, ni le pipeline, qui ne l'écrit plus : sale_row_builders) : il ne garde que la
--    marque de quarantaine.

create or replace function public.log_auction_sale_change()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  changed jsonb;
  new_row public.auction_sales := new;
  old_row public.auction_sales := old;
begin
  -- Never compared (excluded below): emptied before the row is turned into jsonb.
  new_row.raw_payload := null;
  old_row.raw_payload := null;
  new_row.observations := null;
  old_row.observations := null;
  new_row.raw_text := null;
  old_row.raw_text := null;

  select coalesce(
    jsonb_object_agg(
      current_value.key,
      case
        when jsonb_typeof(current_value.value) in ('object', 'array')
          or pg_column_size(current_value.value) > 2048
        then jsonb_build_object(
          'kind', 'changed_value_fingerprint',
          'size_bytes', pg_column_size(current_value.value),
          'md5', md5(current_value.value::text)
        )
        else current_value.value
      end
    ),
    '{}'::jsonb
  )
  into changed
  from jsonb_each(to_jsonb(new_row)) as current_value(key, value)
  left join jsonb_each(to_jsonb(old_row)) as previous_value(key, value)
    on previous_value.key = current_value.key
  where current_value.key not in (
      'updated_at', 'last_seen_at',
      'raw_payload', 'observations', 'last_run_id', 'raw_text',
      'score_factors', 'quality_flags', 'investment_summary', 'dedupe_confidence',
      'investment_score', 'score_confidence', 'sale_procedure'
    )
    and current_value.key not like 'premium\_readiness\_%'
    and current_value.key not like 'catalogue\_%'
    and current_value.key not like 'retention\_deadline%'
    and current_value.value is distinct from previous_value.value;

  if changed <> '{}'::jsonb then
    insert into public.auction_sale_history (source_url, changed_at, changed_fields)
    values (new.source_url, statement_timestamp(), changed);
  end if;
  return new;
end;
$function$;

-- Seule la marque de quarantaine reste (les deux tables sont lisibles sous RLS par les comptes Analyse).
update public.properties
set raw_payload = case
  when raw_payload ? 'publication_quarantine'
    then jsonb_build_object('publication_quarantine', raw_payload->'publication_quarantine')
  else '{}'::jsonb
end
where raw_payload - 'publication_quarantine' <> '{}'::jsonb;

update public.judicial_sales
set raw_payload = case
  when raw_payload ? 'publication_quarantine'
    then jsonb_build_object('publication_quarantine', raw_payload->'publication_quarantine')
  else '{}'::jsonb
end
where raw_payload - 'publication_quarantine' <> '{}'::jsonb;

commit;
