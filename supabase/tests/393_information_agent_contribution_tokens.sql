begin;

select plan(15);

select has_column(
  'public',
  'information_agent_missions',
  'contribution_token_version',
  'contribution links carry a persisted rotation version'
);
select is(
  (
    select column_default::text
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'information_agent_missions'
      and column_name = 'contribution_token_version'
  ),
  '1'::text,
  'new missions start at contribution token version one'
);
select has_function(
  'app_private',
  'bump_information_agent_contribution_token_version',
  array[]::text[],
  'mission changes have a token rotation trigger function'
);
select ok(
  exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.information_agent_missions'::regclass
      and tgname = 'information_agent_missions_contribution_token_version'
      and not tgisinternal
  ),
  'recipient and case updates invoke token rotation'
);
select ok(
  position('new.case_id is distinct from old.case_id' in pg_get_functiondef(
    'app_private.bump_information_agent_contribution_token_version()'::regprocedure
  )) > 0
    and position('new.recipient_email' in pg_get_functiondef(
      'app_private.bump_information_agent_contribution_token_version()'::regprocedure
    )) > 0,
  'token rotation covers both case and recipient changes'
);
select ok(
  position('new.contribution_token_version := old.contribution_token_version + 1' in pg_get_functiondef(
    'app_private.bump_information_agent_contribution_token_version()'::regprocedure
  )) > 0,
  'token rotation is monotonic'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'app_private.bump_information_agent_contribution_token_version()'::regprocedure,
    'EXECUTE'
  ),
  'browser clients cannot invoke token rotation directly'
);

insert into auth.users (id) values
  ('39300000-0000-4000-8000-000000000001');

insert into public.auction_sales (id, source_name, source_url, status)
values (
  '39300000-1000-4000-8000-000000000001',
  'information-agent-token-pgtap',
  'https://example.test/information-agent-token-pgtap',
  'upcoming'
);

insert into public.information_agent_missions (
  id,
  user_id,
  sale_id,
  recipient_kind,
  recipient_email,
  subject,
  body_text,
  question_keys,
  missing_information,
  privacy_version,
  status
)
values (
  '39300000-2000-4000-8000-000000000001',
  '39300000-0000-4000-8000-000000000001',
  '39300000-1000-4000-8000-000000000001',
  'manual_professional',
  'contact-a@example.test',
  'Information-agent token trigger test',
  'Merci de transmettre les informations du dossier.',
  array['documents'],
  array['documents'],
  '393-pgtap',
  'draft'
);

insert into public.information_agent_cases (
  id,
  sale_id,
  created_by,
  recipient_kind,
  recipient_email,
  normalized_recipient_email,
  subject,
  body_text,
  question_keys,
  missing_information
)
values
  (
    '39300000-3000-4000-8000-000000000001',
    '39300000-1000-4000-8000-000000000001',
    '39300000-0000-4000-8000-000000000001',
    'manual_professional',
    'contact-a@example.test',
    'contact-a@example.test',
    'Information-agent token trigger test',
    'Merci de transmettre les informations du dossier.',
    array['documents'],
    array['documents']
  ),
  (
    '39300000-3000-4000-8000-000000000002',
    '39300000-1000-4000-8000-000000000001',
    '39300000-0000-4000-8000-000000000001',
    'manual_professional',
    'contact-b@example.test',
    'contact-b@example.test',
    'Information-agent token trigger test',
    'Merci de transmettre les informations du dossier.',
    array['documents'],
    array['documents']
  );

set local role service_role;

update public.information_agent_missions
set case_id = '39300000-3000-4000-8000-000000000001'
where id = '39300000-2000-4000-8000-000000000001';
select is(
  (select contribution_token_version from public.information_agent_missions
   where id = '39300000-2000-4000-8000-000000000001'),
  2::bigint,
  'assigning a shared case rotates the contribution token'
);

update public.information_agent_missions
set recipient_email = 'contact-b@example.test'
where id = '39300000-2000-4000-8000-000000000001';
select is(
  (select contribution_token_version from public.information_agent_missions
   where id = '39300000-2000-4000-8000-000000000001'),
  3::bigint,
  'changing the recipient rotates the contribution token'
);

update public.information_agent_missions
set case_id = '39300000-3000-4000-8000-000000000002'
where id = '39300000-2000-4000-8000-000000000001';
select is(
  (select contribution_token_version from public.information_agent_missions
   where id = '39300000-2000-4000-8000-000000000001'),
  4::bigint,
  'moving to another shared case rotates the contribution token'
);

select lives_ok(
  $$update public.information_agent_missions
    set metadata = metadata
    where id = '39300000-2000-4000-8000-000000000001'$$,
  'an unrelated mission update remains allowed'
);
select is(
  (select contribution_token_version from public.information_agent_missions
   where id = '39300000-2000-4000-8000-000000000001'),
  4::bigint,
  'an unrelated mission update does not rotate the contribution token'
);

select lives_ok(
  $$update public.information_agent_missions
    set contribution_token_version = 1
    where id = '39300000-2000-4000-8000-000000000001'$$,
  'a direct attempt to decrement the token version remains valid SQL'
);
select is(
  (select contribution_token_version from public.information_agent_missions
   where id = '39300000-2000-4000-8000-000000000001'),
  4::bigint,
  'the trigger prevents contribution token version rollback'
);

update public.information_agent_missions
set recipient_email = 'contact-a@example.test'
where id = '39300000-2000-4000-8000-000000000001';
select is(
  (select contribution_token_version from public.information_agent_missions
   where id = '39300000-2000-4000-8000-000000000001'),
  5::bigint,
  'returning to a previous recipient rotates again so an old link cannot revive'
);

select * from finish();

rollback;
