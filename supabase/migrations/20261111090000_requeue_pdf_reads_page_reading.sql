begin;

set local lock_timeout = '5s';

-- Relecture des pièces jointes mal lues, avec la lecture des pages corrigée (03/11/2026).
--
-- Le 03/11, 74 pièces de ventes en ligne étaient « incomplete » et 38 « partial » : des pages de photographies
-- ou de plans restaient à reprendre sans fin (motif ignoré des journaux, « reasons=unknown »), l'OCR expirait à
-- 60 s quand deux lectures se disputaient les cœurs, et des pièces lues jusqu'à la dernière page restaient
-- « incomplete » faute d'un dernier passage. Le pipeline corrigé règle les pages d'images sans texte, lit avec un
-- seul fil Tesseract et termine une pièce dont toutes les pages sont lues.
--
-- Une pièce « incomplete » est déjà reprise chaque jour par le rattrapage des pièces jointes. Une pièce
-- « partial » (tolérée : moins d'une page sur dix illisible) ne l'est que lorsqu'une tâche pdf de la vente
-- tourne, une fois sa vérification HTTP de plus d'un jour : la dernière tâche pdf de ces ventes repart en file.
-- Le texte des pages déjà lues est en cache ; seules les pages en échec sont relues.
-- À appliquer après le déploiement du code ; une tâche en cours n'est pas touchée ; une vente dont toutes les
-- sources sont retirées du catalogue n'est pas relue.
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
   and exists (
         select 1 from public.auction_documents document
          where document.source_url = sale.source_url
            and document.extraction_status in ('partial', 'incomplete')
       )
   and sale.status in ('active', 'unknown', 'upcoming', 'postponed')
   and jsonb_typeof(sale.documents) = 'array'
   and jsonb_array_length(sale.documents) > 0
   and not app_private.sale_is_fully_withdrawn(
         sale.source_name, sale.observations, (select app_private.catalogue_withdrawn_sources())
       );

commit;
