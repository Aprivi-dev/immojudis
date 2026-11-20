begin;

set local lock_timeout = '5s';

-- Relecture des pièces de l'agent d'information refusées pour leur nombre de pages (20/11/2026).
--
-- Le worker (services/data-pipeline/src/information_agent_evidence.py) refusait tout PDF de plus de 100 pages
-- (status 'unsupported', error_code 'PAGE_LIMIT_EXCEEDED') ; ce refus était définitif : la RPC de prise ne reprend
-- que 'queued' et 'failed'. Le worker lit maintenant jusqu'à 300 pages, en plusieurs passages pour un long scan.
-- Ces lignes, et elles seules, repartent en file comme une pièce reçue : essais à zéro, erreur et fin effacées.
-- Les autres refus (signature, type annoncé, image, PDF chiffré en 'needs_password') ne sont pas touchés.
--
-- ORDRE DE DÉPLOIEMENT : après la mise en ligne du worker qui lit au-delà de 100 pages (sinon les pièces seraient
-- refusées de nouveau). Rejouable : un second passage ne trouve plus de ligne à remettre en file.
-- RETOUR ARRIÈRE : sans objet (une pièce relue reste lue ; la fonction ne sert qu'à cette relance et à son test).

-- Garde de départ : la fonction est absente (première application) ou porte le corps de cette migration (rejeu).
do $guard$
declare
  found_md5 text;
begin
  select md5(procedure_row.prosrc) into found_md5
    from pg_catalog.pg_proc procedure_row
   where procedure_row.oid =
     to_regprocedure('app_private.requeue_evidence_extractions_refused_for_page_limit()');
  if found_md5 is not null and found_md5 is distinct from '6d08d15a92633aaff8280ebb374000ab' then
    raise exception using
      errcode = '55000',
      message = format(
        'Unexpected body for app_private.requeue_evidence_extractions_refused_for_page_limit() (md5 %s).',
        found_md5
      );
  end if;
end;
$guard$;

-- Remet en file les extractions refusées pour le seul motif PAGE_LIMIT_EXCEEDED ; rend le nombre de lignes remises.
create or replace function app_private.requeue_evidence_extractions_refused_for_page_limit()
returns integer
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_requeued integer;
begin
  update public.information_agent_evidence_extractions extraction
     set status = 'queued',
         attempts = 0,
         available_at = statement_timestamp(),
         locked_at = null,
         completed_at = null,
         error_code = null,
         error_message = null,
         updated_at = statement_timestamp()
   where extraction.status = 'unsupported'
     and extraction.error_code = 'PAGE_LIMIT_EXCEEDED';
  get diagnostics v_requeued = row_count;
  return v_requeued;
end;
$function$;

revoke all on function app_private.requeue_evidence_extractions_refused_for_page_limit()
  from public, anon, authenticated, service_role;

select app_private.requeue_evidence_extractions_refused_for_page_limit();

notify pgrst, 'reload schema';

commit;
