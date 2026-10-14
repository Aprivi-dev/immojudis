begin;

-- Garde-fous juridiques de l'agent d'information (avis juridique du 14/10/2026, section 7) :
--   1. source typée de toute adresse retenue (nature, URL, date de relevé, auteur) ;
--   2. purge des adresses jamais utilisées pour un envoi (21 jours, la purge étant hebdomadaire :
--      « un mois au plus » partout) et durées de conservation alignées sur le pied du message
--      (12 mois sans réponse, 24 mois après le dernier échange) ;
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
  'Nom de l''annuaire officiel (liste fermée), obligatoire et réservé pour source_kind = official_directory.';
comment on column public.information_agent_contacts.observed_at is
  'Date de relevé de l''adresse (art. 14 RGPD) ; point de départ de la purge de 21 jours.';
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
  -- Liste fermée, reprise par INFORMATION_AGENT_DIRECTORY_NAMES (information-agent-compliance.ts).
  add constraint information_agent_contacts_directory_name_check check (
    (source_kind is not distinct from 'official_directory') = (source_directory_name is not null)
    and (
      source_directory_name is null
      or source_directory_name in (
        'annuaire officiel des commissaires de justice',
        'annuaire du barreau de Lyon',
        'annuaire du barreau de Bordeaux',
        'annuaire des avocats du CNB'
      )
    )
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

-- Une opposition par adresse (lien, réponse, STOP, saisie) :
--   - vide la ligne de tout ce qui n'est pas nécessaire pour ne plus solliciter la personne (nom,
--     source, provenance, métadonnées) : l'adresse normalisée, les clés d'identité et la date
--     restent, conservées à cette seule fin ;
--   - alimente la liste par identité avec toutes les clés connues pour cette adresse (registre et
--     missions) ;
--   - supprime les autres lignes du registre pour cette adresse et les demandes jamais envoyées.
-- Réciproquement, une adresse observée pour un professionnel déjà opposé naît opposée.
-- Les colonnes générées ne sont pas encore calculées dans un déclencheur BEFORE : l'adresse est
-- normalisée ici. Le traitement des clés ne doit JAMAIS faire échouer l'opposition : clés hors de
-- 3 à 400 caractères ignorées, 64 clés au plus, et toute erreur de propagation est seulement
-- signalée (l'opposition par adresse est enregistrée dans tous les cas).
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
  if new.opposition_status <> 'opposed'
    and cardinality(coalesce(new.identity_keys, '{}'::text[])) > 0
    and app_private.information_agent_identity_is_blocked(new.identity_keys) then
    new.opposition_status := 'opposed';
    new.opposed_at := coalesce(new.opposed_at, now());
  end if;

  if new.opposition_status = 'opposed' then
    new.opposed_at := coalesce(new.opposed_at, now());
    new.display_name := null;
    new.source_name := null;
    new.source_url := null;
    new.source_kind := null;
    new.source_directory_name := null;
    new.observed_at := null;
    new.observed_by := null;
    new.observed_by_user_id := null;
    new.provenance := '[]'::jsonb;
    new.metadata := '{}'::jsonb;

    begin
      select coalesce(array_agg(clean.item order by clean.item), '{}'::text[])
      into known_keys
      from (
        select distinct raw.item
        from (
          select unnest(contact.identity_keys) as item
          from public.information_agent_contacts contact
          where contact.normalized_email = normalized
          union all
          select unnest(mission.recipient_identity_keys) as item
          from public.information_agent_missions mission
          where lower(btrim(mission.recipient_email)) = normalized
          union all
          select unnest(coalesce(new.identity_keys, '{}'::text[])) as item
        ) raw
        where char_length(raw.item) between 3 and 400
          and raw.item = lower(raw.item)
        order by raw.item
        limit 64
      ) clean;

      new.identity_keys := known_keys;
      insert into public.information_agent_identity_oppositions (identity_key, opposed_at)
      select known_item, new.opposed_at
      from unnest(known_keys) as known_item
      on conflict (identity_key) do nothing;
    exception when others then
      raise warning 'information-agent opposition: identity keys not recorded (%)', sqlerrm;
      new.identity_keys := '{}'::text[];
    end;

    begin
      delete from public.information_agent_contacts contact
      where contact.normalized_email = normalized
        and contact.scope_sale_id is not null
        and contact.id is distinct from new.id;
      delete from public.information_agent_missions mission
      where lower(btrim(mission.recipient_email)) = normalized
        and mission.status in ('draft', 'cancelled', 'failed')
        and mission.sent_at is null
        and mission.provider_message_id is null;
    exception when others then
      raise warning 'information-agent opposition: related rows not deleted (%)', sqlerrm;
    end;
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
-- La purge tourne une fois par semaine : « un mois au plus » est annoncé partout, le seuil des
-- demandes jamais envoyées est donc de 21 jours. Durées annoncées dans le pied du message (art. 14) :
--   - aucun message envoyé (brouillon, annulé, approuvé ou en cours d'envoi sans suite, échec sans
--     identifiant du fournisseur) : 21 jours après la création de la demande ;
--   - envoyé sans réponse : 12 mois après l'envoi (un échec avec identifiant du fournisseur compte
--     comme envoyé : le message a été accepté) ;
--   - avec réponse : 24 mois après le dernier échange (dernier message, pas updated_at).
-- Une demande « subscribed » rejoint un dossier partagé : elle suit l'envoi et les échanges de ce
-- dossier. Les adresses du registre qu'aucune demande ne vise sont supprimées 21 jours après leur
-- relevé ; les rebonds permanents au bout de 12 mois. Les oppositions et la liste d'opposition par
-- identité ne sont jamais purgées.
create or replace function app_private.information_agent_mission_sent_at(
  p_mission public.information_agent_missions
)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    p_mission.sent_at,
    (
      select shared_case.sent_at
      from public.information_agent_cases shared_case
      where shared_case.id = p_mission.case_id
    ),
    case
      when p_mission.provider_message_id is not null
        then coalesce(p_mission.approved_at, p_mission.updated_at)
    end
  );
