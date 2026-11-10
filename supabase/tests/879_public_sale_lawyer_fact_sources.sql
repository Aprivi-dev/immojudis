-- 20261114100000 : source « avocat poursuivant » sur la fiche publique (proposition 5).
--   * la fonction publique est accessible sans compte ; la lecture est SECURITY DEFINER à search_path vide,
--     l'enveloppe publique SECURITY INVOKER ;
--   * la sortie se limite à la clé, au jour de réception et au mode : ni valeur, ni extrait, ni expéditeur,
--     ni objet, ni identifiant de fait ;
--   * une clé n'est rendue que si la valeur affichée est encore celle transmise ;
--   * les faits acceptés avant la migration (sans publication_mode ni received_at) sont rendus en « manual »
--     avec la date de réception du message ; le mode « auto » est déjà lisible ;
--   * une vente hors du catalogue public ne rend rien.
begin;

select plan(14);

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
          'publication_mode', 'manual', 'received_at', '2026-11-12T08:30:00+00:00'))
    ),
    '{}'::jsonb, 'tribunal', null, null, null, null, null);

insert into public.information_agent_cases (
  id, sale_id, created_by, status, recipient_email, normalized_recipient_email, subject, body_text,
  question_keys, missing_information, sent_at, replied_at
) values (
  '87900000-3000-4000-8000-000000000001', '87900000-1000-4000-8000-000000000001',
  '87900000-0000-4000-8000-0000000000a1', 'replied', 'avocat-879@example.test', 'avocat-879@example.test',
  'Demande d''informations 879', 'Merci de nous transmettre les informations manquantes.',
  array['surface'], array['surface'], now() - interval '3 days', now() - interval '2 days'
);
insert into public.information_agent_missions (
  id, user_id, sale_id, case_id, status, recipient_email, subject, body_text, question_keys,
  missing_information, privacy_version
) values (
  '87900000-2000-4000-8000-000000000001', '87900000-0000-4000-8000-0000000000a1',
  '87900000-1000-4000-8000-000000000001', '87900000-3000-4000-8000-000000000001', 'sent',
  'avocat-879@example.test', 'Demande d''informations 879',
  'Merci de nous transmettre les informations manquantes.', array['surface'], array['surface'], '879-pgtap'
);
insert into public.information_agent_messages (
  id, mission_id, case_id, user_id, direction, message_kind, delivery_status, subject, body_text,
  received_at
) values (
  '87900000-4000-4000-8000-000000000001', '87900000-2000-4000-8000-000000000001',
  '87900000-3000-4000-8000-000000000001', '87900000-0000-4000-8000-0000000000a1',
  'inbound', 'reply', 'received', 'Re: Demande d''informations 879', 'Voici les informations demandées.',
  '2026-11-12 09:30:00+01'
);
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

-- Publications par la RPC administrateur (chemin réel).
do $$
begin
  perform public.review_information_agent_fact_candidate(
    '87900000-0000-4000-8000-0000000000a1', fact.id, 'accepted', null)
  from public.information_agent_fact_candidates fact
  where fact.id in (
    '87900000-5000-4000-8000-000000000001', '87900000-5000-4000-8000-000000000002',
    '87900000-5000-4000-8000-000000000003', '87900000-5000-4000-8000-000000000004'
  );
end;
$$;

-- Le comportement ------------------------------------------------------------------------------------------------
select results_eq(
  $$select fact_key, received_on, publication_mode
    from public.get_public_sale_lawyer_fact_sources('87900000-1000-4000-8000-000000000001')$$,
  $$values ('occupancy_status', '2026-11-12'::date, 'manual'),
           ('rooms_count', '2026-11-12'::date, 'manual'),
           ('surface_m2', '2026-11-12'::date, 'manual')$$,
  'each displayed key published from the reply comes out with its reception day; free text never does'
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
      'publication_mode', 'auto', 'received_at', '2026-11-13T08:00:00+00:00'),
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
  exists (
    select 1 from public.get_public_sale_lawyer_fact_sources('87900000-1000-4000-8000-000000000001')
    where fact_key = 'land_surface_m2' and received_on = '2026-11-13' and publication_mode = 'auto'
  ),
  'the auto mode is already readable'
);
select is(
  (select array_agg(fact_key order by fact_key)
     from public.get_public_sale_lawyer_fact_sources('87900000-1000-4000-8000-000000000001')),
  array['land_surface_m2', 'occupancy_status', 'property_type', 'surface_m2'],
  'malformed values, unknown modes, unreadable dates and keys without a displayed column are ignored without error'
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
  4,
  'a signed-out visitor reads the projection'
);
select throws_ok(
  $$select raw_payload from public.auction_sales limit 1$$,
  '42501', null, 'raw_payload itself stays hidden from a signed-out visitor'
);
reset role;

select * from finish();
rollback;
