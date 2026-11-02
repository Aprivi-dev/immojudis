-- 20261110220000 : file de travail de l'agent d'information, attestation de l'aller-retour, indicateurs et alertes.
--   * la file est filtrée AVANT la pagination et répartie en classes A (avocat), B (texte libre), C (greffe) et D ;
--   * une vente déjà sollicitée, ou dont la date est passée, n'y figure pas ; un dossier rebondi la rend éligible ;
--   * l'attestation exige un administrateur ; les trois fonctions sont réservées à service_role ;
--   * les indicateurs comptent les envois de la catégorie « agent » ; trois alertes de santé s'ajoutent.
begin;

select plan(21);

select has_function('public', 'admin_information_agent_queue', array['integer', 'integer', 'text'], 'the queue function exists');
select has_function('public', 'attest_information_agent_roundtrip', array['uuid'], 'the attestation function exists');
select has_function('public', 'information_agent_indicators', array['timestamp with time zone', 'timestamp with time zone'], 'the indicators function exists');

select ok(
  not has_function_privilege('anon', 'public.admin_information_agent_queue(integer, integer, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.admin_information_agent_queue(integer, integer, text)', 'execute')
  and has_function_privilege('service_role', 'public.admin_information_agent_queue(integer, integer, text)', 'execute')
  and not has_function_privilege('anon', 'public.attest_information_agent_roundtrip(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.attest_information_agent_roundtrip(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.information_agent_indicators(timestamptz, timestamptz)', 'execute')
  and not has_function_privilege('authenticated', 'public.information_agent_indicators(timestamptz, timestamptz)', 'execute'),
  'the functions are closed to the browser roles and open to the server'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.information_agent_operations'::regclass)
  and not has_table_privilege('anon', 'public.information_agent_operations', 'SELECT')
  and not has_table_privilege('authenticated', 'public.information_agent_operations', 'SELECT')
  and not has_table_privilege('authenticated', 'public.information_agent_operations', 'UPDATE')
  and has_table_privilege('service_role', 'public.information_agent_operations', 'UPDATE'),
  'the operations row has RLS and is reserved to the server'
);

select throws_ok(
  $$insert into public.information_agent_operations (singleton) values (false)$$,
  '23514', null, 'the operations table keeps a single row'
);

delete from public.operational_alerts where alert_key like 'information_agent.%';

-- Fixtures ---------------------------------------------------------------------------------------------------
insert into auth.users (id) values ('86700000-0000-4000-8000-0000000000a1'), ('86700000-0000-4000-8000-0000000000a2');
insert into public.user_profiles (user_id, email, user_role) values
  ('86700000-0000-4000-8000-0000000000a1', 'queue-admin@example.test', 'admin'),
  ('86700000-0000-4000-8000-0000000000a2', 'queue-user@example.test', 'user')
on conflict (user_id) do update set user_role = excluded.user_role;

insert into public.auction_sales (id, source_name, source_url, status, premium_readiness_status, lawyer_contact, sale_date)
values
  ('86700000-1000-4000-8000-00000000000a', 'queue-pgtap', 'https://example.test/867-a', 'upcoming', 'needs_enrichment', 'Me Dupont dupont@cabinet-dupont.example', now() + interval '20 days'),
  ('86700000-1000-4000-8000-00000000000d', 'queue-pgtap', 'https://example.test/867-d', 'upcoming', 'needs_enrichment', '04 00 00 00 00', now() + interval '20 days'),
  ('86700000-1000-4000-8000-00000000000e', 'queue-pgtap', 'https://example.test/867-e', 'upcoming', 'needs_enrichment', 'old@cabinet-dupont.example', now() - interval '5 days'),
  ('86700000-1000-4000-8000-000000000010', 'queue-pgtap', 'https://example.test/867-10', 'upcoming', 'needs_enrichment', 'sent@cabinet-dupont.example', now() + interval '5 days'),
  ('86700000-1000-4000-8000-000000000011', 'queue-pgtap', 'https://example.test/867-11', 'upcoming', 'premium_ready', 'ready@cabinet-dupont.example', now() + interval '5 days');

insert into public.information_agent_cases (id, sale_id, created_by, status, recipient_email, normalized_recipient_email, subject, body_text, question_keys, sent_at)
values (
  '86700000-2000-4000-8000-000000000010', '86700000-1000-4000-8000-000000000010',
  '86700000-0000-4000-8000-0000000000a1', 'sent', 'sent@cabinet-dupont.example', 'sent@cabinet-dupont.example',
  'Objet de test', 'Corps de test de plus de vingt caractères.', array['documents'], now() - interval '3 days'
);

