begin;

set local lock_timeout = '5s';

-- Rétention des dossiers partagés de l'agent d'information (public.information_agent_cases).
--
-- Jusqu'ici un dossier (adresse et nom du destinataire, objet, texte, jeton de réponse) n'était
-- supprimé qu'avec la vente concernée : purge_information_agent_data ne supprimait que les demandes
-- (missions) et les adresses du registre. Aucune durée propre n'était fixée aux dossiers dans
-- docs/data-retention-matrix.md ; ils suivent donc celles des demandes, qui sont déjà les plus
-- prudentes de l'agent :
--   - jamais envoyé : 21 jours après la création (suppression au plus tard 28 jours après, la purge
--     étant hebdomadaire) ;
--   - envoyé sans réponse : 12 mois après l'envoi ;
--   - avec réponse : 24 mois après le dernier échange.
-- Un dossier encore rattaché à une demande n'est pas supprimé : la demande suit sa propre durée, et
-- le dossier part avec la dernière. Les messages, pièces, informations extraites et tâches
-- d'analyse sont supprimés en cascade ; les fichiers de pièces sont d'abord mis dans la file de
-- suppression Storage (sale_retention_storage_queue, vidée par /api/cron/sale-retention).
--
-- purge_information_agent_data est reprise à l'identique de 20261023120000 (missions, registre) avec
-- l'étape des dossiers entre les deux ; le rapport gagne la clé information_agent_cases.

create or replace function app_private.information_agent_case_purge_due(
  p_case public.information_agent_cases,
  p_now timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    not exists (
      select 1
      from public.information_agent_missions mission
      where mission.case_id = p_case.id
    )
    and case
      when p_case.replied_at is not null
        or p_case.status in ('replied', 'completed')
        or exists (
          select 1
          from public.information_agent_messages message
          where message.case_id = p_case.id
            and message.direction = 'inbound'
        )
        then coalesce(
          greatest(
            p_case.sent_at,
            p_case.replied_at,
            (
              select max(coalesce(message.received_at, message.sent_at, message.created_at))
              from public.information_agent_messages message
              where message.case_id = p_case.id
            )
          ),
          p_case.updated_at
        ) < p_now - interval '24 months'
      when p_case.sent_at is not null
        or p_case.provider_message_id is not null
        or p_case.status = 'sent'
        then coalesce(p_case.sent_at, p_case.updated_at) < p_now - interval '12 months'
      else p_case.created_at < p_now - interval '21 days'
    end;
$$;

revoke all on function app_private.information_agent_case_purge_due(
  public.information_agent_cases, timestamptz
) from public, anon, authenticated;
grant execute on function app_private.information_agent_case_purge_due(
  public.information_agent_cases, timestamptz
) to service_role;

comment on function app_private.information_agent_case_purge_due(
  public.information_agent_cases, timestamptz
) is
  'Vrai quand un dossier partagé de l''agent d''information n''a plus de demande rattachée et a dépassé sa durée : 21 jours sans envoi, 12 mois sans réponse, 24 mois après le dernier échange.';

create or replace function app_private.purge_information_agent_data(
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_missions integer := 0;
  deleted_cases integer := 0;
  deleted_contacts integer := 0;
  deleted_bounces integer := 0;
  due_case_ids uuid[];
begin
  delete from public.information_agent_missions mission
  where app_private.information_agent_mission_purge_due(mission, p_now);
  get diagnostics deleted_missions = row_count;

  -- Après les missions : un dossier qui n'a plus aucune demande rattachée suit sa propre durée.
  select coalesce(array_agg(shared_case.id), '{}'::uuid[])
  into due_case_ids
  from public.information_agent_cases shared_case
  where app_private.information_agent_case_purge_due(shared_case, p_now);

  if cardinality(due_case_ids) > 0 then
    -- Les fichiers d'abord : l'échec de la suppression des lignes annule aussi cette mise en file.
    insert into public.sale_retention_storage_queue (bucket, object_path)
    select asset.storage_bucket, asset.storage_path
    from public.information_agent_evidence_assets asset
    where asset.case_id = any (due_case_ids)
      and asset.storage_bucket = 'information-agent-evidence'
    union
    select 'information-agent-approved', asset.metadata ->> 'approved_public_path'
    from public.information_agent_evidence_assets asset
    where asset.case_id = any (due_case_ids)
      and nullif(asset.metadata ->> 'approved_public_path', '') is not null
    on conflict (bucket, object_path) do nothing;

    delete from public.information_agent_cases shared_case
    where shared_case.id = any (due_case_ids);
    get diagnostics deleted_cases = row_count;
  end if;

  -- Après les missions : une adresse qui n'a servi à aucun envoi disparaît 21 jours après son
  -- relevé, une adresse utilisée suit la demande qui la porte.
  delete from public.information_agent_contacts contact
  where contact.scope_sale_id is not null
    and contact.opposition_status <> 'opposed'
    and contact.bounce_status <> 'permanent'
    and coalesce(contact.observed_at, contact.created_at) < p_now - interval '21 days'
    and not exists (
      select 1
      from public.information_agent_missions mission
      where lower(btrim(mission.recipient_email)) = contact.normalized_email
    );
  get diagnostics deleted_contacts = row_count;

  delete from public.information_agent_contacts contact
  where contact.bounce_status = 'permanent'
    and contact.opposition_status <> 'opposed'
    and coalesce(contact.bounced_at, contact.updated_at) < p_now - interval '12 months';
  get diagnostics deleted_bounces = row_count;

  return jsonb_build_object(
    'information_agent_missions', deleted_missions,
    'information_agent_cases', deleted_cases,
    'information_agent_contacts', deleted_contacts + deleted_bounces
  );
end;
$$;

revoke all on function app_private.purge_information_agent_data(timestamptz)
  from public, anon, authenticated;
grant execute on function app_private.purge_information_agent_data(timestamptz)
  to service_role;

notify pgrst, 'reload schema';

commit;
