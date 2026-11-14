begin;

set local lock_timeout = '5s';

-- Ventes à venir sans date d'audience que leur source ne montre plus : statut inconnu (14/11/2026, état des lieux, D13).
--
-- Une vente datée quitte « à venir » avec sa date ; une vente sans date d'audience n'a pas d'échéance. Au 14/11, 33
-- ventes à venir sans date n'avaient été revues par aucune collecte depuis août ou septembre (encheres_publiques 13,
-- notaires 18, avoventes 1, cessions_etat 2) : app_private.withdraw_missing_source_sales ne les retire pas (elle ne
-- voit que les inventaires complets, et refuse au-delà de 15 % d'une source).
--
-- Cette fonction, voisine de la fonction de retrait et avec ses garde-fous, passe en « unknown » les ventes
-- « upcoming » sans date d'audience d'une source qu'aucune collecte n'a revues (last_seen_at) depuis 14 jours :
--   * source ACTIVE : seulement juste après un inventaire complet de la source (last_inventory_complete_at de moins
--     de 2 h, comme le retrait) ; le pipeline ne l'appelle qu'après un inventaire complet, réussi et non refusé
--     (src/autonomous_runner.py, finish_source) ;
--   * source DÉSACTIVÉE (auction_source_state.enabled faux) : décision du propriétaire du 14/11/2026, la règle
--     s'applique aussi, sans condition d'inventaire puisque la source ne tourne pas. Le pipeline l'appelle pour
--     toutes les sources désactivées à la fin de chaque passage (src/source_absence.py) ;
--   * plafond et alerte du retrait : au plus 15 % des ventes visibles de la source d'un coup (au moins une) ; au-delà,
--     rien n'est fait et l'alerte catalogue.unseen_undated.<source> s'ouvre.
-- Rien n'est retiré ni supprimé : la vente reste visible, le statut précédent est gardé dans raw_payload.unseen_undated
-- (lu par le suivi des ventes, src/lib/sale-change-monitor.ts, qui annonce « Annonce non revue depuis 14 jours » sans
-- gravité), et la collecte qui revoit la vente la republie avec le statut que la source donne.
--
-- 14 jours (c_unseen_days) : la même valeur que services/data-pipeline/src/source_absence.py (UNSEEN_UNDATED_DAYS),
-- comparée par un test ; 15 % et le plancher d'une vente sont ceux du retrait (MAX_WITHDRAWN_SHARE, MIN_WITHDRAWALS).
-- La migration ne touche aucune ligne : l'effet vient des prochains passages de collecte.
-- RETOUR ARRIÈRE : supprimer la fonction (le pipeline ignore une base où elle manque).

create or replace function app_private.mark_unseen_undated_sales(
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
  c_unseen_days constant integer := 14;
  c_max_share constant numeric := 0.15;
  c_min_marks constant integer := 1;
  c_inventory_max_age constant interval := interval '2 hours';
  v_alert_key text;
  v_enabled boolean;
  v_complete_at timestamptz;
  v_population integer;
  v_candidates uuid[];
  v_share numeric;
  v_allowed integer;
  v_marked integer := 0;
begin
  if p_source is null or pg_catalog.btrim(p_source) = '' then
    raise exception using errcode = '22023', message = 'A source name is required.';
  end if;
  v_alert_key := 'catalogue.unseen_undated.' || p_source;

  -- Une passe à la fois par source.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('mark_unseen_undated_sales:' || p_source, 0)
  );

  select state.enabled, state.last_inventory_complete_at
    into v_enabled, v_complete_at
  from public.auction_source_state state
  where state.source_name = p_source;
  if not found then
    return pg_catalog.jsonb_build_object('source', p_source, 'action', 'skipped', 'reason', 'unknown_source');
  end if;
  -- Source active : jamais sans un inventaire complet récent, comme le retrait. Source désactivée : décision du
  -- propriétaire du 14/11/2026, la condition d'inventaire ne s'applique pas (la source ne tourne pas).
  if v_enabled and (v_complete_at is null or v_complete_at < p_now - c_inventory_max_age) then
    return pg_catalog.jsonb_build_object(
      'source', p_source, 'action', 'skipped', 'reason', 'no_recent_complete_inventory'
    );
  end if;

  select count(*)::integer,
         coalesce(
           pg_catalog.array_agg(sale.id order by sale.id) filter (
             where sale.status = 'upcoming'
               and sale.sale_date is null
               and sale.last_seen_at < p_now - pg_catalog.make_interval(days => c_unseen_days)
           ),
           '{}'
         )
    into v_population, v_candidates
  from public.auction_sales sale
  where sale.source_name = p_source
    and coalesce(sale.status, 'unknown') in ('upcoming', 'unknown', 'postponed')
    and app_private.auction_sale_is_publicly_visible(sale.id);

  if pg_catalog.cardinality(v_candidates) = 0 then
    perform app_private.sync_operational_alert(v_alert_key, 'import', 'warning', '{}'::jsonb, false, p_now);
    return pg_catalog.jsonb_build_object(
      'source', p_source, 'action', 'none', 'enabled', v_enabled, 'population', v_population, 'candidates', 0
    );
  end if;

  v_share := pg_catalog.cardinality(v_candidates)::numeric / greatest(v_population, 1);
  v_allowed := greatest(c_min_marks, pg_catalog.floor(c_max_share * v_population)::integer);

  -- Garde-fou du retrait : un coup trop large ressemble à une collecte cassée, pas à des ventes disparues.
  if pg_catalog.cardinality(v_candidates) > v_allowed then
    perform app_private.sync_operational_alert(
      v_alert_key,
      'import',
      'warning',
      pg_catalog.jsonb_build_object(
        'source', p_source,
        'enabled', v_enabled,
        'population', v_population,
        'candidates', pg_catalog.cardinality(v_candidates),
        'share', pg_catalog.round(v_share, 3),
        'max_marks', v_allowed,
        'unseen_days', c_unseen_days,
        'sample_sale_ids', v_candidates[1:10],
        'message', 'Plus de 15 % des ventes visibles de la source (au moins 1) sont à venir, sans date et non revues '
          || 'depuis 14 jours : aucune n''est passée en statut inconnu. Vérifier la collecte de la source.'
      ),
      true,
      p_now
    );
    return pg_catalog.jsonb_build_object(
      'source', p_source,
      'action', 'blocked',
      'enabled', v_enabled,
      'population', v_population,
      'candidates', pg_catalog.cardinality(v_candidates),
      'share', pg_catalog.round(v_share, 3),
      'max_marks', v_allowed
    );
  end if;

  if p_apply then
    update public.auction_sales sale
       set status = 'unknown',
           updated_at = p_now,
           raw_payload = (
             case when pg_catalog.jsonb_typeof(sale.raw_payload) = 'object'
               then sale.raw_payload else '{}'::jsonb end
           ) || pg_catalog.jsonb_build_object(
             'unseen_undated', pg_catalog.jsonb_build_object(
               'source', p_source,
               'status_before', sale.status,
               'marked_at', p_now,
               'last_seen_at', sale.last_seen_at,
               'unseen_days', c_unseen_days
             )
           )
     where sale.id = any (v_candidates)
       and sale.status = 'upcoming'
       and sale.sale_date is null;
    get diagnostics v_marked = row_count;
  end if;

  perform app_private.sync_operational_alert(v_alert_key, 'import', 'warning', '{}'::jsonb, false, p_now);
  return pg_catalog.jsonb_build_object(
    'source', p_source,
    'action', case when p_apply then 'marked' else 'would_mark' end,
    'enabled', v_enabled,
    'population', v_population,
    'candidates', pg_catalog.cardinality(v_candidates),
    'marked', v_marked,
    'share', pg_catalog.round(v_share, 3)
  );
end;
$function$;

revoke all on function app_private.mark_unseen_undated_sales(text, boolean, timestamptz)
  from public, anon, authenticated, service_role;

comment on function app_private.mark_unseen_undated_sales(text, boolean, timestamptz) is
  'Passe en unknown les ventes upcoming sans date d''audience d''une source non revues depuis 14 jours : source active '
  'juste après un inventaire complet, source désactivée sans condition d''inventaire (décision du 14/11/2026). Au-delà '
  'de 15 % des ventes visibles de la source (au moins 1) : rien, alerte catalogue.unseen_undated.<source>.';

commit;
