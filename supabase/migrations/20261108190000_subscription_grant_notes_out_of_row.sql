-- Motifs des attributions d'abonnement : hors de la ligne lisible par le compte, écrits dans la même transaction
-- que la ligne (revue du 28/10/2026, n° 4).
--
-- 1. Prolongation de l'essai : le motif était écrit AVANT la ligne d'essai, par deux appels distincts
--    (record_trial_extension puis un insert/update de user_subscriptions) : un échec du second laissait un motif
--    orphelin, une relance un doublon. public.extend_trial_with_note écrit les deux dans UNE transaction, avec la
--    condition sur updated_at (un webhook Stripe arrivé entre la lecture et l'écriture n'est pas écrasé : la
--    fonction rend « changed » et n'écrit alors aucun motif). record_trial_extension reste, pour le repli du code
--    tant que cette migration n'est pas appliquée.
-- 2. Attribution manuelle d'un abonnement (page /admin/subscriptions) : sa note était recopiée dans
--    user_subscriptions.metadata.manual_grant.note, lisible par le titulaire. Le sens diffère d'une prolongation
--    d'essai (un plan et un statut choisis, une fin de période facultative, pas forcément un essai) : le motif va
--    dans une table jumelle, app_private.manual_grant_notes, écrite par public.grant_manual_subscription en même
--    temps que la ligne.
-- 3. Les lignes existantes : les notes déjà écrites dans metadata.manual_grant.note sont reversées dans la table
--    qui correspond à leur source (admin_trial_extension : trial_extension_notes ; sinon manual_grant_notes) quand
--    leur forme le permet (administrateur identifiable, longueur valide), puis retirées de manual_grant et de
--    manual_grant_history. Les entrées d'historique ne sont que retirées (elles n'ont jamais gardé leur note).
--
-- DÉPLOIEMENT : le code détecte l'absence des deux fonctions : l'extension d'essai se replie sur
-- record_trial_extension puis l'écriture de la ligne (ancien comportement), l'attribution manuelle sans note
-- s'écrit comme avant et AVEC note est refusée tant que la migration n'est pas appliquée (la note ne retourne
-- jamais dans la ligne). Appliquer la migration, puis le code ; l'ordre inverse ne casse rien.
-- À savoir : le nettoyage met à jour les lignes concernées, donc leur updated_at (déclencheur de la table).
-- RETOUR ARRIÈRE : drop function public.extend_trial_with_note(uuid, uuid, timestamptz, text, jsonb, timestamptz),
-- drop function public.grant_manual_subscription(uuid, uuid, text, text, timestamptz, jsonb, text), puis
-- drop table app_private.manual_grant_notes (les notes retirées des lignes ne se reconstituent pas).
begin;

set local lock_timeout = '5s';

create table if not exists app_private.manual_grant_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  granted_by uuid not null,
  plan_code text not null,
  status text not null,
  current_period_end timestamptz,
  note text not null check (char_length(btrim(note)) between 3 and 500),
  created_at timestamptz not null default statement_timestamp()
);

create index if not exists manual_grant_notes_user_idx
  on app_private.manual_grant_notes (user_id, created_at desc);

alter table app_private.manual_grant_notes enable row level security;
revoke all on table app_private.manual_grant_notes from public, anon, authenticated;

comment on table app_private.manual_grant_notes is
  'Motif de chaque attribution manuelle d''abonnement décidée par un administrateur (qui, pour quel compte, quel plan et quel statut, pourquoi). Jamais lisible par le compte concerné ; écrite par public.grant_manual_subscription (service_role). Table en ajout seul.';

-- 1. Prolongation d'essai : motif et ligne dans la même transaction ------------------------------------------------
create or replace function public.extend_trial_with_note(
  p_user_id uuid,
  p_granted_by uuid,
  p_ends_at timestamptz,
  p_note text,
  p_metadata jsonb,
  p_expected_updated_at timestamptz default null
)
returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  changed integer;
begin
  if p_user_id is null or p_granted_by is null or p_ends_at is null then
    raise exception using errcode = '22023', message = 'Trial extension user, admin and end are required.';
  end if;
  if p_note is null or char_length(btrim(p_note)) < 3 then
    raise exception using errcode = '22023', message = 'A trial extension needs a reason.';
  end if;

  if p_expected_updated_at is null then
    -- Première ligne : refusée (« changed ») si une autre est apparue entre-temps.
    insert into public.user_subscriptions (user_id, plan_code, status, current_period_end, metadata)
    values (p_user_id, 'analyse', 'trialing', p_ends_at, coalesce(p_metadata, '{}'::jsonb))
    on conflict (user_id) do nothing;
  else
    update public.user_subscriptions
       set plan_code = 'analyse',
           status = 'trialing',
           current_period_end = p_ends_at,
           metadata = coalesce(p_metadata, '{}'::jsonb)
     where user_id = p_user_id
       and updated_at = p_expected_updated_at;
  end if;
  get diagnostics changed = row_count;
  if changed = 0 then
    return 'changed';
  end if;

  insert into app_private.trial_extension_notes (user_id, granted_by, ends_at, note)
  values (p_user_id, p_granted_by, p_ends_at, btrim(p_note));
  return 'written';
end;
$function$;

