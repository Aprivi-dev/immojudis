begin;

-- Garde-fous juridiques de l'agent d'information (avis juridique du 14/10/2026, section 7) :
--   1. source typée de toute adresse retenue (nature, URL, date de relevé, auteur) ;
--   2. purge des adresses jamais utilisées pour un envoi (30 jours) et durées de conservation
--      alignées sur le pied du message (30 jours sans envoi, 12 mois sans réponse, 24 mois après
--      le dernier échange) ;
--   3. opposition par identité (rôle + nom + barreau ou ville, ou SIREN), en plus de l'adresse.

-- ---------------------------------------------------------------------------
-- 1. Source typée dans le registre des contacts
-- ---------------------------------------------------------------------------
-- Les colonnes sont portées par le registre plutôt que par une table dédiée : une ligne du registre
-- identifie déjà une adresse dans une portée (vente), la source est 1-1 avec elle, et le libellé
-- d'origine du message, la purge et le contrôle d'opposition lisent déjà cette ligne. Une table
-- séparée n'ajouterait qu'une jointure. `provenance` (jsonb) garde le détail champ par champ.
alter table public.information_agent_contacts
  add column if not exists source_kind text,
  add column if not exists source_directory_name text,
  add column if not exists observed_at timestamptz,
  add column if not exists observed_by text,
  add column if not exists observed_by_user_id uuid references auth.users(id) on delete set null,
  add column if not exists identity_keys text[] not null default '{}'::text[];

comment on column public.information_agent_contacts.source_kind is
  'Nature de la source de l''adresse : annonce de la vente, autre annonce du professionnel, site du cabinet, annuaire officiel ou saisie d''un administrateur. NULL pour une ligne qui ne porte qu''une opposition ou un rebond.';
comment on column public.information_agent_contacts.source_directory_name is
  'Nom de l''annuaire officiel, obligatoire (et réservé) pour source_kind = official_directory.';
comment on column public.information_agent_contacts.observed_at is
  'Date de relevé de l''adresse (art. 14 RGPD) ; point de départ de la purge de 30 jours.';
comment on column public.information_agent_contacts.observed_by is
  'Auteur du relevé : l''agent ou un administrateur (observed_by_user_id).';
comment on column public.information_agent_contacts.identity_keys is
  'Clés d''identité normalisées du professionnel (rôle|barreau ou ville|nom, ou siren|n), sans adresse email.';

-- Les adresses observées jusqu'ici viennent toutes des données de l'annonce de la vente.
update public.information_agent_contacts
set source_kind = 'sale_listing',
    observed_at = coalesce(last_seen_at, created_at),
    observed_by = 'agent'
where source_kind is null
  and verification_status = 'source_observed';

alter table public.information_agent_contacts
  add constraint information_agent_contacts_source_kind_check check (
    source_kind is null
    or source_kind in (
      'sale_listing', 'other_listing', 'firm_website', 'official_directory', 'admin_entry'
    )
  ),
  add constraint information_agent_contacts_observed_by_check check (
    observed_by is null or observed_by in ('agent', 'admin')
  ),
  add constraint information_agent_contacts_directory_name_check check (
    (source_kind is not distinct from 'official_directory')
      = (source_directory_name is not null and btrim(source_directory_name) <> '')
    and (source_directory_name is null or char_length(source_directory_name) <= 120)
  ),
  add constraint information_agent_contacts_typed_source_check check (
    (source_kind is null) = (observed_at is null)
    and (source_kind is null) = (observed_by is null)
  ),
  add constraint information_agent_contacts_found_source_url_check check (
    source_kind is null
    or source_kind not in ('other_listing', 'firm_website', 'official_directory')
    or (source_url is not null and source_url ~* '^https://[^[:space:]]+$')
  ),
  add constraint information_agent_contacts_identity_keys_check check (
    cardinality(identity_keys) <= 64
  );

create index if not exists information_agent_contacts_identity_keys_idx
  on public.information_agent_contacts using gin (identity_keys);

