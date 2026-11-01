begin;

set local lock_timeout = '5s';

-- Lot 6, n° 92 : la liste des personnes qui ont accepté un entretien (questionnaire de la liste
-- d'attente, 20261028120200). Jusqu'ici l'administrateur ne voyait que leur NOMBRE
-- (public.admin_offer_opening_survey_summary, 20261108180200) : impossible de les contacter, alors que
-- c'est la raison d'être de la case « J'accepte un entretien ».
--
-- Contenu : pour chaque demande active (notify_enabled, non retirée) dont la personne a coché la case
-- d'accord à l'entretien : la date de l'accord (survey_interview_consented_at, la preuve), le profil
-- déclaré (survey_profile) et l'adresse email du compte (auth.users). Rien d'autre : ni les repères de
-- prix, ni le nombre de ventes étudiées, ni l'identifiant du compte. Les administrateurs sont exclus.
-- Une personne qui retire sa demande ou son accord disparaît de la liste (le retrait efface déjà les
-- réponses côté application ; la condition est une seconde garde, comme pour l'agrégat).
--
-- Lecture seule, service_role seul : le serveur d'application contrôle le rôle administrateur et la
-- double authentification avant l'appel (src/lib/admin-offer-opening-survey.ts). Au plus 500 lignes
-- (200 par défaut), des plus récentes aux plus anciennes. SECURITY DEFINER à search_path vide, comme
-- l'agrégat. Aucune écriture, aucune nouvelle colonne, aucune nouvelle table.
create or replace function public.admin_offer_opening_interviewees(
  p_limit integer default 200
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with accepted as (
    select
      request.survey_interview_consented_at as consented_at,
      request.survey_profile as profile,
      account.email as email
    from public.offer_opening_notifications request
    join auth.users account on account.id = request.user_id
    where request.notify_enabled
      and request.revoked_at is null
      and request.survey_interview_accepted
      and request.survey_interview_consented_at is not null
      and pg_catalog.btrim(coalesce(account.email, '')) <> ''
      and not exists (
        select 1
        from public.user_profiles profile
        where profile.user_id = request.user_id
          and profile.user_role = 'admin'
      )
  ),
  picked as (
    select a.consented_at, a.profile, a.email
    from accepted a
    order by a.consented_at desc, a.email
    limit least(greatest(coalesce(p_limit, 200), 1), 500)
  )
  select pg_catalog.jsonb_build_object(
    'total', (select pg_catalog.count(*) from accepted),
    'interviewees', coalesce(
      (
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'consented_at', p.consented_at,
            'profile', p.profile,
            'email', p.email
          )
          order by p.consented_at desc, p.email
        )
        from picked p
      ),
      '[]'::jsonb
    )
  );
$function$;

revoke all on function public.admin_offer_opening_interviewees(integer)
  from public, anon, authenticated;
grant execute on function public.admin_offer_opening_interviewees(integer) to service_role;

comment on function public.admin_offer_opening_interviewees(integer) is
  'Liste admin des personnes ayant accepté un entretien (service_role seul, lecture seule) : date de l''accord, profil déclaré, email du compte. Demandes actives seulement, administrateurs exclus, 500 lignes au plus. À n''appeler qu''après le contrôle du rôle administrateur par le serveur.';

notify pgrst, 'reload schema';

commit;
