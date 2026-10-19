begin;

set local lock_timeout = '5s';

-- Après l'audience : instantané des ventes suivies (point 70 de la session du 18/10/2026, validé le
-- 19/10/2026).
--
-- Une vente suivie (un favori) dont l'audience est passée est supprimée du catalogue par
-- public.purge_expired_auction_sales dès l'instant de l'audience (catalogue_expiry_deadline : l'heure
-- observée, ou minuit à Paris pour une date sans heure), et, par « on delete cascade », le favori avec
-- elle. La personne perdait alors la trace de la vente pendant la fenêtre de surenchère (10 jours).
--
-- Avant la suppression d'une vente dont l'audience est passée, un déclencheur garde pour chaque compte
-- qui la suivait UNE ligne de public.user_followed_sale_snapshots :
--   - les données clés de la vente (titre, commune, tribunal, type de bien, mise à prix, date d'audience,
--     nom de l'avocat tel que publié, source de la fiche) ;
--   - le résultat s'il est connu : « adjugé » ou « inconnu », et le prix d'adjudication SEULEMENT s'il est
--     publié sur la fiche, avec le nom de sa source. Aucun prix n'est déduit ni estimé ;
--   - le statut personnel et l'enchère plafond enregistrés par le compte (20261028190000).
-- La fenêtre de surenchère (date limite) ne se stocke pas : elle se calcule à la lecture, à partir de la
-- date d'audience (src/lib/surenchere-window.ts).
--
-- Règles de source (Licitor et offre) :
--   - L'autorisation de Licitor ne porte que sur des agrégats de prix (docs/model-card-tribunal-
--     statistics.md) : un prix n'est JAMAIS copié dans un instantané quand la fiche vient de Licitor ou
--     cite Licitor (source principale, URL, observations). Le résultat reste « adjugé » ou « inconnu »,
--     sans prix. Le contact de l'avocat (email décodé Licitor possible) n'est pas copié non plus.
--   - Le résultat n'est presque jamais connu à la capture : la vente est supprimée à l'heure de
--     l'audience, avant que les sources publient le prix. L'instantané dit alors « inconnu », il ne
--     devine rien et n'est pas mis à jour après la purge (limite connue, voir le rapport du chantier).
--   - Le prix d'adjudication est un contenu de l'offre Analyse (les vues Découverte et « débloquée » le
--     rendent null). Il n'est donc copié que si le compte a l'accès Analyse (offre de lancement comprise)
--     au moment de la capture ; sinon l'instantané porte adjudication_price_withheld = true et la
--     personne lit « réservé à l'offre Analyse », pas « non connu ».
--   - Une vente reportée, annulée, retirée ou en quarantaine, ou fusionnée dans une autre fiche
--     (app_private.auction_sale_merges : le favori suit la fiche conservée), ne donne pas d'instantané.
--
-- Conservation : BORNÉE à 6 mois après la capture (app_private.followed_sale_snapshot_retention()), la
-- capture ayant lieu à la purge de la vente, c'est-à-dire à l'heure de l'audience. Au plus 12 mois,
-- garanti par une contrainte. Purge par run_data_retention (cron hebdomadaire data-retention). La
-- personne peut aussi supprimer un instantané à tout moment, et l'effacement du compte l'emporte
-- (on delete cascade ; table ajoutée à ERASURE_TABLES). Durée à faire valider (voir le rapport du chantier).

-- 1. Durée de conservation ---------------------------------------------------------------------------
create or replace function app_private.followed_sale_snapshot_retention()
returns interval
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $$
  select interval '6 months';
$$;

revoke all on function app_private.followed_sale_snapshot_retention()
  from public, anon, authenticated;
grant execute on function app_private.followed_sale_snapshot_retention() to service_role;

comment on function app_private.followed_sale_snapshot_retention() is
  'Durée de conservation d''un instantané de vente suivie, à partir de sa capture (à la purge de la vente, c''est-à-dire à l''heure de l''audience). La contrainte user_followed_sale_snapshots_expiry_check la borne à 12 mois.';

