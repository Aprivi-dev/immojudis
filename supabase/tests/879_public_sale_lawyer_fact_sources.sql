-- 20261114100000 : source « avocat poursuivant » sur la fiche publique (proposition 5).
--   * la fonction publique est accessible sans compte ; la lecture est SECURITY DEFINER à search_path vide,
--     l'enveloppe publique SECURITY INVOKER ;
--   * la sortie se limite à la clé, au jour de réception et au mode : ni valeur, ni extrait, ni expéditeur,
--     ni objet, ni identifiant de fait ;
--   * une clé n'est rendue que si la valeur affichée est encore celle transmise ;
--   * les faits acceptés avant la migration (sans publication_mode ni received_at) sont rendus en « manual »
--     avec la date de réception du message ; depuis le lot C, une entrée « auto » sans observation n'a aucune mention ;
--   * une vente hors du catalogue public ne rend rien ;
--   * seule la réponse à un dossier adressé à l'avocat poursuivant (recipient_kind = 'source_lawyer') lui est
--     attribuée ; sans cette information, aucune mention (échec fermé) ;
--   * une surface réécrite depuis l'annonce (même valeur, autre provenance) perd sa mention.
begin;

-- Jours de réception lus dans un fuseau fixe pour la session (la fonction, elle, compte en heure de Paris).
set local timezone = 'UTC';

select plan(17);

-- Le contrat ---------------------------------------------------------------------------------------------------
select has_function('public', 'get_public_sale_lawyer_fact_sources', array['uuid'], 'the public RPC exists');
select is(
  pg_get_function_result('public.get_public_sale_lawyer_fact_sources(uuid)'::regprocedure),
  'TABLE(fact_key text, received_on date, publication_mode text)',
  'the answer is limited to the key, the reception day and the publication mode'
);
select ok(
  (select prosecdef and proconfig @> array['search_path=""']::text[]
     from pg_proc where oid = 'app_private.get_public_sale_lawyer_fact_sources(uuid)'::regprocedure)
  and not (select prosecdef from pg_proc
           where oid = 'public.get_public_sale_lawyer_fact_sources(uuid)'::regprocedure)
  and (select proconfig @> array['search_path=""']::text[]
         from pg_proc where oid = 'public.get_public_sale_lawyer_fact_sources(uuid)'::regprocedure),
  'the read is security definer with an empty search_path, the wrapper security invoker'
);
select ok(
  has_function_privilege('anon', 'public.get_public_sale_lawyer_fact_sources(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.get_public_sale_lawyer_fact_sources(uuid)', 'execute')
  and not has_function_privilege('public', 'public.get_public_sale_lawyer_fact_sources(uuid)', 'execute'),
  'a visitor and an account can call it, public itself cannot'
);

-- Jeu d'essai ----------------------------------------------------------------------------------------------------
-- Lot C : retenue coupée, le noyau écrit la fiche (branche de repli) ; le chemin réel est couvert par 900.
update public.auction_fact_fields set hold_enabled = false where hold_enabled;

insert into auth.users (id) values ('87900000-0000-4000-8000-0000000000a1');
insert into public.user_profiles (user_id, email, user_role) values
  ('87900000-0000-4000-8000-0000000000a1', 'source-admin-879@example.test', 'admin')
on conflict (user_id) do update set user_role = excluded.user_role;

insert into public.auction_sales (
  id, source_name, source_url, status, sale_date, city, property_type, starting_price_eur,
  raw_payload, sale_procedure, sale_venue_type, app_surface_m2, surface_m2, land_surface_m2, rooms_count,
  occupancy_status
) values
  ('87900000-1000-4000-8000-000000000001', 'licitor', 'https://example.test/879/01', 'upcoming',
    current_timestamp + interval '20 days', 'Alphaville', 'apartment', 90000, '{}'::jsonb, '{}'::jsonb,
    'tribunal', 40, 40, 500, 2, 'unknown'),
  ('87900000-1000-4000-8000-000000000002', 'licitor', 'https://example.test/879/02', 'upcoming',
    current_timestamp + interval '21 days', 'Betaville', 'apartment', 70000,
    jsonb_build_object(
      'publication_quarantine', 'operator_hold',
      'information_agent_verified_facts', jsonb_build_object(
        'starting_price_eur', jsonb_build_object(
          'value', jsonb_build_object('value', '70000'),
          'publication_mode', 'manual', 'received_at', '2026-11-12T08:30:00+00:00',
          'recipient_kind', 'source_lawyer'))
    ),
    '{}'::jsonb, 'tribunal', null, null, null, null, null);