-- ---------------------------------------------------------------------------
-- 2. Clés d'identité des missions et liste d'opposition par identité
-- ---------------------------------------------------------------------------
alter table public.information_agent_missions
  add column if not exists recipient_identity_keys text[] not null default '{}'::text[];

alter table public.information_agent_missions
  add constraint information_agent_missions_identity_keys_check check (
    cardinality(recipient_identity_keys) <= 64
  );

comment on column public.information_agent_missions.recipient_identity_keys is
  'Clés d''identité du destinataire, vérifiées contre la liste d''opposition avant l''envoi.';

create index if not exists information_agent_missions_recipient_email_idx
  on public.information_agent_missions (lower(btrim(recipient_email)));

-- Liste d'opposition par identité, conservée à part des lignes purgeables du registre : jamais
-- supprimée par la rétention. Elle ne contient ni adresse ni contenu de message.
create table if not exists public.information_agent_identity_oppositions (
  identity_key text primary key,
  opposed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint information_agent_identity_oppositions_key_check check (
    char_length(identity_key) between 3 and 400 and identity_key = lower(identity_key)
  )
);

comment on table public.information_agent_identity_oppositions is
  'Professionnels opposés à être contactés, par clé d''identité normalisée ; alimentée par toute opposition par adresse. Conservée tant que le traitement existe (au moins 3 ans), hors purge.';

alter table public.information_agent_identity_oppositions enable row level security;
revoke all on table public.information_agent_identity_oppositions from public, anon, authenticated;
grant select, insert, update, delete on table public.information_agent_identity_oppositions
  to service_role;

create or replace function app_private.information_agent_identity_is_blocked(p_keys text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.information_agent_identity_oppositions opposition
    where opposition.identity_key = any(coalesce(p_keys, '{}'::text[]))
  );
$$;

revoke all on function app_private.information_agent_identity_is_blocked(text[])
from public, anon, authenticated;
grant execute on function app_private.information_agent_identity_is_blocked(text[])
to service_role;

-- Une opposition par adresse (lien, réponse, STOP, saisie) alimente la liste par identité avec
-- toutes les clés connues pour cette adresse (registre et missions) ; réciproquement, une adresse
-- observée pour un professionnel déjà opposé naît opposée. Les colonnes générées ne sont pas
-- encore calculées dans un déclencheur BEFORE : l'adresse est normalisée ici.
create or replace function app_private.apply_information_agent_identity_opposition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized text := lower(btrim(new.email));
  known_keys text[];
begin
  if new.opposition_status = 'opposed' then
    select coalesce(array_agg(distinct known.item), '{}'::text[])
    into known_keys
    from (
      select unnest(contact.identity_keys) as item
      from public.information_agent_contacts contact
      where contact.normalized_email = normalized
      union
      select unnest(mission.recipient_identity_keys) as item
      from public.information_agent_missions mission
      where lower(btrim(mission.recipient_email)) = normalized
      union
      select unnest(coalesce(new.identity_keys, '{}'::text[])) as item
    ) known;

    new.identity_keys := known_keys;
    insert into public.information_agent_identity_oppositions (identity_key, opposed_at)
    select known_item, coalesce(new.opposed_at, now())
    from unnest(known_keys) as known_item
    on conflict (identity_key) do nothing;
  elsif cardinality(coalesce(new.identity_keys, '{}'::text[])) > 0
    and app_private.information_agent_identity_is_blocked(new.identity_keys) then
    new.opposition_status := 'opposed';
    new.opposed_at := coalesce(new.opposed_at, now());
  end if;
  return new;
end;
$$;

revoke all on function app_private.apply_information_agent_identity_opposition()
from public, anon, authenticated;

drop trigger if exists immojudis_information_agent_contacts_identity_opposition
on public.information_agent_contacts;
create trigger immojudis_information_agent_contacts_identity_opposition
before insert or update on public.information_agent_contacts
for each row
execute function app_private.apply_information_agent_identity_opposition();

