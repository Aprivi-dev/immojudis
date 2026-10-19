-- Mesure du parcours par compte (point 65) : cinq événements enregistrés côté serveur, rattachés au
-- compte, pour la page admin « Pilotage » (agrégats seulement, aucune liste de personnes).
--
-- Événements (liste fermée) :
--   * sale_unlocked          : une vente vient d'être débloquée (un déblocage consommé) ;
--   * quota_reached          : un quota est atteint, avec lequel (detail) : unlocks, favorites, daily ;
--   * bid_ceiling_calculated : la valeur de référence du plafond d'enchère est servie pour une vente ;
--   * calendar_exported      : le fichier .ics de l'audience est téléchargé depuis un compte connecté ;
--   * email_clicked          : clic sur un lien suivi d'un email, avec lequel (detail) : alert, reminder.
--
-- Minimisation : identifiant du compte, type, détail fermé, identifiant de vente (quand il sert) et
-- horodatage. Aucune colonne libre, aucun JSON, aucune adresse IP, aucun agent utilisateur. Un
-- événement identique d'un même compte (même type, même détail, même vente) n'est gardé qu'une fois par
-- jour UTC : un rechargement ou un robot de messagerie ne gonfle pas les chiffres.
--
-- Accès : RLS activée sans aucune politique et aucun droit pour anon, authenticated ni public. Seul
-- service_role lit et écrit, par le serveur Next.js. La lecture admin passe par
-- public.admin_pilotage_summary (agrégats), jamais par la table.
--
-- Conservation : 90 jours, purgés par public.run_data_retention (migration suivante). Les lignes
-- disparaissent aussi avec le compte (on delete cascade).
begin;

set local lock_timeout = '5s';

create table if not exists public.account_product_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null,
  detail text,
  sale_id uuid references public.auction_sales(id) on delete set null,
  occurred_at timestamptz not null default now(),
  constraint account_product_events_type_detail_check check (
    -- Chaque branche est vraie ou fausse, jamais nulle : un CHECK à résultat nul passerait.
    (event_type = 'quota_reached' and coalesce(detail in ('unlocks', 'favorites', 'daily'), false))
    or (event_type = 'email_clicked' and coalesce(detail in ('alert', 'reminder'), false))
    or (event_type in ('sale_unlocked', 'bid_ceiling_calculated', 'calendar_exported') and detail is null)
  ),
  -- Un quota atteint ne désigne aucune vente : il compte des comptes, pas des ventes.
  constraint account_product_events_quota_without_sale_check check (
    event_type <> 'quota_reached' or sale_id is null
  )
);

comment on table public.account_product_events is
  'Événements produit par compte (déblocage, quota atteint, plafond calculé, export agenda, clic d''email). Pas de donnée libre. Conservés 90 jours (run_data_retention). Aucun accès pour anon ni authenticated ; lus seulement en agrégats par admin_pilotage_summary.';
comment on column public.account_product_events.detail is
  'Précision fermée : quota atteint (unlocks, favorites, daily) ou email cliqué (alert, reminder) ; nulle pour les autres événements.';
comment on column public.account_product_events.sale_id is
  'Vente concernée quand elle sert à lire l''événement ; mise à null si la vente est supprimée.';

-- Un événement identique par compte, type, détail, vente et jour UTC. Sert d'arbitre à
-- record_account_product_event (insert ... on conflict do nothing).
create unique index if not exists account_product_events_once_per_day_idx
  on public.account_product_events (
    user_id,
    event_type,
    (coalesce(detail, '')),
    (coalesce(sale_id, '00000000-0000-0000-0000-000000000000'::uuid)),
    ((occurred_at at time zone 'UTC')::date)
  );
create index if not exists account_product_events_type_time_idx
  on public.account_product_events (event_type, occurred_at desc);
create index if not exists account_product_events_time_idx
  on public.account_product_events (occurred_at);
create index if not exists account_product_events_sale_idx
  on public.account_product_events (sale_id)
  where sale_id is not null;

alter table public.account_product_events enable row level security;

-- Aucune politique : sans politique, la RLS refuse tout aux rôles qui la subissent. Les droits de
-- table sont retirés en plus (défense en profondeur) ; service_role contourne la RLS et n'a que les
-- droits utiles : lire (agrégats), écrire (enregistrement) et supprimer (purge). Les privilèges par
-- défaut de Supabase lui donnent tout sur une nouvelle table : ils sont retirés d'abord.
revoke all on table public.account_product_events from public, anon, authenticated, service_role;
grant select, insert, delete on table public.account_product_events to service_role;

-- Début de la mesure : permet à la page « Pilotage » de dire qu'une fenêtre de 30 jours est
-- partielle tant que la mesure n'a pas 30 jours. Une seule ligne ; rejouer la migration ne la
-- déplace jamais.
create table if not exists app_private.account_product_events_measure (
  singleton boolean primary key default true check (singleton),
  started_at timestamptz not null default statement_timestamp()
);

comment on table app_private.account_product_events_measure is
  'Date de début de la mesure des événements par compte (une seule ligne).';

insert into app_private.account_product_events_measure (singleton)
values (true)
on conflict (singleton) do nothing;

alter table app_private.account_product_events_measure enable row level security;
revoke all on table app_private.account_product_events_measure from public, anon, authenticated;

-- Seule voie d'écriture de l'application. SECURITY INVOKER : elle s'exécute avec les droits de
-- l'appelant, c'est-à-dire service_role, seul rôle à avoir le droit d'insérer. Rend vrai quand une
-- ligne est écrite, faux quand l'événement du jour existait déjà. Une combinaison hors liste
-- (type, détail ou vente) est refusée par les contraintes de la table.
create or replace function public.record_account_product_event(
  p_user_id uuid,
  p_event_type text,
  p_detail text default null,
  p_sale_id uuid default null
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_inserted integer;
begin
  if p_user_id is null then
    raise exception using errcode = '22004', message = 'Account is required.';
  end if;

  insert into public.account_product_events (user_id, event_type, detail, sale_id)
  values (p_user_id, p_event_type, p_detail, p_sale_id)
  on conflict do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted > 0;
end;
$$;

revoke all on function public.record_account_product_event(uuid, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.record_account_product_event(uuid, text, text, uuid)
  to service_role;

comment on function public.record_account_product_event(uuid, text, text, uuid) is
  'Enregistre un événement produit pour un compte (service_role seul). Un seul par compte, type, détail, vente et jour UTC.';

notify pgrst, 'reload schema';

commit;
