begin;

select plan(38);

-- ---------------------------------------------------------------------------
-- Structure : source typée, clés d'identité, liste d'opposition par identité
-- ---------------------------------------------------------------------------
select has_column('public', 'information_agent_contacts', 'source_kind', 'contacts carry a typed source');
select has_column('public', 'information_agent_contacts', 'source_directory_name', 'contacts name the official directory');
select has_column('public', 'information_agent_contacts', 'observed_at', 'contacts carry the date of collection');
select has_column('public', 'information_agent_contacts', 'observed_by', 'contacts carry the author of the collection');
select has_column('public', 'information_agent_contacts', 'identity_keys', 'contacts carry identity keys');
select has_column('public', 'information_agent_missions', 'recipient_identity_keys', 'missions carry identity keys');
select has_table('public', 'information_agent_identity_oppositions', 'the identity opposition list exists');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.information_agent_identity_oppositions'::regclass),
  'the identity opposition list has RLS enabled'
);
select ok(
  not has_table_privilege('authenticated', 'public.information_agent_identity_oppositions', 'SELECT')
    and not has_table_privilege('anon', 'public.information_agent_identity_oppositions', 'SELECT')
    and has_table_privilege('service_role', 'public.information_agent_identity_oppositions', 'INSERT'),
  'only trusted server code reads the identity opposition list'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'app_private.information_agent_identity_is_blocked(text[])',
    'EXECUTE'
  ),
  'browser clients cannot call the identity lookup'
);

-- ---------------------------------------------------------------------------
-- Contraintes de la source typée
-- ---------------------------------------------------------------------------
select throws_ok(
  $$insert into public.information_agent_contacts (email, source_kind, observed_at, observed_by)
    values ('kind@example.test', 'search_engine', now(), 'agent')$$,
  '23514',
  null,
  'an unknown source kind is refused'
);
select throws_ok(
  $$insert into public.information_agent_contacts (email, source_kind, observed_at, observed_by)
    values ('dir@example.test', 'official_directory', now(), 'agent')$$,
  '23514',
  null,
  'an official directory without its name is refused'
);
select throws_ok(
  $$insert into public.information_agent_contacts
      (email, source_kind, source_directory_name, source_url, observed_at, observed_by)
    values ('name@example.test', 'firm_website', 'annuaire du CNB', 'https://cabinet.example.test/', now(), 'agent')$$,
  '23514',
  null,
  'a directory name is reserved to official directories'
);
select throws_ok(
  $$insert into public.information_agent_contacts (email, source_kind, source_url, observed_at, observed_by)
    values ('site@example.test', 'firm_website', 'http://cabinet.example.test/', now(), 'agent')$$,
  '23514',
  null,
  'a firm website must be an https address'
);
select throws_ok(
  $$insert into public.information_agent_contacts (email, source_kind, observed_at, observed_by)
    values ('nourl@example.test', 'other_listing', now(), 'agent')$$,
  '23514',
  null,
  'another listing needs the exact URL'
);
select throws_ok(
  $$insert into public.information_agent_contacts (email, source_kind, source_url)
    values ('nodate@example.test', 'sale_listing', 'https://www.licitor.com/annonce/1')$$,
  '23514',
  null,
  'a typed source needs its date and author'
);
select throws_ok(
  $$insert into public.information_agent_contacts (email, source_kind, observed_at, observed_by)
    values ('author@example.test', 'sale_listing', now(), 'robot')$$,
  '23514',
  null,
  'the author is the agent or an administrator'
);
select lives_ok(
  $$insert into public.information_agent_contacts
      (email, source_kind, source_directory_name, source_url, observed_at, observed_by)
    values (
      'ok-dir@example.test', 'official_directory', 'annuaire officiel des commissaires de justice',
      'https://annuaire.commissaire-justice.fr/etude-1', now(), 'agent'
    )$$,
  'a complete official directory source is accepted'
);

-- ---------------------------------------------------------------------------
-- Opposition par identité
-- ---------------------------------------------------------------------------
insert into public.auction_sales (id, source_name, source_url, status)
values (
  '46100000-1000-4000-8000-000000000001',
  'legal-safeguards-pgtap',
  'https://example.test/legal-safeguards/sale',
  'upcoming'
);

insert into public.information_agent_contacts (
  sale_id, scope_sale_id, email, role, verification_status, source_kind, source_url,
  observed_at, observed_by, identity_keys
)
values (
  '46100000-1000-4000-8000-000000000001',
  '46100000-1000-4000-8000-000000000001',
  'avocat@cabinet-a.example.test',
  'lawyer',
  'source_observed',
  'sale_listing',
  'https://www.licitor.com/annonce/1',
  now(),
  'agent',
  array['lawyer|bordeaux|dupont jean']
);

select is(
  app_private.information_agent_identity_is_blocked(array['lawyer|bordeaux|dupont jean']),
  false,
  'a professional who did not object is not blocked by identity'
);

-- Opposition par lien : l'adresse seule est connue du lien.
insert into public.information_agent_contacts (email, opposition_status, opposed_at)
values ('AVOCAT@cabinet-a.example.test', 'opposed', '2026-10-01T00:00:00Z');

