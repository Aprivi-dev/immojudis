begin;

set local lock_timeout = '5s';

-- Agent d'information, étape 2 du plan d'enrichissement (propositions 4 et 5, validées le 10/11/2026).
--
-- 1. Noyau de publication commun : app_private.apply_information_agent_fact(fait, type d'auteur, auteur,
--    version de politique). Il reprend À L'IDENTIQUE l'écriture sur la fiche que faisait
--    public.review_information_agent_fact_candidate (dernière définition : 20260920144219, cible
--    « on conflict (source_url, document_url) » depuis 20261003091424), et y ajoute :
--      * une ligne au journal public.information_agent_fact_publications, dans la même transaction :
--        valeurs précédentes des colonnes modifiées, leur provenance précédente, nouvelles valeurs,
--        auteur réel (admin aujourd'hui), version de politique (nulle pour admin), date de réception ;
--      * publication_mode (« manual » aujourd'hui) et received_at dans
--        raw_payload.information_agent_verified_facts[clé].
--    Le noyau n'est exécutable par aucun rôle de l'API (ni anon, ni authenticated, ni service_role) :
--    seule la RPC administrateur, SECURITY DEFINER, l'appelle, avec 'admin'. Aucun chemin n'écrit
--    'auto' : la valeur est prévue par la contrainte du journal pour une étape ultérieure.
-- 2. public.review_information_agent_fact_candidate garde ses contrôles (décision, administrateur,
--    statut, droits et dépôt des pièces jointes), ses effets et ses retours ; seule l'écriture passe par
--    le noyau. La variante _with_path appelle cette RPC : elle passe par le même noyau sans changer.
-- 3. Le pont vers auction_fact_claims (20260928200000) lit le type d'auteur au journal : pour 'admin'
--    (ou sans ligne de journal), le résultat est identique à aujourd'hui ; pour 'auto', il refuse la
--    transaction tant qu'une provenance de claim n'est pas définie (étape ultérieure).
--
-- Aucune donnée existante n'est réécrite : les faits acceptés avant cette migration n'ont ni ligne de
-- journal ni publication_mode.

-- Journal des publications ---------------------------------------------------------------------------------------
-- Une ligne par publication. Aucune adresse email, aucun extrait de message, aucun texte libre issu du
-- message : seulement des valeurs de colonnes (nombres, codes, dates, adresses de stockage) et des
-- métadonnées de provenance. Le retour arrière (étape ultérieure) ajoutera ses propres colonnes ou lignes :
-- la table n'a ni contrainte d'unicité sur le fait ni déclencheur qui l'empêcherait.
-- fact_id n'a pas de clé étrangère : la purge de conservation des messages supprime les faits candidats en
-- cascade, et le journal doit survivre à cette purge (l'identifiant seul ne contient aucune donnée).
create table if not exists public.information_agent_fact_publications (
  id uuid primary key default gen_random_uuid(),
  fact_id uuid not null,
  sale_id uuid not null references public.auction_sales(id) on delete cascade,
  fact_key text not null check (char_length(fact_key) between 1 and 64),
  previous_values jsonb not null default '{}'::jsonb check (jsonb_typeof(previous_values) = 'object'),
  previous_provenance jsonb not null default '{}'::jsonb check (
    jsonb_typeof(previous_provenance) = 'object'
  ),
  new_values jsonb not null default '{}'::jsonb check (jsonb_typeof(new_values) = 'object'),
  actor_kind text not null check (actor_kind in ('admin', 'auto')),
  -- Nul pour 'auto' ; pour 'admin', mis à nul seulement si le compte est supprimé.
  actor_id uuid references auth.users(id) on delete set null,
  policy_version text check (
    policy_version is null or char_length(btrim(policy_version)) between 1 and 64
  ),
  response_received_at timestamptz,
  published_at timestamptz not null default statement_timestamp(),
  constraint information_agent_fact_publications_actor_check check (
    (actor_kind = 'admin' and policy_version is null)
    or (actor_kind = 'auto' and actor_id is null and policy_version is not null)
  )
);

create index if not exists information_agent_fact_publications_sale_idx
  on public.information_agent_fact_publications (sale_id, published_at desc);
create index if not exists information_agent_fact_publications_fact_idx
  on public.information_agent_fact_publications (fact_id, published_at desc);

alter table public.information_agent_fact_publications enable row level security;
revoke all on table public.information_agent_fact_publications
  from public, anon, authenticated, service_role;
-- Lecture serveur seulement ; aucune écriture, modification ni suppression par l'API.
grant select on table public.information_agent_fact_publications to service_role;

comment on table public.information_agent_fact_publications is
  'Journal des publications de l''agent d''information (une ligne par publication) : valeurs et provenance précédentes, nouvelles valeurs, auteur réel. Ni email ni extrait de message. Écrit seulement par app_private.apply_information_agent_fact.';

-- Noyau de publication ---------------------------------------------------------------------------------------------
create or replace function app_private.apply_information_agent_fact(
  p_fact_id uuid,
  p_actor_kind text,
  p_actor_id uuid,
  p_policy_version text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fact public.information_agent_fact_candidates%rowtype;
  v_sale public.auction_sales%rowtype;
  v_source_url text;
  v_value_text text;
  v_value_numeric numeric;
  v_value_integer integer;
  v_value_date date;
  v_public_url text;
  v_source_images jsonb;
  v_document_kind text;
  v_now timestamptz := statement_timestamp();
  v_valuation_queued boolean := false;
  v_publication_mode text;
  v_policy_version text := nullif(btrim(p_policy_version), '');
  v_received_at timestamptz;
  v_previous_fact jsonb;
  v_previous_values jsonb := '{}'::jsonb;
  v_previous_provenance jsonb := '{}'::jsonb;
  v_new_values jsonb := '{}'::jsonb;
begin
  if p_actor_kind is null or p_actor_kind not in ('admin', 'auto') then
    raise exception using errcode = '22023', message = 'Invalid publication actor.';
  end if;
  if p_actor_kind = 'admin' then
    if p_actor_id is null or v_policy_version is not null then
      raise exception using errcode = '22023',
        message = 'An administrator publication needs the administrator and no policy version.';
    end if;
    if not exists (
      select 1 from public.user_profiles profile
      where profile.user_id = p_actor_id and profile.user_role = 'admin'
    ) then
      raise exception using errcode = '42501', message = 'Administrator review is required.';
    end if;
  elsif p_actor_id is not null or v_policy_version is null then
    raise exception using errcode = '22023',
      message = 'An automatic publication needs a policy version and no person.';
  end if;
  v_publication_mode := case p_actor_kind when 'admin' then 'manual' else 'auto' end;

  select * into v_fact
  from public.information_agent_fact_candidates fact
  where fact.id = p_fact_id
  for update;

  if v_fact.id is null then
    raise exception using errcode = 'P0002', message = 'Information agent fact not found.';
  end if;
  if v_fact.status <> 'accepted' then
    raise exception using errcode = '55000',
      message = 'Only an accepted information agent fact can be published.';
  end if;
  if p_actor_kind = 'admin' and v_fact.reviewed_by is distinct from p_actor_id then
    raise exception using errcode = '55000',
      message = 'The publishing administrator must be the reviewer of the fact.';
  end if;
  if p_actor_kind = 'auto' and v_fact.reviewed_by is not null then
    raise exception using errcode = '55000',
      message = 'A fact reviewed by a person cannot be published automatically.';
  end if;
  if p_actor_kind = 'auto' and v_fact.fact_key in ('document', 'photo') then
    raise exception using errcode = '55000',
      message = 'Attachments are never published automatically.';
  end if;
  if exists (
    select 1 from public.information_agent_fact_publications publication
    where publication.fact_id = p_fact_id
  ) then
    raise exception using errcode = '55000',
      message = 'Information agent fact was already published.';
  end if;
  if v_fact.fact_key in ('document', 'photo') then
    v_public_url := nullif(btrim(v_fact.proposed_value->>'public_url'), '');
    if v_public_url is null
      or v_public_url !~ '^https://[a-z0-9]+[.]supabase[.]co/storage/v1/object/public/information-agent-approved/'
    then
      raise exception using errcode = '55000',
        message = 'Attachment publication must be staged before acceptance.';
    end if;
  end if;

  -- Date de réception de la réponse, quand elle est connue (jamais l'expéditeur ni l'objet).
  select coalesce(
    message.received_at,
    case when message.direction = 'inbound' then message.created_at end
  )
  into v_received_at
  from public.information_agent_messages message
  where message.id = v_fact.message_id;

  select * into v_sale
  from public.auction_sales sale where sale.id = v_fact.sale_id
  for update;
  v_source_url := v_sale.source_url;
  v_value_text := nullif(btrim(v_fact.proposed_value->>'value'), '');

  -- Provenance précédente commune à toutes les clés : l'entrée de raw_payload que cette publication
  -- remplace, réduite à ses métadonnées (ni valeur affichée ni texte issu d'un message).
  v_previous_fact := case
    when jsonb_typeof(v_sale.raw_payload->'information_agent_verified_facts'->v_fact.fact_key) = 'object'
      then v_sale.raw_payload->'information_agent_verified_facts'->v_fact.fact_key
    else null
  end;
  v_previous_provenance := jsonb_build_object(
    'verified_fact',
    case when v_previous_fact is null then null else jsonb_strip_nulls(jsonb_build_object(
      'fact_id', v_previous_fact->'fact_id',
      'evidence_asset_id', v_previous_fact->'evidence_asset_id',
      'source_page', v_previous_fact->'source_page',
      'reviewed_at', v_previous_fact->'reviewed_at',
      'received_at', v_previous_fact->'received_at',
      'publication_mode', v_previous_fact->'publication_mode',
      'source', v_previous_fact->'source'
    )) end
  );

  if v_fact.fact_key = 'surface_m2' then
    v_value_numeric := v_value_text::numeric;
    if v_value_numeric <= 0 or v_value_numeric > 1000000 then
      raise exception using errcode = '22023', message = 'Invalid accepted surface.';
    end if;
    v_previous_values := jsonb_build_object(
      'surface_m2', v_sale.surface_m2,
      'app_surface_m2', v_sale.app_surface_m2
    );
    -- surface_evidence précédente : gardée quand elle vient de l'annonce ou des pièces ; retenue quand
    -- elle vient déjà d'une réponse (c'est un extrait de message, retrouvable par verified_fact.fact_id).
    v_previous_provenance := v_previous_provenance || jsonb_build_object(
      'app_surface_kind', v_sale.app_surface_kind,
      'surface_source', v_sale.surface_source,
      'surface_confidence', v_sale.surface_confidence,
      'surface_evidence', case
        when v_sale.surface_source = 'information_agent_verified' then null
        else v_sale.surface_evidence
      end,
      'surface_evidence_withheld',
      v_sale.surface_source = 'information_agent_verified' and v_sale.surface_evidence is not null
    );
    update public.auction_sales sale set
      surface_m2 = v_value_numeric,
      app_surface_m2 = v_value_numeric,
      app_surface_kind = 'information_agent_verified',
      surface_source = 'information_agent_verified',
      surface_confidence = greatest(v_fact.confidence, 0.85),
      surface_evidence = left(coalesce(v_fact.evidence_excerpt, v_fact.display_value), 2000),
      updated_at = v_now
    where sale.id = v_fact.sale_id;
    v_new_values := jsonb_build_object(
      'surface_m2', v_value_numeric,
      'app_surface_m2', v_value_numeric,
      'app_surface_kind', 'information_agent_verified',
      'surface_source', 'information_agent_verified',
      'surface_confidence', greatest(v_fact.confidence, 0.85)
    );
    v_valuation_queued := true;
  elsif v_fact.fact_key = 'land_surface_m2' then
    v_value_numeric := v_value_text::numeric;
    if v_value_numeric <= 0 or v_value_numeric > 100000000 then
      raise exception using errcode = '22023', message = 'Invalid accepted land surface.';
    end if;
    v_previous_values := jsonb_build_object('land_surface_m2', v_sale.land_surface_m2);
    update public.auction_sales sale set land_surface_m2 = v_value_numeric, updated_at = v_now
    where sale.id = v_fact.sale_id;
    v_new_values := jsonb_build_object('land_surface_m2', v_value_numeric);
    v_valuation_queued := true;
  elsif v_fact.fact_key = 'rooms_count' then
    v_value_integer := v_value_text::integer;
    if v_value_integer < 1 or v_value_integer > 100 then
      raise exception using errcode = '22023', message = 'Invalid accepted room count.';
    end if;
    v_previous_values := jsonb_build_object('rooms_count', v_sale.rooms_count);
    update public.auction_sales sale set rooms_count = v_value_integer, updated_at = v_now
    where sale.id = v_fact.sale_id;
    v_new_values := jsonb_build_object('rooms_count', v_value_integer);
    v_valuation_queued := true;
  elsif v_fact.fact_key = 'occupancy_status' then
    if v_value_text not in ('vacant', 'occupied', 'rented', 'owner_occupied', 'squatted', 'unknown') then
      raise exception using errcode = '22023', message = 'Invalid accepted occupancy status.';
    end if;
    v_previous_values := jsonb_build_object('occupancy_status', v_sale.occupancy_status);
    update public.auction_sales sale set occupancy_status = v_value_text, updated_at = v_now
    where sale.id = v_fact.sale_id;
    v_new_values := jsonb_build_object('occupancy_status', v_value_text);
    v_valuation_queued := true;
  elsif v_fact.fact_key = 'starting_price_eur' then
    v_value_numeric := v_value_text::numeric;
    if v_value_numeric <= 0 or v_value_numeric > 1000000000 then
      raise exception using errcode = '22023', message = 'Invalid accepted starting price.';
    end if;
    v_previous_values := jsonb_build_object('starting_price_eur', v_sale.starting_price_eur);
    update public.auction_sales sale set starting_price_eur = v_value_numeric, updated_at = v_now
    where sale.id = v_fact.sale_id;
    v_new_values := jsonb_build_object('starting_price_eur', v_value_numeric);
    v_valuation_queued := true;
  elsif v_fact.fact_key = 'sale_date' then
    v_value_date := v_value_text::date;
    v_previous_values := jsonb_build_object('sale_date', v_sale.sale_date);
    update public.auction_sales sale set sale_date = v_value_date, updated_at = v_now
    where sale.id = v_fact.sale_id;
    v_new_values := jsonb_build_object('sale_date', v_value_date);
  elsif v_fact.fact_key = 'property_type' then
    if v_value_text not in ('house', 'apartment', 'building', 'commercial', 'mixed', 'land', 'parking', 'other') then
      raise exception using errcode = '22023', message = 'Invalid accepted property type.';
    end if;
    v_previous_values := jsonb_build_object('property_type', v_sale.property_type);
    update public.auction_sales sale set property_type = v_value_text, updated_at = v_now
    where sale.id = v_fact.sale_id;
    v_new_values := jsonb_build_object('property_type', v_value_text);
    v_valuation_queued := true;
  elsif v_fact.fact_key = 'photo' then
    select case
      when jsonb_typeof(sale.raw_payload->'source_images') = 'array'
        then sale.raw_payload->'source_images'
      else '[]'::jsonb
    end into v_source_images
    from public.auction_sales sale
    where sale.id = v_fact.sale_id;
    v_previous_values := jsonb_build_object(
      'raw_payload.source_images', v_sale.raw_payload->'source_images'
    );
    if not v_source_images @> jsonb_build_array(v_public_url) then
      v_source_images := v_source_images || jsonb_build_array(v_public_url);
    end if;
    update public.auction_sales sale
    set raw_payload = jsonb_set(
          coalesce(sale.raw_payload, '{}'::jsonb),
          '{source_images}',
          v_source_images,
          true
        ),
        updated_at = v_now
    where sale.id = v_fact.sale_id;
    v_new_values := jsonb_build_object('raw_payload.source_images', v_source_images);
  elsif v_fact.fact_key = 'document' then
    select extraction.document_kind into v_document_kind
    from public.information_agent_evidence_extractions extraction
    where extraction.asset_id = v_fact.evidence_asset_id;
    -- Ligne de pièce remplacée, s'il y en avait une à la même adresse (colonnes que l'upsert modifie).
    select jsonb_build_object('auction_documents', jsonb_build_object(
      'label', document.label,
      'document_type', document.document_type,
      'file_path', document.file_path,
      'sha256', document.sha256,
      'download_status', document.download_status,
      'extraction_status', document.extraction_status,
      'raw_payload', document.raw_payload
    ))
    into v_previous_values
    from public.auction_documents document
    where document.source_url = v_source_url and document.document_url = v_public_url;
    v_previous_values := coalesce(v_previous_values, jsonb_build_object('auction_documents', null));
    insert into public.auction_documents (
      source_url, document_url, label, document_type, file_path, sha256,
      download_status, extraction_status, raw_payload, updated_at
    )
    select
      sale.source_url,
      v_public_url,
      asset.original_filename,
      coalesce(v_document_kind, 'information_agent_document'),
      v_fact.proposed_value->>'public_path',
      asset.sha256,
      'stored',
      'completed',
      jsonb_build_object(
        'source', 'information_agent',
        'fact_id', v_fact.id,
        'evidence_asset_id', asset.id,
        'reviewed_at', v_now
      ),
      v_now
    from public.auction_sales sale
    join public.information_agent_evidence_assets asset on asset.id = v_fact.evidence_asset_id
    where sale.id = v_fact.sale_id
    on conflict (source_url, document_url) do update set
      label = excluded.label,
      document_type = excluded.document_type,
      file_path = excluded.file_path,
      sha256 = excluded.sha256,
      download_status = excluded.download_status,
      extraction_status = excluded.extraction_status,
      raw_payload = excluded.raw_payload,
      updated_at = excluded.updated_at;
    v_new_values := jsonb_build_object('auction_documents', jsonb_build_object(
      'document_url', v_public_url,
      'document_type', coalesce(v_document_kind, 'information_agent_document')
    ));
  end if;

  update public.auction_sales sale
  set raw_payload = (
        (coalesce(sale.raw_payload, '{}'::jsonb)
          - 'llm_display_description'
          - 'llm_display_description_word_count'
          - 'llm_prompt_version')
        || jsonb_build_object(
          'information_agent_verified_facts',
          coalesce(sale.raw_payload->'information_agent_verified_facts', '{}'::jsonb)
            || jsonb_build_object(
              v_fact.fact_key,
              jsonb_build_object(
                'value', v_fact.proposed_value,
                'display_value', v_fact.display_value,
                'fact_id', v_fact.id,
                'evidence_asset_id', v_fact.evidence_asset_id,
                'source_page', v_fact.source_page,
                'reviewed_at', case when p_actor_kind = 'admin' then v_now end,
                'source', 'professional_email',
                'publication_mode', v_publication_mode,
                'received_at', v_received_at
              )
            )
        )
      ),
      updated_at = v_now
  where sale.id = v_fact.sale_id;

  if v_source_url is not null then
    insert into public.auction_enrichment_jobs (source_url, job_type, priority, input_hash)
    values (
      v_source_url, 'display_description', 90,
      md5(
        jsonb_build_object(
          'fingerprint_version', 1,
          'source', 'information-agent',
          'fact_id', v_fact.id,
          'case_id', v_fact.case_id,
          'message_id', v_fact.message_id,
          'sale_id', v_fact.sale_id,
          'fact_key', v_fact.fact_key,
          'proposed_value', v_fact.proposed_value,
          'display_value', v_fact.display_value,
          'evidence_excerpt', v_fact.evidence_excerpt,
          'evidence_asset_id', v_fact.evidence_asset_id,
          'source_page', v_fact.source_page,
          'source_locator', v_fact.source_locator,
          'confidence', v_fact.confidence,
          'extraction_method', v_fact.extraction_method,
          'metadata', v_fact.metadata
        )::text
      )
    )
    on conflict (source_url, job_type, input_hash) do nothing;
  end if;

  if v_valuation_queued then
    perform public.enqueue_auction_sale_market_estimate(
      p_auction_sale_id => v_fact.sale_id,
      p_priority => 90,
      p_reason => 'information_agent_verified_fact',
      p_now => v_now
    );
  end if;

  insert into public.information_agent_fact_publications (
    fact_id, sale_id, fact_key, previous_values, previous_provenance, new_values,
    actor_kind, actor_id, policy_version, response_received_at, published_at
  ) values (
    v_fact.id, v_fact.sale_id, v_fact.fact_key, v_previous_values, v_previous_provenance,
    v_new_values, p_actor_kind, p_actor_id, v_policy_version, v_received_at, v_now
  );

  return jsonb_build_object(
    'fact_id', p_fact_id,
    'status', 'accepted',
    'sale_id', v_fact.sale_id,
    'valuation_queued', v_valuation_queued,
    'description_queued', v_source_url is not null
  );
end;
$$;

revoke all on function app_private.apply_information_agent_fact(uuid, text, uuid, text)
  from public, anon, authenticated, service_role;

comment on function app_private.apply_information_agent_fact(uuid, text, uuid, text) is
  'Noyau de publication d''un fait accepté de l''agent d''information : écrit la fiche, raw_payload.information_agent_verified_facts et une ligne de journal. Appelé seulement par review_information_agent_fact_candidate (auteur admin).';

-- RPC administrateur : mêmes contrôles, mêmes effets, mêmes retours ; l'écriture passe par le noyau ----------
create or replace function public.review_information_agent_fact_candidate(
  p_reviewer_id uuid,
  p_fact_id uuid,
  p_decision text,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fact public.information_agent_fact_candidates%rowtype;
  v_public_url text;
  v_now timestamptz := statement_timestamp();
begin
  if p_decision not in ('accepted', 'rejected') then
    raise exception using errcode = '22023', message = 'Invalid fact review decision.';
  end if;
  if not exists (
    select 1 from public.user_profiles profile
    where profile.user_id = p_reviewer_id and profile.user_role = 'admin'
  ) then
    raise exception using errcode = '42501', message = 'Administrator review is required.';
  end if;

  select * into v_fact
  from public.information_agent_fact_candidates fact
  where fact.id = p_fact_id
  for update;

  if v_fact.id is null then
    raise exception using errcode = 'P0002', message = 'Information agent fact not found.';
  end if;
  if v_fact.status not in ('pending', 'conflict') then
    raise exception using errcode = '55000', message = 'Information agent fact was already reviewed.';
  end if;
  if p_decision = 'accepted'
    and v_fact.fact_key in ('document', 'photo')
    and not exists (
      select 1 from public.information_agent_evidence_assets asset
      where asset.id = v_fact.evidence_asset_id and asset.rights_status = 'authorized'
    )
  then
    raise exception using errcode = '55000',
      message = 'Attachment rights must be authorized before publication acceptance.';
  end if;
  if p_decision = 'accepted' and v_fact.fact_key in ('document', 'photo') then
    v_public_url := nullif(btrim(v_fact.proposed_value->>'public_url'), '');
    if v_public_url is null
      or v_public_url !~ '^https://[a-z0-9]+[.]supabase[.]co/storage/v1/object/public/information-agent-approved/'
    then
      raise exception using errcode = '55000',
        message = 'Attachment publication must be staged before acceptance.';
    end if;
  end if;

  update public.information_agent_fact_candidates fact
  set status = p_decision, reviewed_by = p_reviewer_id, reviewed_at = v_now,
      review_notes = nullif(btrim(p_notes), ''), updated_at = v_now
  where fact.id = p_fact_id;

  if v_fact.evidence_asset_id is not null and v_fact.fact_key in ('document', 'photo') then
    update public.information_agent_evidence_assets asset
    set review_status = case when p_decision = 'accepted' then 'accepted' else 'rejected' end
    where asset.id = v_fact.evidence_asset_id;
  end if;

  if p_decision = 'rejected' then
    return jsonb_build_object('fact_id', p_fact_id, 'status', 'rejected');
  end if;

  -- L'auteur réel de la décision est l'administrateur qui relit : jamais une publication automatique.
  return app_private.apply_information_agent_fact(p_fact_id, 'admin', p_reviewer_id, null);
end;
$$;

revoke all on function public.review_information_agent_fact_candidate(uuid, uuid, text, text)
from public, anon, authenticated;
grant execute on function public.review_information_agent_fact_candidate(uuid, uuid, text, text)
to service_role;

-- Pont vers auction_fact_claims : texte et méthode selon l'auteur réel ------------------------------------------
create or replace function app_private.bridge_accepted_information_agent_fact_claim()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_sale public.auction_sales%rowtype;
  v_field_key text;
  v_value_text text;
  v_value_numeric numeric;
  v_value_integer integer;
  v_value_date date;
  v_value_jsonb jsonb;
  v_existing_claim_id uuid;
  v_actor_kind text;
  v_policy_version text;
begin
  if new.status <> 'accepted' or old.status = 'accepted' then
    return new;
  end if;

  -- Binary evidence and free-form visit/address suggestions are accepted by
  -- the existing workflow but do not have a comparable canonical scalar in
  -- auction_sales. They remain represented by the reviewed candidate and its
  -- evidence trail; they must not be mislabelled as a fiche fact claim.
  v_field_key := case new.fact_key
    when 'surface_m2' then 'property.surface_m2'
    when 'land_surface_m2' then 'property.land_surface_m2'
    when 'rooms_count' then 'property.rooms_count'
    when 'occupancy_status' then 'property.occupancy_status'
    when 'starting_price_eur' then 'sale.starting_price_eur'
    when 'sale_date' then 'sale.sale_date'
    when 'property_type' then 'property.property_type'
    else null
  end;
  if v_field_key is null then
    return new;
  end if;

  -- Auteur réel de la publication, lu au journal écrit par le noyau dans la même transaction. Sans
  -- ligne (écriture directe du statut), le pont garde son exigence d'un relecteur administrateur.
  select publication.actor_kind, publication.policy_version
  into v_actor_kind, v_policy_version
  from public.information_agent_fact_publications publication
  where publication.fact_id = new.id
  order by publication.published_at desc, publication.id desc
  limit 1;
  v_actor_kind := coalesce(v_actor_kind, 'admin');

  select sale.* into v_sale
  from public.auction_sales sale
  where sale.id = new.sale_id
  for update;

  if v_sale.id is null then
    raise exception using
      errcode = 'P0002',
      message = 'Cannot bridge an information-agent fact without its sale.';
  end if;

  if v_actor_kind = 'auto' then
    -- Une claim acceptée exige une provenance (created_by, source...) que la publication automatique
    -- n'a pas encore : refus explicite plutôt qu'une claim attribuée à tort. À définir avec le mode
    -- automatique ; les textes de la claim ci-dessous sont déjà prévus.
    raise exception using
      errcode = '55000',
      message = 'Automatic information-agent publications have no fact-claim provenance yet.';
  end if;

  if new.reviewed_by is null then
    raise exception using
      errcode = '42501',
      message = 'Accepted information-agent facts require a reviewer identity.';
  end if;

  if not exists (
    select 1
    from public.user_profiles profile
    where profile.user_id = new.reviewed_by
      and profile.user_role = 'admin'
  ) then
    raise exception using
      errcode = '42501',
      message = 'Accepted information-agent facts require an administrator reviewer.';
  end if;

  v_value_text := nullif(btrim(new.proposed_value->>'value'), '');
  if v_value_text is null then
    raise exception using
      errcode = '23514',
      message = 'Accepted information-agent facts require a scalar value.';
  end if;

  -- Recheck the post-review canonical value. The checks intentionally use
  -- IS DISTINCT FROM so that NULL never counts as an accepted match.
  if new.fact_key = 'surface_m2' then
    v_value_numeric := v_value_text::numeric;
    if v_value_numeric <= 0 or v_value_numeric > 1000000
      or v_sale.surface_m2 is distinct from v_value_numeric
      or v_sale.app_surface_m2 is distinct from v_value_numeric then
      raise exception using
        errcode = '55000',
        message = 'Accepted information-agent surface does not match the canonical sale.';
    end if;
    v_value_jsonb := to_jsonb(v_value_numeric);
  elsif new.fact_key = 'land_surface_m2' then
    v_value_numeric := v_value_text::numeric;
    if v_value_numeric <= 0 or v_value_numeric > 100000000
      or v_sale.land_surface_m2 is distinct from v_value_numeric then
      raise exception using
        errcode = '55000',
        message = 'Accepted information-agent land surface does not match the canonical sale.';
    end if;
    v_value_jsonb := to_jsonb(v_value_numeric);
  elsif new.fact_key = 'rooms_count' then
    v_value_integer := v_value_text::integer;
    if v_value_integer < 1 or v_value_integer > 100
      or v_sale.rooms_count is distinct from v_value_integer then
      raise exception using
        errcode = '55000',
        message = 'Accepted information-agent room count does not match the canonical sale.';
    end if;
    v_value_jsonb := to_jsonb(v_value_integer);
  elsif new.fact_key = 'occupancy_status' then
    if v_sale.occupancy_status is distinct from v_value_text then
      raise exception using
        errcode = '55000',
        message = 'Accepted information-agent occupancy does not match the canonical sale.';
    end if;
    v_value_jsonb := to_jsonb(v_value_text);
  elsif new.fact_key = 'starting_price_eur' then
    v_value_numeric := v_value_text::numeric;
    if v_value_numeric <= 0 or v_value_numeric > 1000000000
      or v_sale.starting_price_eur is distinct from v_value_numeric then
      raise exception using
        errcode = '55000',
        message = 'Accepted information-agent price does not match the canonical sale.';
    end if;
    v_value_jsonb := to_jsonb(v_value_numeric);
  elsif new.fact_key = 'sale_date' then
    v_value_date := v_value_text::date;
    if v_sale.sale_date is null
      or v_sale.sale_date::date is distinct from v_value_date then
      raise exception using
        errcode = '55000',
        message = 'Accepted information-agent sale date does not match the canonical sale.';
    end if;
    v_value_jsonb := to_jsonb(v_sale.sale_date);
  elsif new.fact_key = 'property_type' then
    if v_sale.property_type is distinct from v_value_text then
      raise exception using
        errcode = '55000',
        message = 'Accepted information-agent property type does not match the canonical sale.';
    end if;
    v_value_jsonb := to_jsonb(v_value_text);
  end if;

  -- A retry or a duplicate status write must never create a second accepted
  -- observation for the same reviewed response.
  select claim.id into v_existing_claim_id
  from public.auction_fact_claims claim
  where claim.evidence_locator->>'information_agent_fact_id' = new.id::text
  limit 1;
  if v_existing_claim_id is not null then
    return new;
  end if;

  insert into public.auction_fact_claims (
    auction_sale_id,
    field_key,
    value_jsonb,
    claim_status,
    evidence_kind,
    evidence_locator,
    confidence_score,
    extractor_name,
    extractor_version,
    captured_at,
    created_by,
    resolution_actor_type,
    resolution_actor_id,
    resolution_note,
    resolved_at
  ) values (
    new.sale_id,
    v_field_key,
    v_value_jsonb,
    'accepted',
    case
      when new.evidence_asset_id is null then
        case when v_actor_kind = 'admin' then 'manual_review' else 'other' end
      when exists (
        select 1
        from public.information_agent_evidence_assets asset
        where asset.id = new.evidence_asset_id
          and asset.provider_attachment_id like 'portal:%'
      ) then 'portal_upload'
      else 'email_attachment'
    end,
    jsonb_build_object(
      'information_agent_fact_id', new.id,
      'case_id', new.case_id,
      'message_id', new.message_id,
      'evidence_asset_id', new.evidence_asset_id,
      'fact_key', new.fact_key,
      'source_page', new.source_page,
      'source_locator', left(new.source_locator, 300)
    ),
    greatest(least(new.confidence, 1), 0),
    'information_agent',
    coalesce(nullif(btrim(new.extraction_method), ''), 'reviewed_v1'),
    coalesce(new.created_at, statement_timestamp()),
    case when v_actor_kind = 'admin' then new.reviewed_by end,
    case when v_actor_kind = 'admin' then 'human' else 'agent' end,
    case when v_actor_kind = 'admin' then new.reviewed_by end,
    case
      when v_actor_kind = 'admin' then coalesce(
        nullif(btrim(new.review_notes), ''),
        'Réponse reçue et validée par un administrateur.'
      )
      else 'Réponse reçue et publiée automatiquement, sans relecture humaine (politique '
        || coalesce(v_policy_version, 'inconnue') || ').'
    end,
    coalesce(new.reviewed_at, statement_timestamp())
  );

  return new;
end;
$function$;

revoke all on function app_private.bridge_accepted_information_agent_fact_claim()
from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