revoke all on function public.extend_trial_with_note(uuid, uuid, timestamptz, text, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.extend_trial_with_note(uuid, uuid, timestamptz, text, jsonb, timestamptz)
  to service_role;

comment on function public.extend_trial_with_note(uuid, uuid, timestamptz, text, jsonb, timestamptz) is
  'Écrit la ligne d''essai prolongé et son motif (app_private.trial_extension_notes) dans une même transaction ; la mise à jour est conditionnée à updated_at (« changed » sinon, sans motif). Serveur seul (service_role).';

-- 2. Attribution manuelle : ligne et motif dans la même transaction -------------------------------------------------
create or replace function public.grant_manual_subscription(
  p_user_id uuid,
  p_granted_by uuid,
  p_plan_code text,
  p_status text,
  p_current_period_end timestamptz,
  p_metadata jsonb,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if p_user_id is null or p_granted_by is null or p_plan_code is null or p_status is null then
    raise exception using errcode = '22023', message = 'Manual grant user, admin, plan and status are required.';
  end if;

  -- Les identifiants Stripe de la ligne existante sont conservés (la liste des colonnes écrites est fermée).
  insert into public.user_subscriptions (user_id, plan_code, status, current_period_end, metadata)
  values (p_user_id, p_plan_code, p_status, p_current_period_end, coalesce(p_metadata, '{}'::jsonb))
  on conflict (user_id) do update
    set plan_code = excluded.plan_code,
        status = excluded.status,
        current_period_end = excluded.current_period_end,
        metadata = excluded.metadata;

  if p_note is not null and btrim(p_note) <> '' then
    if char_length(btrim(p_note)) < 3 then
      raise exception using errcode = '22023', message = 'A manual grant reason needs at least 3 characters.';
    end if;
    insert into app_private.manual_grant_notes (user_id, granted_by, plan_code, status, current_period_end, note)
    values (p_user_id, p_granted_by, p_plan_code, p_status, p_current_period_end, btrim(p_note));
  end if;
end;
$function$;

revoke all on function public.grant_manual_subscription(uuid, uuid, text, text, timestamptz, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.grant_manual_subscription(uuid, uuid, text, text, timestamptz, jsonb, text)
  to service_role;

comment on function public.grant_manual_subscription(uuid, uuid, text, text, timestamptz, jsonb, text) is
  'Attribue un abonnement à la main (ligne user_subscriptions) et enregistre le motif facultatif dans app_private.manual_grant_notes, dans une même transaction. Serveur seul (service_role).';

-- 3. Lignes existantes : notes reversées dans les tables privées, puis retirées -------------------------------------
with legacy as (
  select
    subscription.user_id,
    subscription.metadata -> 'manual_grant' as grant_row,
    subscription.current_period_end as row_period_end
  from public.user_subscriptions subscription
  where jsonb_typeof(subscription.metadata -> 'manual_grant') = 'object'
    and jsonb_typeof(subscription.metadata -> 'manual_grant' -> 'note') = 'string'
    and char_length(btrim(subscription.metadata -> 'manual_grant' ->> 'note')) between 3 and 500
    and (subscription.metadata -> 'manual_grant' ->> 'granted_by')
        ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
)
insert into app_private.trial_extension_notes (user_id, granted_by, ends_at, note)
select
  legacy.user_id,
  (legacy.grant_row ->> 'granted_by')::uuid,
  legacy.row_period_end,
  btrim(legacy.grant_row ->> 'note')
from legacy
where legacy.grant_row ->> 'source' = 'admin_trial_extension'
  and legacy.row_period_end is not null;

with legacy as (
  select
    subscription.user_id,
    subscription.metadata -> 'manual_grant' as grant_row,
    subscription.plan_code,
    subscription.status,
    subscription.current_period_end
  from public.user_subscriptions subscription
  where jsonb_typeof(subscription.metadata -> 'manual_grant') = 'object'
    and jsonb_typeof(subscription.metadata -> 'manual_grant' -> 'note') = 'string'
    and char_length(btrim(subscription.metadata -> 'manual_grant' ->> 'note')) between 3 and 500
    and (subscription.metadata -> 'manual_grant' ->> 'granted_by')
        ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
)
insert into app_private.manual_grant_notes (user_id, granted_by, plan_code, status, current_period_end, note)
select
  legacy.user_id,
  (legacy.grant_row ->> 'granted_by')::uuid,
  legacy.plan_code,
  legacy.status,
  legacy.current_period_end,
  btrim(legacy.grant_row ->> 'note')
from legacy
where legacy.grant_row ->> 'source' is distinct from 'admin_trial_extension';

update public.user_subscriptions subscription
   set metadata = jsonb_set(
         subscription.metadata, '{manual_grant}', (subscription.metadata -> 'manual_grant') - 'note'
       )
 where jsonb_typeof(subscription.metadata -> 'manual_grant') = 'object'
   and subscription.metadata -> 'manual_grant' ? 'note';

update public.user_subscriptions subscription
   set metadata = jsonb_set(
         subscription.metadata,
         '{manual_grant_history}',
         (select coalesce(
                   jsonb_agg(
                     case when jsonb_typeof(history.entry) = 'object' then history.entry - 'note' else history.entry end
                     order by history.position
                   ),
                   '[]'::jsonb
                 )
            from jsonb_array_elements(subscription.metadata -> 'manual_grant_history')
                   with ordinality as history(entry, position))
       )
 where jsonb_typeof(subscription.metadata -> 'manual_grant_history') = 'array'
   and exists (
     select 1
       from jsonb_array_elements(subscription.metadata -> 'manual_grant_history') entry
      where jsonb_typeof(entry) = 'object' and entry ? 'note'
   );

notify pgrst, 'reload schema';

commit;
