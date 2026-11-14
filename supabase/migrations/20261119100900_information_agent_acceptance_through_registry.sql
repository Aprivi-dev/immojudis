begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Agent d'information, lot C du 14/11/2026, point T4 (palliatif choisi par le propriétaire : passer par le
-- registre des pièces). « Accepter et mettre à jour la fiche » écrivait les colonnes de la fiche sans les tenir :
-- la collecte suivante pouvait écraser la valeur acceptée, et l'observation créée par le pont n'avait aucune
-- décision au journal. Désormais, pour un champ que le registre tient :
--   * le noyau de publication n'écrit plus ses colonnes : il garde son journal, la trace de raw_payload
--     (information_agent_verified_facts, lue par la mention publique), les tâches de description et d'estimation ;
--   * le pont crée l'observation sans exiger que la fiche porte déjà la valeur ;
--   * l'application enregistre aussitôt la décision d'acceptation de l'administrateur, avec SON jeton (la fonction
--     publique d'acceptation du registre, lot R2b) : la projection écrit les colonnes et les tient (retenue), et la
--     décision figure au journal du registre. Le bloc « annonce » de la première prise est alors la vraie valeur
--     de l'annonce, et non celle de l'avocat : un retrait ou une opposition rend bien l'annonce.
-- Aucune fonction de la base n'appelle la décision (invariant registry-rpc-actor-from-jwt : l'auteur est celui du
-- jeton, rien n'enveloppe les fonctions de décision). Si l'application ne peut pas enregistrer la décision (vente
-- occupée par un import, refus du registre), le fait reste accepté, l'observation attend sa décision dans
-- « Observations à décider » (vente choisie), et la fiche garde la valeur de l'annonce : rien n'est affiché sans
-- décision.
--
-- 1. app_private.information_agent_fact_registry_field(clé) : la clé du fait de l'agent et le champ d'observation
--    du registre, lue par le noyau, par la fonction suivante et par la mention. Le pont garde sa propre copie (son
--    texte est vérifié par le test 374) ; le test de concordance de l'application compare les deux copies.
-- 2. app_private.information_agent_fact_held_by_registry(clé) : le registre tient-il ce champ pour une réponse
--    d'avocat ? Lu dans ses données (auction_fact_fields.hold_enabled, droit de tenir de l'origine « email
--    d'avocat », celle que le classement des observations donne au pont). Un champ que le registre ne tient pas
--    (mise à prix, date de vente, type de bien, ou champ dont la retenue est coupée) garde l'écriture d'avant.
-- 3. app_private.apply_information_agent_fact : redéfinition complète (20261114100000), avec ces changements :
--      * champ tenu par le registre : aucune colonne de la fiche n'est écrite ; new_values du journal porte
--        {"fact_registry": {"field_key": …, "value": …}} ;
--      * occupation : seules les valeurs que le registre peut tenir sont acceptées (vacant, occupied, rented :
--        jamais qui occupe ni pourquoi, plan du 11/11/2026, section 6, choix 5). « owner_occupied », « squatted »
--        et « unknown » sont refusés (22023), avec un message qui le dit ;
--      * pièce publiée : son libellé public (auction_documents.label) n'est plus le nom du fichier d'origine, qui
--        peut nommer des personnes, mais « Pièce transmise par l'avocat poursuivant le JJ/MM/AAAA » (« Pièce
--        transmise le … » pour un autre destinataire ou un autre expéditeur, sans date si la réception n'est pas
--        connue ; le type reste dans document_type), demande de juridique-rgpd du 14/11/2026. Procès-verbal
--        descriptif et bail sont refusés (22023) : ils nomment les occupants ou le débiteur. Les pièces déjà
--        publiées gardent leur libellé : aucune réparation ici (règle T17), voir le runbook de l'agent, section du
--        lot C, pour la mesure et la reprise ;
--      * attribution : raw_payload ne porte « source_lawyer » que si l'expéditeur de la réponse est le contact
--        sollicité (metadata.sender_matches_recipient) ; sinon « unverified_sender », jamais de mention. Le journal
--        de l'agent garde le destinataire du dossier.
-- 4. app_private.bridge_accepted_information_agent_fact_claim : redéfinition complète (20261114100000). Pour un
--    champ tenu, l'observation est créée sans comparer la fiche (la projection l'écrira) ; sa valeur doit être
--    une valeur que le registre peut tenir. Les autres champs gardent le contrôle « la fiche porte la valeur ».
-- 5. app_private.get_public_sale_lawyer_fact_sources : redéfinition complète (20261114100000). Une surface tenue par
--    le registre porte le libellé neutre « fact_registry » : elle garde sa mention, comme une surface écrite par
--    l'ancien noyau. Toute mention exige désormais que l'observation du pont pour ce fait soit encore acceptée au
--    journal du registre et, pour un champ tenu, que la fiche tienne cette observation : une opposition ou un
--    retrait efface la mention, même si la valeur affichée est restée la même. Un fait accepté avant ce lot, sans
--    décision au journal, n'a plus de mention (sa valeur reste affichée).
-- 6. public.forget_information_agent_verified_facts(dossiers) : l'effacement RGPD d'un professionnel retire de
--    raw_payload les entrées des faits de ses dossiers, avant de supprimer ces dossiers (service_role seulement).
--
-- Aucune donnée n'est réécrite. Les deux fonctions de la correspondance ne sont exécutables par aucun rôle de
-- l'API ; celle de l'effacement par service_role seul ; les fonctions redéfinies gardent leurs droits.
--
-- Verrous : remplacement et création de fonctions seulement. Aucun verrou de table. Possible pendant un import.
--
-- Retour arrière (aucune donnée à reprendre ; les décisions déjà écrites restent au journal, en ajout seul) :
-- déployer d'abord le code de l'application qui n'enregistre plus la décision après l'acceptation, puis, dans une
-- transaction, recréer app_private.apply_information_agent_fact, app_private.bridge_accepted_information_agent_fact_claim
-- et app_private.get_public_sale_lawyer_fact_sources dans leur définition de 20261114100000, puis supprimer
-- public.forget_information_agent_verified_facts(uuid[]) (et son appel dans l'effacement),
-- app_private.information_agent_fact_held_by_registry(text) et app_private.information_agent_fact_registry_field(text).

-- 1. Correspondance clé du fait → champ d'observation ----------------------------------------------------------------
-- Pièce jointe, visite, adresse, diagnostics : aucune valeur comparable d'une colonne de la fiche (nul).
create or replace function app_private.information_agent_fact_registry_field(p_fact_key text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_fact_key
    when 'surface_m2' then 'property.surface_m2'
    when 'land_surface_m2' then 'property.land_surface_m2'
    when 'rooms_count' then 'property.rooms_count'
    when 'occupancy_status' then 'property.occupancy_status'
    when 'starting_price_eur' then 'sale.starting_price_eur'
    when 'sale_date' then 'sale.sale_date'
    when 'property_type' then 'property.property_type'
    else null
  end;
$$;

comment on function app_private.information_agent_fact_registry_field(text) is
  'Agent d''information : champ d''observation du registre des pièces d''un fait de l''agent (nul sans colonne comparable). Même correspondance que le pont (copie comparée par le test de concordance de l''application).';

revoke all on function app_private.information_agent_fact_registry_field(text)
  from public, anon, authenticated, service_role;

-- 2. Le registre tient-il ce champ pour une réponse d'avocat ? -------------------------------------------------------
create or replace function app_private.information_agent_fact_held_by_registry(p_fact_key text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.auction_fact_fields field
    join public.auction_fact_source_precedence precedence on precedence.field_key = field.field_key
    where field.field_key = app_private.information_agent_fact_registry_field(p_fact_key)
      and field.hold_enabled
      -- Origine que le classement des observations (fact_claim_source_kind) donne à une observation du pont.
      and precedence.source_kind = 'lawyer_email'
      and precedence.can_hold
  );
$$;

comment on function app_private.information_agent_fact_held_by_registry(text) is
  'Agent d''information : le registre des pièces tient-il le champ de ce fait pour une réponse d''avocat (champ tenable, origine « email d''avocat » qui peut tenir) ? Vrai : le noyau n''écrit pas la fiche, la décision de l''administrateur et la projection le font.';

revoke all on function app_private.information_agent_fact_held_by_registry(text)
  from public, anon, authenticated, service_role;

-- 3. Noyau de publication --------------------------------------------------------------------------------------------
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
  v_document_label text;
  v_now timestamptz := statement_timestamp();
  v_valuation_queued boolean := false;
  v_publication_mode text;
  v_policy_version text := nullif(btrim(p_policy_version), '');
  v_received_at timestamptz;
  v_recipient_kind text;
  v_sender_matches boolean;
  v_attributed_kind text;
  v_previous_fact jsonb;
  v_previous_values jsonb := '{}'::jsonb;
  v_previous_provenance jsonb := '{}'::jsonb;
  v_new_values jsonb := '{}'::jsonb;
  -- Champ que le registre des pièces tient : ses colonnes sont écrites par la projection, après la décision.
  v_held boolean;
  v_registry_field text;
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

  -- Date de réception de la réponse, quand elle est connue (jamais l'expéditeur ni l'objet), et accord de
  -- l'expéditeur avec le contact sollicité (lecture de la réponse ; déclaré sur le portail).
  select coalesce(
    message.received_at,
    case when message.direction = 'inbound' then message.created_at end
  ),
  coalesce(message.metadata->>'sender_matches_recipient' = 'true', false)
  into v_received_at, v_sender_matches
  from public.information_agent_messages message
  where message.id = v_fact.message_id;

  -- Destinataire du dossier : seul « source_lawyer » est l'avocat poursuivant.
  select case_row.recipient_kind into v_recipient_kind
  from public.information_agent_cases case_row
  where case_row.id = v_fact.case_id;
  if v_recipient_kind is null then
    raise exception using errcode = 'P0002', message = 'Information agent case not found.';
  end if;
  -- Une réponse n'est attribuée à l'avocat poursuivant (mention de la fiche, libellé d'une pièce) que si son
  -- expéditeur est le contact sollicité. Expéditeur différent, réponse consignée à la main (téléphone,
  -- courrier) : « unverified_sender » dans raw_payload, jamais de mention. Le journal garde le destinataire du
  -- dossier.
  v_attributed_kind := case
    when v_recipient_kind = 'source_lawyer' and not coalesce(v_sender_matches, false) then 'unverified_sender'
    else v_recipient_kind
  end;

  select * into v_sale
  from public.auction_sales sale where sale.id = v_fact.sale_id
  for update;
  v_source_url := v_sale.source_url;
  v_value_text := nullif(btrim(v_fact.proposed_value->>'value'), '');
  v_registry_field := app_private.information_agent_fact_registry_field(v_fact.fact_key);
  v_held := app_private.information_agent_fact_held_by_registry(v_fact.fact_key);

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
    if v_held then
      v_new_values := jsonb_build_object('fact_registry', jsonb_build_object(
        'field_key', v_registry_field, 'value', v_value_numeric
      ));
    else
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
    end if;
    v_valuation_queued := true;
  elsif v_fact.fact_key = 'land_surface_m2' then
    v_value_numeric := v_value_text::numeric;
    if v_value_numeric <= 0 or v_value_numeric > 100000000 then
      raise exception using errcode = '22023', message = 'Invalid accepted land surface.';
    end if;
    v_previous_values := jsonb_build_object('land_surface_m2', v_sale.land_surface_m2);
    if v_held then
      v_new_values := jsonb_build_object('fact_registry', jsonb_build_object(
        'field_key', v_registry_field, 'value', v_value_numeric
      ));
    else
      update public.auction_sales sale set land_surface_m2 = v_value_numeric, updated_at = v_now
      where sale.id = v_fact.sale_id;
      v_new_values := jsonb_build_object('land_surface_m2', v_value_numeric);
    end if;
    v_valuation_queued := true;
  elsif v_fact.fact_key = 'rooms_count' then
    v_value_integer := v_value_text::integer;
    if v_value_integer < 1 or v_value_integer > 100 then
      raise exception using errcode = '22023', message = 'Invalid accepted room count.';
    end if;
    v_previous_values := jsonb_build_object('rooms_count', v_sale.rooms_count);
    if v_held then
      v_new_values := jsonb_build_object('fact_registry', jsonb_build_object(
        'field_key', v_registry_field, 'value', v_value_integer
      ));
    else
      update public.auction_sales sale set rooms_count = v_value_integer, updated_at = v_now
      where sale.id = v_fact.sale_id;
      v_new_values := jsonb_build_object('rooms_count', v_value_integer);
    end if;
    v_valuation_queued := true;
  elsif v_fact.fact_key = 'occupancy_status' then
    -- Une seule définition de l'occupation affichable : celle du registre (libre, occupé, loué). Qui occupe et
    -- pourquoi (owner_occupied, squatted) ne s'affichent jamais, ni une occupation inconnue.
    if v_value_text is null
      or app_private.sale_field_claim_value('property.occupancy_status', to_jsonb(v_value_text)) is null
    then
      raise exception using errcode = '22023',
        message = 'Occupancy status cannot be displayed: only vacant, occupied or rented can be accepted.';
    end if;
    v_previous_values := jsonb_build_object('occupancy_status', v_sale.occupancy_status);
    if v_held then
      v_new_values := jsonb_build_object('fact_registry', jsonb_build_object(
        'field_key', v_registry_field, 'value', v_value_text
      ));
    else
      update public.auction_sales sale set occupancy_status = v_value_text, updated_at = v_now
      where sale.id = v_fact.sale_id;
      v_new_values := jsonb_build_object('occupancy_status', v_value_text);
    end if;
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
    -- Procès-verbal descriptif, bail : ils nomment les occupants ou le débiteur. Jamais publiés (juridique-rgpd,
    -- 14/11/2026).
    if v_document_kind in ('pv_huissier', 'bail') then
      raise exception using errcode = '22023',
        message = 'This document cannot be published: a descriptive report or a lease names the occupants or the debtor.';
    end if;
    -- Libellé public neutre : qui l'a transmise et quand, sans date si la réception n'est pas connue. Jamais le nom
    -- du fichier d'origine, qui peut nommer des personnes (« PV_Me_X_saisie_Y.pdf »), ni le type : la fiche lit
    -- document_type et l'affiche avec son propre libellé. « Par l'avocat poursuivant » seulement quand la réponse
    -- lui est attribuée (expéditeur égal au contact sollicité).
    v_document_label := case when v_attributed_kind = 'source_lawyer'
        then 'Pièce transmise par l''avocat poursuivant'
        else 'Pièce transmise'
      end
      || case when v_received_at is null then ''
        else ' le ' || to_char(v_received_at at time zone 'Europe/Paris', 'DD/MM/YYYY')
      end;
    -- Pièce remplacée, s'il y en avait une à la même adresse : son type et son chemin seulement (ni nom
    -- de fichier d'origine, ni contenu brut).
    select jsonb_build_object('auction_documents', jsonb_build_object(
      'document_type', document.document_type,
      'file_path', document.file_path
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
      v_document_label,
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
                'received_at', v_received_at,
                'recipient_kind', v_attributed_kind
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
    actor_kind, actor_id, policy_version, response_received_at, recipient_kind, published_at
  ) values (
    v_fact.id, v_fact.sale_id, v_fact.fact_key, v_previous_values, v_previous_provenance,
    v_new_values, p_actor_kind, p_actor_id, v_policy_version, v_received_at, v_recipient_kind, v_now
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
  'Noyau de publication d''un fait accepté de l''agent d''information : raw_payload.information_agent_verified_facts, une ligne de journal, et la fiche pour un champ que le registre des pièces ne tient pas (un champ tenu est écrit par la décision de l''administrateur et la projection). Occupation : libre, occupé ou loué seulement. Appelé seulement par review_information_agent_fact_candidate (auteur admin).';

-- 4. Pont vers auction_fact_claims ---------------------------------------------------------------------------------
create or replace function app_private.bridge_accepted_information_agent_fact_claim()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_sale public.auction_sales%rowtype;
  v_field_key text;
  v_held boolean;
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
  -- Même correspondance que app_private.information_agent_fact_registry_field (le test de concordance de
  -- l'application compare les deux copies à la sienne).
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
  -- Champ tenu par le registre : la fiche ne porte pas encore la valeur, la décision de l'administrateur et la
  -- projection l'y mettront.
  v_held := app_private.information_agent_fact_held_by_registry(new.fact_key);

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

  -- Recheck the post-review canonical value of a field that the registry does
  -- not hold. The checks intentionally use IS DISTINCT FROM so that NULL never
  -- counts as an accepted match.
  if new.fact_key = 'surface_m2' then
    v_value_numeric := v_value_text::numeric;
    if v_value_numeric <= 0 or v_value_numeric > 1000000
      or (not v_held and (
        v_sale.surface_m2 is distinct from v_value_numeric
        or v_sale.app_surface_m2 is distinct from v_value_numeric
      )) then
      raise exception using
        errcode = '55000',
        message = 'Accepted information-agent surface does not match the canonical sale.';
    end if;
    v_value_jsonb := to_jsonb(v_value_numeric);
  elsif new.fact_key = 'land_surface_m2' then
    v_value_numeric := v_value_text::numeric;
    if v_value_numeric <= 0 or v_value_numeric > 100000000
      or (not v_held and v_sale.land_surface_m2 is distinct from v_value_numeric) then
      raise exception using
        errcode = '55000',
        message = 'Accepted information-agent land surface does not match the canonical sale.';
    end if;
    v_value_jsonb := to_jsonb(v_value_numeric);
  elsif new.fact_key = 'rooms_count' then
    v_value_integer := v_value_text::integer;
    if v_value_integer < 1 or v_value_integer > 100
      or (not v_held and v_sale.rooms_count is distinct from v_value_integer) then
      raise exception using
        errcode = '55000',
        message = 'Accepted information-agent room count does not match the canonical sale.';
    end if;
    v_value_jsonb := to_jsonb(v_value_integer);
  elsif new.fact_key = 'occupancy_status' then
    if not v_held and v_sale.occupancy_status is distinct from v_value_text then
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

  -- Champ tenu : l'observation doit porter une valeur que le registre peut tenir (sinon sa décision serait
  -- refusée et la réponse acceptée ne s'afficherait jamais).
  if v_held and app_private.sale_field_claim_value(v_field_key, v_value_jsonb) is null then
    raise exception using
      errcode = '23514',
      message = 'Accepted information-agent value cannot be held by the fact registry.';
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

-- 5. Projection publique de la source « avocat poursuivant » ---------------------------------------------------------
-- Une ligne par clé affichée sur la fiche dont la valeur actuelle est encore celle transmise. La date est
-- celle de la réception de la réponse (raw_payload pour les publications de cette étape, sinon le
-- message s'il est encore conservé) ; sans date connue, pas de ligne. Les conversions sont gardées par
-- des CASE : une valeur mal formée dans raw_payload ne fait jamais échouer la lecture.
-- Lot C (juridique-rgpd et relecture du 14/11/2026) : la valeur n'est attribuée à l'avocat que si l'observation
-- créée par le pont pour ce fait est encore acceptée (dernière décision au journal du registre) et, pour un champ
-- que le registre tient, si la fiche tient cette observation-là. Opposition, retrait, décision jamais écrite, autre
-- pièce retenue : plus de mention, même quand la valeur affichée n'a pas changé (confirmation identique à
-- l'annonce, mise à prix, date ou type de bien que le registre ne rétablit pas).
create or replace function app_private.get_public_sale_lawyer_fact_sources(p_sale_id uuid)
returns table (fact_key text, received_on date, publication_mode text)
language sql
stable
security definer
set search_path = ''
as $function$
  with entries as (
    select
      s.id as sale_id,
      s.app_surface_m2,
      s.surface_source,
      s.land_surface_m2,
      s.rooms_count,
      s.occupancy_status,
      s.starting_price_eur,
      s.sale_date,
      s.property_type,
      s.held_fields -> app_private.information_agent_fact_registry_field(entry.key) as held_entry,
      entry.key as fact_key,
      nullif(btrim(entry.value #>> '{value,value}'), '') as value_text,
      coalesce(entry.value->>'publication_mode', 'manual') as publication_mode,
      entry.value->>'recipient_kind' as payload_recipient_kind,
      case
        when entry.value->>'received_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}'
          then (entry.value->>'received_at')::timestamptz
      end as payload_received_at,
      case
        when entry.value->>'fact_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then (entry.value->>'fact_id')::uuid
      end as fact_id
    from public.auction_sales s
    cross join lateral jsonb_each(
      case
        when jsonb_typeof(s.raw_payload->'information_agent_verified_facts') = 'object'
          then s.raw_payload->'information_agent_verified_facts'
        else '{}'::jsonb
      end
    ) entry
    where s.id = p_sale_id
      and app_private.auction_sale_is_publicly_visible(s.id)
      and jsonb_typeof(entry.value) = 'object'
      and entry.key in (
        'surface_m2', 'land_surface_m2', 'rooms_count', 'occupancy_status',
        'starting_price_eur', 'sale_date', 'property_type'
      )
  ),
  dated as (
    select
      entries.*,
      coalesce(
        entries.payload_received_at,
        message.received_at,
        case when message.direction = 'inbound' then message.created_at end
      ) as received_at,
      coalesce(entries.payload_recipient_kind, case_row.recipient_kind) as recipient_kind
    from entries
    left join public.information_agent_fact_candidates fact
      on fact.id = entries.fact_id
      and fact.sale_id = entries.sale_id
      and fact.status = 'accepted'
    left join public.information_agent_messages message on message.id = fact.message_id
    left join public.information_agent_cases case_row on case_row.id = fact.case_id
  ),
  -- L'observation du pont pour ce fait, si sa dernière décision est une acceptation.
  decided as (
    select dated.*, claim.id as claim_id
    from dated
    join public.auction_fact_claims claim
      on claim.evidence_locator ? 'information_agent_fact_id'
      and claim.evidence_locator->>'information_agent_fact_id' = dated.fact_id::text
      and claim.auction_sale_id = dated.sale_id
    cross join lateral (
      select decision.decision
      from public.auction_fact_claim_decisions decision
      where decision.claim_id = claim.id
      order by decision.seq desc
      limit 1
    ) last
    where last.decision = 'accepted'
  )
  select
    decided.fact_key,
    (decided.received_at at time zone 'Europe/Paris')::date as received_on,
    decided.publication_mode
  from decided
  where decided.received_at is not null
    -- Seule une réponse à un dossier adressé à l'avocat poursuivant, dont l'expéditeur est le contact sollicité,
    -- lui est attribuée ; sans cette information (dossier purgé d'un fait antérieur à la migration), aucune mention.
    and decided.recipient_kind = 'source_lawyer'
    and decided.publication_mode in ('manual', 'auto')
    and decided.value_text is not null
    -- Champ tenu par le registre : la fiche tient cette observation-là.
    and (
      not app_private.information_agent_fact_held_by_registry(decided.fact_key)
      or (
        decided.held_entry->>'state' = 'held'
        and decided.held_entry->>'claim_id' = decided.claim_id::text
      )
    )
    and case decided.fact_key
      when 'surface_m2' then
        -- La même valeur réécrite depuis l'annonce change la provenance : plus de mention. Une surface tenue
        -- par le registre des pièces porte le libellé neutre « fact_registry » (lot C du 14/11/2026).
        decided.surface_source in ('information_agent_verified', 'fact_registry')
        and decided.app_surface_m2 = case
          when decided.value_text ~ '^[0-9]{1,9}([.][0-9]{1,4})?$' then decided.value_text::numeric
        end
      when 'land_surface_m2' then
        decided.land_surface_m2 = case
          when decided.value_text ~ '^[0-9]{1,9}([.][0-9]{1,4})?$' then decided.value_text::numeric
        end
      when 'rooms_count' then
        decided.rooms_count = case
          when decided.value_text ~ '^[0-9]{1,3}$' then decided.value_text::integer
        end
      when 'occupancy_status' then decided.occupancy_status = decided.value_text
      when 'starting_price_eur' then
        decided.starting_price_eur = case
          when decided.value_text ~ '^[0-9]{1,10}([.][0-9]{1,2})?$' then decided.value_text::numeric
        end
      when 'sale_date' then
        decided.sale_date::date = case
          when decided.value_text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then decided.value_text::date
        end
      when 'property_type' then decided.property_type = decided.value_text
      else false
    end
  order by decided.fact_key;
$function$;

revoke all on function app_private.get_public_sale_lawyer_fact_sources(uuid)
  from public, anon, authenticated;
grant execute on function app_private.get_public_sale_lawyer_fact_sources(uuid)
  to anon, authenticated, service_role;

-- 6. Effacement RGPD d'un professionnel ----------------------------------------------------------------------------
-- Retire de raw_payload.information_agent_verified_facts les entrées des faits de ses dossiers (date de réception,
-- destinataire, valeur transmise) : la mention publique disparaît avec elles. Appelée par le code de l'effacement
-- (src/lib/information-agent-professional-rights.ts) avant la suppression des dossiers, qui emporte les faits.
-- Rend le nombre de ventes réécrites. Les valeurs affichées ne changent pas : leur retrait passe par le registre
-- (runbook de l'agent, section du lot C).
create or replace function public.forget_information_agent_verified_facts(p_case_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_count integer;
begin
  if p_case_ids is null or cardinality(p_case_ids) = 0 then
    return 0;
  end if;

  with facts as (
    select fact.id::text as fact_id, fact.sale_id
    from public.information_agent_fact_candidates fact
    where fact.case_id = any(p_case_ids)
  )
  update public.auction_sales sale
  set raw_payload = jsonb_set(
        sale.raw_payload,
        '{information_agent_verified_facts}',
        coalesce((
          select jsonb_object_agg(entry.key, entry.value)
          from jsonb_each(sale.raw_payload->'information_agent_verified_facts') entry
          where not exists (
            select 1 from facts where facts.fact_id = entry.value->>'fact_id'
          )
        ), '{}'::jsonb)
      ),
      updated_at = statement_timestamp()
  where sale.id in (select facts.sale_id from facts)
    and exists (
      select 1
      from jsonb_each(
        case
          when jsonb_typeof(sale.raw_payload->'information_agent_verified_facts') = 'object'
            then sale.raw_payload->'information_agent_verified_facts'
          else '{}'::jsonb
        end
      ) entry
      where exists (select 1 from facts where facts.fact_id = entry.value->>'fact_id')
    );
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

comment on function public.forget_information_agent_verified_facts(uuid[]) is
  'Effacement RGPD d''un professionnel : retire de raw_payload.information_agent_verified_facts les entrées des faits de ses dossiers (la mention publique disparaît). Serveur seulement, appelée avant la suppression des dossiers.';

revoke all on function public.forget_information_agent_verified_facts(uuid[])
  from public, anon, authenticated;
grant execute on function public.forget_information_agent_verified_facts(uuid[]) to service_role;

notify pgrst, 'reload schema';

commit;
