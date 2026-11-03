-- File d'enrichissement : l'avance des pièces (PDF) passe de 96 h à 24 h (03/11/2026).
--
-- Mesure au passage de 04:00 UTC avec l'avance de 96 h (20261111060000) : 18 prises pdf (2 terminées, 12 avancées
-- par OCR), aucune description terminée. Tâches prenables à 05:55 UTC (score = priorité + âge en heures + avance) :
-- 170 pdf (score moyen 169), 228 descriptions (104) et 69 passes de faits (92), toutes sans pièce à attendre
-- grâce à la garde de 20261111050000. Les tâches pdf, souvent des scans de 3 à 6 minutes par passe, auraient
-- occupé la voie générale pendant une dizaine de passages avant la première description.
--
-- Avec 24 points, les deux groupes ont des scores voisins : la voie générale alterne en pratique entre lecture
-- des pièces et descriptions, et une pièce passe encore devant une description qui n'attend pas depuis un jour de
-- plus qu'elle. La garde (description et faits attendent la tâche pdf de leur vente) ne change pas.
--
-- Même méthode que 20261111060000 : définition relue sur place, une seule expression remplacée, refus si elle
-- n'apparaît pas exactement une fois ou si SECURITY DEFINER, les réglages ou les droits changent. Rejouable.
begin;

set local lock_timeout = '5s';

do $patch$
declare
  v_function constant regprocedure :=
    'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure;
  v_old constant text := $old$
                + case when j.job_type = 'pdf' then 96 else 0 end$old$;
  v_new constant text := $new$
                + case when j.job_type = 'pdf' then 24 else 0 end$new$;
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
        'Unexpected general enrichment order of %s: %s matches instead of one; refusing the 24 h PDF head start.',
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
