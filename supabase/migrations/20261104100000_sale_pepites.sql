begin;

set local lock_timeout = '5s';

-- Pépites : une vente à fort potentiel d'investissement, d'après la règle versionnée « pepite-v1 »
-- (src/lib/pepite-policy.ts, compte-rendu docs/equipe/2026-10-26-plafond-tous-types-et-selection.md).
--
-- Le calcul reste en TypeScript (route planifiée /api/cron/sale-pepites, src/lib/sale-pepites-batch.ts) : c'est
-- le chemin de la fiche (plafond d'enchère, relecture IA, estimation stockée). La base ne stocke que le
-- résultat, dans une table privée, et sert le résultat PUBLIABLE par deux fonctions qui ne rendent jamais un
-- montant.
--
-- MODE (app_private.sale_pepite_settings, valeur initiale « shadow ») :
--   * off    : le traitement planifié ne fait rien ;
--   * shadow : les résultats sont calculés et stockés, les fonctions publiques ne rendent RIEN ;
--   * on     : les fonctions publiques rendent les pépites publiables.
-- Rien n'est visible du public tant que le mode n'est pas « on ». Le passage à « on » se fait par une migration
-- dédiée (revue, CI, workflow « Apply Supabase Migrations » avec confirmation), jamais depuis l'interface.
--
-- LECTURE PUBLIQUE (get_public_sale_pepite, list_public_pepite_sale_ids) : vrai seulement si le mode vaut « on »
-- et, AU MOMENT DE L'APPEL, que
--   * la vente est publiquement visible, à venir (status = 'upcoming') et datée dans le futur ;
--   * la mise à prix est celle de l'évaluation (input_starting_price_eur) ;
--   * l'estimation a toujours le computed_at enregistré, prête ou en cours de rafraîchissement (comme la fiche) :
--     une estimation recalculée, en échec ou indisponible masque la pépite jusqu'à la prochaine évaluation
--     (au plus une heure) ;
--   * l'évaluation date de moins de 36 heures (PEPITE_MAX_EVALUATION_AGE_HOURS) : un traitement en panne ne laisse
--     pas une pépite périmée affichée.
-- Même schéma que list_public_sale_ids_under_market_range (20261030110000) : la logique est une fonction
-- SECURITY DEFINER d'app_private, la fonction de public est une enveloppe SECURITY INVOKER (une fonction
-- SECURITY DEFINER de public exécutable par anon est refusée par supabase/tests/441_function_privileges.sql).
--
-- ADMINISTRATION : public.admin_list_sale_pepites rend les compteurs et la liste des pépites et des presque
-- pépites avec leurs détails. Service_role seul (comme admin_pilotage_summary) : la route /api/admin/pepites
-- vérifie le jeton et le rôle administrateur avant l'appel.
--
-- ARRÊT D'URGENCE : public.suspend_sale_pepites ne sait faire qu'UNE chose, repasser le mode de « on » à
-- « shadow » (par défaut) ou « off ». Elle ne peut jamais ouvrir ni changer un mode qui n'est pas « on » :
-- l'ouverture reste une migration dédiée. Service_role seul ; la route POST /api/admin/pepites vérifie le jeton
-- et le rôle administrateur avant l'appel et passe l'identifiant de l'administrateur.
--
-- RETOURS : le signal « pepite » (motifs : amount_too_high, criterion_wrong, not_interesting) rejoint les listes
-- fermées de sale_signal_feedback ; admin_sale_signal_feedback_summary le compte aussi. L'affichage du bouton
-- viendra avec l'affichage public (lot suivant).
--
-- DÉPLOIEMENT : le code applicatif fonctionne avant cette migration (la route planifiée se termine sans rien faire).
--
-- SUPERVISION : toute redéfinition de app_private.evaluate_operational_health doit GARDER l'entrée
-- ('sale-pepites', interval '3 hours') de sa liste de tâches attendues (ajoutée par 20261104100100) : sans elle,
-- une tâche à l'arrêt ne déclencherait plus d'alerte cron.stale.
--
-- RETOUR ARRIÈRE (aucune commande ci-dessous ne s'applique seule en production : à passer par une migration
-- de retour arrière revue). Les trois migrations 20261104 se défont dans l'ordre INVERSE de leur pose :
--   1. D'ABORD 20261104110000 : restaurer app_private.snapshot_sale_market_estimate telle que définie par
--      20261102110100 AVANT de supprimer la table ci-dessous (la fonction de 20261104110000 lit
--      public.auction_sale_pepites : l'erreur serait avalée par son bloc d'exception et plus aucun instantané
--      ne serait écrit, sans alerte) ;
--   2. PUIS 20261104100100 : cron.unschedule('immojudis-sale-pepites'), supprimer
--      app_private.invoke_sale_pepites_endpoint(), retirer ('sale-pepites', interval '3 hours') de
--      app_private.evaluate_operational_health ;
--   3. ENFIN cette migration (20261104100000) : supprimer les lignes de retour de signal « pepite »
--      (delete from public.sale_signal_feedback where signal = 'pepite'), rétablir les deux contraintes de
--      20261030110100 et la fonction de 20261030110300, supprimer public.suspend_sale_pepites(text, uuid),
--      public.admin_list_sale_pepites(timestamptz, integer), public.list_public_pepite_sale_ids(),
--      public.get_public_sale_pepite(uuid), app_private.list_public_pepite_sale_ids(),
--      app_private.get_public_sale_pepite(uuid), public.get_sale_pepite_mode(),
--      app_private.sale_pepite_mode(), puis les tables app_private.sale_pepite_settings et
--      public.auction_sale_pepites. Le code applicatif se termine proprement sans ces objets
--      (skipped: "not_migrated") : le déployer d'abord n'est pas nécessaire.

