-- Retour en un clic sur la bande d'écart au marché et sur les points à vérifier (point 67 de la session du
-- 20/10/2026, seconde vague).
--
-- Une personne connectée dit si un signal affiché sur une vente lui a été utile, ou pas pertinent, puis, si
-- elle le souhaite, pourquoi (liste fermée). Pas de mesure anonyme : sans compte, rien n'est écrit.
--
-- Signaux et motifs (listes fermées) :
--   * market_gap_band  : la bande d'écart au marché ; motifs : estimate_too_high, estimate_too_low ;
--   * points_to_verify : la liste des points à vérifier ; motifs : point_wrong, point_missing.
-- Valeurs : useful, not_relevant. Un motif n'existe que pour not_relevant.
--
-- Minimisation : compte, vente, signal, valeur, motif, jour UTC. Aucune colonne libre, aucun JSON, aucune
-- adresse IP, aucun agent utilisateur. Un seul retour par compte, vente, signal et jour UTC : le même jour,
-- un second envoi (typiquement le motif, choisi après « Pas pertinent ») met à jour la ligne du jour au lieu
-- d'en ajouter une.
--
-- Accès : RLS activée sans aucune politique, aucun droit pour anon, authenticated ni public. Seul
-- service_role lit et écrit, par la route serveur POST /api/sales/[id]/signal-feedback. La lecture admin
-- passe par public.admin_sale_signal_feedback_summary (agrégats), jamais par la table.
--
-- Vente : « on delete set null », comme account_product_events. La mesure est gardée, détachée de la vente
-- qui disparaît à la purge du catalogue : les agrégats par signal ne regardent pas la vente. Le piège du
-- 20/10/2026 (un index unique contenant une colonne qui passe à null bloquait la purge des ventes,
-- 20261029100000) est évité : l'unicité du jour est un index PARTIEL « where sale_id is not null », une ligne
-- détachée sort de l'index et ne peut plus entrer en collision.
--
-- Conservation : 90 jours, purgés par public.run_data_retention (migration 20261030110200). Les lignes
-- disparaissent aussi avec le compte (on delete cascade ; src/lib/privacy-requests.ts les efface
-- explicitement).
begin;

set local lock_timeout = '5s';

create table if not exists public.sale_signal_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  sale_id uuid references public.auction_sales(id) on delete set null,
  signal text not null,
  value text not null,
  reason text,
  feedback_day date not null default ((now() at time zone 'UTC')::date),
  created_at timestamptz not null default now(),
  constraint sale_signal_feedback_signal_check check (
    signal in ('market_gap_band', 'points_to_verify')
  ),
  constraint sale_signal_feedback_value_check check (value in ('useful', 'not_relevant')),
  -- Chaque branche est vraie ou fausse, jamais nulle : un CHECK à résultat nul passerait.
  constraint sale_signal_feedback_reason_check check (
    reason is null
    or (
      value = 'not_relevant'
      and (
        (signal = 'market_gap_band' and reason in ('estimate_too_high', 'estimate_too_low'))
        or (signal = 'points_to_verify' and reason in ('point_wrong', 'point_missing'))
      )
    )
  )
);

comment on table public.sale_signal_feedback is
  'Retours « Utile » / « Pas pertinent » des comptes connectés sur la bande d''écart au marché et sur les points à vérifier, avec un motif en liste fermée. Pas de donnée libre. Conservés 90 jours (run_data_retention). Aucun accès pour anon ni authenticated ; lus seulement en agrégats par admin_sale_signal_feedback_summary.';
comment on column public.sale_signal_feedback.sale_id is
  'Vente concernée ; mise à null si la vente est purgée (la mesure est gardée).';
comment on column public.sale_signal_feedback.feedback_day is
  'Jour UTC du retour : un seul retour par compte, vente, signal et jour.';

-- Un retour par compte, vente, signal et jour UTC. Index partiel (voir l'en-tête) : sert d'arbitre à
-- record_sale_signal_feedback (insert ... on conflict ... do update).
create unique index if not exists sale_signal_feedback_once_per_day_idx
  on public.sale_signal_feedback (user_id, sale_id, signal, feedback_day)
  where sale_id is not null;
create index if not exists sale_signal_feedback_time_idx
  on public.sale_signal_feedback (created_at);
create index if not exists sale_signal_feedback_sale_idx
  on public.sale_signal_feedback (sale_id)
  where sale_id is not null;

alter table public.sale_signal_feedback enable row level security;

-- Aucune politique : sans politique, la RLS refuse tout aux rôles qui la subissent. Les droits de table sont
-- retirés en plus (défense en profondeur) ; service_role contourne la RLS et n'a que les droits utiles :
-- lire (agrégats), écrire et corriger le retour du jour (insert ... on conflict do update), supprimer
-- (purge, effacement).
revoke all on table public.sale_signal_feedback from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.sale_signal_feedback to service_role;

-- Seule voie d'écriture de l'application. SECURITY INVOKER : elle s'exécute avec les droits de l'appelant,
-- c'est-à-dire service_role, seul rôle à avoir le droit d'écrire. Rend vrai quand le retour du jour est écrit
-- ou corrigé, faux quand il est refusé (vente absente du catalogue public, plafond du jour atteint). Une
-- combinaison hors liste (signal, valeur, motif) est refusée par les contraintes de la table.
--
-- Garde-fous contre une écriture en masse par un compte : la vente doit être publiquement visible
-- (app_private.auction_sale_is_publicly_visible) et un compte écrit au plus 100 retours par jour UTC (le
-- plafond borne un volume, il ne protège pas un invariant : deux appels simultanés peuvent le dépasser de
-- quelques lignes). Corriger le retour du jour n'est jamais refusé par le plafond.
create or replace function public.record_sale_signal_feedback(
  p_user_id uuid,
  p_sale_id uuid,
  p_signal text,
  p_value text,
  p_reason text default null
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_day date := (pg_catalog.now() at time zone 'UTC')::date;
begin
  if p_user_id is null then
    raise exception using errcode = '22004', message = 'Account is required.';
  end if;
  if p_sale_id is null then
    raise exception using errcode = '22004', message = 'Sale is required.';
  end if;
  if not app_private.auction_sale_is_publicly_visible(p_sale_id) then
    return false;
  end if;

  if not exists (
    select 1
    from public.sale_signal_feedback existing
    where existing.user_id = p_user_id
      and existing.sale_id = p_sale_id
      and existing.signal = p_signal
      and existing.feedback_day = v_day
  ) and (
    select pg_catalog.count(*)
    from public.sale_signal_feedback today
    where today.user_id = p_user_id
      and today.feedback_day = v_day
  ) >= 100 then
    return false;
  end if;

  insert into public.sale_signal_feedback (user_id, sale_id, signal, value, reason, feedback_day)
  values (p_user_id, p_sale_id, p_signal, p_value, p_reason, v_day)
  on conflict (user_id, sale_id, signal, feedback_day) where sale_id is not null
  do update set value = excluded.value, reason = excluded.reason;
  return true;
end;
$$;

revoke all on function public.record_sale_signal_feedback(uuid, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.record_sale_signal_feedback(uuid, uuid, text, text, text)
  to service_role;

comment on function public.record_sale_signal_feedback(uuid, uuid, text, text, text) is
  'Enregistre ou corrige le retour du jour d''un compte sur un signal d''une vente (service_role seul). Un seul par compte, vente, signal et jour UTC ; vente publique requise ; 100 retours au plus par compte et par jour UTC.';

notify pgrst, 'reload schema';

commit;
