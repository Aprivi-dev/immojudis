-- File d'enrichissement : la voie générale lit les pièces (PDF) avant de décrire une vente (02/11/2026).
--
-- La voie générale de claim_auction_enrichment_jobs_family classait ses tâches par priorité + âge en heures
-- (+168 si la vente a lieu dans les 7 jours). Les tâches display_description et fact_extraction les plus
-- anciennes passaient donc toujours devant les tâches pdf ; prises, elles étaient aussitôt rendues 30 min
-- parce que les pièces de leur vente n'étaient pas encore lues (src/queued_runner.py,
-- has_eligible_pdf_job_for_sale), puis reprises au tick suivant. Tick de 21:30 UTC : 84 prises, aucune
-- tâche terminée, 80 tâches description/faits reportées et une seule tâche pdf ; en 12 h, 0 à 11 pdf par
-- heure et 2 passes de faits au total.
--
-- Deux changements, dans la seule voie générale (familles « enrichment » et « all ») :
--
-- 1. Une tâche display_description ou fact_extraction n'est pas prise tant que la tâche pdf de la même
--    vente peut encore avancer : statut queued, running ou failed, et essais restants ou bail en cours.
--    C'est le prédicat de has_eligible_pdf_job_for_sale (services/data-pipeline/src/storage/supabase_client.py).
--    Une tâche pdf terminée, annulée ou à bout d'essais libère la vente : le chemin « review_required: PDF
--    extraction retry budget exhausted » du pipeline s'applique comme avant. La recherche (source_url,
--    job_type) passe par l'index existant auction_enrichment_jobs_revision_idx (source_url, job_type,
--    created_at desc) : pas de nouvel index.
-- 2. Les tâches pdf passent devant les autres tâches générales : (j.job_type = 'pdf') desc, juste après le
--    rang de la voie source_detail. Règle simple : une description ou une passe de faits ne fait rien d'utile
--    avant la lecture des pièces de sa vente, et c'est la lecture qui la libère (point 1). Le bonus de 168 h
--    d'une vente proche et l'âge gardent leur effet à l'intérieur de chaque groupe : une pièce d'une vente
--    proche est lue d'abord, puis la description de cette vente passe devant celles des ventes lointaines.
--    Les tâches pdf ne se recréent pas en étant traitées (essais bornés, reports d'accès de 24 h) : les autres
--    tâches reprennent dès que la file pdf due est vide.
--
-- La voie source_detail, les gardes d'admission (rétention, bail en cours, révisions remplacées, verrous) et
-- les droits ne changent pas. La définition en production est relue sur place (pg_get_functiondef) ; la seule
-- expression remplacée est la fin du filtre et l'ordre de la voie générale, tels que les a laissés
-- 20261001083619_enrichment_general_finite_urgency_bonus.sql. La migration s'arrête si ce texte n'y apparaît
-- pas exactement une fois, ou si SECURITY DEFINER, les réglages ou les droits de la fonction changent.
-- Rejouable : une définition déjà corrigée est laissée.
begin;

set local lock_timeout = '5s';

do $patch$
declare
  v_function constant regprocedure :=
    'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure;
  v_old constant text := $old$
       and not exists (
         select 1
           from public.auction_enrichment_jobs active
          where active.source_url = j.source_url
            and active.status = 'running'
            and coalesce(active.locked_at, active.updated_at) >= now() - interval '30 minutes'
       )
     order by (v_family = 'all' and j.job_type = 'source_detail') desc,
              j.priority
                + extract(epoch from (now() - j.created_at)) / 3600
                + case
                    when coalesce((s.sale_date between now() and now() + interval '7 days'), false)
                      then 168
                    else 0
                  end desc,
              j.created_at,
              j.id$old$;
  v_new constant text := $new$
       and not exists (
         select 1
           from public.auction_enrichment_jobs active
          where active.source_url = j.source_url
            and active.status = 'running'
            and coalesce(active.locked_at, active.updated_at) >= now() - interval '30 minutes'
       )
       -- Description et faits attendent la lecture des pièces de leur vente (has_eligible_pdf_job_for_sale).
       and (
         j.job_type not in ('display_description', 'fact_extraction')
         or not exists (
           select 1
             from public.auction_enrichment_jobs pdf
            where pdf.source_url = j.source_url
              and pdf.job_type = 'pdf'
              and pdf.status in ('queued', 'running', 'failed')
              and (pdf.status = 'running' or pdf.attempt_count < pdf.max_attempts)
         )
       )
     order by (v_family = 'all' and j.job_type = 'source_detail') desc,
              (j.job_type = 'pdf') desc,
              j.priority
                + extract(epoch from (now() - j.created_at)) / 3600
                + case
                    when coalesce((s.sale_date between now() and now() + interval '7 days'), false)
                      then 168
                    else 0
                  end desc,
              j.created_at,
              j.id$new$;
  v_before text := pg_catalog.pg_get_functiondef(v_function);
  v_after text;
  v_matches integer;
  v_secdef_before boolean;
  v_config_before text;
  v_acl_before text;
  v_secdef_after boolean;
  v_config_after text;
  v_acl_after text;
begin
  if strpos(v_before, v_new) > 0 then
    return;
  end if;

  v_matches := (length(v_before) - length(replace(v_before, v_old, ''))) / length(v_old);
  if v_matches <> 1 then
    raise exception using
      errcode = '55000',
      message = format(
        'Unexpected general enrichment claim of %s: %s matches instead of one; refusing the PDF-first patch.',
        v_function, v_matches
      );
  end if;

  select procedure_row.prosecdef, coalesce(procedure_row.proconfig::text, ''), coalesce(procedure_row.proacl::text, '')
    into v_secdef_before, v_config_before, v_acl_before
    from pg_catalog.pg_proc procedure_row
   where procedure_row.oid = v_function::oid;

  execute replace(v_before, v_old, v_new);

  v_after := pg_catalog.pg_get_functiondef(v_function);
  select procedure_row.prosecdef, coalesce(procedure_row.proconfig::text, ''), coalesce(procedure_row.proacl::text, '')
    into v_secdef_after, v_config_after, v_acl_after
    from pg_catalog.pg_proc procedure_row
   where procedure_row.oid = v_function::oid;

  if v_secdef_after is distinct from v_secdef_before
     or v_config_after is distinct from v_config_before
     or v_acl_after is distinct from v_acl_before then
    raise exception using
      errcode = '55000',
      message = format('Rewriting %s changed SECURITY DEFINER, settings or privileges.', v_function);
  end if;

  if strpos(v_after, v_new) = 0
     or strpos(v_after, v_old) > 0
     or position('then 168' in v_after) = 0
     or position('r.is_near desc' in v_after) = 0
     or position('pg_advisory_xact_lock' in v_after) = 0
     or position('revision_rank > 1' in v_after) = 0
     or position('s.retention_deadline_materialized' in v_after) = 0
     or position('for update of j, s skip locked' in v_after) = 0 then
    raise exception using
      errcode = '55000',
      message = 'PDF-first patch did not preserve the claim guards or the source-detail lane.';
  end if;
end;
$patch$;

notify pgrst, 'reload schema';

commit;