-- Deux dossiers sur la vente : l'avocat poursuivant, et un autre professionnel (un greffe, par exemple).
insert into public.information_agent_cases (
  id, sale_id, created_by, status, recipient_kind, recipient_email, normalized_recipient_email, subject,
  body_text, question_keys, missing_information, sent_at, replied_at
) values
  ('87900000-3000-4000-8000-000000000001', '87900000-1000-4000-8000-000000000001',
   '87900000-0000-4000-8000-0000000000a1', 'replied', 'source_lawyer', 'avocat-879@example.test',
   'avocat-879@example.test', 'Demande d''informations 879',
   'Merci de nous transmettre les informations manquantes.',
   array['surface'], array['surface'], now() - interval '3 days', now() - interval '2 days'),
  ('87900000-3000-4000-8000-000000000002', '87900000-1000-4000-8000-000000000001',
   '87900000-0000-4000-8000-0000000000a1', 'replied', 'source_contact', 'greffe-879@example.test',
   'greffe-879@example.test', 'Demande d''informations 879 bis',
   'Merci de nous transmettre les informations manquantes.',
   array['price'], array['price'], now() - interval '3 days', now() - interval '2 days');
insert into public.information_agent_missions (
  id, user_id, sale_id, case_id, status, recipient_email, subject, body_text, question_keys,
  missing_information, privacy_version
) values
  ('87900000-2000-4000-8000-000000000001', '87900000-0000-4000-8000-0000000000a1',
   '87900000-1000-4000-8000-000000000001', '87900000-3000-4000-8000-000000000001', 'sent',
   'avocat-879@example.test', 'Demande d''informations 879',
   'Merci de nous transmettre les informations manquantes.', array['surface'], array['surface'], '879-pgtap'),
  ('87900000-2000-4000-8000-000000000002', '87900000-0000-4000-8000-0000000000a1',
   '87900000-1000-4000-8000-000000000001', '87900000-3000-4000-8000-000000000002', 'sent',
   'greffe-879@example.test', 'Demande d''informations 879 bis',
   'Merci de nous transmettre les informations manquantes.', array['price'], array['price'], '879-pgtap');
insert into public.information_agent_messages (
  id, mission_id, case_id, user_id, direction, message_kind, delivery_status, subject, body_text,
  received_at, provider_message_id, metadata
) values
  ('87900000-4000-4000-8000-000000000001', '87900000-2000-4000-8000-000000000001',
   '87900000-3000-4000-8000-000000000001', '87900000-0000-4000-8000-0000000000a1',
   'inbound', 'reply', 'received', 'Re: Demande d''informations 879', 'Voici les informations demandées.',
   '2026-11-12 09:30:00+01', 'source-provider-879-1',
   '{"imported_manually": false, "sender_authentication": {"status": "pass"}, "sender_matches_recipient": true}'::jsonb),
  ('87900000-4000-4000-8000-000000000002', '87900000-2000-4000-8000-000000000002',
   '87900000-3000-4000-8000-000000000002', '87900000-0000-4000-8000-0000000000a1',
   'inbound', 'reply', 'received', 'Re: Demande d''informations 879 bis', 'La mise à prix est de 90 000 €.',
   '2026-11-12 10:30:00+01', 'source-provider-879-2',
   '{"imported_manually": false, "sender_authentication": {"status": "pass"}, "sender_matches_recipient": true}'::jsonb);
insert into public.information_agent_fact_candidates (
  id, case_id, message_id, sale_id, fact_key, proposed_value, display_value, evidence_excerpt, confidence
)
select
  fixture.id::uuid,
  '87900000-3000-4000-8000-000000000001',
  '87900000-4000-4000-8000-000000000001',
  '87900000-1000-4000-8000-000000000001',
  fixture.fact_key,
  jsonb_build_object('value', fixture.value),
  fixture.display_value,
  'Extrait confidentiel du message 879',
  0.9
