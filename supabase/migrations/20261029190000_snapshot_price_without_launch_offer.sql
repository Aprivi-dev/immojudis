-- Instantanés des ventes suivies : le prix d'adjudication ne suit plus l'offre de lancement (point 28 de la
-- session du 20/10/2026, intégré par le chef d'orchestre à la fusion des chantiers W1 et W3).
--
-- 20261029110200 a créé app_private.snapshot_price_access(user_id) : vrai pour un abonné Analyse, un
-- compte premium ou un administrateur, jamais pour un compte qui n'a que l'offre de lancement. Le
-- déclencheur la reprend ici à la place de has_active_analysis_access, pour qu'un prix copié pendant
-- l'offre ne reste pas lisible six mois après sa coupure. Le reste du corps est celui de 20261029100000
-- (capture isolée dans un sous-bloc, code postal non copié), inchangé.
--
-- Les instantanés déjà capturés gardent leur prix : les corriger serait une réparation de données.
begin;

set local lock_timeout = '5s';

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

  -- Sous-bloc : l'instantané est un service rendu au compte, jamais une condition de la rétention. Une
  -- erreur ici (contrainte, droit, donnée inattendue) annule seulement la capture. Le message d'erreur
  -- n'est pas journalisé : il peut citer la ligne copiée (compte, titre).
  begin
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
      title, city, department, property_type, tribunal_name,
      sale_venue_type, sale_legal_framework, starting_price_eur, sale_date, lawyer_name, source_name,
      result_status, adjudication_price_eur, adjudication_price_source, adjudication_price_withheld,
      personal_status, bid_ceiling_eur
    )
    select
      followed.user_id, old.id, pg_catalog.now(),
      pg_catalog.now() + app_private.followed_sale_snapshot_retention(),
      old.title, old.city, old.department, old.property_type, v_tribunal_name,
      old.sale_venue_type, old.sale_legal_framework, old.starting_price_eur, old.sale_date,
      old.lawyer_name, old.source_name,
      case when old.status = 'adjudicated' or v_price is not null then 'adjudicated' else 'unknown' end,
      case when v_price is not null and not v_licitor and access.granted then v_price end,
      case when v_price is not null and not v_licitor and access.granted then old.source_name end,
      (v_price is not null and not v_licitor and not access.granted),
      followed.personal_status, followed.bid_ceiling_eur
    from public.user_favorites followed
    cross join lateral (
      select app_private.snapshot_price_access(followed.user_id) as granted
    ) access
    where followed.sale_id = old.id
    on conflict (user_id, sale_id) do nothing;
  exception when others then
    raise warning 'snapshot_followed_sale_before_delete: capture skipped for sale % (SQLSTATE %)',
      old.id, sqlstate;
  end;

  return old;
end;
$$;

revoke all on function app_private.snapshot_followed_sale_before_delete()
  from public, anon, authenticated;

comment on function app_private.snapshot_followed_sale_before_delete() is
  'Avant la suppression d''une vente dont l''audience est passée : garde un instantané par compte qui la suivait (données clés sans code postal, résultat publié, statut et plafond personnels). Jamais pour une fusion, une vente reportée, annulée, retirée ou en quarantaine ; jamais de prix issu de Licitor ; le prix ne suit que le droit durable (abonnement, premium, administrateur), pas l''offre de lancement. Une capture qui échoue est journalisée et ne bloque pas la suppression.';

notify pgrst, 'reload schema';

commit;
