begin;

set local lock_timeout = '5s';

-- Plafond des ventes notariales : les conditions de la vente arrivent au navigateur du compte Analyse et du
-- compte qui a débloqué la vente (jamais au compte Découverte non débloqué).
--
-- Le pipeline lit dans l'annonce des Notaires de France les conditions de la vente
-- (services/data-pipeline/src/sources/notaires_extraction.py, sale_conditions) et les range dans
-- raw_payload -> 'source_property_features' -> 'sale_conditions' ; la nature du prix de départ est dans
-- raw_payload ->> 'starting_price_nature' (notaires_price_nature.py). raw_payload n'est exposé ni à la vue de la
-- fiche (v_auction_sales_app) ni à celle des ventes débloquées (v_auction_sales_unlocked) : sans cette migration,
-- la fiche ne sait pas si une vente notariale est à la bougie ou interactive, ni qui paie les honoraires de
-- négociation, ni quelle est la garantie lue : elle ne peut donc pas chiffrer le plafond de la vente (le régime de
-- frais en dépend, src/lib/fee-regime.ts) et un compte qui a débloqué la vente n'a pas la même garantie
-- (deposit_eur) que le compte Analyse.
--
-- Cette migration ajoute, en DERNIÈRE colonne de v_auction_sales_app et de v_auction_sales_unlocked :
--
--   sale_conditions jsonb  -- liste blanche des conditions de la vente notariale, ou null
--
-- Liste blanche (app_private.public_sale_conditions) : procedure (notarial_auction, online_tender),
-- adjudication_type, origin (ADJUDICATION, LICITATION, SAISIE : les valeurs que le pipeline écrit,
-- notaires_extraction.py ORIGINE_LABELS ; le code refuse le régime notarial pour une licitation ou une saisie),
-- price_nature (mise_a_prix, displayed_price, first_offer_possible), first_offer_eur, deposit_eur,
-- advertising_fees_eur, negotiation_fee_rate (entre 1 % et 20 %, arrondi au demi-point : 0,005),
-- negotiation_fee_payer (ACQUEREUR, VENDEUR), overbid_allowed. Ces champs décrivent les règles de la vente et ne
-- sont pas des données personnelles. Chaque valeur est contrôlée (type, bornes) ; une valeur invalide est omise.
-- Cette projection ne copie JAMAIS : le prix d'adjudication (réservé, adjudication_price_eur est null dans la vue
-- des ventes débloquées), le prix plancher (floor_price_eur de ces conditions), la faculté de baisse, la dernière
-- offre possible, les modalités et l'heure de dépôt de la consignation, la date de séance, le montant des
-- honoraires de négociation (il permettrait de retrouver le prix de réserve : seul le taux est repris, et arrondi
-- au demi-point, parce qu'un taux exact varie avec le prix de réserve dans les barèmes dégressifs), ni aucune autre
-- clé. Elle ne dit rien de ce que d'autres colonnes exposent déjà : la vue de la fiche sert
-- raw_payload -> 'source_blocks' en entier au compte Analyse, qui peut contenir un prix plancher publié par
-- l'annonce ; ce n'est pas l'objet de cette migration.
--
-- La fonction n'est appelée que pour les ventes de la source « notaires » (s.source_name = 'notaires' : toutes les
-- ventes notariales du pipeline la portent) : les autres sources ont un raw_payload qui peut atteindre plusieurs
-- Mo (les ventes notariales pèsent 121 ko en médiane), que la fonction n'a aucune raison de lire. Une vente d'une
-- autre source a sale_conditions = null : elle n'a pas de plafond notarial.
--
-- v_auction_sales_discovery (compte Découverte non débloqué) NE CHANGE PAS : elle n'a pas cette colonne. Les vues
-- de recherche (*_search) listent leurs colonnes et ne changent pas non plus.
--
-- Droits : aucune colonne de auction_sales n'est ouverte de plus. La vue de la fiche est security invoker et lit
-- déjà raw_payload (droits de colonne de 20261010003000) ; la vue des ventes débloquées est une vue definer qui lit
-- la table avec les droits de son propriétaire. La fonction est appelée avec les droits de l'appelant : elle est
-- accordée à authenticated et service_role, jamais à anon, comme les autres fonctions de projection de ces vues.
--
-- Les définitions actuelles des vues ont été réécrites sur place par plusieurs migrations : on les relit
-- (pg_get_viewdef) au lieu de les recopier, et on refuse de continuer si leur forme n'est pas celle attendue
-- (même méthode que 20261101110000). Options (security_invoker, security_barrier), droits et commentaires des vues
-- sont conservés par create or replace view. Rejouable : une vue déjà à jour est laissée.
--
-- Retour arrière (sans toucher aux vues ni supprimer la colonne) : remplacer le corps de la fonction par
--
--   create or replace function app_private.public_sale_conditions(p_raw_payload pg_catalog.jsonb)
--   returns pg_catalog.jsonb language sql stable parallel safe security invoker set search_path = ''
--   as $fn$ select null::pg_catalog.jsonb $fn$;
--
-- (même signature). La colonne sale_conditions reste dans les deux vues, vide : le code se replie sur la valeur par
-- défaut (aucun plafond notarial, garantie de 20 % de la mise à prix signalée) et les droits sont inchangés. Pour
-- retirer aussi la colonne, il faudrait réécrire les deux vues sans elle : à faire dans une migration à part.

