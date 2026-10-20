begin;

set local lock_timeout = '5s';

-- Agrégat admin des retours sur les signaux d'une vente (point 67) : pour la page « Pilotage », par signal,
-- le nombre de retours, la part d'« Utile », les comptes distincts et le décompte des motifs. Les « point
-- faux » (motif point_wrong de la liste des points à vérifier) y ont leur ligne : /admin/quality n'a pas de
-- file adaptée (elle lit le rapport de qualité du catalogue, pas des retours de personnes).
--
-- Même contrat que public.admin_pilotage_summary (20261029120200) : fonction séparée, service_role seul,
-- SECURITY DEFINER à search_path vide, nombres exacts (la page masque ceux de moins de 5), aucun nom, aucune
-- vente, aucune liste de personnes. Les administrateurs (user_profiles.user_role = 'admin') ne sont comptés
-- nulle part : un administrateur qui teste son propre site n'est pas un utilisateur.
--
-- Fenêtre : les 90 derniers jours, la durée de conservation de la table (la purge supprime au-delà).
-- Les deux signaux sont toujours rendus, même sans retour (zéros).
create or replace function public.admin_sale_signal_feedback_summary(
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with feedback as (
    select f.user_id, f.signal, f.value, f.reason
    from public.sale_signal_feedback f
    where f.created_at > p_now - interval '90 days'
      and f.created_at <= p_now
      and not exists (
        select 1
        from public.user_profiles profile
        where profile.user_id = f.user_id
          and profile.user_role = 'admin'
      )
  )
  select pg_catalog.jsonb_build_object(
    'generated_at', p_now,
    'window_days', 90,
    'signals', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'signal', 'market_gap_band',
        'total', (select pg_catalog.count(*) from feedback where signal = 'market_gap_band'),
        'useful', (select pg_catalog.count(*) from feedback
                    where signal = 'market_gap_band' and value = 'useful'),
        'not_relevant', (select pg_catalog.count(*) from feedback
                          where signal = 'market_gap_band' and value = 'not_relevant'),
        'accounts', (select pg_catalog.count(distinct user_id) from feedback
                      where signal = 'market_gap_band'),
        'reasons', pg_catalog.jsonb_build_object(
          'estimate_too_high', (select pg_catalog.count(*) from feedback
                                 where signal = 'market_gap_band' and reason = 'estimate_too_high'),
          'estimate_too_low', (select pg_catalog.count(*) from feedback
                                where signal = 'market_gap_band' and reason = 'estimate_too_low')
        )
      ),
      pg_catalog.jsonb_build_object(
        'signal', 'points_to_verify',
        'total', (select pg_catalog.count(*) from feedback where signal = 'points_to_verify'),
        'useful', (select pg_catalog.count(*) from feedback
                    where signal = 'points_to_verify' and value = 'useful'),
        'not_relevant', (select pg_catalog.count(*) from feedback
                          where signal = 'points_to_verify' and value = 'not_relevant'),
        'accounts', (select pg_catalog.count(distinct user_id) from feedback
                      where signal = 'points_to_verify'),
        'reasons', pg_catalog.jsonb_build_object(
          'point_wrong', (select pg_catalog.count(*) from feedback
                           where signal = 'points_to_verify' and reason = 'point_wrong'),
          'point_missing', (select pg_catalog.count(*) from feedback
                             where signal = 'points_to_verify' and reason = 'point_missing')
        )
      )
    )
  );
$function$;

revoke all on function public.admin_sale_signal_feedback_summary(timestamptz)
  from public, anon, authenticated;
grant execute on function public.admin_sale_signal_feedback_summary(timestamptz) to service_role;

comment on function public.admin_sale_signal_feedback_summary(timestamptz) is
  'Agrégat admin des retours « Utile » / « Pas pertinent » sur 90 jours, par signal (service_role seul) : total, utiles, pas pertinents, comptes distincts, motifs. Aucun nom, aucune vente. Administrateurs exclus.';

notify pgrst, 'reload schema';

commit;