-- File -------------------------------------------------------------------------------------------------------
select is(
  (public.admin_information_agent_queue(500, 0, 'A') -> 'items') @> '[{"id": "86700000-1000-4000-8000-00000000000a", "class": "A"}]'::jsonb,
  true,
  'a sale with a lawyer address is in class A'
);

select is(
  (public.admin_information_agent_queue(500, 0, null) -> 'items') @> '[{"id": "86700000-1000-4000-8000-00000000000d"}]'::jsonb,
  false,
  'a sale with a phone number only (class D) is not in the working list'
);

select is(
  (public.admin_information_agent_queue(500, 0, 'D') -> 'items') @> '[{"id": "86700000-1000-4000-8000-00000000000d", "class": "D"}]'::jsonb,
  true,
  'a sale with a phone number only is listed under « contact impossible »'
);

select is(
  ((public.admin_information_agent_queue(500, 0, null) -> 'items') @> '[{"id": "86700000-1000-4000-8000-00000000000e"}]'::jsonb)
  or ((public.admin_information_agent_queue(500, 0, 'D') -> 'items') @> '[{"id": "86700000-1000-4000-8000-00000000000e"}]'::jsonb)
  or ((public.admin_information_agent_queue(500, 0, 'A') -> 'items') @> '[{"id": "86700000-1000-4000-8000-00000000000e"}]'::jsonb),
  false,
  'a sale whose date has passed is in no class'
);

select is(
  (public.admin_information_agent_queue(500, 0, 'A') -> 'items') @> '[{"id": "86700000-1000-4000-8000-000000000010"}]'::jsonb,
  false,
  'a sale already contacted is not in the queue'
);

select is(
  (public.admin_information_agent_queue(500, 0, 'A') -> 'items') @> '[{"id": "86700000-1000-4000-8000-000000000011"}]'::jsonb,
  false,
  'a sale already ready for the Analyse offer is not in the queue'
);

update public.information_agent_cases
set metadata = '{"delivery": {"status": "bounced"}}'::jsonb
where id = '86700000-2000-4000-8000-000000000010';

select is(
  (public.admin_information_agent_queue(500, 0, 'A') -> 'items') @> '[{"id": "86700000-1000-4000-8000-000000000010", "class": "A"}]'::jsonb,
  true,
  'a bounced case makes the sale eligible again'
);

select is(
  jsonb_array_length(public.admin_information_agent_queue(1, 0, 'A') -> 'items'),
  1,
  'the page size is applied after the filter'
);

select throws_ok(
  $$select public.admin_information_agent_queue(10, 0, 'Z')$$,
  '22023', null, 'an unknown class is refused'
);

-- Attestation ----------------------------------------------------------------------------------------------------
select throws_ok(
  $$select public.attest_information_agent_roundtrip('86700000-0000-4000-8000-0000000000a2')$$,
  '42501', null, 'a non-admin account cannot attest the round trip'
);

-- La date et l'auteur sont lus dans une instruction distincte : une sous-requête de la même instruction ne voit pas
-- l'écriture de la fonction (instantané de l'instruction).
do $$
begin
  perform public.attest_information_agent_roundtrip('86700000-0000-4000-8000-0000000000a1');
end;
$$;

select ok(
  (select inbound_roundtrip_verified_by = '86700000-0000-4000-8000-0000000000a1'
     and inbound_roundtrip_verified_at is not null
   from public.information_agent_operations where singleton),
  'an administrator attests the round trip: the date and the author are stored'
);

-- Indicateurs et santé ---------------------------------------------------------------------------------------------
insert into public.email_send_log (resend_email_id, template_key, category, mode, to_address, status, bounce_type)
select '867-sent-' || n, 'agent_request', 'agent', 'manual', 'dest' || n || '@example.test',
  case when n <= 8 then 'delivered' when n = 9 then 'bounced' else 'complained' end,
  case when n = 9 then 'permanent' else null end
from generate_series(1, 10) as n;

select is(
  (public.information_agent_indicators() ->> 'sent')::integer,
  10,
  'the indicators count the sent messages of the agent'
);

select is(
  (public.information_agent_indicators() ->> 'bounced_permanent')::integer,
  1,
  'the indicators count the permanent bounces'
);

select ok(public.evaluate_information_agent_health() is not null, 'the health check runs');

select ok(
  (select count(*) from public.operational_alerts
    where alert_key in ('information_agent.delivery.bounce_rate', 'information_agent.delivery.complaint')
      and status = 'open') = 2,
  'a bounce rate of 10 % and a complaint open their alerts'
);

select * from finish();
rollback;
