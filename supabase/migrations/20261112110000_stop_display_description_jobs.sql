begin;

set local lock_timeout = '5s';

-- Synthèse rédigée par le modèle (llm_display_description) retirée du pipeline : aucune tâche
-- display_description ne doit plus être créée.
--
-- Le déclencheur auction_sales_enqueue_surface_enrichment (filet des écrivains du catalogue autres que la
-- publication Python, qui pose app.pipeline_queue_owner = 'python') créait encore, à chaque vente à venir
-- insérée ou dont le content_hash ou les pièces changent, une tâche display_description. La fonction garde
-- tout le reste à l'identique : mêmes gardes, même tâche pdf pour une vente avec pièces, même empreinte.
--
-- Aucune donnée n'est modifiée : les tâches display_description encore en file se terminent sans appel au
-- modèle (src/queued_runner.py), les textes déjà écrits restent dans raw_payload.
--
-- RETOUR ARRIÈRE : réappliquer la définition de 20260911091913_reliable_enrichment_queue.sql.

create or replace function app_private.enqueue_auction_surface_enrichment()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_input_hash text := md5(
    coalesce(new.content_hash, new.source_url || coalesce(new.documents::text, '[]'))
    || ':auction_display_v8:qwen2_7b_instruct'
  );
  v_has_documents boolean := jsonb_typeof(coalesce(new.documents, '[]'::jsonb)) = 'array'
    and jsonb_array_length(coalesce(new.documents, '[]'::jsonb)) > 0;
begin
  -- Transactional Python publication owns versioned scheduling. Keep the
  -- trigger as a compatibility fallback for other catalogue writers.
  if current_setting('app.pipeline_queue_owner', true) = 'python' then
    return new;
  end if;
  if new.status not in ('active', 'upcoming') or new.sale_date < now() then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.content_hash is not distinct from old.content_hash
      and new.documents is not distinct from old.documents then
    return new;
  end if;
  if v_has_documents then
    insert into public.auction_enrichment_jobs (source_url, job_type, priority, input_hash)
    values (new.source_url, 'pdf', 30, v_input_hash)
    on conflict (source_url, job_type, input_hash) do nothing;
  end if;
  return new;
end;
$$;

revoke all on function app_private.enqueue_auction_surface_enrichment() from public, anon, authenticated;
grant execute on function app_private.enqueue_auction_surface_enrichment() to service_role;

commit;
