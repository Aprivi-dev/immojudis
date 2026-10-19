-- Liste d'attente qualifiée (point 64) : après « Me prévenir de l'ouverture », trois questions
-- facultatives (profil, ventes étudiées par mois, deux repères de prix) et une case, non cochée par
-- défaut, « J'accepte un entretien de 20 minutes ».
--
-- Mêmes règles que offer_opening_notifications (20261020100000) :
--   * les réponses sont des colonnes de la même ligne : elles suivent la durée de conservation de la
--     demande (purge prévue : 30 jours après un retrait ou l'envoi, 12 mois sans ouverture) et
--     disparaissent avec le compte (user_id ... on delete cascade, et la liste d'effacement de
--     src/lib/privacy-requests.ts) ;
--   * toutes les écritures passent par la route serveur (service_role) : le rôle authenticated ne
--     peut que lire sa propre ligne, il ne peut pas fabriquer la date d'accord à l'entretien ;
--   * rien ne conditionne l'inscription à la liste : chaque colonne est facultative.
-- Le retrait de la demande efface les réponses (code applicatif, buildOfferOpeningPatch).
begin;

set local lock_timeout = '5s';

alter table public.offer_opening_notifications
  add column if not exists survey_profile text,
  add column if not exists survey_sales_per_month integer,
  add column if not exists survey_price_too_expensive_eur integer,
  add column if not exists survey_price_cheap_eur integer,
  add column if not exists survey_interview_accepted boolean not null default false,
  add column if not exists survey_interview_consented_at timestamptz,
  add column if not exists survey_text_version text,
  add column if not exists survey_answered_at timestamptz;

alter table public.offer_opening_notifications
  drop constraint if exists offer_opening_notifications_survey_profile_check,
  drop constraint if exists offer_opening_notifications_survey_sales_check,
  drop constraint if exists offer_opening_notifications_survey_prices_check,
  drop constraint if exists offer_opening_notifications_survey_interview_check,
  drop constraint if exists offer_opening_notifications_survey_version_check,
  add constraint offer_opening_notifications_survey_profile_check
    check (
      survey_profile is null
      or survey_profile in ('particulier', 'marchand_de_biens', 'avocat', 'autre')
    ),
  add constraint offer_opening_notifications_survey_sales_check
    check (survey_sales_per_month is null or survey_sales_per_month between 0 and 500),
  add constraint offer_opening_notifications_survey_prices_check
    check (
      (survey_price_too_expensive_eur is null or survey_price_too_expensive_eur between 0 and 1000)
      and (survey_price_cheap_eur is null or survey_price_cheap_eur between 0 and 1000)
    ),
  -- L'accord à l'entretien et sa date vont ensemble : jamais de date sans accord.
  add constraint offer_opening_notifications_survey_interview_check
    check (survey_interview_accepted = (survey_interview_consented_at is not null)),
  add constraint offer_opening_notifications_survey_version_check
    check (survey_text_version is null or length(survey_text_version) between 1 and 64);

comment on column public.offer_opening_notifications.survey_profile is
  'Réponse facultative : particulier, marchand_de_biens, avocat ou autre.';
comment on column public.offer_opening_notifications.survey_sales_per_month is
  'Réponse facultative : nombre de ventes étudiées par mois.';
comment on column public.offer_opening_notifications.survey_price_too_expensive_eur is
  'Réponse facultative : prix mensuel (euros) au-delà duquel Analyse serait jugé trop cher.';
comment on column public.offer_opening_notifications.survey_price_cheap_eur is
  'Réponse facultative : prix mensuel (euros) auquel Analyse serait jugé bon marché.';
comment on column public.offer_opening_notifications.survey_interview_accepted is
  'Case « J''accepte un entretien de 20 minutes », non cochée par défaut ; vraie seulement après un clic explicite.';
comment on column public.offer_opening_notifications.survey_interview_consented_at is
  'Date du clic sur la case d''entretien (preuve de l''accord) ; nulle tant que la case n''est pas cochée.';
comment on column public.offer_opening_notifications.survey_text_version is
  'Version du texte des questions affiché lors de la dernière réponse.';

notify pgrst, 'reload schema';

commit;