from (
  values
    ('87900000-5000-4000-8000-000000000001', 'surface_m2', '54', '54 m²'),
    ('87900000-5000-4000-8000-000000000002', 'rooms_count', '3', '3 pièces'),
    ('87900000-5000-4000-8000-000000000003', 'occupancy_status', 'vacant', 'Libre'),
    ('87900000-5000-4000-8000-000000000004', 'visit_information', 'Visite le 20', 'Visite le 20'),
    ('87900000-5000-4000-8000-000000000005', 'property_type', 'apartment', 'Appartement')
) as fixture(id, fact_key, value, display_value);
-- Réponse du second dossier (pas l'avocat poursuivant) : même valeur que la fiche.
insert into public.information_agent_fact_candidates (
  id, case_id, message_id, sale_id, fact_key, proposed_value, display_value, confidence
) values (
  '87900000-5000-4000-8000-000000000006', '87900000-3000-4000-8000-000000000002',
  '87900000-4000-4000-8000-000000000002', '87900000-1000-4000-8000-000000000001',
  'starting_price_eur', '{"value": "90000"}'::jsonb, '90 000 €', 0.9
);

-- Publications par la RPC administrateur (chemin réel).
do $$
begin
  perform public.review_information_agent_fact_candidate(
    '87900000-0000-4000-8000-0000000000a1', fact.id, 'accepted', null)
  from public.information_agent_fact_candidates fact
  where fact.id in (
    '87900000-5000-4000-8000-000000000001', '87900000-5000-4000-8000-000000000002',
    '87900000-5000-4000-8000-000000000003', '87900000-5000-4000-8000-000000000004',
    '87900000-5000-4000-8000-000000000006'
  );
end;
$$;

-- Lot C : la mention exige une observation acceptée au journal du registre. Le pont est un déclencheur différé ;
-- l'administrateur, connecté, accepte ensuite les observations des faits 1, 2, 3 et 6.
set constraints all immediate;
set constraints all deferred;
create temporary table claims on commit drop as
  select claim.evidence_locator->>'information_agent_fact_id' as fact_id, claim.id as claim_id
  from public.auction_fact_claims claim
  where claim.evidence_locator->>'information_agent_fact_id' in (
    '87900000-5000-4000-8000-000000000001', '87900000-5000-4000-8000-000000000002',
    '87900000-5000-4000-8000-000000000003', '87900000-5000-4000-8000-000000000006'
  );
grant select on claims to authenticated;
create temporary table decisions (result jsonb) on commit drop;
grant insert on decisions to authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"87900000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}',
  true
);
set local role authenticated;
insert into decisions
select public.accept_auction_fact_claim(claims.claim_id, 'single_lot') from claims;
reset role;

-- Le comportement ------------------------------------------------------------------------------------------------
select results_eq(
  $$select fact_key, received_on, publication_mode
    from public.get_public_sale_lawyer_fact_sources('87900000-1000-4000-8000-000000000001')$$,
  $$values ('occupancy_status', '2026-11-12'::date, 'manual'),
           ('rooms_count', '2026-11-12'::date, 'manual'),
           ('surface_m2', '2026-11-12'::date, 'manual')$$,
  'each displayed key published from the reply of the lawyer comes out with its reception day; free text and a reply from another professional never do'
);
select ok(
  (select raw_payload->'information_agent_verified_facts'->'starting_price_eur'->>'recipient_kind'
     from public.auction_sales where id = '87900000-1000-4000-8000-000000000001') = 'source_contact',
  'the published value keeps the kind of recipient of its case'
);

update public.auction_sales set rooms_count = 5 where id = '87900000-1000-4000-8000-000000000001';
select is(
  (select array_agg(fact_key order by fact_key)
     from public.get_public_sale_lawyer_fact_sources('87900000-1000-4000-8000-000000000001')),
  array['occupancy_status', 'surface_m2'],
  'a value changed since the reply loses its mention'
);

-- Fait accepté avant la migration : ni publication_mode ni received_at, date retrouvée par le message.
update public.information_agent_fact_candidates
set status = 'accepted', reviewed_by = '87900000-0000-4000-8000-0000000000a1', reviewed_at = now()
where id = '87900000-5000-4000-8000-000000000005';
update public.auction_sales
set raw_payload = jsonb_set(
  raw_payload,
  '{information_agent_verified_facts,property_type}',
  jsonb_build_object(
    'value', jsonb_build_object('value', 'apartment'),
    'display_value', 'Appartement',
    'fact_id', '87900000-5000-4000-8000-000000000005',
    'source', 'professional_email'
  )
)
where id = '87900000-1000-4000-8000-000000000001';
-- Lot C : son observation (créée par le pont à la validation du statut) est acceptée par l'administrateur.
set constraints all immediate;
set constraints all deferred;
insert into claims
select claim.evidence_locator->>'information_agent_fact_id', claim.id
from public.auction_fact_claims claim
where claim.evidence_locator->>'information_agent_fact_id' = '87900000-5000-4000-8000-000000000005';
set local role authenticated;
insert into decisions
select public.accept_auction_fact_claim(claims.claim_id, 'single_lot')
from claims
where claims.fact_id = '87900000-5000-4000-8000-000000000005';
reset role;
select set_config('request.jwt.claims', '', true);
select ok(
  exists (
    select 1 from public.get_public_sale_lawyer_fact_sources('87900000-1000-4000-8000-000000000001')
    where fact_key = 'property_type' and received_on = '2026-11-12' and publication_mode = 'manual'
  ),
  'a fact accepted before the migration is shown as manual with the reception day of its message'
);

