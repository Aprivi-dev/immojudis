begin;

set local lock_timeout = '5s';

-- Objets Storage des emails entrants non ramassés (audit du 23/10/2026, n° 48).
--
-- enqueue_orphan_information_agent_portal_uploads (20260928150000) ne regardait que les dépôts du
-- portail (`<dossier>/portal/<uuid>/<fichier>`). Les emails entrants écrivent aussi dans le bucket
-- `information-agent-evidence` :
--   <dossier>/<message>/body/<sha256>-email-body.txt      (corps de la réponse)
--   <dossier>/<message>/<clé de pièce>/<sha256>-<fichier> (pièces jointes)
-- Un objet envoyé sans que la ligne `information_agent_evidence_assets` soit écrite (panne entre les
-- deux), ou dont la ligne a disparu avec sa demande ou son dossier (purge, effacement), restait
-- à jamais dans le bucket. La fonction reconnaît maintenant les deux formes de chemin.
--
-- Même délai de 24 heures qu'avant, plus long que l'autorisation de dépôt de deux heures et que le
-- traitement d'un email entrant : un envoi en cours ne croise pas le ramassage. Même nom, mêmes
-- arguments, mêmes droits : /api/cron/sale-retention n'a rien à changer.
create or replace function public.enqueue_orphan_information_agent_portal_uploads(
  p_now timestamptz default statement_timestamp(),
  p_limit integer default 100
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  enqueued integer;
begin
  if p_now is null or p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception using
      errcode = '22023',
      message = 'Portal upload cleanup requires a timestamp and batch size between 1 and 100.';
  end if;

  with orphan_objects as (
    select stored_object.name
    from storage.objects stored_object
    where stored_object.bucket_id = 'information-agent-evidence'
      and (
        -- dépôt du portail : <dossier>/portal/<uuid>/<fichier>
        stored_object.name ~ '^[0-9a-f-]{36}/portal/[0-9a-f-]{36}/[^/]+$'
        -- email entrant : <dossier>/<message>/<body ou clé de pièce>/<fichier>
        or stored_object.name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[^/]+/[^/]+$'
      )
      and stored_object.created_at <= p_now - interval '24 hours'
      and not exists (
        select 1
        from public.information_agent_evidence_assets asset
        where asset.storage_bucket = 'information-agent-evidence'
          and asset.storage_path = stored_object.name
      )
    order by stored_object.created_at, stored_object.name
    limit p_limit
  )
  insert into public.sale_retention_storage_queue (bucket, object_path)
  select 'information-agent-evidence', orphan_objects.name
  from orphan_objects
  on conflict (bucket, object_path) do nothing;

  get diagnostics enqueued = row_count;
  return enqueued;
end;
$$;

revoke all on function public.enqueue_orphan_information_agent_portal_uploads(timestamptz, integer)
from public, anon, authenticated;
grant execute on function public.enqueue_orphan_information_agent_portal_uploads(timestamptz, integer)
to service_role;

notify pgrst, 'reload schema';

commit;
