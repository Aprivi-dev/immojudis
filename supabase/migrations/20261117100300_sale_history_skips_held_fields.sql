begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Registre des pièces, lot R2a, étape A4 (plan du 11/11/2026, section 10 ; annexe 08, point 10, historique).
-- INERTE : held_fields est nulle partout, le journal des ventes ne change pas.
--
-- public.log_auction_sale_change (définition de 20261109140000) compare toutes les colonnes de l'ancienne et de
-- la nouvelle ligne, sauf une liste de colonnes écartées. held_fields n'y était pas : dès qu'un champ serait tenu,
-- public.auction_sale_history (lue par le seul rôle serveur service_role : aucune politique ne l'ouvre aux rôles
-- du navigateur) recevrait une empreinte de la colonne interne à chaque pose, à chaque retrait et à chaque mise à
-- jour de la valeur d'annonce mémorisée, gardée 12 mois après la vente. held_fields est
-- désormais écartée comme raw_payload : vidée sur la copie locale avant la conversion (la provenance, les
-- identifiants de pièce et de décision ne sont jamais convertis) et ajoutée à la liste des clés ignorées.
--
-- Les colonnes tenues (surface, terrain, pièces, occupation) restent journalisées : c'est l'historique normal de
-- la fiche. Conséquence à connaître : la valeur d'une pièce retirée ou opposée reste dans auction_sale_history,
-- comme toute ancienne valeur d'une fiche : 12 mois après le changement, rattachée à la vente par son source_url,
-- y compris après la suppression de la vente (purge existante, voir docs/data-retention-matrix.md).
--
-- Verrous : remplacement d'une fonction (le déclencheur l'appelle par son nom). Aucun verrou sur auction_sales.
-- Possible pendant un import.
--
-- Retour arrière : rétablir la définition de 20261109140000_light_history_trigger_and_projection_payloads.sql.

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
  -- Colonne interne du registre des pièces : jamais recopiée dans l'historique, même en empreinte. Ce sont deux
  -- copies locales de la ligne : la colonne de la table n'est pas écrite ici (l'invariant
  -- held-fields-projection-only n'admet que ces deux affectations à NULL, dans cette fonction).
  new_row.held_fields := null;
  old_row.held_fields := null;

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
      'investment_score', 'score_confidence', 'sale_procedure', 'held_fields'
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

commit;
