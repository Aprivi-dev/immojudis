-- Prolongation de l'essai : le motif est enregistré hors de la ligne lisible par le compte.
--
-- Jusqu'ici la note libre de l'administrateur était écrite dans user_subscriptions.metadata
-- (manual_grant.note). La table est lisible par son titulaire (policy select sur user_id =
-- auth.uid(), sans restriction de colonne) : la personne pouvait lire un jugement écrit « en
-- interne » sur elle. Le motif va désormais dans app_private.trial_extension_notes, sans aucun droit
-- pour anon ni authenticated ; seul le serveur (service_role) y écrit, par
-- public.record_trial_extension. Table en ajout seul : une prolongation, une ligne, jamais modifiée.
--
-- Suppression du compte : la ligne part avec lui (on delete cascade), comme user_subscriptions.
-- L'identifiant de l'administrateur est conservé tel quel (sans clé étrangère) pour que la trace
-- survive à la suppression de son compte.
begin;

set local lock_timeout = '5s';

create table if not exists app_private.trial_extension_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  granted_by uuid not null,
  ends_at timestamptz not null,
  note text not null check (char_length(btrim(note)) between 3 and 500),
  created_at timestamptz not null default statement_timestamp()
);

create index if not exists trial_extension_notes_user_idx
  on app_private.trial_extension_notes (user_id, created_at desc);

alter table app_private.trial_extension_notes enable row level security;
revoke all on table app_private.trial_extension_notes from public, anon, authenticated;

comment on table app_private.trial_extension_notes is
  'Motif de chaque prolongation d''essai décidée par un administrateur (qui, pour quel compte, jusqu''à quand, pourquoi). Jamais lisible par le compte concerné ; écrite par public.record_trial_extension (service_role).';

create or replace function public.record_trial_extension(
  p_user_id uuid,
  p_granted_by uuid,
  p_ends_at timestamptz,
  p_note text
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  created_id uuid;
begin
  if p_user_id is null or p_granted_by is null or p_ends_at is null then
    raise exception using errcode = '22023', message = 'Trial extension user, admin and end are required.';
  end if;
  if p_note is null or char_length(btrim(p_note)) < 3 then
    raise exception using errcode = '22023', message = 'A trial extension needs a reason.';
  end if;

  insert into app_private.trial_extension_notes (user_id, granted_by, ends_at, note)
  values (p_user_id, p_granted_by, p_ends_at, btrim(p_note))
  returning id into created_id;

  return created_id;
end;
$function$;

revoke all on function public.record_trial_extension(uuid, uuid, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.record_trial_extension(uuid, uuid, timestamptz, text)
  to service_role;

comment on function public.record_trial_extension(uuid, uuid, timestamptz, text) is
  'Enregistre le motif d''une prolongation d''essai dans app_private.trial_extension_notes. Serveur seul (service_role).';

notify pgrst, 'reload schema';

commit;
