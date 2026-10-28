begin;

set local lock_timeout = '5s';

-- Versionner l'estimation de valeur dans la pépite, et compléter les instantanés (n° 25 du compte-rendu du
-- 27/10/2026, qa-modeles n° 6 et 7). Sans cela, après l'activation d'un nouveau modèle de valeur on ne sait pas
-- quelle estimation a produit quelle pépite, ni rattacher une pépite à l'estimation archivée.
--
--   1. public.auction_sale_pepites gagne estimate_model_version et estimate_engine_kind : la version du modèle
--      (auction_sale_market_estimates.model_version) et le moteur (engine_kind) de l'estimation lue par
--      l'évaluation. Nuls pour les lignes déjà écrites et pour une évaluation sans estimation. Le traitement
--      planifié (src/lib/sale-pepites-batch.ts) les écrit à chaque évaluation.
--   2. Les instantanés (app_private.sale_market_estimate_snapshots) gagnent les mêmes deux colonnes et ce qu'il
--      faut pour juger la pépite a posteriori : date de l'estimation lue par l'évaluation (distincte de
--      estimate_computed_at, qui est celle de l'estimation archivée), clé et valeur du multiplicateur, fourchette de
--      prix, part de la mise à prix dans la valeur, fiabilité et effectif de l'estimation, effectif et borne basse
--      de Wilson de la part B, motifs (reason_codes), mode des pépites au moment de l'archivage (shadow ou on),
--      date de gel et première date de publication.
--   3. app_private.snapshot_sale_market_estimate écrit ces colonnes (même fonction que 20261104110000, plus les
--      colonnes ci-dessus). Les instantanés déjà écrits gardent ces colonnes nulles.
--
-- Rien d'identifiant n'est ajouté : des versions, des nombres, des codes de critère et des dates. La
-- conservation (36 mois après la séance), la purge et les droits (aucun accès pour anon et authenticated) ne
-- changent pas.
--
-- DÉPLOIEMENT : appliquer cette migration AVANT le déploiement du code qui écrit les deux colonnes de
-- auction_sale_pepites. Si le code passe avant, le traitement des pépites retente l'écriture sans ces deux colonnes
-- (colonne inconnue) : rien n'est perdu, mais les versions ne sont pas archivées.
--
-- RETOUR ARRIÈRE (par une migration de retour arrière revue) : restaurer app_private.snapshot_sale_market_estimate
-- telle que définie par 20261104110000, puis supprimer les colonnes ajoutées ci-dessous.

alter table public.auction_sale_pepites
  add column if not exists estimate_model_version text,
  add column if not exists estimate_engine_kind text;

comment on column public.auction_sale_pepites.estimate_model_version is
  'Version du modèle de valeur (auction_sale_market_estimates.model_version) de l''estimation lue par cette évaluation ; nul sans estimation ou avant 20261108140000.';
comment on column public.auction_sale_pepites.estimate_engine_kind is
  'Moteur de l''estimation lue par cette évaluation (engine_kind : comparable_ensemble, hybrid_lightgbm…) ; nul sans estimation ou avant 20261108140000.';

alter table app_private.sale_market_estimate_snapshots
  add column if not exists estimate_model_version text,
  add column if not exists estimate_engine_kind text,
  add column if not exists pepite_input_estimate_computed_at timestamptz,
  add column if not exists pepite_multiplier_key text,
  add column if not exists pepite_multiplier numeric,
  add column if not exists pepite_range_low_eur numeric,
  add column if not exists pepite_range_high_eur numeric,
  add column if not exists pepite_starting_share_of_value numeric,
  add column if not exists pepite_estimate_reliability text,
  add column if not exists pepite_estimate_effective_sample numeric,
  add column if not exists pepite_chance_sample numeric,
  add column if not exists pepite_chance_wilson_low numeric,
  add column if not exists pepite_reason_codes text[],
  add column if not exists pepite_mode text,
  add column if not exists pepite_frozen_at timestamptz,
  add column if not exists pepite_first_pepite_at timestamptz;

comment on column app_private.sale_market_estimate_snapshots.estimate_model_version is
  'Version du modèle de valeur de l''estimation lue par l''évaluation de la pépite archivée (peut différer de model_version si l''estimation a été recalculée depuis) ; nul sans évaluation.';
comment on column app_private.sale_market_estimate_snapshots.estimate_engine_kind is
  'Moteur de l''estimation lue par l''évaluation de la pépite archivée ; nul sans évaluation.';
comment on column app_private.sale_market_estimate_snapshots.pepite_input_estimate_computed_at is
  'computed_at de l''estimation lue par l''évaluation de la pépite (à comparer à estimate_computed_at, celle de l''estimation archivée).';
comment on column app_private.sale_market_estimate_snapshots.pepite_multiplier_key is
  'Multiplicateur de prix retenu par la règle : q50, q75 (mise à prix très basse) ou start (vente notariale).';
comment on column app_private.sale_market_estimate_snapshots.pepite_chance_sample is
  'Effectif sur lequel la part B est lissée (ventes du tribunal + poids national) ; renseigné par la règle pepite-v1.1 et suivantes.';
comment on column app_private.sale_market_estimate_snapshots.pepite_reason_codes is
  'Codes de motif de l''évaluation archivée (pass:/fail: par critère, stab: pour la stabilité) : aucun texte libre.';
comment on column app_private.sale_market_estimate_snapshots.pepite_mode is
  'Mode des pépites au moment de l''archivage (shadow : calculées sans être publiques ; on : publiques).';
comment on column app_private.sale_market_estimate_snapshots.pepite_frozen_at is
  'Date du gel à J-7 de l''évaluation archivée ; nul hors gel.';

-- 3. Écriture ------------------------------------------------------------------------------------------------
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
      pepite_cost_ratio, pepite_evaluated_at, adjudication_price_eur, sale_result,
      estimate_model_version, estimate_engine_kind, pepite_input_estimate_computed_at,
      pepite_multiplier_key, pepite_multiplier, pepite_range_low_eur, pepite_range_high_eur,
      pepite_starting_share_of_value, pepite_estimate_reliability, pepite_estimate_effective_sample,
      pepite_chance_sample, pepite_chance_wilson_low, pepite_reason_codes, pepite_mode,
      pepite_frozen_at, pepite_first_pepite_at
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
      v_result,
      pepite.estimate_model_version,
      pepite.estimate_engine_kind,
      pepite.input_estimate_computed_at,
      pepite.details ->> 'multiplierKey',
      app_private.pepite_details_number(pepite.details, 'multiplier'),
      app_private.pepite_details_number(pepite.details, 'rangeLowEur'),
      app_private.pepite_details_number(pepite.details, 'rangeHighEur'),
      app_private.pepite_details_number(pepite.details, 'startingShareOfValue'),
      pepite.details ->> 'estimateReliability',
      app_private.pepite_details_number(pepite.details, 'estimateEffectiveSample'),
      app_private.pepite_details_number(pepite.details, 'chanceSample'),
      app_private.pepite_details_number(pepite.details, 'chanceWilsonLow'),
      case when pepite.sale_id is not null then pepite.reason_codes end,
      case when pepite.sale_id is not null then app_private.sale_pepite_mode() end,
      pepite.frozen_at,
      pepite.first_pepite_at
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
  'Garde l''estimation de marché d''une vente de tribunal ou notariale dont l''audience est passée, avec le résultat de la règle de pépite (version de la règle, du modèle et du moteur, multiplicateur, fourchette, effectifs, motifs, mode, gel) et, pour une vente notariale, le résultat publié par la source, une seule fois (snapshot_key), juste avant la disparition de sa ligne d''estimation. Jamais pour une vente reportée, annulée, retirée, en quarantaine ou fusionnée ; une erreur n''empêche jamais l''opération appelante.';

notify pgrst, 'reload schema';

commit;
