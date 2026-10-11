begin;

set local lock_timeout = '5s';

-- Cessions de l'État : une annonce encore publiée par le site officiel sans
-- échéance (« Procédure à venir », ou appel d'offres dont la date limite figure
-- seulement au cahier des charges) n'a pas de sale_date. Jusqu'ici elle était
-- invisible, car la visibilité du catalogue exige une échéance future.
--
-- Règle : une vente sans sale_date est visible quand la pipeline a observé,
-- il y a moins de 14 jours, la fiche active sur le site (marqueur
-- raw_payload.state_listing, écrit par l'extracteur cessions_etat) et que la
-- fin de publication estimée (compte à rebours « Fini dans N jours ») n'est pas
-- dépassée. Une fiche « Expirée » passe au statut past ; une fiche qui disparaît
-- du site cesse d'être rafraîchie et sort du catalogue au bout de 14 jours.
--
-- La rétention n'est PAS modifiée : sale_catalogue_expiry et
-- sale_catalogue_retention_deadline restent nulles pour ces ventes, aucune
-- échéance n'est inventée, donc aucune ligne n'est purgée ni « tombstonée » avec
-- une sale_date nulle (un tel tombstone bloquerait la réimportation).
-- Seul sale_catalogue_entry_is_live, prédicat de visibilité pur (vues
-- catalogue, aperçus de recherche, fiche publique, sitemap), change.

create or replace function app_private.state_listing_is_live(p_raw jsonb)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  select coalesce(
    case
      when p_raw is null or jsonb_typeof(p_raw) <> 'object' then false
      when coalesce(p_raw->>'source_name', '') <> 'cessions_etat' then false
      when jsonb_typeof(p_raw->'state_listing') <> 'object' then false
      when coalesce(p_raw->'state_listing'->>'active', '') <> 'true' then false
      when coalesce(p_raw->'state_listing'->>'observed_at', '')
        !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([.]\d{1,6})?(Z|[+-]\d{2}:\d{2})$' then false
      when coalesce(p_raw->'state_listing'->>'listing_end_estimate', '') !~ '^(\d{4}-\d{2}-\d{2})?$' then false
      else
        (p_raw->'state_listing'->>'observed_at')::timestamptz > current_timestamp - interval '14 days'
        and (p_raw->'state_listing'->>'observed_at')::timestamptz <= current_timestamp + interval '1 day'
        and (
          coalesce(p_raw->'state_listing'->>'listing_end_estimate', '') = ''
          or (p_raw->'state_listing'->>'listing_end_estimate')::date
            >= (current_timestamp at time zone 'Europe/Paris')::date
        )
    end,
    false
  );
$function$;

comment on function app_private.state_listing_is_live(jsonb) is
  'Cessions de l''État sans échéance publiée : fiche observée active depuis moins de 14 jours et fin de publication estimée non dépassée.';

revoke all on function app_private.state_listing_is_live(jsonb) from public, anon, authenticated;
grant execute on function app_private.state_listing_is_live(jsonb) to anon, authenticated, service_role;

-- Same signature, same grants: views and preview functions keep calling it.
create or replace function app_private.sale_catalogue_entry_is_live(
  p_sale_date timestamptz,
  p_raw jsonb
)
returns boolean
language sql
stable
set search_path = ''
as $function$
  select case
    when p_sale_date is null then app_private.state_listing_is_live(p_raw)
    else app_private.sale_catalogue_expiry(p_sale_date, p_raw) > current_timestamp
  end;
$function$;

comment on function app_private.sale_catalogue_entry_is_live(timestamptz, jsonb) is
  'Visibility only: a dated sale is live until its catalogue cutoff; an undated cessions_etat listing is live while state_listing_is_live holds. Retention never reads it.';

commit;
