begin;

select plan(29);

select has_table(
  'public',
  'information_agent_contacts',
  'the information-agent contact registry exists'
);
select has_column('public', 'information_agent_contacts', 'sale_id', 'contacts may be scoped to a sale');
select has_column(
  'public',
  'information_agent_contacts',
  'scope_sale_id',
  'contacts retain their original sale scope after retention'
);
select has_column('public', 'information_agent_contacts', 'provenance', 'contacts retain provenance');
select has_column('public', 'information_agent_contacts', 'role', 'contacts retain a role');
select has_column(
  'public',
  'information_agent_contacts',
  'verification_status',
  'contacts retain verification status'
);
select has_column(
  'public',
  'information_agent_contacts',
  'opposition_status',
  'contacts retain opposition status'
);
select has_column(
  'public',
  'information_agent_contacts',
  'bounce_status',
  'contacts retain bounce status'
);
select has_column(
  'public',
  'information_agent_contacts',
  'normalized_email',
  'contacts have a normalized lookup key'
);
select col_is_fk(
  'public',
  'information_agent_contacts',
  'sale_id',
  'sale-scoped contacts retain their sale relationship'
);
select is(
  (
    select count(*)::integer
    from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.information_agent_contacts'::regclass
      and constraint_row.contype = 'f'
      and constraint_row.confrelid = 'public.auction_sales'::regclass
      and constraint_row.confdeltype = 'n'
  ),
  1,
  'sale_id remains ON DELETE SET NULL while scope_sale_id preserves provenance'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.information_agent_contacts'::regclass),
  'contact registry has RLS enabled'
);
select ok(
  not has_table_privilege('authenticated', 'public.information_agent_contacts', 'SELECT'),
  'browser clients cannot query the contact registry'
);
select ok(
  has_table_privilege('service_role', 'public.information_agent_contacts', 'SELECT')
    and has_table_privilege('service_role', 'public.information_agent_contacts', 'UPDATE'),
  'trusted server code can operate the contact registry'
);
select ok(
  exists (
    select 1
    from pg_constraint
    where conrelid = 'public.information_agent_contacts'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) ilike '%scope_sale_id%normalized_email%'
  ),
  'one registry row identifies an email within a global or sale scope'
);
select has_function(
  'app_private',
  'information_agent_contact_is_blocked',
  array['uuid', 'text'],
  'the blocked-contact lookup is available to trusted code'
);
select has_function(
  'app_private',
  'guard_information_agent_mission_contact',
  array[]::text[],
  'mission approval has a database contact guard'
);
select ok(
  exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.information_agent_missions'::regclass
      and tgname = 'information_agent_missions_contact_guard'
      and not tgisinternal
  ),
  'mission approval invokes the contact guard'
);
select ok(
  position('new.recipient_email is distinct from old.recipient_email' in pg_get_functiondef(
    'app_private.guard_information_agent_mission_contact()'::regprocedure
  )) > 0
    and position('new.sale_id is distinct from old.sale_id' in pg_get_functiondef(
      'app_private.guard_information_agent_mission_contact()'::regprocedure
    )) > 0,
  'mission guard rechecks recipient and sale changes while sendable'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'app_private.information_agent_contact_is_blocked(uuid,text)',
    'EXECUTE'
  ),
  'browser clients cannot call the blocked-contact lookup'
);
select ok(
  has_function_privilege(
    'service_role',
    'app_private.information_agent_contact_is_blocked(uuid,text)',
    'EXECUTE'
  ),
  'trusted server code can call the blocked-contact lookup'
);

insert into public.information_agent_contacts (
  email,
  opposition_status,
  provenance
)
values (
  'opposed@example.test',
  'opposed',
  '[{"kind":"manual","source":"contact_request"}]'::jsonb
);
select is(
  app_private.information_agent_contact_is_blocked(null, 'OPPOSED@example.test'),
  true,
  'an explicit global opposition blocks every sale'
);
select is(
  app_private.information_agent_contact_is_blocked(null, 'clear@example.test'),
  false,
  'an absent registry row does not block a contact'
);
insert into public.information_agent_contacts (
  email,
  opposition_status
)
values (
  'opposed@example.test',
  'none'
)
on conflict (scope_sale_id, normalized_email) do nothing;
select is(
  (select opposition_status from public.information_agent_contacts where email = 'opposed@example.test'),
  'opposed',
  'a later source observation cannot clear an existing opposition'
);

insert into public.auction_sales (
  id, source_name, source_url, status
)
values (
  '37200000-1000-4000-8000-000000000001',
  'contact-registry-test',
  'https://example.test/contact-registry/sale',
  'upcoming'
);
select lives_ok(
  $$select * from public.bridge_auction_sales_to_outcome_graph()$$,
  'the retention fixture has the required Outcome Graph bridge before sale deletion'
);
insert into public.information_agent_contacts (email, opposition_status)
values ('scoped@example.test', 'none');
insert into public.information_agent_contacts (
  sale_id, scope_sale_id, email, opposition_status
)
values (
  '37200000-1000-4000-8000-000000000001',
  '37200000-1000-4000-8000-000000000001',
  'scoped@example.test',
  'none'
);
select lives_ok(
  $$delete from public.auction_sales
    where id = '37200000-1000-4000-8000-000000000001'$$,
  'sale retention nulls the live FK without globalizing its scoped contact'
);
select is(
  (
    select count(*)::integer
    from public.information_agent_contacts
    where normalized_email = 'scoped@example.test'
      and scope_sale_id = '37200000-1000-4000-8000-000000000001'
      and sale_id is null
  ),
  1,
  'a deleted sale leaves its contact archived under the original scope'
);
select is(
  (
    select count(*)::integer
    from public.information_agent_contacts
    where normalized_email = 'scoped@example.test'
      and scope_sale_id is null
  ),
  1,
  'a pre-existing global contact remains a separate registry row'
);
select throws_ok(
  $$update public.information_agent_contacts
    set scope_sale_id = null
    where normalized_email = 'scoped@example.test'
      and scope_sale_id = '37200000-1000-4000-8000-000000000001'$$,
  '55000',
  'Information-agent contact scope is immutable.',
  'archived sale scope cannot be rewritten as global'
);

select * from finish();

rollback;