$$;

create or replace function app_private.information_agent_mission_last_exchange_at(
  p_mission public.information_agent_missions
)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(
    app_private.information_agent_mission_sent_at(p_mission),
    p_mission.replied_at,
    (
      select max(coalesce(message.received_at, message.sent_at, message.created_at))
      from public.information_agent_messages message
      where message.mission_id = p_mission.id
        or (p_mission.case_id is not null and message.case_id = p_mission.case_id)
    )
  );
$$;

create or replace function app_private.information_agent_mission_purge_due(
  p_mission public.information_agent_missions,
  p_now timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_mission.replied_at is not null
      or p_mission.status in ('replied', 'completed')
      or exists (
        select 1
        from public.information_agent_messages message
        where message.direction = 'inbound'
          and (
            message.mission_id = p_mission.id
            or (p_mission.case_id is not null and message.case_id = p_mission.case_id)
          )
      )
      then coalesce(
        app_private.information_agent_mission_last_exchange_at(p_mission),
        p_mission.updated_at
      ) < p_now - interval '24 months'
    when app_private.information_agent_mission_sent_at(p_mission) is not null
      or p_mission.status = 'sent'
      then coalesce(
        app_private.information_agent_mission_sent_at(p_mission),
        p_mission.updated_at
      ) < p_now - interval '12 months'
    else p_mission.created_at < p_now - interval '21 days'
  end;
$$;

revoke all on function app_private.information_agent_mission_sent_at(public.information_agent_missions)
  from public, anon, authenticated;
revoke all on function app_private.information_agent_mission_last_exchange_at(public.information_agent_missions)
  from public, anon, authenticated;
revoke all on function app_private.information_agent_mission_purge_due(public.information_agent_missions, timestamptz)
  from public, anon, authenticated;
grant execute on function app_private.information_agent_mission_sent_at(public.information_agent_missions)
  to service_role;
grant execute on function app_private.information_agent_mission_last_exchange_at(public.information_agent_missions)
  to service_role;
grant execute on function app_private.information_agent_mission_purge_due(public.information_agent_missions, timestamptz)
  to service_role;

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
  deleted_bounces integer := 0;
begin
  delete from public.information_agent_missions mission
  where app_private.information_agent_mission_purge_due(mission, p_now);
  get diagnostics deleted_missions = row_count;

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
    'information_agent_contacts', deleted_contacts + deleted_bounces
  );
end;
$$;

revoke all on function app_private.purge_information_agent_data(timestamptz)
  from public, anon, authenticated;
grant execute on function app_private.purge_information_agent_data(timestamptz)
  to service_role;

-- ---------------------------------------------------------------------------
-- 4. Modèles de message : numérotation après la révision de conformité
-- ---------------------------------------------------------------------------
-- Le code n'utilise un modèle publié que si sa révision est au moins MIN_COMPLIANT_TEMPLATE_REVISION
-- (7). Les révisions sont une séquence : on la fait avancer pour que tout modèle publié ensuite
-- soit pris en compte, et on renumérote un éventuel brouillon antérieur. Le modèle publié actuel
-- n'est pas modifié : il est simplement ignoré par le code.
do $$
begin
  perform setval(
    'public.information_agent_email_templates_revision_seq',
    greatest(
      (select last_value from public.information_agent_email_templates_revision_seq),
      6
    )
  );
end;
$$;

update public.information_agent_email_templates
set revision = nextval('public.information_agent_email_templates_revision_seq')
where status = 'draft'
  and revision < 7;

notify pgrst, 'reload schema';

commit;
