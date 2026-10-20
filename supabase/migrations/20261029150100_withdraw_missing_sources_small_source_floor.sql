begin;

set local lock_timeout = '5s';

-- Compteur d'absence : plancher des petites sources et écart minimal entre inventaires (point 11 de la session
-- du 20/10/2026).
--
-- app_private.withdraw_missing_source_sales (20261028110100) refuse tout retrait quand plus de 15 % des ventes
-- visibles d'une source seraient retirées d'un coup. Pour une petite source (moins de 7 ventes visibles) un seul
-- retrait dépasse déjà 15 % : aucune de ses ventes ne pouvait disparaître. On redéfinit la fonction avec :
--   * un plancher absolu : au moins c_min_withdrawals (1) retrait autorisé, même au-dessus de 15 % ;
--   * un écart minimal c_min_spacing (12 h) entre le premier inventaire où la vente est absente
--     (absent_since) et le retrait, pour cette source et pour chacune des autres sources de la vente. Le pipeline
--     (src.autonomous_runner.count_absent_inventories) ne compte plus un inventaire complet que s'il est distant
--     d'au moins 12 h du précédent compté ; ce contrôle protège aussi les compteurs déjà avancés par deux
--     inventaires rapprochés de quelques minutes. Une ligne sans absent_since (compteur posé avant la colonne)
--     n'est pas écartée.
-- Les constantes (15 %, 2 inventaires, plancher, 12 h) sont les mêmes que dans src/source_absence.py et
-- src/autonomous_runner.py : un test Python les compare au texte de cette migration.