-- 1. Résultats ----------------------------------------------------------------------------------------------
create table if not exists public.auction_sale_pepites (
  sale_id uuid primary key references public.auction_sales(id) on delete cascade,
  rule_version text not null check (length(btrim(rule_version)) > 0),
  engine_version text not null check (length(btrim(engine_version)) > 0),
  regime_version text,
  status text not null check (status in ('pepite', 'not_pepite', 'not_applicable', 'insufficient')),
  is_pepite boolean not null default false,
  favorable_streak integer not null default 0 check (favorable_streak >= 0),
  frozen_at timestamptz,
  last_favorable_at timestamptz,
  data_missing_since timestamptz,
  reason_codes text[] not null default '{}',
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  input_starting_price_eur numeric check (input_starting_price_eur is null or input_starting_price_eur > 0),
  input_estimate_computed_at timestamptz,
  evaluated_at timestamptz not null default now(),
  first_pepite_at timestamptz,
  -- Une vente hors de la règle n'est jamais publiée.
  constraint auction_sale_pepites_not_applicable_unpublished check (
    status <> 'not_applicable' or not is_pepite
  )
);

comment on table public.auction_sale_pepites is
  'Résultat de la règle pepite-v1 pour une vente en ligne (calcul : /api/cron/sale-pepites). Privé : jamais lisible par anon ni authenticated ; le public ne lit qu''un booléen, par get_public_sale_pepite, et seulement en mode « on ».';
comment on column public.auction_sale_pepites.rule_version is
  'Version de la règle (PEPITE_RULE_VERSION). Une autre version fait réévaluer la vente.';
comment on column public.auction_sale_pepites.engine_version is
  'Version du moteur de plafond (CEILING_ENGINE_VERSION) qui a calculé le plafond de référence.';
comment on column public.auction_sale_pepites.regime_version is
  'Version du régime de frais de la vente (FeeRegime.version) ; nul quand la vente n''a pas de régime.';
comment on column public.auction_sale_pepites.status is
  'Résultat de CETTE évaluation : pepite (tous les critères d''entrée réussis), not_pepite, not_applicable (pas de régime ouvert ou vente pas à venir), insufficient (donnée indispensable manquante).';
comment on column public.auction_sale_pepites.is_pepite is
  'Résultat publiable : après deux évaluations favorables consécutives, avec hystérésis de sortie et gel à J-7 (applyPepiteStability).';
comment on column public.auction_sale_pepites.favorable_streak is
  'Évaluations favorables consécutives (plafonné au nombre requis pour apparaître).';
comment on column public.auction_sale_pepites.frozen_at is
  'Date à laquelle le résultat a été gelé (7 jours avant la vente) ; nul hors gel.';
