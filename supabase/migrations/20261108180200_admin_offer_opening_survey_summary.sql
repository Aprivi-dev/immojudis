begin;

set local lock_timeout = '5s';

-- Réponses du questionnaire de la liste d'attente, lues en agrégats pour la page « Pilotage » (point 88 de la
-- session du 27/10/2026). Les colonnes survey_* de offer_opening_notifications (20261028120200) n'étaient lues
-- que par le compte lui-même : le Pilotage ne comptait que les demandes.
--
-- Rendu : la répartition par profil, la médiane des deux repères de prix (masquée, c'est-à-dire nulle, sous 10
-- réponses : une médiane de quelques personnes les désigne), le nombre d'acceptants d'un entretien. Aucune ligne
-- individuelle, aucun email, aucun identifiant. Les administrateurs ne sont comptés nulle part. Seules les
-- demandes actives (notify_enabled, non retirées) comptent : un retrait efface déjà les réponses côté
-- application, la condition est une seconde garde.
--
-- Les repères de prix sont déclaratifs et viennent d'une liste d'attente qui s'est elle-même choisie : ils ne
-- mesurent pas une intention d'achat (compte-rendu du 20/10/2026). Le nombre exact de réponses est rendu pour
-- que la page puisse l'écrire à côté de la médiane.
--
-- Même contrat que public.admin_pilotage_summary : SECURITY DEFINER à search_path vide, service_role seul.
create or replace function public.admin_offer_opening_survey_summary(
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with answers as (
    select
      request.survey_profile,
      request.survey_sales_per_month,
      request.survey_price_too_expensive_eur,
      request.survey_price_cheap_eur,
      request.survey_interview_accepted
    from public.offer_opening_notifications request
    where request.notify_enabled
      and request.revoked_at is null
      and request.survey_answered_at is not null
      and request.survey_answered_at <= p_now
      and not exists (
        select 1
        from public.user_profiles profile
        where profile.user_id = request.user_id
          and profile.user_role = 'admin'
      )
  )
  select pg_catalog.jsonb_build_object(
    'generated_at', p_now,
    'min_median_answers', 10,
    'answered', (select pg_catalog.count(*) from answers),
    'profiles', pg_catalog.jsonb_build_object(
      'particulier', (select pg_catalog.count(*) from answers where survey_profile = 'particulier'),
      'marchand_de_biens', (select pg_catalog.count(*) from answers where survey_profile = 'marchand_de_biens'),
      'avocat', (select pg_catalog.count(*) from answers where survey_profile = 'avocat'),
      'autre', (select pg_catalog.count(*) from answers where survey_profile = 'autre'),
      'unanswered', (select pg_catalog.count(*) from answers where survey_profile is null)
    ),
    'price_too_expensive', pg_catalog.jsonb_build_object(
      'answers', (select pg_catalog.count(survey_price_too_expensive_eur) from answers),
      'median_eur', (
        select case
          when pg_catalog.count(survey_price_too_expensive_eur) >= 10
            then pg_catalog.percentile_cont(0.5) within group (order by survey_price_too_expensive_eur)
        end
        from answers
      )
    ),
    'price_cheap', pg_catalog.jsonb_build_object(
      'answers', (select pg_catalog.count(survey_price_cheap_eur) from answers),
      'median_eur', (
        select case
          when pg_catalog.count(survey_price_cheap_eur) >= 10
            then pg_catalog.percentile_cont(0.5) within group (order by survey_price_cheap_eur)
        end
        from answers
      )
    ),
    'interview_accepted', (select pg_catalog.count(*) from answers where survey_interview_accepted)
  );
$function$;

revoke all on function public.admin_offer_opening_survey_summary(timestamptz)
  from public, anon, authenticated;
grant execute on function public.admin_offer_opening_survey_summary(timestamptz) to service_role;

comment on function public.admin_offer_opening_survey_summary(timestamptz) is
  'Agrégat admin des réponses du questionnaire de la liste d''attente (service_role seul) : répartition par profil, médiane des deux repères de prix (nulle sous 10 réponses), acceptants d''un entretien. Aucune ligne individuelle. Administrateurs exclus.';

notify pgrst, 'reload schema';

commit;
