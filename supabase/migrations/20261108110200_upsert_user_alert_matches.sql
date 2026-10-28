begin;

set local lock_timeout = '5s';

-- Écriture des correspondances d'alertes sans attente de verrou (chantier W2a, n° 6).
--
-- `user_alert_matches.sale_id` référence `auction_sales(id)` : chaque insertion prend un verrou `FOR KEY SHARE`
-- sur la vente (contrôle de clé étrangère). Une transaction qui tient la vente en `FOR UPDATE` (publication du
-- pipeline avant le passage à `FOR NO KEY UPDATE`, suppression, changement d'URL) fait attendre l'écriture jusqu'au
-- délai de la requête, puis l'alerte entière échoue. Cette fonction, réservée au rôle de service (le moteur d'alertes
-- écrit avec `supabaseAdmin`), saute les ventes dont la ligne est verrouillée en écriture (`for key share skip
-- locked`) au lieu d'attendre. Elle saute aussi une vente disparue entre-temps (purgée ou fusionnée), qui faisait
-- échouer l'alerte pour toujours avec une erreur 23503.
--
-- Elle rend les lignes écrites (toutes les colonnes, comme `upsert(...).select("*")`). Le code compare les ventes
-- rendues à celles envoyées : une vente sautée laisse l'alerte « non évaluée » (sa date d'évaluation n'avance pas),
-- elle est rejouée à la passe suivante sans doublon. Les colonnes `read_at` et `dismissed_at` ne sont jamais
-- touchées par la mise à jour, comme avec l'upsert d'origine.
--
-- DÉPLOIEMENT : le code fonctionne avant cette migration (fonction absente : repli sur l'upsert d'origine).
-- RETOUR ARRIÈRE : drop function public.upsert_user_alert_matches(jsonb);

create or replace function public.upsert_user_alert_matches(p_rows jsonb)
returns setof public.user_alert_matches
language sql
volatile
security invoker
set search_path = ''
set lock_timeout = '3s'
as $function$
  with incoming as (
    select
      r.user_id,
      r.alert_id,
      r.sale_id,
      coalesce(r.match_reasons, '{}'::text[]) as match_reasons,
      coalesce(r.match_snapshot, '{}'::jsonb) as match_snapshot,
      coalesce(r.matched_at, pg_catalog.now()) as matched_at
    from pg_catalog.jsonb_populate_recordset(null::public.user_alert_matches, p_rows) r
  ),
  locked as (
    select a.id
    from public.auction_sales a
    where a.id in (select i.sale_id from incoming i)
    for key share skip locked
  )
  insert into public.user_alert_matches as m
    (user_id, alert_id, sale_id, match_reasons, match_snapshot, matched_at)
  select i.user_id, i.alert_id, i.sale_id, i.match_reasons, i.match_snapshot, i.matched_at
  from incoming i
  join locked l on l.id = i.sale_id
  on conflict (alert_id, sale_id) do update
    set user_id = excluded.user_id,
        match_reasons = excluded.match_reasons,
        match_snapshot = excluded.match_snapshot,
        matched_at = excluded.matched_at
  returning m.*;
$function$;

revoke all on function public.upsert_user_alert_matches(jsonb) from public, anon, authenticated;
grant execute on function public.upsert_user_alert_matches(jsonb) to service_role;

comment on function public.upsert_user_alert_matches(jsonb) is
  'Enregistre des correspondances d''alerte (service_role seul) sans attendre un verrou : les ventes verrouillées en écriture ou disparues sont sautées et absentes du résultat. Rend les lignes écrites.';

notify pgrst, 'reload schema';

commit;