select is(
  (select identity_key from public.information_agent_identity_oppositions),
  'lawyer|bordeaux|dupont jean',
  'an objection by address feeds the identity list with the keys known for that address'
);
select is(
  (
    select identity_keys
    from public.information_agent_contacts
    where normalized_email = 'avocat@cabinet-a.example.test' and scope_sale_id is null
  ),
  array['lawyer|bordeaux|dupont jean'],
  'the global objection row keeps the identity keys (the sale-scoped rows are purgeable)'
);
select is(
  (select opposed_at from public.information_agent_identity_oppositions),
  '2026-10-01T00:00:00Z'::timestamptz,
  'the identity objection keeps the date of the objection'
);
select is(
  app_private.information_agent_identity_is_blocked(
    array['lawyer|lyon|martin', 'lawyer|bordeaux|dupont jean']
  ),
  true,
  'the same professional is blocked under any other address'
);
select is(
  app_private.information_agent_identity_is_blocked(array['lawyer|lyon|martin']),
  false,
  'another professional is not blocked'
);
select is(
  app_private.information_agent_identity_is_blocked(null),
  false,
  'an unknown identity is not blocked by identity'
);

-- Même professionnel, autre adresse (annuaire) : la ligne naît opposée.
insert into public.information_agent_contacts (
  sale_id, scope_sale_id, email, role, verification_status, source_kind, source_directory_name,
  source_url, observed_at, observed_by, identity_keys
)
values (
  '46100000-1000-4000-8000-000000000001',
  '46100000-1000-4000-8000-000000000001',
  'jean.dupont@cabinet-b.example.test',
  'lawyer',
  'source_observed',
  'official_directory',
  'annuaire du barreau de Lyon',
  'https://www.barreaulyon.com/annuaire/avocat/jean-dupont/',
  now(),
  'agent',
  array['lawyer|bordeaux|dupont jean']
);
select is(
  (
    select opposition_status
    from public.information_agent_contacts
    where email = 'jean.dupont@cabinet-b.example.test'
  ),
  'opposed',
  'a new address of an opposed professional is registered as opposed'
);
select is(
  app_private.information_agent_contact_is_blocked(
    '46100000-1000-4000-8000-000000000001',
    'Jean.Dupont@cabinet-b.example.test'
  ),
  true,
  'the existing address guard blocks the new address of an opposed professional'
);

-- Les clés sont complétées par celles de la mission du même destinataire.
insert into auth.users (id) values ('46100000-0000-4000-8000-000000000001');
insert into public.information_agent_missions (
  id, user_id, sale_id, recipient_kind, recipient_email, recipient_identity_keys, subject, body_text,
  question_keys, missing_information, privacy_version, status
)
values (
  '46100000-2000-4000-8000-000000000001',
  '46100000-0000-4000-8000-000000000001',
  '46100000-1000-4000-8000-000000000001',
  'manual_professional',
  'notaire@etude-c.example.test',
  array['notary|bordeaux|martin'],
  'Demande de précisions',
  'Merci de transmettre les informations du dossier.',
  array['documents'],
  array['documents'],
  'test',
  'draft'
);
insert into public.information_agent_contacts (email, opposition_status)
values ('notaire@etude-c.example.test', 'opposed');
select is(
  app_private.information_agent_identity_is_blocked(array['notary|bordeaux|martin']),
  true,
  'an objection also records the identity keys of the missions sent to that address'
);

-- Blocage de l'envoi par identité, sous une adresse qui n'est pas opposée.
insert into public.information_agent_missions (
  id, user_id, sale_id, recipient_kind, recipient_email, recipient_identity_keys, subject, body_text,
  question_keys, missing_information, privacy_version, status
)
values (
  '46100000-2000-4000-8000-000000000002',
  '46100000-0000-4000-8000-000000000001',
  '46100000-1000-4000-8000-000000000001',
  'manual_professional',
  'dupont@cabinet-d.example.test',
  array['lawyer|bordeaux|dupont jean'],
  'Demande de précisions',
  'Merci de transmettre les informations du dossier.',
  array['documents'],
  array['documents'],
  'test',
  'draft'
);
select throws_ok(
  $$update public.information_agent_missions
    set status = 'sending'
    where id = '46100000-2000-4000-8000-000000000002'$$,
  '23514',
  'Information-agent contact is opposed or permanently bounced.',
  'a mission cannot be sent to an opposed professional under another address'
);
select lives_ok(
  $$update public.information_agent_missions
    set recipient_identity_keys = array['lawyer|lyon|martin']
    where id = '46100000-2000-4000-8000-000000000002'$$,
  'a mission for another identity is not blocked'
);
select lives_ok(
  $$update public.information_agent_missions
    set status = 'sending'
    where id = '46100000-2000-4000-8000-000000000002'$$,
  'the same mission can be sent once its identity is not opposed'
);
select throws_ok(
  $$update public.information_agent_missions
    set recipient_identity_keys = array['lawyer|bordeaux|dupont jean']
    where id = '46100000-2000-4000-8000-000000000002'$$,
  '23514',
  'Information-agent contact is opposed or permanently bounced.',
  'changing the identity of a sendable mission rechecks the objection list'
);

