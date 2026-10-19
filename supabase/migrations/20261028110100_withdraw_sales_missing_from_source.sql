begin;

set local lock_timeout = '5s';

-- Ventes disparues de leur source (point 3 de la session du 18/10/2026).
--
-- 22 ventes visibles n'ont pas été revues depuis plusieurs inventaires complets de leur source (dont deux qui
-- répondent 410 chez Vench) et restent affichées « à venir ». Après un inventaire complet réussi d'une source,
-- une vente visible absente des DEUX derniers inventaires complets passe en 'withdrawn'.
--
-- Il manquait de quoi savoir quel était l'avant-dernier inventaire complet : app_private.auction_sale_source_presence
-- ne garde que l'état du dernier (state = present | absent, posé seulement par un inventaire complet). On y ajoute
-- un compteur par vente et par source, tenu par le pipeline (record_source_presence, src/autonomous_runner.py) :
--   * absent_inventories : nombre d'inventaires COMPLETS consécutifs où la vente est absente (0 dès qu'elle
--     réapparaît) ; un inventaire partiel ou en échec ne le modifie jamais ;
--   * absent_since : date du premier de ces inventaires ;
--   * absent_run_id : dernier run compté, pour ne jamais compter deux fois le même inventaire.
--
-- Rattrapage : une ligne dont le dernier inventaire complet l'a vue absente (state = 'absent') compte déjà pour
-- un inventaire ; le deuxième inventaire complet suivant la migration suffit donc pour retirer les ventes déjà
-- disparues. Aucune autre donnée n'est modifiée par la migration, et aucune vente n'est retirée à ce stade.

alter table app_private.auction_sale_source_presence
  add column if not exists absent_inventories integer not null default 0
    check (absent_inventories >= 0),
  add column if not exists absent_since timestamptz,
  add column if not exists absent_run_id text;

comment on column app_private.auction_sale_source_presence.absent_inventories is
  'Inventaires complets consécutifs de la source où la vente est absente (remis à 0 quand elle réapparaît).';
comment on column app_private.auction_sale_source_presence.absent_since is
  'Fin du premier des inventaires complets consécutifs où la vente est absente.';
comment on column app_private.auction_sale_source_presence.absent_run_id is
  'Dernier run dont l''inventaire complet a été compté dans absent_inventories (idempotence).';

update app_private.auction_sale_source_presence
   set absent_inventories = 1,
       absent_since = checked_at
 where state = 'absent'
   and absent_inventories = 0;

-- Retrait. Appelée par le pipeline juste après un inventaire complet réussi (src/source_absence.py), seule.
-- Droits : aucun rôle navigateur ; le pipeline se connecte avec le rôle propriétaire de la base.
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
  v_alert_key text;
  v_complete_at timestamptz;
  v_population integer;
  v_candidates uuid[];
  v_share numeric;
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
        and not exists (
          select 1
          from app_private.auction_sale_source_presence other
          where other.sale_id = sale.id
            and other.source_name <> p_source
            and (other.state is distinct from 'absent' or other.absent_inventories < c_min_inventories)
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

  -- Garde-fou : un coup trop large ressemble à un inventaire tronqué, pas à des ventes disparues.
  if v_share > c_max_share then
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
        'sample_sale_ids', v_candidates[1:10],
        'message', 'Plus de 15 % des ventes visibles de la source sont absentes des deux derniers inventaires complets : aucun retrait. Vérifier l''inventaire de la source.'
      ),
      true,
      p_now
    );
    return pg_catalog.jsonb_build_object(
      'source', p_source,
      'action', 'blocked',
      'population', v_population,
      'candidates', pg_catalog.cardinality(v_candidates),
      'share', pg_catalog.round(v_share, 3)
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
  'Passe en withdrawn les ventes visibles absentes des deux derniers inventaires complets de leur source (toutes leurs sources, si elles en ont plusieurs). Ne fait rien si plus de 15 % des ventes visibles de la source seraient retirées : alerte opérationnelle à la place.';

commit;
