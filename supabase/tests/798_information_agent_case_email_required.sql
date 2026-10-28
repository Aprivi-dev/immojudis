-- 20261108203000 : aucun dossier (information_agent_cases) ne se crée sans adresse email valide, quel que
-- soit l'appelant de public.subscribe_information_agent_mission.
begin;

select plan(7);

insert into auth.users (id) values ('79800000-0000-4000-8000-000000000001');
insert into public.auction_sales (id, source_name, source_url, status)
values (
  '79800000-1000-4000-8000-000000000001',
  'information-agent-case-email-required-pgtap',
  'https://example.test/information-agent-case-email-required-pgtap',
  'upcoming'
);

-- Demande ancienne : adresse acceptée par l'ancienne contrainte (« a@b.c »), refusée par la règle.
alter table public.information_agent_missions disable trigger information_agent_missions_contact_guard;
insert into public.information_agent_missions (
  id, user_id, sale_id, recipient_email, subject, body_text,
  question_keys, missing_information, privacy_version
) values (
  '79800000-2000-4000-8000-000000000001',
  '79800000-0000-4000-8000-000000000001',
  '79800000-1000-4000-8000-000000000001',
  'ancienne@cabinet.f', 'Demande', 'Merci de transmettre les informations du dossier.',
  array['documents'], array['documents'], '798-pgtap'
);
alter table public.information_agent_missions enable trigger information_agent_missions_contact_guard;

select throws_ok(
  $$select * from public.subscribe_information_agent_mission(
      '79800000-0000-4000-8000-000000000001', '79800000-2000-4000-8000-000000000001'
    )$$,
  '23514',
  'Aucune adresse email de contact : l''agent ne peut pas écrire.',
  'a mission without a valid address is not attached to a case'
);
select is(
  (select count(*) from public.information_agent_cases
   where sale_id = '79800000-1000-4000-8000-000000000001'),
  0::bigint,
  'no case was created for it'
);
select is(
  (select status from public.information_agent_missions
   where id = '79800000-2000-4000-8000-000000000001'),
  'draft',
  'the refused mission is left untouched'
);

insert into public.information_agent_missions (
  id, user_id, sale_id, recipient_email, subject, body_text,
  question_keys, missing_information, privacy_version
) values (
  '79800000-2000-4000-8000-000000000002',
  '79800000-0000-4000-8000-000000000001',
  '79800000-1000-4000-8000-000000000001',
  'Cabinet.Dupont@Example.test', 'Demande', 'Merci de transmettre les informations du dossier.',
  array['documents'], array['documents'], '798-pgtap'
);

select lives_ok(
  $$select * from public.subscribe_information_agent_mission(
      '79800000-0000-4000-8000-000000000001', '79800000-2000-4000-8000-000000000002'
    )$$,
  'a mission with a valid address joins a case'
);
select is(
  (select normalized_recipient_email from public.information_agent_cases
   where sale_id = '79800000-1000-4000-8000-000000000001'),
  'cabinet.dupont@example.test',
  'the case is keyed by the normalised address'
);
select is(
  (select count(*) from public.information_agent_cases
   where sale_id = '79800000-1000-4000-8000-000000000001'),
  1::bigint,
  'exactly one case exists for the sale'
);
select ok(
  not has_function_privilege(
    'authenticated', 'public.subscribe_information_agent_mission(uuid,uuid)', 'EXECUTE'
  )
  and has_function_privilege(
    'service_role', 'public.subscribe_information_agent_mission(uuid,uuid)', 'EXECUTE'
  ),
  'the case function is still reserved to trusted server code'
);

select * from finish();
rollback;