-- 2. Table -------------------------------------------------------------------------------------------
-- Pas de clé étrangère vers auction_sales : l'instantané doit survivre à la purge de la vente.
create table if not exists public.user_followed_sale_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  sale_id uuid not null,
  captured_at timestamptz not null default now(),
  expires_at timestamptz not null,
  title text,
  city text,
  department text,
  postal_code text,
  property_type text,
  tribunal_name text,
  sale_venue_type text,
  sale_legal_framework text,
  starting_price_eur numeric,
  sale_date timestamptz,
  lawyer_name text,
  source_name text,
  result_status text not null,
  adjudication_price_eur numeric,
  adjudication_price_source text,
  adjudication_price_withheld boolean not null default false,
  personal_status text,
  bid_ceiling_eur numeric,
  constraint user_followed_sale_snapshots_user_sale_key unique (user_id, sale_id),
  constraint user_followed_sale_snapshots_expiry_check check (
    expires_at > captured_at and expires_at <= captured_at + interval '12 months'
  ),
  constraint user_followed_sale_snapshots_result_check check (
    result_status in ('adjudicated', 'unknown')
  ),
  constraint user_followed_sale_snapshots_price_check check (
    adjudication_price_eur is null
    or (
      adjudication_price_eur > 0
      and adjudication_price_source is not null
      and not adjudication_price_withheld
      and result_status = 'adjudicated'
    )
  ),
  constraint user_followed_sale_snapshots_personal_status_check check (
    personal_status is null
    or personal_status in ('watching', 'reviewing', 'bidding', 'won', 'lost', 'archived')
  ),
  constraint user_followed_sale_snapshots_bid_ceiling_check check (
    bid_ceiling_eur is null or (bid_ceiling_eur >= 0 and bid_ceiling_eur <= 10000000000)
  )
);

comment on table public.user_followed_sale_snapshots is
  'Instantané, gardé dans l''espace d''un compte, d''une vente suivie dont l''audience est passée. Écrit seulement par app_private.snapshot_followed_sale_before_delete (avant la purge de la vente). Conservé 6 mois au plus (expires_at), puis purgé par app_private.purge_followed_sale_snapshots.';
comment on column public.user_followed_sale_snapshots.sale_id is
  'Identifiant de la vente au moment de la capture. Sans clé étrangère : la vente est supprimée par la rétention du catalogue.';
comment on column public.user_followed_sale_snapshots.adjudication_price_eur is
  'Prix d''adjudication publié sur la fiche, jamais déduit. Null si inconnu, si la fiche vient de Licitor (agrégats seulement) ou si le compte n''avait pas l''accès Analyse (voir adjudication_price_withheld).';
comment on column public.user_followed_sale_snapshots.adjudication_price_withheld is
  'Vrai quand la fiche publiait un prix mais que le compte n''avait pas l''accès Analyse à la capture : le prix n''est pas copié.';

create index if not exists user_followed_sale_snapshots_expires_idx
  on public.user_followed_sale_snapshots (expires_at);
create index if not exists user_followed_sale_snapshots_user_date_idx
  on public.user_followed_sale_snapshots (user_id, sale_date desc);

alter table public.user_followed_sale_snapshots enable row level security;

-- Lecture et suppression par le propriétaire seulement ; aucune écriture directe (ni insertion ni
-- modification) : un compte ne peut pas fabriquer un instantané.
revoke all on table public.user_followed_sale_snapshots from public, anon, authenticated;
grant select, delete on table public.user_followed_sale_snapshots to authenticated;
grant select, delete on table public.user_followed_sale_snapshots to service_role;

drop policy if exists user_followed_sale_snapshots_select_own on public.user_followed_sale_snapshots;
create policy user_followed_sale_snapshots_select_own
on public.user_followed_sale_snapshots for select
to authenticated
using (user_id = (select auth.uid()));

