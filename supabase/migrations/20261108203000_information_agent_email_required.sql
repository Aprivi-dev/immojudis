-- L'agent d'information ne fonctionne que par email (décision du propriétaire du 28/10/2026) : ni mission,
-- ni dossier, ni brouillon pour une vente dont le seul contact connu est un numéro de téléphone, un nom sans
-- adresse email ou un champ vide.
--
-- État avant : les tables information_agent_missions et information_agent_cases refusaient déjà une adresse
-- absente ou sans « @ » (not null et contrainte *_recipient_email_check), mais avec une expression plus lâche
-- que celle de l'application (« a@b.c » passait) et avec une erreur de contrainte sans motif lisible.
--
-- Cette migration ajoute, sans toucher aux contraintes ni aux lignes existantes :
--   1. app_private.information_agent_email_is_valid(text) : MÊME règle que le validateur de l'application
--      (src/lib/information-agent/email-address.ts, z.string().email() de zod 4, après trim et minuscules) ;
--   2. une garde dans le déclencheur de information_agent_missions : à l'insertion, et quand l'adresse change,
--      une adresse invalide est refusée avec le motif « Aucune adresse email de contact : l'agent ne peut pas
--      écrire. » (23514). Les autres mises à jour (statut, rebond, envoi) ne revérifient pas l'adresse : une
--      ligne ancienne ne se bloque jamais ;
--   3. la même vérification dans public.subscribe_information_agent_mission, seul chemin qui crée un dossier
--      (information_agent_cases) : pas de dossier sans adresse valide, quel que soit l'appelant.
--
-- Aucune ligne n'est lue ni modifiée : pas de validation de l'existant, donc rien à purger. Les deux
-- brouillons existants en production ont une adresse valide ; ils ne sont revérifiés qu'à leur prochain
-- changement d'adresse ou à leur rattachement à un dossier.
--
-- DÉPLOIEMENT : indépendant du code (le code refuse déjà ces cas avant d'écrire). Appliquer dans n'importe
-- quel ordre.
-- RETOUR ARRIÈRE : recréer guard_information_agent_mission_contact et subscribe_information_agent_mission
-- depuis 20261023120000_information_agent_legal_safeguards.sql et 20260825103748_centralize_information_agent_cases.sql,
-- puis drop function app_private.information_agent_email_is_valid(text).
begin;

set local lock_timeout = '5s';

-- 1. La règle d'adresse ------------------------------------------------------------------------------------------
-- Expression de zod 4 (z.regexes.email), écrite pour PostgreSQL : le tiret en fin de classe est littéral, l'apostrophe
-- est doublée dans la chaîne SQL.
create or replace function app_private.information_agent_email_is_valid(p_email text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select p_email is not null
    and char_length(btrim(p_email)) between 3 and 320
    and lower(btrim(p_email)) ~
      '^(?:[A-Za-z0-9_''+-]+\.)*[A-Za-z0-9_''+-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$';
$$;

revoke all on function app_private.information_agent_email_is_valid(text)
from public, anon, authenticated;
grant execute on function app_private.information_agent_email_is_valid(text) to service_role;

-- 2. Garde du déclencheur des demandes -------------------------------------------------------------------------
-- Reprend la version de 20261023120000 (opposition par adresse et par identité à l'envoi) et ajoute la
-- vérification de l'adresse à l'insertion et au changement d'adresse.
create or replace function app_private.guard_information_agent_mission_contact()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  should_check boolean;
begin
  if (tg_op = 'INSERT' or new.recipient_email is distinct from old.recipient_email)
     and not app_private.information_agent_email_is_valid(new.recipient_email) then
    raise exception using
      errcode = '23514',
      message = 'Aucune adresse email de contact : l''agent ne peut pas écrire.';
  end if;

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

-- 3. Rattachement à un dossier ---------------------------------------------------------------------------------
-- Reprend la version de 20260825103748 ; seul ajout : le refus d'une adresse invalide avant de créer le dossier.
create or replace function public.subscribe_information_agent_mission(
  p_user_id uuid,
  p_mission_id uuid
)
returns table (case_id uuid, case_status text, mission_status text, inbound_token uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mission public.information_agent_missions%rowtype;
  v_case public.information_agent_cases%rowtype;
  v_normalized_email text;
begin
  select * into v_mission
  from public.information_agent_missions mission
  where mission.id = p_mission_id and mission.user_id = p_user_id
  for update;

  if v_mission.id is null or v_mission.sale_id is null then
    raise exception using errcode = 'P0002', message = 'Information agent mission not found.';
  end if;
  if v_mission.status not in ('draft', 'failed', 'subscribed') then
    raise exception using errcode = '55000', message = 'Information agent mission cannot change case.';
  end if;
  if not app_private.information_agent_email_is_valid(v_mission.recipient_email) then
    raise exception using
      errcode = '23514',
      message = 'Aucune adresse email de contact : l''agent ne peut pas écrire.';
  end if;

  v_normalized_email := lower(btrim(v_mission.recipient_email));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'information-agent:case:' || v_mission.sale_id::text || ':' || v_normalized_email,
      0
    )
  );

  insert into public.information_agent_cases (
    sale_id, created_by, recipient_kind, recipient_name, recipient_email,
    normalized_recipient_email, subject, body_text, question_keys,
    missing_information, metadata
  ) values (
    v_mission.sale_id, p_user_id, v_mission.recipient_kind, v_mission.recipient_name,
    v_mission.recipient_email, v_normalized_email, v_mission.subject, v_mission.body_text,
    v_mission.question_keys, v_mission.missing_information,
    jsonb_build_object('created_from_mission_id', v_mission.id)
  )
  on conflict (sale_id, normalized_recipient_email) do nothing;

  select * into v_case
  from public.information_agent_cases shared_case
  where shared_case.sale_id = v_mission.sale_id
    and shared_case.normalized_recipient_email = v_normalized_email
  for update;

  delete from public.information_agent_case_subscribers subscriber
  where subscriber.mission_id = v_mission.id;

  update public.information_agent_missions mission
  set case_id = v_case.id,
      status = case when v_case.status in ('draft', 'failed') then 'draft' else 'subscribed' end,
      updated_at = statement_timestamp()
  where mission.id = v_mission.id;

  insert into public.information_agent_case_subscribers (
    case_id, user_id, mission_id, requested_question_keys, is_initiator
  ) values (
    v_case.id, p_user_id, v_mission.id, v_mission.question_keys,
    coalesce(v_case.initiator_mission_id = v_mission.id, false)
  )
  on conflict on constraint information_agent_case_subscribers_pkey do update set
    mission_id = excluded.mission_id,
    requested_question_keys = excluded.requested_question_keys;

  return query
  select
    v_case.id,
    v_case.status,
    case when v_case.status in ('draft', 'failed') then 'draft'::text else 'subscribed'::text end,
    v_case.inbound_token;
end;
$$;

revoke all on function public.subscribe_information_agent_mission(uuid, uuid)
from public, anon, authenticated;
grant execute on function public.subscribe_information_agent_mission(uuid, uuid) to service_role;

notify pgrst, 'reload schema';

commit;