comment on column public.auction_sale_pepites.last_favorable_at is
  'Date de la dernière évaluation favorable COMPTÉE dans la série d''entrée : deux évaluations ne comptent que si elles sont espacées d''au moins 12 heures (PEPITE_MIN_HOURS_BETWEEN_EVALUATIONS).';
comment on column public.auction_sale_pepites.data_missing_since is
  'Depuis quand une pépite publiée n''a plus de donnée pour être évaluée (estimation absente) : tolérée 24 heures (PEPITE_DATA_GRACE_HOURS), puis elle sort. Nul sinon.';
comment on column public.auction_sale_pepites.reason_codes is
  'Un code par critère évalué (pass:<critère> ou fail:<critère>) et les codes de stabilité (stab:...).';
comment on column public.auction_sale_pepites.details is
  'Détail PRIVÉ : plafond de référence, prix probable, fourchette, part B, ratio C, effectif et fiabilité de la cohorte. Jamais publié, jamais journalisé.';
comment on column public.auction_sale_pepites.input_starting_price_eur is
  'Mise à prix de la vente lue par l''évaluation : la lecture publique exige qu''elle n''ait pas changé.';
comment on column public.auction_sale_pepites.input_estimate_computed_at is
  'computed_at de l''estimation de marché utilisée : la lecture publique exige qu''elle n''ait pas été recalculée.';

create index if not exists auction_sale_pepites_published_idx
  on public.auction_sale_pepites (sale_id)
  where is_pepite;
-- Pas d'index sur le statut : aucune requête ne filtre par statut seul (le traitement planifié lit toute la table
-- par clé, l'administration la parcourt en entier pour ses compteurs).

alter table public.auction_sale_pepites enable row level security;

revoke all on table public.auction_sale_pepites from public, anon, authenticated;
grant select, insert, update on table public.auction_sale_pepites to service_role;

drop policy if exists auction_sale_pepites_service_role on public.auction_sale_pepites;
create policy auction_sale_pepites_service_role
  on public.auction_sale_pepites
  for all to service_role
  using (true)
  with check (true);

-- 2. Mode ---------------------------------------------------------------------------------------------------
create table if not exists app_private.sale_pepite_settings (
  singleton boolean primary key default true check (singleton),
  mode text not null default 'shadow' check (mode in ('off', 'shadow', 'on')),
  updated_at timestamptz not null default statement_timestamp(),
  updated_by uuid references auth.users (id) on delete set null
);

comment on table app_private.sale_pepite_settings is
  'Mode des pépites (une seule ligne) : off (rien), shadow (calcul et stockage, rien de public), on (lecture publique). Valeur initiale : shadow.';

-- Valeur initiale « shadow ». Rejouer la migration ne remet jamais le mode à « shadow » s'il a été changé.
insert into app_private.sale_pepite_settings (singleton, mode)
values (true, 'shadow')
on conflict (singleton) do nothing;

alter table app_private.sale_pepite_settings enable row level security;
revoke all on table app_private.sale_pepite_settings from public, anon, authenticated;

create or replace function app_private.sale_pepite_mode()
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  -- Fermé par défaut : sans ligne, le mode est « off ».
  select coalesce(
    (select settings.mode from app_private.sale_pepite_settings settings where settings.singleton),
    'off'
  );
$function$;

revoke all on function app_private.sale_pepite_mode() from public, anon, authenticated;
grant execute on function app_private.sale_pepite_mode() to service_role;

comment on function app_private.sale_pepite_mode() is
  'Mode des pépites : off, shadow ou on (off sans ligne). Lu par le traitement planifié et par les fonctions publiques ; jamais ouvert à anon.';

-- Lecture du mode par l'application (serveur Next.js, rôle service_role), sur le modèle de
-- get_launch_offer_status.
create or replace function public.get_sale_pepite_mode()
returns text
language sql
stable
security invoker
set search_path = ''
as $function$
  select app_private.sale_pepite_mode();
$function$;

revoke all on function public.get_sale_pepite_mode() from public, anon, authenticated;
grant execute on function public.get_sale_pepite_mode() to service_role;

