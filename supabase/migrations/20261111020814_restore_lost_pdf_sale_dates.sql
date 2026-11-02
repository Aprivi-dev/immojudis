begin;

set local lock_timeout = '5s';

-- Dates de vente lues dans les pièces jointes puis effacées par une relecture de la page source (02/11/2026).
--
-- Une page Cessions de l'État ne donne pas de date : la date limite de remise des offres n'est que dans le
-- cahier des charges. La relecture complète de la page remettait ``sale_date`` à vide en gardant la trace PDF,
-- et la passe PDF suivante prenait ce vide pour une correction manuelle (Saint-Alexandre : offres attendues le
-- 10 décembre 2026, aucune date affichée). Le pipeline garde désormais la date des pièces ; cette migration
-- rend la leur aux ventes à venir déjà touchées.

update public.auction_sales sale
   set sale_date = (sale.raw_payload -> 'pdf_fact_provenance' -> 'sale_date' ->> 'value')::timestamptz
 where sale.sale_date is null
   and sale.status = 'upcoming'
   and sale.raw_payload -> 'pdf_fact_provenance' -> 'sale_date' ->> 'source' = 'pdf'
   and jsonb_typeof(sale.raw_payload -> 'pdf_sale_date_extraction') = 'object'
   and sale.raw_payload -> 'pdf_fact_provenance' -> 'sale_date' ->> 'value'
       ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$'
   and (sale.raw_payload -> 'pdf_fact_provenance' -> 'sale_date' ->> 'value')::timestamptz > now();

-- La lecture des pièces reconnaît aussi d'autres libellés de la date limite (« réception du dossier d'offre »,
-- « des dossiers », « 1 ER DECEMBRE », renvoi au « II. » d'un calendrier). Les appels d'offres à venir encore
-- sans date, dont les pièces ont déjà été lues avec les anciennes règles (34 ventes Cessions de l'État le
-- 02/11/2026), relisent leurs pièces : leurs faits perdent la marque de version des règles qui les ont lus, ce
-- qui fait relire des pièces encore fraîches, et la dernière tâche PDF de chacune repart en file. Une tâche en
-- cours n'est pas touchée ; le texte des pièces est déjà en cache.
update public.auction_sales sale
   set raw_payload = sale.raw_payload - 'document_facts_version'
 where sale.sale_date is null
   and sale.status in ('active', 'unknown', 'upcoming', 'postponed')
   and lower(sale.source_name) in ('cessions_etat', 'agrasc', 'notaires')
   and jsonb_typeof(sale.documents) = 'array'
   and jsonb_array_length(sale.documents) > 0
   and sale.raw_payload ? 'document_facts_version';

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
   and sale.sale_date is null
   and sale.status in ('active', 'unknown', 'upcoming', 'postponed')
   and lower(sale.source_name) in ('cessions_etat', 'agrasc', 'notaires')
   and jsonb_typeof(sale.documents) = 'array'
   and jsonb_array_length(sale.documents) > 0;

commit;