drop policy if exists user_followed_sale_snapshots_delete_own on public.user_followed_sale_snapshots;
create policy user_followed_sale_snapshots_delete_own
on public.user_followed_sale_snapshots for delete
to authenticated
using (user_id = (select auth.uid()));

-- 3. Capture avant la suppression de la vente -------------------------------------------------------
-- Les déclencheurs « before delete » d'une même table s'exécutent par ordre alphabétique de leur nom :
-- auction_sales_carry_favorite_dossier et auction_sales_carry_sale_user_data (fusion de doublons) passent
-- avant auction_sales_snapshot_followed_sale. Une fusion a alors déjà noté la correspondance
-- (app_private.auction_sale_merges), et ce déclencheur ne capture rien.
create or replace function app_private.snapshot_followed_sale_before_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_price numeric := case when old.adjudication_price_eur > 0 then old.adjudication_price_eur end;
  v_licitor boolean;
  v_tribunal_name text;
begin
  -- Audience passée seulement, vente maintenue, jamais une fusion de doublons.
  if old.sale_date is null
    or old.sale_date > pg_catalog.now()
    or coalesce(old.status, '') in ('postponed', 'cancelled', 'withdrawn', 'quarantined')
    or coalesce(old.catalogue_quarantined, false)
    or exists (
      select 1 from app_private.auction_sale_merges merged where merged.old_sale_id = old.id
    )
    or not exists (select 1 from public.user_favorites followed where followed.sale_id = old.id)
  then
    return old;
  end if;

  v_licitor := pg_catalog.lower(coalesce(old.source_name, '')) like '%licitor%'
    or pg_catalog.lower(coalesce(old.source_url, '')) like '%licitor%'
    or pg_catalog.lower(coalesce(old.source_urls::text, '')) like '%licitor%'
    or pg_catalog.lower(coalesce(old.observations::text, '')) like '%licitor%';

  v_tribunal_name := coalesce(
    (
      select nullif(pg_catalog.btrim(tribunal.canonical_name), '')
      from public.tribunals tribunal
      where tribunal.code = old.tribunal_code
    ),
    old.tribunal
  );

  insert into public.user_followed_sale_snapshots (
    user_id, sale_id, captured_at, expires_at,
    title, city, department, postal_code, property_type, tribunal_name,
    sale_venue_type, sale_legal_framework, starting_price_eur, sale_date, lawyer_name, source_name,
    result_status, adjudication_price_eur, adjudication_price_source, adjudication_price_withheld,
    personal_status, bid_ceiling_eur
  )
  select
    followed.user_id, old.id, pg_catalog.now(),
    pg_catalog.now() + app_private.followed_sale_snapshot_retention(),
    old.title, old.city, old.department, old.postal_code, old.property_type, v_tribunal_name,
    old.sale_venue_type, old.sale_legal_framework, old.starting_price_eur, old.sale_date,
    old.lawyer_name, old.source_name,
    case when old.status = 'adjudicated' or v_price is not null then 'adjudicated' else 'unknown' end,
    case when v_price is not null and not v_licitor and access.granted then v_price end,
    case when v_price is not null and not v_licitor and access.granted then old.source_name end,
    (v_price is not null and not v_licitor and not access.granted),
    followed.personal_status, followed.bid_ceiling_eur
  from public.user_favorites followed
  cross join lateral (
    select app_private.has_active_analysis_access(followed.user_id) as granted
  ) access
  where followed.sale_id = old.id
  on conflict (user_id, sale_id) do nothing;

  return old;
end;
$$;

revoke all on function app_private.snapshot_followed_sale_before_delete()
  from public, anon, authenticated;

drop trigger if exists auction_sales_snapshot_followed_sale on public.auction_sales;
create trigger auction_sales_snapshot_followed_sale
before delete on public.auction_sales
for each row execute function app_private.snapshot_followed_sale_before_delete();