create or replace function app_private.public_sale_conditions(p_raw_payload pg_catalog.jsonb)
returns pg_catalog.jsonb
language sql
stable
parallel safe
security invoker
set search_path = ''
as $$
  with source as (
    select
      case
        when pg_catalog.jsonb_typeof(p_raw_payload #> '{source_property_features,sale_conditions}') = 'object'
          then p_raw_payload #> '{source_property_features,sale_conditions}'
        else '{}'::pg_catalog.jsonb
      end as conditions,
      case
        when pg_catalog.jsonb_typeof(p_raw_payload) = 'object'
          then p_raw_payload ->> 'starting_price_nature'
        else null
      end as price_nature
  )
  select nullif(
    pg_catalog.jsonb_strip_nulls(
      pg_catalog.jsonb_build_object(
        'procedure',
        case
          when pg_catalog.jsonb_typeof(source.conditions -> 'procedure') = 'string'
            and source.conditions ->> 'procedure' in ('notarial_auction', 'online_tender')
            then source.conditions -> 'procedure'
        end,
        'adjudication_type',
        case
          when pg_catalog.jsonb_typeof(source.conditions -> 'adjudication_type') = 'string'
            and pg_catalog.upper(pg_catalog.btrim(source.conditions ->> 'adjudication_type')) ~ '^[A-Z_]{1,30}$'
            then pg_catalog.to_jsonb(pg_catalog.upper(pg_catalog.btrim(source.conditions ->> 'adjudication_type')))
        end,
        'origin',
        case
          when pg_catalog.jsonb_typeof(source.conditions -> 'origin') = 'string'
            and pg_catalog.upper(pg_catalog.btrim(source.conditions ->> 'origin'))
              in ('ADJUDICATION', 'LICITATION', 'SAISIE')
            then pg_catalog.to_jsonb(pg_catalog.upper(pg_catalog.btrim(source.conditions ->> 'origin')))
        end,
        'price_nature',
        case
          when source.price_nature in ('mise_a_prix', 'displayed_price', 'first_offer_possible')
            then pg_catalog.to_jsonb(source.price_nature)
        end,
        'first_offer_eur',
        case
          when pg_catalog.jsonb_typeof(source.conditions -> 'first_offer_eur') = 'number'
            and (source.conditions ->> 'first_offer_eur')::pg_catalog.numeric > 0
            and (source.conditions ->> 'first_offer_eur')::pg_catalog.numeric <= 1000000000
            then source.conditions -> 'first_offer_eur'
        end,
        'deposit_eur',
        case
          when pg_catalog.jsonb_typeof(source.conditions -> 'deposit_eur') = 'number'
            and (source.conditions ->> 'deposit_eur')::pg_catalog.numeric > 0
            and (source.conditions ->> 'deposit_eur')::pg_catalog.numeric <= 1000000000
            then source.conditions -> 'deposit_eur'
        end,
        'advertising_fees_eur',
        case
          when pg_catalog.jsonb_typeof(source.conditions -> 'advertising_fees_eur') = 'number'
            and (source.conditions ->> 'advertising_fees_eur')::pg_catalog.numeric > 0
            and (source.conditions ->> 'advertising_fees_eur')::pg_catalog.numeric <= 1000000000
            then source.conditions -> 'advertising_fees_eur'
        end,
        'negotiation_fee_rate',
        -- Bornes (1 % à 20 %) contrôlées sur la valeur lue, puis arrondi au demi-point (0,005) : le taux exact
        -- permettrait de retrouver le prix de réserve (émoluments de négociation / prix de réserve).
        case
          when pg_catalog.jsonb_typeof(source.conditions -> 'negotiation_fee_rate') = 'number'
            and (source.conditions ->> 'negotiation_fee_rate')::pg_catalog.numeric >= 0.01
            and (source.conditions ->> 'negotiation_fee_rate')::pg_catalog.numeric <= 0.20
            then pg_catalog.to_jsonb(
              pg_catalog.trim_scale(
                pg_catalog.round((source.conditions ->> 'negotiation_fee_rate')::pg_catalog.numeric * 200) / 200
              )
            )
        end,
        'negotiation_fee_payer',
        case
          when pg_catalog.jsonb_typeof(source.conditions -> 'negotiation_fee_payer') = 'string'
            and pg_catalog.upper(pg_catalog.btrim(source.conditions ->> 'negotiation_fee_payer'))
              in ('ACQUEREUR', 'VENDEUR')
            then pg_catalog.to_jsonb(pg_catalog.upper(pg_catalog.btrim(source.conditions ->> 'negotiation_fee_payer')))
        end,
        'overbid_allowed',
        case
          when pg_catalog.jsonb_typeof(source.conditions -> 'overbid_allowed') = 'boolean'
            then source.conditions -> 'overbid_allowed'
        end
      )
    ),
    '{}'::pg_catalog.jsonb
  )
  from source;
$$;

comment on function app_private.public_sale_conditions(pg_catalog.jsonb) is
  'The conditions of a notarial sale that the sale (fiche) and unlocked views may show, read from raw_payload (source_property_features.sale_conditions and starting_price_nature): procedure, adjudication_type, origin, price_nature, first_offer_eur, deposit_eur, advertising_fees_eur, negotiation_fee_rate (1 % to 20 %, rounded to 0.005), negotiation_fee_payer, overbid_allowed, each validated; null when none. This projection never copies the adjudication price, the floor price, the price reduction, the last possible offer, the deposit terms, the session date or the negotiation fee amount. Called only for source_name = notaires. Exposed as sale_conditions by v_auction_sales_app and v_auction_sales_unlocked, never by the discovery view.';

revoke all on function app_private.public_sale_conditions(pg_catalog.jsonb)
  from public, anon, authenticated;
grant execute on function app_private.public_sale_conditions(pg_catalog.jsonb)
  to authenticated, service_role;

do $grants$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'lovable_readonly') then
    execute 'grant execute on function app_private.public_sale_conditions(pg_catalog.jsonb) to lovable_readonly';
  end if;
