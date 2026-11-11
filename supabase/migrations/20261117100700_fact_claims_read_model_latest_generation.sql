begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Registre des pièces, lot R2a : la vue des observations ne montre que la dernière génération de la collecte.
-- INERTE tant que la collecte écrit une seule génération : aucune vente ne porte deux générations, rien n'est
-- masqué. À APPLIQUER AVANT le lot « collecte » qui fait passer ses observations à la version 3.
--
-- Pourquoi. L'identifiant d'une observation de la collecte dépend de sa version (extractor_version =
-- 'auction_fact_claims_v<n>', services/data-pipeline/src/fact_claims.py). Au passage à la version 3, chaque
-- observation existante reçoit donc un jumeau, et public.v_auction_fact_claims_read_model, que l'application lit
-- sans filtre de version (src/lib/auction-fact-claims.ts, src/lib/admin-auction-fact-claims-review.ts), montrerait
-- les deux : la fiche et la liste de relecture compteraient chaque fait en double.
--
-- Génération. app_private.fact_claims_generation(version) rend le nombre qui termine 'auction_fact_claims_v<n>',
-- un ou deux chiffres, en ENTIER (v10 > v9). Sans expression rationnelle (la liste de relecture la calcule pour
-- chaque observation) : préfixe fixe, longueur bornée, chiffres seuls, puis conversion, qui ne peut donc ni
-- déborder ni lever. Toute autre version (autre format, trois chiffres ou plus, « v999999 ») est ILLISIBLE : elle
-- donne NULL, l'observation reste visible et ne masque rien.
--
-- Plafond. app_private.fact_claims_generation_ceiling() est la plus haute génération que la collecte déployée a
-- le droit d'écrire : 3 (la version 2 d'aujourd'hui, la version 3 du lot « collecte »). Une génération lisible
-- au-dessus du plafond ne compte pas : elle ne masque rien, et ses observations candidates sont elles-mêmes
-- masquées. Sans plafond, une seule observation d'une génération plus haute (un passage d'essai de la collecte
-- suivi d'un retour arrière, une ligne écrite par erreur) masquait pour toujours toutes les candidates de sa
-- vente, et aucune écriture ne pouvait le défaire (les observations sont immuables). Avec lui :
--   * passage d'essai en version 4, puis retour : les observations de l'essai sont au-dessus du plafond, donc
--     sans effet et masquées ; rien à nettoyer ;
--   * retour arrière de la version 3 elle-même : une migration d'une ligne ramène le plafond à 2 ; les
--     observations de la version 3 cessent de masquer et sont masquées, sans rouvrir les jumeaux ;
--   * passage voulu à une version 4 : une migration relève le plafond AVANT le déploiement de la collecte.
--     L'invariant fact-claims-generation-pattern fait échouer la CI si la version écrite par la collecte dépasse
--     le plafond ou ne se lit pas : l'oubli ne peut pas arriver en production.
--
-- Règle. Une observation est masquée quand, à la fois, elle est encore « candidate » (une observation déjà
-- relue, accepted ou conflicted, n'est jamais masquée), elle vient de l'extracteur de la collecte,
-- 'immojudis.pipeline.fact_claims', et :
--   * la MÊME VENTE porte une observation de ce même extracteur d'une génération plus haute, au plus égale au
--     plafond, quel que soit son statut (une version 3 rejetée masque son jumeau version 2 : le fait rejeté ne
--     revient pas) et quel que soit son champ (la collecte émet toutes les observations d'une vente en une
--     passe ; un champ que la version 3 n'émet plus est un champ qu'elle a retiré exprès) ;
--   * ou sa propre génération dépasse le plafond.
-- La génération la plus haute se calcule pour l'extracteur de la collecte seul : la version d'un autre extracteur
-- ne masque rien. coalesce(…, false) : une observation sans extracteur, de version illisible, ou d'une vente sans
-- génération lisible, n'est jamais masquée. Une observation rattachée à un lot seul (auction_sale_id nul) ne
-- masque rien et n'est pas masquée par une autre.
--
-- Le reste de la vue est celui de 20260929103000_ai_review_projection_guard.sql (dernière définition : aucune
-- migration plus récente ne la touche) : mêmes colonnes, dans le même ordre, même expression is_publishable, même
-- filtre de statut. security_invoker = true est répété : CREATE OR REPLACE VIEW sans cette option la retirerait.
-- Droits d'origine repris (service_role seul) ; les deux fonctions, appelées avec les droits du lecteur, sont
-- exécutables par service_role seul. Elles n'ont pas de clause SET search_path, qui empêcherait PostgreSQL de les
-- fondre dans la requête (elles coûteraient un appel par observation) : tout y est qualifié par pg_catalog.
--
-- Limites, à confirmer par la collecte : une vente pour laquelle la nouvelle génération n'émet rien garde ses
-- observations de l'ancienne ; les observations d'une vente doivent partir dans une seule requête, sinon la fiche
-- montre un jeu partiel entre deux lots d'écriture.
--
-- Coût : aucun index nouveau. La lecture par vente (auction_sale_id = …) filtre aussi le sous-ensemble groupé,
-- par l'index auction_fact_claims_sale_field_idx (plan figé par le test pgTAP 890). La liste de relecture paie
-- un agrégat de plus sur les observations rattachées à une vente (mesure dans le runbook).
--
-- Verrous : ACCESS EXCLUSIVE bref sur la vue seulement (remplacement de sa définition) ; aucun verrou sur
-- public.auction_fact_claims au-delà d'une lecture. Possible pendant un import. Rejouable.
--
-- Retour arrière : réappliquer la définition de la vue de 20260929103000_ai_review_projection_guard.sql (lignes
-- 1687 à 1734), revoke et grant compris, puis supprimer les deux fonctions.

create or replace function app_private.fact_claims_generation(p_version text)
returns integer
language sql
immutable
parallel safe
as $$
  select case
    when pg_catalog.left(p_version, 21) = 'auction_fact_claims_v'
      and pg_catalog.length(p_version) in (22, 23)
      and pg_catalog.translate(pg_catalog.substr(p_version, 22), '0123456789', '') = ''
      then pg_catalog.substr(p_version, 22)::integer
  end;
$$;

comment on function app_private.fact_claims_generation(text) is
  'Génération d''une observation de la collecte : le nombre (un ou deux chiffres) qui termine auction_fact_claims_v<n>, en entier ; NULL pour toute autre version. Ne lève jamais.';

create or replace function app_private.fact_claims_generation_ceiling()
returns integer
language sql
immutable
parallel safe
as $$
  select 3;
$$;

comment on function app_private.fact_claims_generation_ceiling() is
  'Plus haute génération d''observations que la collecte déployée a le droit d''écrire. Au-dessus, une génération ne masque rien et ses observations candidates sont masquées. À relever par migration avant de déployer une collecte qui écrit une génération plus haute.';

revoke all on function app_private.fact_claims_generation(text) from public, anon, authenticated;
revoke all on function app_private.fact_claims_generation_ceiling() from public, anon, authenticated;
grant execute on function app_private.fact_claims_generation(text) to service_role;
grant execute on function app_private.fact_claims_generation_ceiling() to service_role;

create or replace view public.v_auction_fact_claims_read_model
with (security_invoker = true)
as
select
  claim.id as claim_id,
  claim.auction_sale_id,
  claim.lot_id,
  claim.field_key,
  claim.value_jsonb,
  claim.claim_status as fact_status,
  (
    claim.claim_status = 'accepted'
    and (
      claim.ai_review_projection_id is null
      or exists (
        select 1
        from public.v_auction_ai_review_projection_reconciliation reconciliation
        where reconciliation.projection_id = claim.ai_review_projection_id
          and reconciliation.auction_sale_id is not distinct from claim.auction_sale_id
          and reconciliation.field_key = claim.field_key
          and reconciliation.ai_value_jsonb is not distinct from claim.value_jsonb
          and reconciliation.local_is_publishable
          and reconciliation.comparison_status = 'match'
          and not app_private.ai_review_sale_is_blocked(claim.auction_sale_id)
      )
    )
  ) as is_publishable,
  claim.conflict_group,
  claim.evidence_kind,
  claim.source_id,
  claim.raw_artifact_id,
  claim.source_record_id,
  claim.artifact_extraction_id,
  claim.source_url,
  claim.evidence_locator,
  claim.confidence_score,
  claim.captured_at,
  claim.resolved_at,
  claim.resolution_note,
  claim.created_at,
  claim.updated_at
from public.auction_fact_claims claim
left join (
  -- Une ligne par vente : la plus haute génération lisible, au plus égale au plafond, de l'extracteur de la
  -- collecte, et la version qui l'écrit. Les versions sont d'abord réduites à une ligne par vente et par version :
  -- la génération se calcule par version présente, pas par observation.
  -- (Le plafond est une clause FILTER de l'agrégat, pas un WHERE : PostgreSQL descendrait un WHERE jusqu'à la
  -- lecture de la table, et recalculerait la génération pour chaque observation.)
  select
    versions.auction_sale_id,
    max(app_private.fact_claims_generation(versions.extractor_version)) filter (
      where app_private.fact_claims_generation(versions.extractor_version)
        <= app_private.fact_claims_generation_ceiling()
    ) as generation,
    'auction_fact_claims_v' || (
      max(app_private.fact_claims_generation(versions.extractor_version)) filter (
        where app_private.fact_claims_generation(versions.extractor_version)
          <= app_private.fact_claims_generation_ceiling()
      )
    )::text as extractor_version
  from (
    select peer.auction_sale_id, peer.extractor_version
    from public.auction_fact_claims peer
    where peer.auction_sale_id is not null
      and peer.extractor_name = 'immojudis.pipeline.fact_claims'
    group by peer.auction_sale_id, peer.extractor_version
  ) versions
  group by versions.auction_sale_id
) latest on latest.auction_sale_id = claim.auction_sale_id
where claim.claim_status in ('candidate', 'accepted', 'conflicted')
  and (claim.auction_sale_id is not null or claim.lot_id is not null)
  -- Une candidate de la collecte qui porte la version la plus haute de sa vente n'est pas masquée : comparaison
  -- d'égalité, sans calcul. Sa génération n'est calculée que si sa version diffère.
  and not coalesce(
    claim.claim_status = 'candidate'
    and claim.extractor_name = 'immojudis.pipeline.fact_claims'
    and claim.auction_sale_id is not null
    and claim.extractor_version is distinct from latest.extractor_version
    and (
      app_private.fact_claims_generation(claim.extractor_version) < latest.generation
      or app_private.fact_claims_generation(claim.extractor_version)
        > app_private.fact_claims_generation_ceiling()
    ),
    false
  );

revoke all on table public.v_auction_fact_claims_read_model
from public, anon, authenticated, service_role;
grant select on table public.v_auction_fact_claims_read_model to service_role;

comment on view public.v_auction_fact_claims_read_model is
  'Trusted read model exposing unresolved, accepted and conflicting fact claims for later listing projections. A candidate claim of the pipeline extractor is hidden once the same sale carries a claim of a higher generation of that extractor, up to the generation ceiling.';

notify pgrst, 'reload schema';

commit;
