begin;

set local lock_timeout = '5s';

-- Retours négatifs lisibles par vente (point 88 de la session du 27/10/2026).
--
-- admin_sale_signal_feedback_summary (20261030110300, 20261104100000) donne le nombre de retours « Un critère
-- est faux » ou « Un point est faux » sans dire sur quelle vente : on ne peut pas corriger la fiche en cause.
-- Cette fonction rend, pour chaque vente, signal et motif, le NOMBRE de retours « Pas pertinent » sur 90 jours.
-- Jamais un compte : ni identifiant, ni nom, ni liste de personnes. Une vente purgée du catalogue (sale_id
-- nul) n'y figure pas. Les administrateurs ne sont comptés nulle part.
--
-- Même contrat que le reste du pilotage : SECURITY DEFINER à search_path vide, service_role seul. Pour le
-- signal « pepite », la version de la règle est celle de la ligne de la vente à la lecture
-- (public.auction_sale_pepites.rule_version) : la table des retours ne garde pas la version en vigueur au
-- moment du retour, la lecture est donc exacte tant qu'une seule version de la règle a servi.
create or replace function public.admin_sale_signal_feedback_by_sale(
  p_now timestamptz default statement_timestamp(),
  p_limit integer default 100
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with feedback as (
    select f.sale_id, f.signal, coalesce(f.reason, 'none') as reason, f.created_at
    from public.sale_signal_feedback f
    where f.value = 'not_relevant'
      and f.sale_id is not null
      and f.created_at > p_now - interval '90 days'
      and f.created_at <= p_now
      and not exists (
        select 1
        from public.user_profiles profile
        where profile.user_id = f.user_id
          and profile.user_role = 'admin'
      )
  ),
  grouped as (
    select
      feedback.sale_id,
      feedback.signal,
      feedback.reason,
      pg_catalog.count(*) as total,
      pg_catalog.max(feedback.created_at) as last_at
    from feedback
    group by feedback.sale_id, feedback.signal, feedback.reason
    order by pg_catalog.count(*) desc, pg_catalog.max(feedback.created_at) desc
    limit greatest(1, least(coalesce(p_limit, 100), 500))
  )
  select pg_catalog.jsonb_build_object(
    'generated_at', p_now,
    'window_days', 90,
    'rows', coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'sale_id', grouped.sale_id,
          'title', sale.title,
          'city', sale.city,
          'department', sale.department,
          'signal', grouped.signal,
          'reason', grouped.reason,
          'count', grouped.total,
          'last_at', grouped.last_at,
          'rule_version', case when grouped.signal = 'pepite' then pepite.rule_version end
        )
        order by grouped.total desc, grouped.last_at desc
      ),
      '[]'::jsonb
    )
  )
  from grouped
  left join public.auction_sales sale on sale.id = grouped.sale_id
  left join public.auction_sale_pepites pepite on pepite.sale_id = grouped.sale_id;
$function$;

revoke all on function public.admin_sale_signal_feedback_by_sale(timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.admin_sale_signal_feedback_by_sale(timestamptz, integer)
  to service_role;

comment on function public.admin_sale_signal_feedback_by_sale(timestamptz, integer) is
  'Retours « Pas pertinent » sur 90 jours par vente, signal et motif (service_role seul) : nombre et date du dernier, version de la règle pour la pépite. Aucun compte. Administrateurs exclus.';

-- Version de la règle jointe à l'agrégat des retours « pepite » : même fonction que 20261104100000, avec
-- 'rule_versions' (nombre de retours par version de règle de la vente à la lecture) en plus pour la pépite.
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
    select f.user_id, f.sale_id, f.signal, f.value, f.reason
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
      ),
      pg_catalog.jsonb_build_object(
        'signal', 'pepite',
        'total', (select pg_catalog.count(*) from feedback where signal = 'pepite'),
        'useful', (select pg_catalog.count(*) from feedback
                    where signal = 'pepite' and value = 'useful'),
        'not_relevant', (select pg_catalog.count(*) from feedback
                          where signal = 'pepite' and value = 'not_relevant'),
        'accounts', (select pg_catalog.count(distinct user_id) from feedback
                      where signal = 'pepite'),
        'reasons', pg_catalog.jsonb_build_object(
          'amount_too_high', (select pg_catalog.count(*) from feedback
                               where signal = 'pepite' and reason = 'amount_too_high'),
          'criterion_wrong', (select pg_catalog.count(*) from feedback
                               where signal = 'pepite' and reason = 'criterion_wrong'),
          'not_interesting', (select pg_catalog.count(*) from feedback
                               where signal = 'pepite' and reason = 'not_interesting')
        ),
        -- Nombre de retours par version de la règle de la vente (ligne actuelle) ; 'unknown' : vente sans
        -- ligne de pépite ou purgée.
        'rule_versions', coalesce(
          (select pg_catalog.jsonb_object_agg(version, total)
             from (
               select coalesce(pepite.rule_version, 'unknown') as version, pg_catalog.count(*) as total
               from feedback
               left join public.auction_sale_pepites pepite on pepite.sale_id = feedback.sale_id
               where feedback.signal = 'pepite'
               group by 1
             ) by_version),
          '{}'::jsonb
        )
      )
    )
  );
$function$;

revoke all on function public.admin_sale_signal_feedback_summary(timestamptz)
  from public, anon, authenticated;
grant execute on function public.admin_sale_signal_feedback_summary(timestamptz) to service_role;

comment on function public.admin_sale_signal_feedback_summary(timestamptz) is
  'Agrégat admin des retours « Utile » / « Pas pertinent » sur 90 jours, par signal (service_role seul) : total, utiles, pas pertinents, comptes distincts, motifs ; pour la pépite, retours par version de la règle. Aucun nom, aucune vente. Administrateurs exclus.';

notify pgrst, 'reload schema';

commit;