end;
$grants$;

do $rewrite$
declare
  -- Dernière colonne : le seul « FROM » de plus haut niveau de la définition est celui précédé d'exactement trois
  -- espaces en début de ligne (les sous-requêtes des jointures latérales sont plus indentées).
  v_top_level_from constant text := E'\n   FROM ';
  v_conditions_new constant text :=
    E',\n    CASE WHEN s.source_name = ''notaires'' THEN app_private.public_sale_conditions(s.raw_payload) ELSE NULL::jsonb END AS sale_conditions';
  v_view_name text;
  v_before text;
  v_after text;
  v_options text;
  v_views integer := 0;
  v_position integer;
begin
  for v_view_name, v_before, v_options in
    select
      view_row.relname,
      pg_catalog.pg_get_viewdef(view_row.oid, true),
      pg_catalog.array_to_string(view_row.reloptions, ', ')
    from pg_catalog.pg_class view_row
    join pg_catalog.pg_namespace schema_row on schema_row.oid = view_row.relnamespace
    where schema_row.nspname = 'public'
      and view_row.relkind = 'v'
      -- Pas v_auction_sales_discovery : un compte Découverte non débloqué ne reçoit pas ces conditions.
      and view_row.relname in ('v_auction_sales_app', 'v_auction_sales_unlocked')
    order by view_row.relname
  loop
    v_views := v_views + 1;
    v_after := v_before;

    if v_after !~ 'AS sale_conditions' then
      v_position := position(v_top_level_from in v_after);
      if v_position = 0
         or position(v_top_level_from in substr(v_after, v_position + 1)) <> 0 then
        raise exception using
          errcode = 'P0001',
          message = format(
            'Unexpected definition of public.%s: cannot find its single top-level FROM.',
            v_view_name
          );
      end if;
      v_after := substr(v_after, 1, v_position - 1) || v_conditions_new || substr(v_after, v_position);
    end if;

    if v_after <> v_before then
      execute 'create or replace view public.' || quote_ident(v_view_name)
        || case when coalesce(v_options, '') <> '' then ' with (' || v_options || ')' else '' end
        || ' as ' || rtrim(v_after, E';\n ');
    end if;
  end loop;

  if v_views <> 2 then
    raise exception using
      errcode = '42P01',
      message = 'Missing public.v_auction_sales_app or v_auction_sales_unlocked.';
  end if;
end;
$rewrite$;

notify pgrst, 'reload schema';

commit;