-- ---------------------------------------------------------------------------
-- Purge : durées du pied de message et adresses jamais utilisées pour un envoi
-- ---------------------------------------------------------------------------
-- Données vieillies : les dates sont relatives à now(), le test ne dépend pas du jour d'exécution.
insert into public.information_agent_contacts (
  sale_id, scope_sale_id, email, verification_status, opposition_status, bounce_status,
  source_kind, source_url, observed_at, observed_by
)
select
  '46100000-1000-4000-8000-000000000001',
  '46100000-1000-4000-8000-000000000001',
  fixture.email,
  'source_observed',
  fixture.opposition,
  fixture.bounce,
  'sale_listing',
  'https://www.licitor.com/annonce/9',
  now() - fixture.age,
  'agent'
from (
  values
    ('purge-unused-old@example.test', 'unknown', 'none', interval '61 days'),
    ('purge-unused-recent@example.test', 'unknown', 'none', interval '10 days'),
    ('purge-opposed-old@example.test', 'opposed', 'none', interval '61 days'),
    ('purge-bounced-old@example.test', 'unknown', 'permanent', interval '61 days'),
    ('purge-sent-old@example.test', 'unknown', 'none', interval '61 days'),
    ('purge-sent-kept@example.test', 'unknown', 'none', interval '61 days'),
    ('purge-draft-old@example.test', 'unknown', 'none', interval '61 days')
) as fixture(email, opposition, bounce, age);

insert into public.information_agent_missions (
  id, user_id, sale_id, status, recipient_kind, recipient_email, subject, body_text, question_keys,
  missing_information, privacy_version, sent_at, replied_at, created_at, updated_at
)
select
  fixture.id::uuid,
  '46100000-0000-4000-8000-000000000001',
  '46100000-1000-4000-8000-000000000001',
  fixture.status,
  'manual_professional',
  fixture.email,
  'Demande de précisions',
  'Merci de transmettre les informations du dossier.',
  array['documents'],
  array['documents'],
  'test',
  now() - fixture.sent_age,
  now() - fixture.replied_age,
  now() - fixture.updated_age,
  now() - fixture.updated_age
from (
  values
    ('46100000-2000-4000-8000-000000000011', 'draft', 'draft-old@example.test', null::interval, null::interval, interval '61 days'),
    ('46100000-2000-4000-8000-000000000012', 'draft', 'purge-draft-old@example.test', null, null, interval '5 days'),
    ('46100000-2000-4000-8000-000000000013', 'cancelled', 'cancelled-old@example.test', null, null, interval '61 days'),
    ('46100000-2000-4000-8000-000000000014', 'failed', 'failed-unsent-old@example.test', null, null, interval '61 days'),
    ('46100000-2000-4000-8000-000000000015', 'sent', 'purge-sent-old@example.test', interval '14 months', null, interval '14 months'),
    ('46100000-2000-4000-8000-000000000016', 'sent', 'purge-sent-kept@example.test', interval '6 months', null, interval '6 months'),
    ('46100000-2000-4000-8000-000000000017', 'replied', 'replied-13-months@example.test', interval '14 months', interval '13 months', interval '13 months'),
    ('46100000-2000-4000-8000-000000000018', 'replied', 'replied-25-months@example.test', interval '26 months', interval '25 months', interval '25 months')
) as fixture(id, status, email, sent_age, replied_age, updated_age);

select is(
  app_private.purge_information_agent_data(now()),
  '{"information_agent_missions": 5, "information_agent_contacts": 2}'::jsonb,
  'the retention report counts the purged missions and registry addresses'
);
select is(
  (
    select array_agg(right(id::text, 2) order by id)
    from public.information_agent_missions
    where id::text like '46100000-2000-4000-8000-0000000000%'
      and id::text > '46100000-2000-4000-8000-000000000010'
  ),
  array['12', '16', '17'],
  'unsent requests go after 30 days, unanswered ones after 12 months, answered ones after 24 months'
);
select is(
  (
    select array_agg(split_part(email, '@', 1) order by email)
    from public.information_agent_contacts
    where email like 'purge-%'
  ),
  array[
    'purge-bounced-old',
    'purge-draft-old',
    'purge-opposed-old',
    'purge-sent-kept',
    'purge-unused-recent'
  ],
  'an address never used for a send is purged after 30 days, one used follows its request; opposed, bounced and recent ones stay'
);
select is(
  (
    select count(*)::integer
    from public.information_agent_contacts
    where scope_sale_id is null and opposition_status = 'opposed'
  ),
  2,
  'global objections are kept by the retention run'
);
select is(
  (select count(*)::integer from public.information_agent_identity_oppositions),
  2,
  'the identity opposition list is kept by the retention run'
);
select is(
  app_private.purge_information_agent_data(now()),
  '{"information_agent_missions": 0, "information_agent_contacts": 0}'::jsonb,
  'a second run has nothing left to purge'
);

select * from finish();

rollback;
