begin;

set local lock_timeout = '5s';

-- Instantanés d'estimation (20261102110100) : ventes notariales et résultat de la pépite, pour pouvoir valider la
-- règle plus tard (proposition n° 18 du compte-rendu du 26/10/2026).
--
-- Jusqu'ici l'instantané ne couvrait que les ventes de tribunal (code de tribunal obligatoire). Il couvre aussi
-- les ventes notariales (à la bougie et interactives), qui n'ont pas de tribunal :
--   * court_code devient facultatif, mais seule une vente notariale peut l'avoir nul (contrôle) ;
--   * sale_venue_type distingue les deux (« tribunal » pour les lignes existantes) ;
--   * le résultat de la règle pepite-v1 à l'instant de l'instantané est gardé (version de la règle, statut, publié
--     ou non, plafond de référence, prix probable, part B, ratio C, régime, occupation, état), lu dans
--     public.auction_sale_pepites : c'est ce qu'il faut pour mesurer, sur les ventes adjugées, la part des
--     pépites réellement remportables sous le plafond. Sans évaluation (la vente n'a pas été calculée), ces
--     colonnes restent nulles ;
--   * le résultat d'une vente notariale quand la source l'a publié (prix d'adjudication et mention « Vendu »,
--     lus dans raw_payload -> source_property_features -> sale_conditions). Le pipeline passe la vente à
--     « past » quand l'annonce porte bienVendu = OUI, avec le prix dans la même écriture : l'instantané pris
--     à la sortie des statuts « active » / « upcoming » le voit. Un résultat publié plus tard, ou après la
--     purge de la vente à l'heure de la séance, n'est PAS rattrapé : la ligne de la vente n'existe plus, et
--     aucun mécanisme ne relit la source pour un instantané. Quand la vente est modifiée ou supprimée APRÈS sa
--     sortie de statut (son résultat a été publié entre-temps), l'écriture suivante complète seulement un
--     résultat encore vide du même instantané, jamais l'estimation ou la pépite déjà gardées.
--
-- Rien d'identifiant n'est ajouté : ni adresse, ni commune, ni identifiant de vente en clair, ni donnée
-- d'avocat ou de sponsoring. La conservation (36 mois après la séance) et la purge sont inchangées.
--
-- RETOUR ARRIÈRE : cette migration se défait EN PREMIER, avant 20261104100100 et 20261104100000 (voir l'en-tête de
-- 20261104100000 pour l'ordre complet). Dans cet ordre précis :
--   1. restaurer app_private.snapshot_sale_market_estimate telle que définie par
--      20261102110100_sale_market_estimate_snapshots.sql (le create or replace de cette migration, avec son
--      revoke et son comment) AVANT que la table public.auction_sale_pepites ne soit supprimée par le retour
--      arrière de 20261104100000 : la fonction ci-dessous la lit, et son bloc d'exception avalerait l'erreur
--      (plus aucun instantané, sans alerte) ;
--   2. drop function app_private.pepite_details_number(jsonb, text) ;
--   3. delete from app_private.sale_market_estimate_snapshots where sale_venue_type = 'notary' (ces lignes n'ont
--      pas de tribunal), puis alter column court_code set not null, drop de la contrainte
--      sale_market_estimate_snapshots_venue_check, et drop des colonnes ajoutées (sale_venue_type, regime,
--      occupancy, condition_status, pepite_*, adjudication_price_eur, sale_result) ;
--   4. rejouer les comment on de 20261102110100.

-- 1. Table -------------------------------------------------------------------------------------------------
alter table app_private.sale_market_estimate_snapshots
  alter column court_code drop not null;

alter table app_private.sale_market_estimate_snapshots
  add column if not exists sale_venue_type text not null default 'tribunal',
  add column if not exists regime text,
  add column if not exists occupancy text,
  add column if not exists condition_status text,
  add column if not exists pepite_rule_version text,
  add column if not exists pepite_status text,
  add column if not exists pepite_is_pepite boolean,
  add column if not exists pepite_reference_ceiling_eur numeric,
  add column if not exists pepite_probable_price_eur numeric,
  add column if not exists pepite_chance_share numeric,
  add column if not exists pepite_cost_ratio numeric,
  add column if not exists pepite_evaluated_at timestamptz,
  add column if not exists adjudication_price_eur numeric,
  add column if not exists sale_result text;

alter table app_private.sale_market_estimate_snapshots
  drop constraint if exists sale_market_estimate_snapshots_venue_check;
alter table app_private.sale_market_estimate_snapshots
  add constraint sale_market_estimate_snapshots_venue_check check (
    sale_venue_type in ('tribunal', 'notary')
    and (court_code is not null or sale_venue_type = 'notary')
  );

comment on table app_private.sale_market_estimate_snapshots is
  'Un instantané par vente de tribunal ou notariale, écrit juste avant la disparition de la ligne d''estimation (purge à l''audience ou sortie des statuts active/upcoming) : tribunal (nul pour une vente notariale), département, type de bien, mise à prix, date d''audience, estimation P10/P50/P90 et qualité, résultat de la règle pepite-v1 (version, statut, plafond de référence, prix probable, part B, ratio C, régime, occupation, état) et, pour une vente notariale dont la source a publié le résultat, prix d''adjudication et mention de résultat. Ne contient pas de donnée directement identifiante : aucune adresse, aucun identifiant de vente en clair (snapshot_key = empreinte SHA-256 non salée de l''identifiant de la vente : pseudonymisation, pas anonymisation, tant que l''identifiant existe ailleurs). Sert à apparier plus tard estimation, pépite et prix d''adjudication agrégé. Conservé 36 mois après l''audience (app_private.market_estimate_snapshot_retention), purgé par run_data_retention.';
comment on column app_private.sale_market_estimate_snapshots.sale_venue_type is
  'tribunal ou notary (les lignes d''avant 20261104110000 sont des ventes de tribunal).';
comment on column app_private.sale_market_estimate_snapshots.pepite_rule_version is
  'Version de la règle de pépite de l''évaluation archivée ; nul quand la vente n''avait pas été évaluée.';
comment on column app_private.sale_market_estimate_snapshots.adjudication_price_eur is
  'Prix d''adjudication publié par la source d''une vente notariale au moment de l''instantané ; nul sinon.';
comment on column app_private.sale_market_estimate_snapshots.sale_result is
  'Mention de résultat d''une vente notariale lue dans l''annonce (Vendu, Non vendu, Retiré de la vente, Vente reportée) ; nul sinon.';

-- 2. Lecture sûre d'un nombre du détail de la pépite ----------------------------------------------------------
-- Le détail est du JSON écrit par l'application : un champ qui n'est pas un nombre ne doit jamais faire échouer
-- l'instantané (une erreur y est avalée, et l'instantané entier serait perdu).
create or replace function app_private.pepite_details_number(p_details jsonb, p_key text)
returns numeric
language sql
immutable
parallel safe
set search_path = ''
as $function$
  select case
    when pg_catalog.jsonb_typeof(p_details -> p_key) = 'number' then (p_details ->> p_key)::numeric
  end;
$function$;

revoke all on function app_private.pepite_details_number(jsonb, text) from public, anon, authenticated;

-- 3. Écriture ------------------------------------------------------------------------------------------------
-- Même fonction que 20261102110100, avec : les ventes notariales, le résultat de la pépite et le résultat d'une
-- vente notariale.
create or replace function app_private.snapshot_sale_market_estimate(p_sale public.auction_sales)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_key text;
  v_price numeric;
  v_result text;
begin
  -- Audience passée seulement, vente de tribunal ou notariale maintenue, jamais une fusion de doublons.
  if p_sale.sale_date is null
    or p_sale.sale_date > pg_catalog.now()
    or coalesce(p_sale.status, '') in ('postponed', 'cancelled', 'withdrawn', 'quarantined')
    or coalesce(p_sale.catalogue_quarantined, false)
    or p_sale.sale_venue_type is null
    or p_sale.sale_venue_type not in ('tribunal', 'notary')
    or (p_sale.sale_venue_type = 'tribunal' and p_sale.tribunal_code is null)
    or coalesce(p_sale.starting_price_eur, 0) <= 0
    or exists (
      select 1 from app_private.auction_sale_merges merged where merged.old_sale_id = p_sale.id
    )
  then
    return;
  end if;

  begin
    -- Les initialisations sont DANS le bloc protégé : une lecture qui échoue (charge utile inattendue) est avalée
    -- avec le reste, elle n'arrête jamais la purge ni la mise à jour de la vente.
    v_key := pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to('sale-market-estimate-snapshot:v1:' || p_sale.id::text, 'UTF8')
      ),
      'hex'
    );
    -- Résultat publié d'une vente notariale (prix, mention). La mention vient d'une liste fermée : jamais un
    -- texte libre de l'annonce.
    v_price := case
      when p_sale.sale_venue_type = 'notary' and coalesce(p_sale.adjudication_price_eur, 0) > 0
        then p_sale.adjudication_price_eur
    end;
    v_result := case
      when p_sale.sale_venue_type = 'notary'
        and (p_sale.raw_payload -> 'source_property_features' -> 'sale_conditions' ->> 'result')
          in ('Vendu', 'Non vendu', 'Retiré de la vente', 'Vente reportée')
        then p_sale.raw_payload -> 'source_property_features' -> 'sale_conditions' ->> 'result'
    end;

    insert into app_private.sale_market_estimate_snapshots (
      snapshot_key, court_code, department, property_type, property_group, starting_price_eur,
      sale_date, value_p10_eur, value_p50_eur, value_p90_eur, actionable, comparable_count,
      confidence_score, engine_kind, model_version, estimate_computed_at,
      sale_venue_type, regime, occupancy, condition_status, pepite_rule_version, pepite_status,
      pepite_is_pepite, pepite_reference_ceiling_eur, pepite_probable_price_eur, pepite_chance_share,
      pepite_cost_ratio, pepite_evaluated_at, adjudication_price_eur, sale_result
    )
    select
      v_key,
      case when p_sale.sale_venue_type = 'tribunal' then p_sale.tribunal_code end,
      p_sale.department,
      p_sale.property_type,
      app_private.scenario_property_group(p_sale.property_type),
      p_sale.starting_price_eur,
      pg_catalog.timezone('Europe/Paris', p_sale.sale_date)::date,
      estimate.value_p10_eur,
      estimate.value_p50_eur,
      estimate.value_p90_eur,
      estimate.actionable,
      estimate.comparable_count,
      estimate.confidence_score,
      estimate.engine_kind,
      estimate.model_version,
      estimate.computed_at,
      p_sale.sale_venue_type,
      pepite.details ->> 'regime',
      pepite.details ->> 'occupancy',
      pepite.details ->> 'conditionStatus',
      pepite.rule_version,
      pepite.status,
      pepite.is_pepite,
      app_private.pepite_details_number(pepite.details, 'referenceCeilingEur'),
      app_private.pepite_details_number(pepite.details, 'probablePriceEur'),
      app_private.pepite_details_number(pepite.details, 'chanceShare'),
      app_private.pepite_details_number(pepite.details, 'costRatio'),
      pepite.evaluated_at,
      v_price,
      v_result
    from public.auction_sale_market_estimates estimate
    left join public.auction_sale_pepites pepite on pepite.sale_id = p_sale.id
    where estimate.auction_sale_id = p_sale.id
      and estimate.status = 'ready'
      and estimate.value_p50_eur > 0
    on conflict (snapshot_key) do nothing;

    -- Le résultat est publié après la sortie de statut : l'instantané existe déjà (la ligne d'estimation, elle,
    -- a disparu), seul son résultat vide est complété. L'estimation et la pépite gardées ne changent jamais.
    if v_price is not null or v_result is not null then
      update app_private.sale_market_estimate_snapshots snapshot
         set adjudication_price_eur = coalesce(snapshot.adjudication_price_eur, v_price),
             sale_result = coalesce(snapshot.sale_result, v_result)
       where snapshot.snapshot_key = v_key
         and (snapshot.adjudication_price_eur is null or snapshot.sale_result is null);
    end if;
  exception when others then
    -- Ne jamais bloquer la purge ni la mise à jour de la vente pour un instantané.
    raise warning 'snapshot_sale_market_estimate: not written (SQLSTATE %): %', sqlstate, sqlerrm;
  end;
end;
$function$;

revoke all on function app_private.snapshot_sale_market_estimate(public.auction_sales)
  from public, anon, authenticated;

comment on function app_private.snapshot_sale_market_estimate(public.auction_sales) is
  'Garde l''estimation de marché d''une vente de tribunal ou notariale dont l''audience est passée, avec le résultat de la règle de pépite et, pour une vente notariale, le résultat publié par la source, une seule fois (snapshot_key), juste avant la disparition de sa ligne d''estimation. Jamais pour une vente reportée, annulée, retirée, en quarantaine ou fusionnée ; une erreur n''empêche jamais l''opération appelante.';

notify pgrst, 'reload schema';

commit;
