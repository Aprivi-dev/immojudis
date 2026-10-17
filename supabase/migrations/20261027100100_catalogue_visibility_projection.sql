begin;

set local lock_timeout = '5s';

-- 2/3 de « visibilité du catalogue sans relire raw_payload » (contexte dans 20261027100200).
-- Suppose 20261027100000 (les trois colonnes). Pose les fonctions de calcul, les déclencheurs qui
-- maintiennent les colonnes, puis rattrape les lignes existantes. Aucune vue ni fonction publique n'est
-- encore modifiée : la visibilité publique ne change qu'avec 20261027100200.
--
-- À APPLIQUER HORS COLLECTE. Cette transaction prend un verrou SHARE ROW EXCLUSIVE sur auction_sales
-- jusqu'au COMMIT : les lectures du catalogue continuent, mais toute écriture (la collecte, le
-- rattrapage des sources, les purges) attend la fin de la migration. Le rattrapage relit raw_payload
-- (quarantaine) de chaque ligne : environ 100 Mo à décompresser, soit de l'ordre de 2 s d'après la
-- mesure de 20261009180000 ; c'est la durée de l'attente des écritures. lock_timeout (5 s) fait échouer la migration, sans effet, si le
-- verrou n'est pas obtenu : relancer hors collecte.
--
-- Pourquoi un verrou posé d'emblée plutôt que celui, implicite, de CREATE TRIGGER : le rattrapage
-- repère les lignes à corriger puis les corrige. Aucune écriture ne peut s'intercaler entre les deux,
-- ni entre le rattrapage et la mise en service des déclencheurs.
lock table public.auction_sales in share row exclusive mode;

-- Calcule les trois valeurs à partir des seules entrées de la décision d'origine. Même source de vérité
-- pour le déclencheur, le rattrapage ci-dessous et la requête de contrôle.
create or replace function app_private.catalogue_visibility_projection(
  p_materialized boolean,
  p_deadline timestamptz,
  p_sale_date timestamptz,
  p_raw jsonb,
  p_sale_procedure jsonb
)
returns table (
  expiry timestamptz,
  state_observed_at timestamptz,
  state_end_estimate date
)
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  v_raw jsonb;
  v_state jsonb;
