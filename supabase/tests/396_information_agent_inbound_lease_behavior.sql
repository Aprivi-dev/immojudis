begin;

select plan(8);

insert into auth.users (id) values ('39600000-0000-4000-8000-000000000001');
insert into public.auction_sales (id, source_name, source_url, status)
values (
  '39600000-1000-4000-8000-000000000001',
  'information-agent-inbound-lease-pgtap',
  'https://example.test/information-agent-inbound-lease-pgtap',
  'upcoming'
);
insert into public.information_agent_missions (
  id, user_id, sale_id, recipient_email, subject, body_text,
  question_keys, missing_information, privacy_version
)
values (
  '39600000-2000-4000-8000-000000000001',
  '39600000-0000-4000-8000-000000000001',
  '39600000-1000-4000-8000-000000000001',
  'contact@example.test',
  'Inbound lease behavioral test',
  'Merci de transmettre les informations du dossier.',
  array['documents'], array['documents'], '396-pgtap'
);
insert into public.information_agent_cases (
  id, sale_id, created_by, status, recipient_email,
  normalized_recipient_email, subject, body_text, question_keys,
  missing_information
)
values (
  '39600000-3000-4000-8000-000000000001',
  '39600000-1000-4000-8000-000000000001',
  '39600000-0000-4000-8000-000000000001',
  'sent', 'contact@example.test', 'contact@example.test',
  'Inbound lease behavioral test',
  'Merci de transmettre les informations du dossier.',
  array['documents'], array['documents']
);
insert into public.information_agent_messages (
  id, mission_id, case_id, user_id, direction, message_kind,
  delivery_status, subject, body_text, provider_message_id
)
values (
  '39600000-4000-4000-8000-000000000001',
  '39600000-2000-4000-8000-000000000001',
  '39600000-3000-4000-8000-000000000001',
  '39600000-0000-4000-8000-000000000001',
  'inbound', 'reply', 'received', 'Inbound lease behavioral test',
  'Voici les documents demandés.', 'provider-396-inbound-lease'
);
insert into public.information_agent_inbound_jobs (
  id, message_id, case_id, provider_email_id, attachment_link_expires_at
)
values (
  '39600000-5000-4000-8000-000000000001',
  '39600000-4000-4000-8000-000000000001',
  '39600000-3000-4000-8000-000000000001',
  'provider-396-inbound-lease', now() + interval '1 hour'
);

set local role service_role;

select is(
  (select count(*) from public.claim_information_agent_inbound_jobs(1)),
  1::bigint,
  'a queued inbound job is claimed'
);
select is(
  (select metadata #>> '{inbound_processing,lease_id}'
   from public.information_agent_messages
   where id = '39600000-4000-4000-8000-000000000001'),
  (select lease_id::text from public.information_agent_inbound_jobs
   where id = '39600000-5000-4000-8000-000000000001'),
  'claim exposes the same lease on the job and message'
);
select throws_ok(
  $$insert into public.information_agent_fact_candidates (
      case_id, message_id, sale_id, fact_key, proposed_value,
      display_value, confidence, metadata
    ) values (
      '39600000-3000-4000-8000-000000000001',
      '39600000-4000-4000-8000-000000000001',
      '39600000-1000-4000-8000-000000000001',
      'rooms_count', '2'::jsonb, 'wrong lease', 1,
      jsonb_build_object(
        'inbound_lease_id', '00000000-0000-4000-8000-000000000000',
        'inbound_message_id', '39600000-4000-4000-8000-000000000001'
      )
    )$$,
  '40001', 'Inbound worker lease lost.',
  'a fact write with another lease is rejected'
);
select lives_ok(
  $$insert into public.information_agent_fact_candidates (
      case_id, message_id, sale_id, fact_key, proposed_value,
      display_value, confidence, metadata
    )
    select job.case_id, job.message_id,
      '39600000-1000-4000-8000-000000000001',
      'rooms_count', '2'::jsonb, 'valid lease', 1,
      jsonb_build_object(
        'inbound_lease_id', job.lease_id::text,
        'inbound_message_id', job.message_id::text
      )
    from public.information_agent_inbound_jobs job
    where job.id = '39600000-5000-4000-8000-000000000001'$$,
  'a fact write with the current lease succeeds'
);
select ok(
  (select not (metadata ? 'inbound_lease_id')
          and not (metadata ? 'inbound_message_id')
   from public.information_agent_fact_candidates
   where display_value = 'valid lease'),
  'the fact stores no transient lease tokens'
);
select lives_ok(
  $$update public.information_agent_cases shared_case
    set status = 'review',
        metadata = jsonb_build_object(
          'inbound_lease_id', job.lease_id::text,
          'inbound_message_id', job.message_id::text
        )
    from public.information_agent_inbound_jobs job
    where shared_case.id = job.case_id
      and job.id = '39600000-5000-4000-8000-000000000001'$$,
  'a case update with the current lease succeeds'
);
select ok(
  (select not (metadata ? 'inbound_lease_id')
          and not (metadata ? 'inbound_message_id')
   from public.information_agent_cases
   where id = '39600000-3000-4000-8000-000000000001'),
  'the case stores no transient lease tokens'
);

update public.information_agent_inbound_jobs
set lease_id = '39600000-6000-4000-8000-000000000001'
where id = '39600000-5000-4000-8000-000000000001';
select throws_ok(
  $$insert into public.information_agent_fact_candidates (
      case_id, message_id, sale_id, fact_key, proposed_value,
      display_value, confidence, metadata
    )
    select message.case_id, message.id,
      '39600000-1000-4000-8000-000000000001',
      'rooms_count', '2'::jsonb, 'stale lease', 1,
      jsonb_build_object(
        'inbound_lease_id',
        message.metadata #>> '{inbound_processing,lease_id}',
        'inbound_message_id', message.id::text
      )
    from public.information_agent_messages message
    where message.id = '39600000-4000-4000-8000-000000000001'$$,
  '40001', 'Inbound worker lease lost.',
  'a stale worker cannot write after another lease takes the job'
);

select * from finish();
rollback;
