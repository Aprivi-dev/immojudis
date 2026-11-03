-- File d'enrichissement : les pièces (PDF) gardent une avance de 96 h au lieu de passer strictement devant
-- (03/11/2026).
--
-- 20261111050000 faisait passer toute tâche pdf devant toute autre tâche générale. Premier passage avec cette
-- règle (01:00 UTC le 03/11/2026) : 10 prises sur 10 pour des pdf, en grande partie des scans lus par OCR
-- (2 à 6 minutes par passe), et aucune description. 254 descriptions et 71 passes de faits sans aucune pièce à
-- attendre (la garde de 20261111050000 ne les retenait pas) n'étaient plus prises du tout, pour des jours :
-- 178 tâches pdf étaient dues, dont beaucoup demandent plusieurs passes.
--
-- Les tâches pdf reçoivent désormais 96 points (96 heures d'attente) dans le classement priorité + âge en
-- heures (+168 pour une vente dans les 7 jours) : une pièce récente passe devant une description qui attend
-- depuis moins de quatre jours de plus, mais une description restée en file plus longtemps reprend son tour.
-- La garde de 20261111050000 (une description ou des faits attendent la tâche pdf de leur vente) ne change pas :
-- c'est elle qui supprime les prises inutiles.
--
-- Même méthode que 20261111050000 : définition relue sur place, une seule expression remplacée, refus si elle
-- n'apparaît pas exactement une fois ou si SECURITY DEFINER, les réglages ou les droits changent. Rejouable.
begin;

set local lock_timeout = '5s';

do $patch$
declare
  v_function constant regprocedure :=
    'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure;
  v_old constant text := $old$
     order by (v_family = 'all' and j.job_type = 'source_detail') desc,
              (j.job_type = 'pdf') desc,
              j.priority
                + extract(epoch from (now() - j.created_at)) / 3600$old$;
  v_new constant text := $new$
     order by (v_family = 'all' and j.job_type = 'source_detail') desc,
              j.priority
                + case when j.job_type = 'pdf' then 96 else 0 end
                + extract(epoch from (now() - j.created_at)) / 3600$new$;
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
        'Unexpected general enrichment order of %s: %s matches instead of one; refusing the PDF head start.',
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
     or position('from public.auction_enrichment_jobs pdf' in v_after) = 0
     or position('then 168' in v_after) = 0
     or position('r.is_near desc' in v_after) = 0
     or position('for update of j, s skip locked' in v_after) = 0 then
    raise exception using
      errcode = '55000',
      message = 'PDF head-start patch did not preserve the PDF guard, the urgency bonus or the claim locks.';
  end if;
end;
$patch$;

notify pgrst, 'reload schema';

commit;