-- Mode « auto » (aucun chemin ne l'écrit encore : entrée posée à la main) et entrées mal formées.
update public.auction_sales
set raw_payload = raw_payload || jsonb_build_object(
  'information_agent_verified_facts',
  raw_payload->'information_agent_verified_facts' || jsonb_build_object(
    'land_surface_m2', jsonb_build_object(
      'value', jsonb_build_object('value', '500'),
      'publication_mode', 'auto', 'received_at', '2026-11-13T08:00:00+00:00',
      'recipient_kind', 'source_lawyer'),
    'starting_price_eur', jsonb_build_object(
      'value', jsonb_build_object('value', 'quatre-vingt-dix mille'),
      'publication_mode', 'manual', 'received_at', '2026-11-13T08:00:00+00:00'),
    'sale_date', jsonb_build_object(
      'value', jsonb_build_object('value', '2026-12-01'),
      'publication_mode', 'robot', 'received_at', 'hier'),
    'address', jsonb_build_object(
      'value', jsonb_build_object('value', '1 rue de la Paix'),
      'publication_mode', 'manual', 'received_at', '2026-11-13T08:00:00+00:00')
  )
)
where id = '87900000-1000-4000-8000-000000000001';
select ok(
  not exists (
    select 1 from public.get_public_sale_lawyer_fact_sources('87900000-1000-4000-8000-000000000001')
    where fact_key in ('land_surface_m2')
  ),
  'an automatic entry has no observation accepted in the registry, hence never a mention'
);
select is(
  (select array_agg(fact_key order by fact_key)
     from public.get_public_sale_lawyer_fact_sources('87900000-1000-4000-8000-000000000001')),
  array['occupancy_status', 'property_type', 'surface_m2'],
  'malformed values, unknown modes, unreadable dates and keys without a displayed column are ignored without error'
);

-- Fait antérieur à la migration dont le dossier n'existe plus : ni destinataire ni date connus, aucune mention.
update public.auction_sales
set raw_payload = jsonb_set(
  raw_payload,
  '{information_agent_verified_facts,rooms_count}',
  jsonb_build_object(
    'value', jsonb_build_object('value', '5'),
    'fact_id', '87900000-5000-4000-8000-0000000000ff',
    'received_at', '2026-11-12T08:30:00+00:00',
    'source', 'professional_email'
  )
)
where id = '87900000-1000-4000-8000-000000000001';
select ok(
  not exists (
    select 1 from public.get_public_sale_lawyer_fact_sources('87900000-1000-4000-8000-000000000001')
    where fact_key in ('rooms_count')
  ),
  'without the kind of recipient (case purged), no mention: it fails closed'
);

-- La même surface réécrite depuis l'annonce : la valeur est la même, la source ne l'est plus.
update public.auction_sales set surface_source = 'listing_text'
where id = '87900000-1000-4000-8000-000000000001';
select ok(
  not exists (
    select 1 from public.get_public_sale_lawyer_fact_sources('87900000-1000-4000-8000-000000000001')
    where fact_key in ('surface_m2')
  ),
  'a surface rewritten from the listing loses its mention even with the same value'
);

select is(
  (select count(*)::integer
     from public.get_public_sale_lawyer_fact_sources('87900000-1000-4000-8000-000000000002')),
  0,
  'a sale outside the public catalogue gives nothing'
);
select is(
  (select count(*)::integer
     from public.get_public_sale_lawyer_fact_sources('87900000-1000-4000-8000-0000000000ff')),
  0,
  'an unknown sale gives nothing'
);

select ok(
  not exists (
    select 1
    from public.get_public_sale_lawyer_fact_sources('87900000-1000-4000-8000-000000000001') source
    where source::text ~* '(87900000-5000|avocat-879|Extrait confidentiel|Demande d''informations|54|vacant)'
  ),
  'no fact identifier, sender, excerpt, subject or value comes out'
);

set local role anon;
select is(
  (select count(*)::integer
     from public.get_public_sale_lawyer_fact_sources('87900000-1000-4000-8000-000000000001')),
  2,
  'a signed-out visitor reads the projection'
);
select throws_ok(
  $$select raw_payload from public.auction_sales limit 1$$,
  '42501', null, 'raw_payload itself stays hidden from a signed-out visitor'
);
reset role;

select * from finish();
rollback;
