begin;

set local lock_timeout = '5s';

-- Journal central des emails envoyés par Immojudis (module « Emails » de l'administration, lot 3).
--
-- Jusqu'ici chaque émetteur gardait son propre suivi (journaux des rappels, du récapitulatif et des alertes de
-- résultat, instantané de l'alerte, messages de l'agent d'information) et rien ne disait, pour un email donné,
-- s'il avait été délivré ou rebondi. Cette migration ajoute :
--   1. public.email_send_log : UNE ligne par email envoyé par Resend (identifiant Resend, gabarit du registre,
--      catégorie, mode d'envoi, compte, expéditeur, destinataire en minuscules, objet borné à 300 caractères,
--      statut de livraison). AUCUN corps : le contenu se relit chez Resend, à la demande, tant qu'il y est conservé.
--      RLS activée, AUCUN droit pour anon, authenticated ni public (règle des tables récentes, vérifiée par
--      scripts/check-security-invariants.mjs) : seul service_role y accède (envoi, webhooks, purge, et routes
--      /api/admin/emails/history, qui vérifient le rôle administrateur avant toute lecture).
--   2. public.record_email_send : écrit la ligne au moment de l'envoi. Reprise idempotente (upsert sur l'identifiant
--      Resend) : un envoi rejoué ne crée pas de seconde ligne et ne fait jamais reculer le statut.
--   3. public.record_email_delivery_event : applique un évènement de livraison reçu par webhook. Le statut ne fait
--      qu'avancer (complained > bounced > delivered > failed > delayed > sent) ; l'évènement peut arriver AVANT
--      l'écriture de la ligne par l'envoi : la ligne est alors créée par l'évènement et complétée ensuite.
--   4. app_private.email_send_log_retention(category) : la durée de conservation, dans UNE fonction. 90 jours pour
--      toutes les catégories, EN ATTENTE DE VALIDATION de juridique-rgpd. Un avis qui demanderait une autre durée
--      pour les emails contractuels ou de facturation (catégories « billing » et « acceptance ») se traduit par une
--      migration qui ne remplace que cette fonction : la colonne category est déjà là pour cela.
--   5. app_private.purge_email_send_log : la purge. Son branchement dans public.run_data_retention est dans la
--      migration suivante (20261110210100), qui reprend la dernière définition de cette fonction.
--
-- Aucune ligne existante n'est modifiée.

