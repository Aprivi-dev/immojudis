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
-- Règle. Une observation est masquée quand, à la fois :
--   * elle est encore « candidate » (une observation déjà relue, accepted ou conflicted, n'est jamais masquée) ;
--   * elle vient de l'extracteur de la collecte, 'immojudis.pipeline.fact_claims' ;
--   * la MÊME VENTE porte une observation de ce même extracteur d'une génération plus haute, quel que soit son
--     statut (une version 3 rejetée masque son jumeau version 2 : le fait rejeté ne revient pas) et quel que soit
--     son champ (la collecte émet toutes les observations d'une vente en une passe ; un champ que la version 3
--     n'émet plus est un champ qu'elle a retiré exprès).
-- La génération est le nombre qui termine extractor_version, extrait par une expression ancrée et comparé en
-- ENTIER (v10 > v9). Une version que l'expression ne lit pas (autre format, plus de six chiffres) donne NULL :
-- la ligne reste visible et ne masque rien, sans erreur de conversion. coalesce(…, false) : une observation sans
-- extracteur, ou d'une vente sans aucune génération lisible, n'est jamais masquée. Une observation rattachée à
-- un lot seul (auction_sale_id nul) ne masque rien et n'est pas masquée.
--
-- Le reste de la vue est celui de 20260929103000_ai_review_projection_guard.sql (dernière définition : aucune
-- migration plus récente ne la touche) : mêmes colonnes, dans le même ordre, même expression is_publishable, même
-- filtre de statut. security_invoker = true est répété : CREATE OR REPLACE VIEW sans cette option la retirerait.
-- Droits d'origine repris (service_role seul).
--
-- Limites, à confirmer par la collecte : une vente pour laquelle la nouvelle génération n'émet rien garde ses
-- observations de l'ancienne ; les observations d'une vente doivent partir dans une seule requête, sinon la fiche
-- montre un jeu partiel entre deux lots d'écriture.
--
-- Coût : aucun index nouveau. La lecture par vente (auction_sale_id = …) filtre aussi le sous-ensemble groupé,
-- par l'index auction_fact_claims_sale_field_idx (plan figé par le test pgTAP 890). La liste de relecture paie
-- un agrégat de plus sur les observations rattachées à une vente.
--
-- Verrous : ACCESS EXCLUSIVE bref sur la vue seulement (remplacement de sa définition) ; aucun verrou sur
-- public.auction_fact_claims au-delà d'une lecture. Possible pendant un import. Rejouable.
--
-- Retour arrière : réappliquer la définition de la vue de 20260929103000_ai_review_projection_guard.sql (lignes
-- 1687 à 1734), revoke et grant compris.

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
  select
    peer.auction_sale_id,
    max((regexp_match(peer.extractor_version, '^auction_fact_claims_v([0-9]{1,6})$'))[1]::integer) as generation
  from public.auction_fact_claims peer
  where peer.auction_sale_id is not null
    and peer.extractor_name = 'immojudis.pipeline.fact_claims'
  group by peer.auction_sale_id
) latest on latest.auction_sale_id = claim.auction_sale_id
where claim.claim_status in ('candidate', 'accepted', 'conflicted')
  and (claim.auction_sale_id is not null or claim.lot_id is not null)
  and not coalesce(
    claim.claim_status = 'candidate'
    and claim.extractor_name = 'immojudis.pipeline.fact_claims'
    and (regexp_match(claim.extractor_version, '^auction_fact_claims_v([0-9]{1,6})$'))[1]::integer
      < latest.generation,
    false
  );

revoke all on table public.v_auction_fact_claims_read_model
from public, anon, authenticated, service_role;
grant select on table public.v_auction_fact_claims_read_model to service_role;

comment on view public.v_auction_fact_claims_read_model is
  'Trusted read model exposing unresolved, accepted and conflicting fact claims for later listing projections. A candidate claim of the pipeline extractor is hidden once the same sale carries a claim of a higher generation of that extractor.';

notify pgrst, 'reload schema';

commit;