-- 3. Lecture publique : un booléen, jamais un montant -----------------------------------------------------------
create or replace function app_private.get_public_sale_pepite(p_sale_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
    (
      select true
      from public.auction_sale_pepites p
      join public.auction_sales s on s.id = p.sale_id
      where p.sale_id = p_sale_id
        and p.is_pepite
        and app_private.sale_pepite_mode() = 'on'
        and app_private.auction_sale_is_publicly_visible(s.id)
        and s.status = 'upcoming'
        and s.sale_date > pg_catalog.now()
        -- Le prix n'a pas changé depuis l'évaluation.
        and s.starting_price_eur is not null
        and s.starting_price_eur = p.input_starting_price_eur
        -- L'estimation est celle de l'évaluation : jamais recalculée (même computed_at) ; un rafraîchissement
        -- en cours (pending, processing) garde l'ancienne estimation lisible, comme sur la fiche, mais une
        -- estimation en échec ou indisponible masque la pépite.
        and exists (
          select 1
          from public.auction_sale_market_estimates e
          where e.auction_sale_id = s.id
            and e.status in ('ready', 'pending', 'processing')
            and e.computed_at is not null
            and e.computed_at = p.input_estimate_computed_at
        )
        -- L'évaluation est récente (PEPITE_MAX_EVALUATION_AGE_HOURS).
        and p.evaluated_at > pg_catalog.now() - interval '36 hours'
      limit 1
    ),
    false
  );
$function$;

revoke all on function app_private.get_public_sale_pepite(uuid) from public, anon, authenticated;
grant execute on function app_private.get_public_sale_pepite(uuid) to anon, authenticated, service_role;

comment on function app_private.get_public_sale_pepite(uuid) is
  'Vrai seulement si le mode des pépites est « on » et que la vente est une pépite publiable AU MOMENT DE L''APPEL : publique, à venir et datée dans le futur, mise à prix inchangée, estimation inchangée (prête ou en cours de rafraîchissement), évaluation de moins de 36 h. Jamais un montant.';

create or replace function app_private.list_public_pepite_sale_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select p.sale_id
  from public.auction_sale_pepites p
  -- Le mode est lu une fois (sous-requête évaluée une seule fois), pas pour chaque pépite ; la garde par vente
  -- reste dans get_public_sale_pepite, qui le relit : une seule garde interne.
  where (select app_private.sale_pepite_mode()) = 'on'
    and p.is_pepite
    and app_private.get_public_sale_pepite(p.sale_id)
  order by p.sale_id
  limit 5000;
$function$;

revoke all on function app_private.list_public_pepite_sale_ids() from public, anon, authenticated;
grant execute on function app_private.list_public_pepite_sale_ids() to anon, authenticated, service_role;

