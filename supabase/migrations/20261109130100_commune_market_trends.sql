begin;

set local lock_timeout = '5s';

-- Règle de pépite pepite-v1.2 (validée le 29/10/2026) : marché local de la commune.
--
-- app_private.commune_market_trends : une ligne par commune (code INSEE tel que DVF l'écrit : arrondissement pour
-- Paris, Lyon et Marseille) et par type de logement (Maison, Appartement), recalculée depuis public.dvf_transactions
-- par app_private.refresh_commune_market_trends(). Seules les ventes comptent : mutation_nature = 'Vente', prix au
-- m² entre 300 et 25 000 (la base garde les erreurs de saisie ; elles ne doivent pas déplacer une médiane).
--   * reference_year : année de la vente la plus récente de la table (« l'année la plus récente disponible »),
--     la même pour toutes les lignes d'un calcul ;
--   * sales_12_months : ventes sur les 12 derniers mois disponibles (après la date de la vente la plus récente moins
--     12 mois) ; critère market_liquid : au moins 20 ;
--   * median_recent_eur_m2 / sales_recent_year : prix médian au m² et nombre de ventes de l'année de référence ;
--   * median_baseline_eur_m2 / sales_baseline_year : les mêmes, trois ans plus tôt (reference_year - 3) ; critère
--     market_not_declining : évalué seulement si les deux années comptent au moins 10 ventes.
-- Une commune qui a des ventes dans la table mais aucune sur la période a sa ligne, avec des comptes à 0 (marché
-- non liquide) ; une commune sans aucune vente n'a pas de ligne : « pas de donnée, pas d'exclusion » côté règle
-- (src/lib/pepite-policy.ts, evaluateLocalMarket).
--
-- Table fermée au navigateur (RLS, aucun droit pour anon ni authenticated) ; lue et écrite par le rôle de service.
-- L'application la lit par public.get_commune_market_trends(text[]), réservée au rôle de service.
--
-- Qui l'appelle : le workflow « Immojudis DVF Import » (manuel), après l'import DVF, par
-- services/data-pipeline/src/dvf_market_trends.py ; aucune planification n'est créée. L'ordre de mise en
-- production est : cette migration, l'index de 20261109130000 (npm run db:indexes:concurrent), un premier calcul
-- (select app_private.refresh_commune_market_trends()), PUIS la règle pepite-v1.2.
--
-- RETOUR ARRIÈRE (migration de retour arrière revue) : drop function public.get_commune_market_trends(text[]);
-- drop function app_private.refresh_commune_market_trends(boolean); drop table app_private.commune_market_trends ;
-- la règle traite alors l'absence de fonction comme « aucun agrégat » (src/lib/pepite-context.server.ts).

create table if not exists app_private.commune_market_trends (
  insee_code text not null check (insee_code ~ '^[0-9][0-9AB][0-9]{3}$'),
  property_type text not null check (property_type in ('Maison', 'Appartement')),
  reference_year integer not null check (reference_year between 2000 and 2100),
  sales_12_months integer not null check (sales_12_months >= 0),
  median_recent_eur_m2 numeric check (median_recent_eur_m2 is null or median_recent_eur_m2 > 0),
  median_baseline_eur_m2 numeric check (median_baseline_eur_m2 is null or median_baseline_eur_m2 > 0),
  sales_recent_year integer not null check (sales_recent_year >= 0),
  sales_baseline_year integer not null check (sales_baseline_year >= 0),
  computed_at timestamptz not null default pg_catalog.statement_timestamp(),
  primary key (insee_code, property_type)
);

comment on table app_private.commune_market_trends is
  'Marché local par commune et type de logement (ventes DVF), pour la règle de pépite pepite-v1.2. Remplie par app_private.refresh_commune_market_trends() ; lue par public.get_commune_market_trends(text[]).';
comment on column app_private.commune_market_trends.reference_year is
  'Année de la vente la plus récente de dvf_transactions au moment du calcul.';
comment on column app_private.commune_market_trends.sales_12_months is
  'Ventes de logements du type dans la commune sur les 12 derniers mois disponibles (prix au m² entre 300 et 25 000).';
comment on column app_private.commune_market_trends.median_baseline_eur_m2 is
  'Prix médian au m² trois ans avant reference_year ; nul sans vente cette année-là.';

alter table app_private.commune_market_trends enable row level security;
revoke all on table app_private.commune_market_trends from public, anon, authenticated, service_role;
grant select, insert, update, delete on table app_private.commune_market_trends to service_role;
drop policy if exists commune_market_trends_service_role on app_private.commune_market_trends;
create policy commune_market_trends_service_role
  on app_private.commune_market_trends
  for all to service_role
  using (true)
  with check (true);

-- Recalcul complet, en une transaction : les lectures voient l'ancien état jusqu'au commit (le verrou exclusif
-- ne bloque pas les lectures, il sérialise deux recalculs). Un seul passage sur dvf_transactions.
--   * Sans aucune vente dans la table (import en cours, table vide), le recalcul est refusé : il effacerait
--     l'agrégat, et une donnée absente laisse passer les critères de marché.
--   * Garde contre une réduction brutale (comme app_private.refresh_auction_scenario_observations) : un agrégat
--     de moins de la moitié des lignes précédentes est refusé (55000) sauf p_allow_shrink.
--   * statement_timeout porté à 10 minutes pour ce recalcul ; l'appelant doit aussi le poser avant l'appel
--     (`set local statement_timeout`), car le délai de la requête en cours est déjà armé. Avec l'index de
--     20261109130000 le calcul prend quelques secondes ; sans lui (table remplacée par l'import DVF), il balaie
--     toute la table.
create or replace function app_private.refresh_commune_market_trends(
  p_allow_shrink boolean default false
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_latest date;
  v_year integer;
  v_count integer;
  v_previous integer;
begin
  perform pg_catalog.set_config('statement_timeout', '10min', true);

  select max(dvf.sale_date) into v_latest
  from public.dvf_transactions dvf
  where dvf.mutation_nature = 'Vente';
  if v_latest is null then
    raise exception using
      errcode = '55000',
      message = 'Commune market trends refresh refused: dvf_transactions has no sale.';
  end if;
  v_year := pg_catalog.date_part('year', v_latest)::integer;

  select pg_catalog.count(*) into v_previous from app_private.commune_market_trends;

  lock table app_private.commune_market_trends in exclusive mode;
  delete from app_private.commune_market_trends;
  insert into app_private.commune_market_trends (
    insee_code, property_type, reference_year, sales_12_months,
    median_recent_eur_m2, median_baseline_eur_m2, sales_recent_year, sales_baseline_year, computed_at
  )
  select
    dvf.insee_code,
    dvf.property_type,
    v_year,
    pg_catalog.count(*) filter (
      where dvf.sale_date > v_latest - interval '12 months' and dvf.sale_date <= v_latest
    ),
    pg_catalog.round(
      (pg_catalog.percentile_cont(0.5) within group (order by dvf.price_per_m2::double precision) filter (
        where dvf.sale_date >= pg_catalog.make_date(v_year, 1, 1) and dvf.sale_date <= v_latest
      ))::numeric,
      2
    ),
    pg_catalog.round(
      (pg_catalog.percentile_cont(0.5) within group (order by dvf.price_per_m2::double precision) filter (
        where dvf.sale_date >= pg_catalog.make_date(v_year - 3, 1, 1)
          and dvf.sale_date <= pg_catalog.make_date(v_year - 3, 12, 31)
      ))::numeric,
      2
    ),
    pg_catalog.count(*) filter (
      where dvf.sale_date >= pg_catalog.make_date(v_year, 1, 1) and dvf.sale_date <= v_latest
    ),
    pg_catalog.count(*) filter (
      where dvf.sale_date >= pg_catalog.make_date(v_year - 3, 1, 1)
        and dvf.sale_date <= pg_catalog.make_date(v_year - 3, 12, 31)
    ),
    pg_catalog.statement_timestamp()
  from public.dvf_transactions dvf
  where dvf.mutation_nature = 'Vente'
    and dvf.property_type in ('Maison', 'Appartement')
    and dvf.insee_code ~ '^[0-9][0-9AB][0-9]{3}$'
    and dvf.price_per_m2 between 300 and 25000
    and dvf.sale_date <= v_latest
  group by dvf.insee_code, dvf.property_type;
  get diagnostics v_count = row_count;

  -- Garde contre une réduction brutale : l'exception annule le delete et l'insert ci-dessus.
  if not p_allow_shrink and v_previous >= 100 and v_count < v_previous * 0.5 then
    raise exception using
      errcode = '55000',
      message = pg_catalog.format(
        'Commune market trends refresh refused: %s rows instead of %s (less than half); pass p_allow_shrink to force it.',
        v_count, v_previous
      );
  end if;
  return v_count;
end;
$function$;

comment on function app_private.refresh_commune_market_trends(boolean) is
  'Recalcule app_private.commune_market_trends depuis public.dvf_transactions (ventes, prix au m² entre 300 et 25 000). Appelée après l''import DVF ; réservée au rôle de service.';

revoke all on function app_private.refresh_commune_market_trends(boolean)
  from public, anon, authenticated;
grant execute on function app_private.refresh_commune_market_trends(boolean) to service_role;

-- Lecture par l'application (serveur Next.js, rôle de service) : les lignes des communes demandées, en JSON.
-- SECURITY INVOKER : elle lit avec les droits de l'appelant, donc service_role seul.
create or replace function public.get_commune_market_trends(p_insee_codes text[])
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'insee_code', trend.insee_code,
        'property_type', trend.property_type,
        'reference_year', trend.reference_year,
        'sales_12_months', trend.sales_12_months,
        'median_recent_eur_m2', trend.median_recent_eur_m2,
        'median_baseline_eur_m2', trend.median_baseline_eur_m2,
        'sales_recent_year', trend.sales_recent_year,
        'sales_baseline_year', trend.sales_baseline_year,
        'computed_at', trend.computed_at
      )
      order by trend.insee_code, trend.property_type
    ),
    '[]'::jsonb
  )
  from app_private.commune_market_trends trend
  where trend.insee_code = any (p_insee_codes);
$function$;

revoke all on function public.get_commune_market_trends(text[]) from public, anon, authenticated;
grant execute on function public.get_commune_market_trends(text[]) to service_role;

comment on function public.get_commune_market_trends(text[]) is
  'Lignes de app_private.commune_market_trends pour les communes demandées (règle de pépite pepite-v1.2). Rôle de service seul.';

notify pgrst, 'reload schema';

commit;