begin
  expiry := null;
  state_observed_at := null;
  state_end_estimate := null;

  -- Date limite matérialisée : la branche rapide des prédicats suffit, rien à conserver. Retour avant
  -- toute lecture de p_raw : raw_payload (TOAST, jusqu'à 2,7 Mo) n'est pas détoasté pour ces lignes.
  if coalesce(p_materialized, false) and p_deadline is not null then
    return next;
    return;
  end if;

  v_raw := case
    when jsonb_typeof(coalesce(p_raw, '{}'::jsonb)) = 'object' then coalesce(p_raw, '{}'::jsonb)
    else '{}'::jsonb
  end;

  -- Même objet que celui des anciens appels : raw_payload complété par la procédure de la ligne.
  expiry := app_private.sale_catalogue_expiry(
    p_sale_date,
    v_raw || jsonb_build_object('sale_procedure', coalesce(p_sale_procedure, '{}'::jsonb))
  );

  -- Contrôles statiques de app_private.state_listing_is_live (20261015100000). Une valeur qui passe
  -- les formats mais n'existe pas (2026-02-30, fuseau +99:00) faisait lever l'ancien prédicat à chaque
  -- lecture ; ici elle laisse les colonnes nulles : l'annonce est masquée, jamais l'écriture refusée.
  v_state := v_raw -> 'state_listing';
  if p_sale_date is null
     and jsonb_typeof(v_state) = 'object'
     and coalesce(v_raw ->> 'source_name', '') = 'cessions_etat'
     and coalesce(v_state ->> 'active', '') = 'true'
     and coalesce(v_state ->> 'observed_at', '')
       ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([.]\d{1,6})?(Z|[+-]\d{2}:\d{2})$'
     and coalesce(v_state ->> 'listing_end_estimate', '') ~ '^(\d{4}-\d{2}-\d{2})?$' then
    begin
      state_observed_at := (v_state ->> 'observed_at')::timestamptz;
      state_end_estimate := nullif(v_state ->> 'listing_end_estimate', '')::date;
    exception
      -- Classe 22 (data_exception), limitée à ces deux conversions : jour ou mois inexistant (22008),
      -- décalage horaire hors limites comme +99:00 (22009), et toute autre erreur de donnée du même
      -- genre. Une écriture n'est jamais refusée pour cela.
      when data_exception then
        state_observed_at := null;
        state_end_estimate := null;
    end;
  end if;

  return next;
end;
$function$;

comment on function app_private.catalogue_visibility_projection(boolean, timestamptz, timestamptz, jsonb, jsonb) is
  'Valeurs matérialisées (catalogue_expiry_fallback, catalogue_state_*) qui remplacent la relecture de raw_payload par le repli de sale_catalogue_entry_is_live_materialized.';

revoke all on function app_private.catalogue_visibility_projection(
  boolean, timestamptz, timestamptz, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function app_private.catalogue_visibility_projection(
  boolean, timestamptz, timestamptz, jsonb, jsonb
) to service_role;

-- Le prédicat de visibilité par date, en colonnes seules. Équivalent de
-- sale_catalogue_entry_is_live_materialized(materialized, deadline, sale_date, raw_payload,
-- sale_procedure) pour toute ligne matérialisée, mais vrai/faux (jamais nul) et sans raw_payload.
create or replace function app_private.sale_catalogue_projection_is_live(
  p_materialized boolean,
  p_deadline timestamptz,
  p_sale_date timestamptz,
  p_fallback_expiry timestamptz,
  p_state_observed_at timestamptz,
  p_state_end_estimate date
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  select coalesce(
    case
      -- Échoue fermé : une ligne non matérialisée n'existe pas en base (voir 20261027100200).
      when not coalesce(p_materialized, false) then false
      when p_deadline is not null then p_deadline > current_timestamp
      -- Fiche de l'État sans échéance : mêmes expressions que state_listing_is_live.
      when p_sale_date is null then
        p_state_observed_at > current_timestamp - interval '14 days'
        and p_state_observed_at <= current_timestamp + interval '1 day'
        and (
          p_state_end_estimate is null
          or p_state_end_estimate >= (current_timestamp at time zone 'Europe/Paris')::date
        )
      else p_fallback_expiry > current_timestamp
    end,
    false
  );
$function$;

comment on function app_private.sale_catalogue_projection_is_live(boolean, timestamptz, timestamptz, timestamptz, timestamptz, date) is
  'Visibilité par date lue sur des colonnes seules (catalogue_expiry_deadline, catalogue_expiry_fallback, catalogue_state_*), sans raw_payload. Remplace sale_catalogue_entry_is_live_materialized dans les vues et fonctions publiques.';

revoke all on function app_private.sale_catalogue_projection_is_live(
  boolean, timestamptz, timestamptz, timestamptz, timestamptz, date
) from public, anon, authenticated;
grant execute on function app_private.sale_catalogue_projection_is_live(
  boolean, timestamptz, timestamptz, timestamptz, timestamptz, date
) to anon, authenticated, service_role;

-- Recalcule, à chaque insertion et à chaque écriture d'une colonne qui compte, la quarantaine et les
-- trois valeurs de repli. La quarantaine est recalculée ici même si raw_payload n'a pas changé : une
-- écriture directe de catalogue_quarantined est donc corrigée au lieu de rendre publique une annonce
-- marquée « publication_quarantine ». Seule une écriture faite triggers désactivés y échappe ; la
-- requête de dérive de docs/runbooks/catalogue-visibility-projection.md la détecte.
create or replace function app_private.sync_auction_sale_catalogue_visibility()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_projection record;
begin
  new.catalogue_quarantined :=
    coalesce(new.raw_payload ->> 'publication_quarantine', '') <> '';

  select projection.*
    into v_projection
    from app_private.catalogue_visibility_projection(
      new.catalogue_expiry_materialized,
      new.catalogue_expiry_deadline,
      new.sale_date,
      new.raw_payload,
      new.sale_procedure
    ) projection;
  new.catalogue_expiry_fallback := v_projection.expiry;
  new.catalogue_state_observed_at := v_projection.state_observed_at;
  new.catalogue_state_end_estimate := v_projection.state_end_estimate;
  return new;
end;
$function$;

revoke all on function app_private.sync_auction_sale_catalogue_visibility()
  from public, anon, authenticated;
grant execute on function app_private.sync_auction_sale_catalogue_visibility() to service_role;

-- « zzzzz_ » se classe après « zzzz_ » : ces déclencheurs voient la date limite que
-- zzzz_auction_sales_retention_deadline_* vient de calculer. Le WHEN est évalué après les déclencheurs
-- précédents ; il couvre aussi une écriture directe des colonnes matérialisées et de
-- catalogue_quarantined (elles sont recalculées).
drop trigger if exists zzzzz_auction_sales_catalogue_visibility_insert on public.auction_sales;
create trigger zzzzz_auction_sales_catalogue_visibility_insert
  before insert on public.auction_sales
  for each row execute function app_private.sync_auction_sale_catalogue_visibility();

drop trigger if exists zzzzz_auction_sales_catalogue_visibility_update on public.auction_sales;
create trigger zzzzz_auction_sales_catalogue_visibility_update
  before update on public.auction_sales
  for each row
  when (
    old.sale_date is distinct from new.sale_date
    or old.raw_payload is distinct from new.raw_payload
    or old.sale_procedure is distinct from new.sale_procedure
    or old.catalogue_expiry_materialized is distinct from new.catalogue_expiry_materialized
    or old.catalogue_expiry_deadline is distinct from new.catalogue_expiry_deadline
    or old.catalogue_quarantined is distinct from new.catalogue_quarantined
    or old.catalogue_expiry_fallback is distinct from new.catalogue_expiry_fallback
    or old.catalogue_state_observed_at is distinct from new.catalogue_state_observed_at
    or old.catalogue_state_end_estimate is distinct from new.catalogue_state_end_estimate
  )
  execute function app_private.sync_auction_sale_catalogue_visibility();

-- Rattrapage des lignes existantes, sans déclencher le journal des ventes, la relecture IA ni les
-- contrôles de source (même méthode que 20261009180000 : projection de données existantes, pas un
-- changement de vente). Il recalcule aussi catalogue_quarantined : le déclencheur le dérive de
-- raw_payload à chaque insertion et à chaque écriture, la colonne est donc déjà égale à
-- coalesce(raw_payload->>'publication_quarantine', '') <> '' ; ce passage ne corrige que d'éventuelles
-- lignes écrites hors déclencheur.
--
-- Ce qui est lu : pour la quarantaine, raw_payload->>'publication_quarantine' de chaque ligne (c'est la
-- seule lecture de raw_payload de toute la table) ; pour le repli, seulement les lignes hors du chemin
-- rapide (date limite matérialisée absente : environ 200 en production), les autres étant vérifiées sur
-- leurs seules colonnes (les trois valeurs de repli doivent y être nulles). Les lignes à corriger sont
-- repérées avant de désactiver les déclencheurs ; le verrou posé en tête de migration garantit qu'aucune
-- écriture ne s'intercale.
do $backfill$
declare
  v_ids uuid[];
begin
  select array_agg(drift.id)
    into v_ids
    from (
      select sale.id
      from public.auction_sales sale
      where sale.catalogue_quarantined
              is distinct from (coalesce(sale.raw_payload ->> 'publication_quarantine', '') <> '')
         or case
              when coalesce(sale.catalogue_expiry_materialized, false)
                   and sale.catalogue_expiry_deadline is not null
                then sale.catalogue_expiry_fallback is not null
                  or sale.catalogue_state_observed_at is not null
                  or sale.catalogue_state_end_estimate is not null
              else exists (
                select 1
                from app_private.catalogue_visibility_projection(
                  sale.catalogue_expiry_materialized,
                  sale.catalogue_expiry_deadline,
                  sale.sale_date,
                  sale.raw_payload,
                  sale.sale_procedure
                ) projection
                where sale.catalogue_expiry_fallback is distinct from projection.expiry
                   or sale.catalogue_state_observed_at is distinct from projection.state_observed_at
                   or sale.catalogue_state_end_estimate is distinct from projection.state_end_estimate
              )
            end
    ) drift;

  if v_ids is not null then
    alter table public.auction_sales disable trigger user;

    update public.auction_sales sale
    set catalogue_quarantined = target.quarantined,
        catalogue_expiry_fallback = target.expiry,
        catalogue_state_observed_at = target.state_observed_at,
        catalogue_state_end_estimate = target.state_end_estimate
    from (
      select
        source.id,
        coalesce(source.raw_payload ->> 'publication_quarantine', '') <> '' as quarantined,
        projection.expiry,
        projection.state_observed_at,
        projection.state_end_estimate
      from public.auction_sales source
      cross join lateral app_private.catalogue_visibility_projection(
        source.catalogue_expiry_materialized,
        source.catalogue_expiry_deadline,
        source.sale_date,
        source.raw_payload,
        source.sale_procedure
      ) projection
      where source.id = any (v_ids)
    ) target
    where sale.id = target.id;

    alter table public.auction_sales enable trigger user;
  end if;
end;
$backfill$;

commit;