create or replace function public.get_public_sale_pepite(p_sale_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $function$
  select app_private.get_public_sale_pepite(p_sale_id);
$function$;

revoke all on function public.get_public_sale_pepite(uuid) from public;
grant execute on function public.get_public_sale_pepite(uuid) to anon, authenticated, service_role;

comment on function public.get_public_sale_pepite(uuid) is
  'Vrai si la vente est une pépite publiable (mode « on » seulement, gardes à la lecture). Jamais un montant.';

create or replace function public.list_public_pepite_sale_ids()
returns setof uuid
language sql
stable
set search_path = ''
as $function$
  select app_private.list_public_pepite_sale_ids();
$function$;

revoke all on function public.list_public_pepite_sale_ids() from public;
grant execute on function public.list_public_pepite_sale_ids() to anon, authenticated, service_role;

comment on function public.list_public_pepite_sale_ids() is
  'Identifiants des pépites publiables (mode « on » seulement, mêmes gardes que get_public_sale_pepite), 5 000 au plus. Aucun montant.';

-- Arrêt d'urgence (voir l'en-tête) : de « on » vers « shadow » ou « off », rien d'autre. Rend le mode obtenu :
-- si le mode n'était pas « on », il est rendu tel quel, sans changement.
create or replace function public.suspend_sale_pepites(
  p_mode text default 'shadow',
  p_user_id uuid default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_current text;
begin
  if p_mode is null or p_mode not in ('shadow', 'off') then
    raise exception using errcode = '22023', message = 'The target mode must be shadow or off.';
  end if;

  select settings.mode into v_current
  from app_private.sale_pepite_settings settings
  where settings.singleton
  for update;

  if v_current is distinct from 'on' then
    return coalesce(v_current, 'off');
  end if;

  update app_private.sale_pepite_settings settings
     set mode = p_mode,
         -- Un identifiant inconnu ne fait pas échouer l'arrêt d'urgence : la colonne reste nulle.
         updated_by = (select u.id from auth.users u where u.id = p_user_id),
         updated_at = statement_timestamp()
   where settings.singleton;
  return p_mode;
end;
$function$;

revoke all on function public.suspend_sale_pepites(text, uuid) from public, anon, authenticated;
grant execute on function public.suspend_sale_pepites(text, uuid) to service_role;

comment on function public.suspend_sale_pepites(text, uuid) is
  'Arrêt d''urgence des pépites (service_role seul ; la route admin vérifie le rôle) : repasse le mode de « on » à « shadow » ou « off », jamais l''inverse ; sans effet si le mode n''est pas « on ». Rend le mode obtenu.';

-- 4. Administration -----------------------------------------------------------------------------------------
-- Compteurs par type de vente, puis la liste des pépites, des pépites à confirmer (une évaluation favorable de
-- plus à attendre) et des « presque pépites » (un seul critère manqué), avec leurs détails. Service_role seul :
-- la route /api/admin/pepites vérifie le jeton et le rôle administrateur. Ne concerne que les ventes encore
-- publiquement visibles.
create or replace function public.admin_list_sale_pepites(
  p_now timestamptz default statement_timestamp(),
  p_limit integer default 300
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with evaluated as (
    -- Sans la colonne « details » (un JSON par ligne) : elle n'est lue que pour les lignes retenues plus bas.
    select
      p.sale_id,
      p.status,
      p.is_pepite,
      p.reason_codes,
      -- Type de vente d'après la colonne de la vente, jamais d'après le détail privé de l'évaluation.
      case s.sale_venue_type
        when 'tribunal' then 'tribunal'
        when 'notary' then 'notary'
        else 'other'
      end as venue,
      (
        select pg_catalog.count(*)
        from pg_catalog.unnest(p.reason_codes) as code
        where code like 'fail:%'
      ) as missed_count
    from public.auction_sale_pepites p
    join public.auction_sales s on s.id = p.sale_id
    where app_private.auction_sale_is_publicly_visible(s.id)
  ),
  venues as (
    select venue from (values ('tribunal'), ('notary'), ('other')) as v(venue)
  ),
  counters as (
    select
      venues.venue,
      pg_catalog.count(e.sale_id) as evaluated,
      pg_catalog.count(e.sale_id) filter (where e.is_pepite) as pepites,
      pg_catalog.count(e.sale_id) filter (where e.status = 'pepite' and not e.is_pepite) as pending,
      pg_catalog.count(e.sale_id) filter (where e.status = 'not_pepite' and not e.is_pepite) as not_pepite,
      pg_catalog.count(e.sale_id) filter (where e.status = 'not_applicable') as not_applicable,
      pg_catalog.count(e.sale_id) filter (where e.status = 'insufficient') as insufficient,
      pg_catalog.count(e.sale_id) filter (
        where e.status in ('pepite', 'not_pepite') or e.is_pepite
      ) as evaluable,
      pg_catalog.count(e.sale_id) filter (
        where e.status = 'not_pepite' and e.missed_count = 1 and 'fail:gap_significant' = any (e.reason_codes)
      ) as only_gap_guard
    from venues
    left join evaluated e on e.venue = venues.venue
    group by venues.venue
  ),
  retained as (
    select e.sale_id, e.venue
    from evaluated e
    where e.is_pepite
      or e.status = 'pepite'
      or (e.status = 'not_pepite' and e.missed_count = 1)
  ),
  listed as (
    select
      p.sale_id,
      p.status,
      p.is_pepite,
      p.favorable_streak,
      p.frozen_at,
      p.reason_codes,
      p.details,
      p.evaluated_at,
      p.first_pepite_at,
      r.venue,
      s.title,
      s.city,
      s.tribunal,
      s.sale_venue_type,
      s.starting_price_eur,
      s.sale_date
    from retained r
    join public.auction_sale_pepites p on p.sale_id = r.sale_id
    join public.auction_sales s on s.id = r.sale_id
    order by
      p.is_pepite desc,
      (p.status = 'pepite') desc,
      case when pg_catalog.jsonb_typeof(p.details -> 'costRatio') = 'number'
        then (p.details ->> 'costRatio')::numeric
      end asc nulls last,
      p.sale_id
    limit greatest(1, least(coalesce(p_limit, 300), 1000))
  )
  select pg_catalog.jsonb_build_object(
    'generated_at', p_now,
    'mode', app_private.sale_pepite_mode(),
    'counters', coalesce(
      (
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'venue', c.venue,
            'evaluated', c.evaluated,
            'pepites', c.pepites,
            'pending', c.pending,
            'not_pepite', c.not_pepite,
            'not_applicable', c.not_applicable,
            'insufficient', c.insufficient,
            'evaluable', c.evaluable,
            'only_gap_guard', c.only_gap_guard
          )
          order by case c.venue when 'tribunal' then 1 when 'notary' then 2 else 3 end
        )
        from counters c
      ),
      '[]'::jsonb
    ),
    'rows', coalesce(
      (
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'sale_id', l.sale_id,
            'status', l.status,
            'is_pepite', l.is_pepite,
            'favorable_streak', l.favorable_streak,
            'frozen_at', l.frozen_at,
            'reason_codes', l.reason_codes,
            'details', l.details,
            'evaluated_at', l.evaluated_at,
            'first_pepite_at', l.first_pepite_at,
            'venue', l.venue,
            'title', l.title,
            'city', l.city,
            'tribunal', l.tribunal,
            'sale_venue_type', l.sale_venue_type,
            'starting_price_eur', l.starting_price_eur,
            'sale_date', l.sale_date
          )
          order by
            l.is_pepite desc,
            (l.status = 'pepite') desc,
            case when pg_catalog.jsonb_typeof(l.details -> 'costRatio') = 'number'
              then (l.details ->> 'costRatio')::numeric
            end asc nulls last,
            l.sale_id
        )
        from listed l
      ),
      '[]'::jsonb
    )
  );