create or replace function app_private.withdraw_missing_source_sales(
  p_source text,
  p_apply boolean default true,
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  c_max_share constant numeric := 0.15;
  c_min_inventories constant integer := 2;
  c_min_withdrawals constant integer := 1;
  c_min_spacing constant interval := interval '12 hours';
  v_alert_key text;
  v_complete_at timestamptz;
  v_population integer;
  v_candidates uuid[];
  v_share numeric;
  v_allowed integer;
  v_withdrawn integer := 0;
begin
  if p_source is null or pg_catalog.btrim(p_source) = '' then
    raise exception using errcode = '22023', message = 'A source name is required.';
  end if;
  v_alert_key := 'catalogue.source_absence.' || p_source;

  -- Une passe à la fois par source.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('withdraw_missing_source_sales:' || p_source, 0)
  );

  -- Jamais sans un inventaire complet récent : les compteurs ne bougent qu'à un inventaire complet, mais cette
  -- fonction ne doit pas non plus agir longtemps après lui, ni pour une source qui n'en a jamais fini un.
  select state.last_inventory_complete_at
    into v_complete_at
  from public.auction_source_state state
  where state.source_name = p_source;
  if v_complete_at is null or v_complete_at < p_now - interval '2 hours' then
    return pg_catalog.jsonb_build_object(
      'source', p_source, 'action', 'skipped', 'reason', 'no_recent_complete_inventory'
    );
  end if;

  -- Ventes visibles au catalogue public qui ont une ligne de présence pour cette source. Une vente est
  -- « disparue » si ce compteur atteint le minimum pour cette source ET pour chacune des autres sources qui la
  -- listent (une vente fusionnée encore vue ailleurs, ou jamais inventoriée ailleurs, n'est pas disparue).
  select count(*)::integer,
         coalesce(pg_catalog.array_agg(visible.sale_id order by visible.sale_id) filter (where visible.gone), '{}')
    into v_population, v_candidates
  from (
    select
      sale.id as sale_id,
      own.state = 'absent'
        and own.absent_inventories >= c_min_inventories
        and (own.absent_since is null or own.absent_since <= p_now - c_min_spacing)
        and not exists (
          select 1
          from app_private.auction_sale_source_presence other
          where other.sale_id = sale.id
            and other.source_name <> p_source
            and (
              other.state is distinct from 'absent'
              or other.absent_inventories < c_min_inventories
              or other.absent_since > p_now - c_min_spacing
            )
        ) as gone
    from public.auction_sales sale
    join app_private.auction_sale_source_presence own
      on own.sale_id = sale.id and own.source_name = p_source
    where coalesce(sale.status, 'unknown') in ('upcoming', 'unknown', 'postponed')
      and app_private.auction_sale_is_publicly_visible(sale.id)
  ) visible;

  if coalesce(pg_catalog.cardinality(v_candidates), 0) = 0 then
    perform app_private.sync_operational_alert(v_alert_key, 'import', 'critical', '{}'::jsonb, false, p_now);
    return pg_catalog.jsonb_build_object(
      'source', p_source, 'action', 'none', 'population', v_population, 'candidates', 0
    );
  end if;

  v_share := pg_catalog.cardinality(v_candidates)::numeric / greatest(v_population, 1);
  -- Plafond de retraits d'un coup : 15 % des ventes visibles, mais au moins c_min_withdrawals. Sans ce plancher
  -- une petite source (moins de 7 ventes visibles) ne pouvait jamais perdre une vente : 1 sur 6 fait 16,7 %.
  v_allowed := greatest(c_min_withdrawals, pg_catalog.floor(c_max_share * v_population)::integer);

  -- Garde-fou : un coup trop large ressemble à un inventaire tronqué, pas à des ventes disparues.
  if pg_catalog.cardinality(v_candidates) > v_allowed then
    perform app_private.sync_operational_alert(
      v_alert_key,
      'import',
      'critical',
      pg_catalog.jsonb_build_object(
        'source', p_source,
        'population', v_population,
        'candidates', pg_catalog.cardinality(v_candidates),
        'share', pg_catalog.round(v_share, 3),
        'max_share', c_max_share,
        'max_withdrawals', v_allowed,
        'sample_sale_ids', v_candidates[1:10],
        'message', 'Plus de 15 % des ventes visibles de la source (au moins 1) sont absentes des deux derniers inventaires complets : aucun retrait. Vérifier l''inventaire de la source.'
      ),
      true,
      p_now
    );
    return pg_catalog.jsonb_build_object(
      'source', p_source,
      'action', 'blocked',
      'population', v_population,
      'candidates', pg_catalog.cardinality(v_candidates),
      'share', pg_catalog.round(v_share, 3),
      'max_withdrawals', v_allowed
    );
  end if;

  if p_apply then
    update public.auction_sales sale
       set status = 'withdrawn',
           updated_at = p_now,
           raw_payload = (
             case when pg_catalog.jsonb_typeof(sale.raw_payload) = 'object'
               then sale.raw_payload else '{}'::jsonb end
           ) || pg_catalog.jsonb_build_object(
             'source_absence', pg_catalog.jsonb_build_object(
               'source', p_source,
               'status_before', sale.status,
               'withdrawn_at', p_now,
               'absent_inventories', c_min_inventories
             )
           )
     where sale.id = any (v_candidates)
       and coalesce(sale.status, 'unknown') in ('upcoming', 'unknown', 'postponed');
    get diagnostics v_withdrawn = row_count;
  end if;

  perform app_private.sync_operational_alert(v_alert_key, 'import', 'critical', '{}'::jsonb, false, p_now);
  return pg_catalog.jsonb_build_object(
    'source', p_source,
    'action', case when p_apply then 'withdrawn' else 'would_withdraw' end,
    'population', v_population,
    'candidates', pg_catalog.cardinality(v_candidates),
    'withdrawn', v_withdrawn,
    'share', pg_catalog.round(v_share, 3)
  );
end;
$function$;

revoke all on function app_private.withdraw_missing_source_sales(text, boolean, timestamptz)
  from public, anon, authenticated, service_role;

comment on function app_private.withdraw_missing_source_sales(text, boolean, timestamptz) is
  'Passe en withdrawn les ventes visibles absentes des deux derniers inventaires complets de leur source (toutes leurs sources, si elles en ont plusieurs), à au moins 12 h d''écart. Ne fait rien si plus de 15 % des ventes visibles de la source (au moins 1) seraient retirées : alerte opérationnelle à la place.';

commit;
