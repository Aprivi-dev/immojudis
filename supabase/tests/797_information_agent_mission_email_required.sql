-- 20261108203000 : une demande de l'agent d'information ne s'enregistre pas sans adresse email valide
-- (téléphone seul, nom seul, champ vide), avec un motif lisible ; une ligne ancienne ne se bloque pas.
begin;

select plan(11);

insert into auth.users (id) values ('79700000-0000-4000-8000-000000000001');
insert into public.auction_sales (id, source_name, source_url, status)
values (
  '79700000-1000-4000-8000-000000000001',
  'information-agent-email-required-pgtap',
  'https://example.test/information-agent-email-required-pgtap',
  'upcoming'
);

select throws_ok(
  $$insert into public.information_agent_missions (
      user_id, sale_id, recipient_email, subject, body_text,
      question_keys, missing_information, privacy_version
    ) values (
      '79700000-0000-4000-8000-000000000001', '79700000-1000-4000-8000-000000000001',
      'Tél. : 05 56 00 00 01', 'Demande', 'Merci de transmettre les informations du dossier.',
      array['documents'], array['documents'], '797-pgtap'
    )$$,
  '23514',
  null,
  'a phone number is refused as the recipient'
);
select throws_ok(
  $$insert into public.information_agent_missions (
      user_id, sale_id, recipient_email, subject, body_text,
      question_keys, missing_information, privacy_version
    ) values (
      '79700000-0000-4000-8000-000000000001', '79700000-1000-4000-8000-000000000001',
      'Maître Jean Dupont', 'Demande', 'Merci de transmettre les informations du dossier.',
      array['documents'], array['documents'], '797-pgtap'
    )$$,
  '23514',
  null,
  'a name is refused as the recipient'
);
select throws_ok(
  $$insert into public.information_agent_missions (
      user_id, sale_id, recipient_email, subject, body_text,
      question_keys, missing_information, privacy_version
    ) values (
      '79700000-0000-4000-8000-000000000001', '79700000-1000-4000-8000-000000000001',
      '', 'Demande', 'Merci de transmettre les informations du dossier.',
      array['documents'], array['documents'], '797-pgtap'
    )$$,
  '23514',
  null,
  'an empty recipient is refused'
);
select throws_ok(
  $$insert into public.information_agent_missions (
      user_id, sale_id, recipient_email, subject, body_text,
      question_keys, missing_information, privacy_version
    ) values (
      '79700000-0000-4000-8000-000000000001', '79700000-1000-4000-8000-000000000001',
      'dupont@cabinet.f', 'Demande', 'Merci de transmettre les informations du dossier.',
      array['documents'], array['documents'], '797-pgtap'
    )$$,
  '23514',
  'Aucune adresse email de contact : l''agent ne peut pas écrire.',
  'an address the application would refuse is refused with a readable reason'
);
select is(
  (select count(*) from public.information_agent_missions
   where sale_id = '79700000-1000-4000-8000-000000000001'),
  0::bigint,
  'no mission was recorded for the refused recipients'
);

insert into public.information_agent_missions (
  id, user_id, sale_id, recipient_email, subject, body_text,
  question_keys, missing_information, privacy_version
) values (
  '79700000-2000-4000-8000-000000000001',
  '79700000-0000-4000-8000-000000000001',
  '79700000-1000-4000-8000-000000000001',
  'Cabinet@Example.test', 'Demande', 'Merci de transmettre les informations du dossier.',
  array['documents'], array['documents'], '797-pgtap'
);
select is(
  (select count(*) from public.information_agent_missions
   where id = '79700000-2000-4000-8000-000000000001'),
  1::bigint,
  'a valid address is recorded'
);

select throws_ok(
  $$update public.information_agent_missions
    set recipient_email = '05 56 00 00 01'
    where id = '79700000-2000-4000-8000-000000000001'$$,
  '23514',
  null,
  'the recipient cannot be replaced by a phone number'
);
select lives_ok(
  $$update public.information_agent_missions
    set recipient_email = 'autre@example.test'
    where id = '79700000-2000-4000-8000-000000000001'$$,
  'the recipient can be replaced by another valid address'
);
select lives_ok(
  $$update public.information_agent_missions
    set subject = 'Demande reformulée'
    where id = '79700000-2000-4000-8000-000000000001'$$,
  'a change that leaves the address alone is not blocked'
);

-- Une ligne ancienne, enregistrée avant la règle avec une adresse que l'ancienne contrainte acceptait,
-- reste modifiable tant que son adresse ne change pas.
alter table public.information_agent_missions disable trigger information_agent_missions_contact_guard;
insert into public.information_agent_missions (
  id, user_id, sale_id, recipient_email, subject, body_text,
  question_keys, missing_information, privacy_version
) values (
  '79700000-2000-4000-8000-000000000002',
  '79700000-0000-4000-8000-000000000001',
  '79700000-1000-4000-8000-000000000001',
  'ancienne@cabinet.f', 'Demande', 'Merci de transmettre les informations du dossier.',
  array['documents'], array['documents'], '797-pgtap'
);
alter table public.information_agent_missions enable trigger information_agent_missions_contact_guard;
select lives_ok(
  $$update public.information_agent_missions
    set status = 'cancelled', completed_at = now()
    where id = '79700000-2000-4000-8000-000000000002'$$,
  'an older row stays editable while its address is unchanged'
);
select throws_ok(
  $$update public.information_agent_missions
    set recipient_email = 'ancienne@cabinet.g'
    where id = '79700000-2000-4000-8000-000000000002'$$,
  '23514',
  null,
  'a new address on an older row must pass the rule'
);

select * from finish();
rollback;