-- 1. Table ---------------------------------------------------------------------------------------------------
create table if not exists public.email_send_log (
  id uuid primary key default gen_random_uuid(),
  -- Identifiant de l'email chez Resend. Nul si le fournisseur n'en a pas rendu ; unique sinon.
  resend_email_id text,
  -- Clé du registre src/lib/email-templates ; « unknown » : ligne créée par un évènement de livraison avant (ou
  -- sans) l'écriture de l'envoi, par exemple un email envoyé par un autre outil du même compte Resend.
  template_key text not null default 'unknown',
  -- Catégorie d'envoi (étiquette Resend « category »). Sert aussi à fixer une durée de conservation par catégorie.
  category text not null default 'unknown',
  -- Réservé au lot 5 (surcharges de textes) : nul = texte du code.
  template_revision_id uuid,
  -- on : envoi normal ; internal : envoyé à une adresse interne seulement ; test : essai d'un administrateur ;
  -- manual : envoi déclenché à la main par un administrateur (agent d'information, mise en relation).
  mode text not null default 'on',
  -- Compte destinataire quand il est connu. La ligne disparaît avec le compte.
  user_id uuid references auth.users (id) on delete cascade,
  from_address text not null default '',
  to_address text not null default '',
  subject text not null default '',
  status text not null default 'sent',
  bounce_type text,
  last_event_at timestamptz,
  error_code text,
  created_at timestamptz not null default now(),
  constraint email_send_log_status_check check (
    status in ('sent', 'delivered', 'delayed', 'bounced', 'complained', 'failed')
  ),
  constraint email_send_log_mode_check check (mode in ('on', 'internal', 'test', 'manual')),
  constraint email_send_log_category_check check (category ~ '^[a-z0-9_]{1,40}$'),
  constraint email_send_log_size_check check (
    (resend_email_id is null or char_length(resend_email_id) between 1 and 200)
    and char_length(template_key) between 1 and 80
    and char_length(from_address) <= 320
    and char_length(to_address) <= 320
    and char_length(subject) <= 300
    and (bounce_type is null or char_length(bounce_type) <= 40)
    and (error_code is null or char_length(error_code) <= 80)
  ),
  constraint email_send_log_address_lowercase_check check (to_address = lower(to_address))
);

comment on table public.email_send_log is
  'Journal des emails envoyés par Immojudis via Resend : gabarit, catégorie, destinataire, objet et statut de livraison, SANS corps (relu chez Resend à la demande). Lu seulement par l''écran d''administration. Conservation : voir app_private.email_send_log_retention (90 jours, en attente de validation juridique-rgpd).';

create unique index if not exists email_send_log_resend_email_idx
  on public.email_send_log (resend_email_id);
create index if not exists email_send_log_created_idx
  on public.email_send_log (created_at desc, id desc);
-- text_pattern_ops : la recherche par adresse est exacte ou par préfixe, quelle que soit la collation.
create index if not exists email_send_log_to_address_idx
  on public.email_send_log (to_address text_pattern_ops, created_at desc);
create index if not exists email_send_log_user_idx
  on public.email_send_log (user_id)
  where user_id is not null;

alter table public.email_send_log enable row level security;

revoke all on table public.email_send_log from public, anon, authenticated;
grant select, insert, update, delete on table public.email_send_log to service_role;
-- Aucune politique : RLS sans politique refuse tout rôle soumis aux politiques ; service_role les contourne.

-- 2. Durée de conservation -----------------------------------------------------------------------------------
-- UNE fonction, une constante. Le paramètre est ignoré aujourd'hui ; il existe pour qu'une migration puisse
-- répondre « 90 jours sauf pour la catégorie X » en ne remplaçant que cette fonction.
create or replace function app_private.email_send_log_retention(p_category text default null)
returns interval
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $$
  select interval '90 days';
$$;

revoke all on function app_private.email_send_log_retention(text) from public, anon, authenticated;
grant execute on function app_private.email_send_log_retention(text) to service_role;

comment on function app_private.email_send_log_retention(text) is
  'Durée de conservation d''une ligne du journal des envois, comptée depuis created_at : 90 jours pour toutes les catégories (EN ATTENTE de validation par juridique-rgpd). Pour une durée différente selon la catégorie (facturation, contractuel), remplacer uniquement cette fonction.';

-- 3. Rang des statuts ----------------------------------------------------------------------------------------
create or replace function app_private.email_send_status_rank(p_status text)
returns integer
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $$
  select case p_status
    when 'sent' then 0
    when 'delayed' then 1
    when 'failed' then 2
    when 'delivered' then 3
    when 'bounced' then 4
    when 'complained' then 5
    else -1
  end;
$$;

revoke all on function app_private.email_send_status_rank(text) from public, anon, authenticated;
grant execute on function app_private.email_send_status_rank(text) to service_role;

-- 4. Écriture de l'envoi -------------------------------------------------------------------------------------
create or replace function public.record_email_send(
  p_resend_email_id text,
  p_template_key text,
  p_category text,
  p_mode text,
  p_from text,
  p_to text,
  p_subject text,
  p_user_id uuid default null,
  p_template_revision_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.email_send_log as entry (
    resend_email_id, template_key, category, template_revision_id, mode, user_id,
    from_address, to_address, subject
  )
  values (
    nullif(pg_catalog.btrim(p_resend_email_id), ''),
    p_template_key,
    p_category,
    p_template_revision_id,
    p_mode,
    p_user_id,
    pg_catalog.left(pg_catalog.btrim(coalesce(p_from, '')), 320),
    pg_catalog.left(pg_catalog.lower(pg_catalog.btrim(coalesce(p_to, ''))), 320),
    pg_catalog.left(coalesce(p_subject, ''), 300)
  )
  on conflict (resend_email_id) do update set
    template_key = excluded.template_key,
    category = excluded.category,
    template_revision_id = coalesce(excluded.template_revision_id, entry.template_revision_id),
    mode = excluded.mode,
    user_id = coalesce(excluded.user_id, entry.user_id),
    from_address = excluded.from_address,
    to_address = excluded.to_address,
    subject = excluded.subject
    -- Ni le statut, ni les évènements de livraison, ni created_at : un envoi rejoué ne fait pas reculer la ligne.
  returning entry.id into v_id;
  return v_id;
end;
$$;

revoke all on function public.record_email_send(text, text, text, text, text, text, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.record_email_send(text, text, text, text, text, text, text, uuid, uuid)
  to service_role;

comment on function public.record_email_send(text, text, text, text, text, text, text, uuid, uuid) is
  'Journal des envois : écrit (ou complète, si un évènement de livraison est arrivé le premier) la ligne d''un email envoyé. Idempotent sur l''identifiant Resend, ne fait jamais reculer le statut. Réservé à service_role.';

-- 5. Évènements de livraison ---------------------------------------------------------------------------------
create or replace function public.record_email_delivery_event(
  p_resend_email_id text,
  p_event text,
  p_occurred_at timestamptz default null,
  p_from text default null,
  p_to text default null,
  p_subject text default null,
  p_bounce_type text default null,
  p_error_code text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_result text;
begin
  v_status := case p_event
    when 'email.sent' then 'sent'
    when 'email.delivery_delayed' then 'delayed'
    when 'email.delivered' then 'delivered'
    when 'email.failed' then 'failed'
    when 'email.bounced' then 'bounced'
    when 'email.complained' then 'complained'
    else null
  end;
  -- Autre évènement (ouverture, clic…) ou email sans identifiant : rien à écrire.
  if v_status is null or nullif(pg_catalog.btrim(p_resend_email_id), '') is null then
    return null;
  end if;

  insert into public.email_send_log as entry (
    resend_email_id, status, from_address, to_address, subject, bounce_type, error_code, last_event_at
  )
  values (
    pg_catalog.btrim(p_resend_email_id),
    v_status,
    pg_catalog.left(pg_catalog.btrim(coalesce(p_from, '')), 320),
    pg_catalog.left(pg_catalog.lower(pg_catalog.btrim(coalesce(p_to, ''))), 320),
    pg_catalog.left(coalesce(p_subject, ''), 300),
    pg_catalog.left(pg_catalog.lower(nullif(pg_catalog.btrim(coalesce(p_bounce_type, '')), '')), 40),
    pg_catalog.left(nullif(pg_catalog.btrim(coalesce(p_error_code, '')), ''), 80),
    coalesce(p_occurred_at, pg_catalog.statement_timestamp())
  )
  on conflict (resend_email_id) do update set
    -- Le statut ne fait qu'avancer ; un évènement en retard (« delivered » après « bounced ») ne le fait pas reculer.
    status = case
      when app_private.email_send_status_rank(excluded.status)
        > app_private.email_send_status_rank(entry.status)
      then excluded.status
      else entry.status
    end,
    bounce_type = coalesce(excluded.bounce_type, entry.bounce_type),
    error_code = coalesce(excluded.error_code, entry.error_code),
    last_event_at = greatest(coalesce(entry.last_event_at, excluded.last_event_at), excluded.last_event_at),
    -- Les champs descriptifs ne sont complétés que s'ils sont vides : l'envoi reste la source de vérité.
    from_address = case when entry.from_address = '' then excluded.from_address else entry.from_address end,
    to_address = case when entry.to_address = '' then excluded.to_address else entry.to_address end,
    subject = case when entry.subject = '' then excluded.subject else entry.subject end
  returning entry.status into v_result;
  return v_result;
end;
$$;

revoke all on function public.record_email_delivery_event(text, text, timestamptz, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.record_email_delivery_event(text, text, timestamptz, text, text, text, text, text)
  to service_role;

comment on function public.record_email_delivery_event(text, text, timestamptz, text, text, text, text, text) is
  'Journal des envois : applique un évènement de livraison Resend (envoyé, retardé, délivré, échec, rebond, plainte). Le statut ne fait qu''avancer ; l''évènement peut précéder l''écriture de l''envoi. Retourne le statut résultant, ou null pour un évènement ignoré. Réservé à service_role.';

-- 6. Purge ---------------------------------------------------------------------------------------------------
create or replace function app_private.purge_email_send_log(
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer := 0;
begin
  delete from public.email_send_log entry
  where entry.created_at < p_now - app_private.email_send_log_retention(entry.category);
  get diagnostics v_deleted = row_count;
  return pg_catalog.jsonb_build_object('email_send_log', v_deleted);
end;
$$;

revoke all on function app_private.purge_email_send_log(timestamptz) from public, anon, authenticated;
grant execute on function app_private.purge_email_send_log(timestamptz) to service_role;

notify pgrst, 'reload schema';

commit;
