begin;

set local lock_timeout = '5s';

-- Relecture des pièces jointes de toutes les ventes en cours avec les règles de l'audit qualité (03/11/2026).
--
-- L'audit de toutes les annonces en ligne a relevé des surfaces, des nombres de pièces, des occupations, des dates
-- limites et des mises à prix mal lus dans les pièces. Le pipeline corrigé passe à document_facts_v5_quality_audit :
-- une tâche pdf relit les pièces d'une vente dont les faits viennent d'une version plus ancienne, même si elles ont
-- été lues récemment (le texte des pièces est en cache, aucun nouveau téléchargement pour celles déjà lues).
-- Le 03/11, 309 ventes en cours ont des pièces, dont 190 avec une tâche pdf déjà en file : la dernière tâche pdf des
-- autres repart en file. Une tâche en cours n'est pas touchée ; une vente dont toutes les sources sont retirées du
-- catalogue n'est pas relue.
update public.auction_enrichment_jobs job
   set status = 'queued',
       attempt_count = 0,
       created_at = now(),
       next_attempt_at = now(),
       locked_at = null,
       completed_at = null,
       last_error = null,
       priority = greatest(job.priority, 40),
       updated_at = now()
  from public.auction_sales sale
 where job.source_url = sale.source_url
   and job.job_type = 'pdf'
   and job.status in ('completed', 'failed', 'cancelled')
   and job.id = (
         select latest.id from public.auction_enrichment_jobs latest
          where latest.source_url = sale.source_url and latest.job_type = 'pdf'
          order by latest.updated_at desc, latest.id desc
          limit 1
       )
   and not exists (
         select 1 from public.auction_enrichment_jobs open_job
          where open_job.source_url = sale.source_url
            and open_job.job_type = 'pdf'
            and open_job.status in ('queued', 'running')
       )
   and sale.status in ('active', 'unknown', 'upcoming', 'postponed')
   and jsonb_typeof(sale.documents) = 'array'
   and jsonb_array_length(sale.documents) > 0
   and not app_private.sale_is_fully_withdrawn(
         sale.source_name, sale.observations, (select app_private.catalogue_withdrawn_sources())
       );

commit;