comment on function app_private.snapshot_followed_sale_before_delete() is
  'Avant la suppression d''une vente dont l''audience est passée : garde un instantané par compte qui la suivait (données clés, résultat publié, statut et plafond personnels). Jamais pour une fusion, une vente reportée, annulée, retirée ou en quarantaine ; jamais de prix issu de Licitor.';

-- 4. Purge ------------------------------------------------------------------------------------------
create or replace function app_private.purge_followed_sale_snapshots(
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer := 0;
begin
  delete from public.user_followed_sale_snapshots where expires_at <= p_now;
  get diagnostics v_deleted = row_count;
  return pg_catalog.jsonb_build_object('user_followed_sale_snapshots', v_deleted);
end;
$$;

revoke all on function app_private.purge_followed_sale_snapshots(timestamptz)
  from public, anon, authenticated;
grant execute on function app_private.purge_followed_sale_snapshots(timestamptz) to service_role;

-- Même corps que 20261025110100_data_retention_isolated_purges.sql, plus la purge des instantanés. Une
-- migration ultérieure qui redéfinit cette fonction doit garder les cinq parties isolées et la clé
-- purge_errors.
create or replace function public.run_data_retention(
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb := '{}'::jsonb;
  v_errors jsonb := '{}'::jsonb;
begin
  begin
    v_result := v_result || coalesce(app_private.purge_expired_operational_data(p_now), '{}'::jsonb);
  exception when others then
    v_errors := v_errors || pg_catalog.jsonb_build_object('purge_expired_operational_data', sqlstate);
    raise warning 'run_data_retention: purge_expired_operational_data failed (SQLSTATE %): %',
      sqlstate, sqlerrm;
  end;

  begin
    v_result := v_result || coalesce(app_private.purge_information_agent_data(p_now), '{}'::jsonb);
  exception when others then
    v_errors := v_errors || pg_catalog.jsonb_build_object('purge_information_agent_data', sqlstate);
    raise warning 'run_data_retention: purge_information_agent_data failed (SQLSTATE %): %',
      sqlstate, sqlerrm;
  end;

  begin
    v_result := v_result || coalesce(app_private.purge_offer_opening_notifications(p_now), '{}'::jsonb);
  exception when others then
    v_errors := v_errors
      || pg_catalog.jsonb_build_object('purge_offer_opening_notifications', sqlstate);
    raise warning 'run_data_retention: purge_offer_opening_notifications failed (SQLSTATE %): %',
      sqlstate, sqlerrm;
  end;

  begin
    v_result := v_result || coalesce(app_private.purge_sale_unlocks(p_now), '{}'::jsonb);
  exception when others then
    v_errors := v_errors || pg_catalog.jsonb_build_object('purge_sale_unlocks', sqlstate);
    raise warning 'run_data_retention: purge_sale_unlocks failed (SQLSTATE %): %',
      sqlstate, sqlerrm;
  end;

  begin
    v_result := v_result || coalesce(app_private.purge_followed_sale_snapshots(p_now), '{}'::jsonb);
  exception when others then
    v_errors := v_errors
      || pg_catalog.jsonb_build_object('purge_followed_sale_snapshots', sqlstate);
    raise warning 'run_data_retention: purge_followed_sale_snapshots failed (SQLSTATE %): %',
      sqlstate, sqlerrm;
  end;

  if v_errors <> '{}'::jsonb then
    v_result := v_result || pg_catalog.jsonb_build_object('purge_errors', v_errors);
  end if;
  return v_result;
end;
$$;

comment on function public.run_data_retention(timestamptz) is
  'Runs the five retention purges, each isolated: a failing purge is logged and reported under purge_errors while the others still run and commit.';

revoke all on function public.run_data_retention(timestamptz)
  from public, anon, authenticated;
grant execute on function public.run_data_retention(timestamptz) to service_role;

notify pgrst, 'reload schema';

commit;