-- Le garde d'envoi vérifie aussi l'identité du destinataire. Même corps que
-- 20260928160000_information_agent_contact_registry.sql plus le contrôle d'identité.
create or replace function app_private.guard_information_agent_mission_contact()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  should_check boolean;
begin
  if tg_op = 'INSERT' then
    should_check := true;
  else
    should_check := old.status not in ('sending', 'sent')
      or new.recipient_email is distinct from old.recipient_email
      or new.recipient_identity_keys is distinct from old.recipient_identity_keys
      or new.sale_id is distinct from old.sale_id;
  end if;

  if new.status in ('sending', 'sent')
     and should_check
     and (
       app_private.information_agent_contact_is_blocked(new.sale_id, new.recipient_email)
       or app_private.information_agent_identity_is_blocked(new.recipient_identity_keys)
     ) then
    raise exception using
      errcode = '23514',
      message = 'Information-agent contact is opposed or permanently bounced.';
  end if;
  return new;
end;
$$;

revoke all on function app_private.guard_information_agent_mission_contact()
from public, anon, authenticated;

drop trigger if exists information_agent_missions_contact_guard
on public.information_agent_missions;
create trigger information_agent_missions_contact_guard
before insert or update of status, recipient_email, recipient_identity_keys, sale_id
on public.information_agent_missions
for each row
execute function app_private.guard_information_agent_mission_contact();

-- ---------------------------------------------------------------------------
-- 3. Purge et durées de conservation
-- ---------------------------------------------------------------------------
-- Durées annoncées dans le pied du message (art. 14) :
--   - aucun message envoyé (brouillon, annulé, échec sans envoi) : 30 jours ;
--   - envoyé sans réponse : 12 mois ;
--   - avec réponse : 24 mois après le dernier échange.
-- Les adresses du registre jamais utilisées pour un envoi (aucune mission ne les vise) sont
-- supprimées 30 jours après leur relevé. Les oppositions (adresse) et rebonds permanents restent,
-- ainsi que toute la liste d'opposition par identité.
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
  deleted_contacts integer := 0;
begin
  delete from public.information_agent_missions mission
  where (
      mission.status in ('draft', 'cancelled')
      and mission.updated_at < p_now - interval '30 days'
    )
    or (
      mission.status = 'failed'
      and mission.sent_at is null
      and mission.updated_at < p_now - interval '30 days'
    )
    or (
      mission.status in ('approved', 'sending')
      and mission.updated_at < p_now - interval '6 months'
    )
    or (
      mission.status = 'sent'
      and mission.replied_at is null
      and coalesce(mission.sent_at, mission.updated_at) < p_now - interval '12 months'
    )
    or (
      (
        mission.status in ('replied', 'completed')
        or (mission.status = 'sent' and mission.replied_at is not null)
        or (mission.status = 'failed' and mission.sent_at is not null)
      )
      and mission.updated_at < p_now - interval '24 months'
    );
  get diagnostics deleted_missions = row_count;

  -- Après les missions : une adresse qui n'a servi à aucun envoi disparaît 30 jours après son
  -- relevé, une adresse utilisée suit la mission qui la porte.
  delete from public.information_agent_contacts contact
  where contact.scope_sale_id is not null
    and contact.opposition_status <> 'opposed'
    and contact.bounce_status = 'none'
    and coalesce(contact.observed_at, contact.last_seen_at, contact.created_at)
      < p_now - interval '30 days'
    and not exists (
      select 1
      from public.information_agent_missions mission
      where lower(btrim(mission.recipient_email)) = contact.normalized_email
    );
  get diagnostics deleted_contacts = row_count;

  return jsonb_build_object(
    'information_agent_missions', deleted_missions,
    'information_agent_contacts', deleted_contacts
  );
end;
$$;

revoke all on function app_private.purge_information_agent_data(timestamptz)
  from public, anon, authenticated;
grant execute on function app_private.purge_information_agent_data(timestamptz)
  to service_role;

notify pgrst, 'reload schema';

commit;