$function$;

revoke all on function public.admin_list_sale_pepites(timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.admin_list_sale_pepites(timestamptz, integer) to service_role;

comment on function public.admin_list_sale_pepites(timestamptz, integer) is
  'Page d''administration des pépites (service_role seul) : mode, compteurs par type de vente, pépites, pépites à confirmer et presque pépites avec leurs détails privés. Ventes publiquement visibles seulement.';

-- 5. Retours « Utile / Pas pertinent » sur le signal « pepite » ---------------------------------------------
-- Motifs de la liste fermée : amount_too_high (« Montant trop haut »), criterion_wrong (« Un critère est faux »),
-- not_interesting (« Peu intéressant »). Les contraintes sont réécrites (les lignes existantes restent valides :
-- elles ne portent que les deux signaux d'origine).
alter table public.sale_signal_feedback
  drop constraint if exists sale_signal_feedback_signal_check;
alter table public.sale_signal_feedback
  add constraint sale_signal_feedback_signal_check check (
    signal in ('market_gap_band', 'points_to_verify', 'pepite')
  );

alter table public.sale_signal_feedback
  drop constraint if exists sale_signal_feedback_reason_check;
-- Chaque branche est vraie ou fausse, jamais nulle : un CHECK à résultat nul passerait.
alter table public.sale_signal_feedback
  add constraint sale_signal_feedback_reason_check check (
    reason is null
    or (
      value = 'not_relevant'
      and (
        (signal = 'market_gap_band' and reason in ('estimate_too_high', 'estimate_too_low'))
        or (signal = 'points_to_verify' and reason in ('point_wrong', 'point_missing'))
        or (signal = 'pepite' and reason in ('amount_too_high', 'criterion_wrong', 'not_interesting'))
      )
    )
  );

comment on table public.sale_signal_feedback is
  'Retours « Utile » / « Pas pertinent » des comptes connectés sur la bande d''écart au marché, les points à vérifier et le repère Pépite, avec un motif en liste fermée. Pas de donnée libre. Conservés 90 jours (run_data_retention). Aucun accès pour anon ni authenticated ; lus seulement en agrégats par admin_sale_signal_feedback_summary.';

-- Même fonction que 20261030110300, avec le signal « pepite » en plus.
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
