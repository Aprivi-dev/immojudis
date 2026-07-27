begin;

select plan(19);

select ok(
  not has_table_privilege('authenticated', 'public.data_refresh_requests', 'INSERT'),
  'authenticated callers cannot insert directly into the refresh queue'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.enqueue_data_refresh_bounded(uuid,uuid,text,boolean)',
    'EXECUTE'
  ),
  'authenticated callers cannot bypass the server-owned refresh admission'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.enqueue_data_refresh_bounded(uuid,uuid,text,boolean)',
    'EXECUTE'
  ),
  'service role can invoke bounded refresh admission'
);

select ok(
  not has_table_privilege('authenticated', 'public.stripe_payment_lifecycle', 'SELECT'),
  'payment lifecycle state is not subscriber-readable'
);

select ok(
  has_table_privilege('service_role', 'public.stripe_payment_lifecycle', 'SELECT'),
  'service role can inspect payment lifecycle state'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.record_stripe_payment_state(text,uuid,text,text,text,bigint,text,boolean)',
    'EXECUTE'
  ),
  'authenticated callers cannot reconcile payment state'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.grant_analysis_access_from_payment(text,text,uuid,text,integer,text,timestamptz,text,bigint,integer)',
    'EXECUTE'
  ),
  'authenticated callers cannot grant paid access'
);

select ok(
  not has_function_privilege(
    'service_role',
    'public.grant_analysis_access_from_checkout(text,uuid,text,integer,text,timestamptz,integer)',
    'EXECUTE'
  ),
  'the legacy checkout-only grant cannot bypass payment lifecycle state'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  (
    '76000000-0000-4000-8000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'phase2-owner@example.test', '', now(), now(), now(),
    '{}'::jsonb, '{}'::jsonb
  ),
  (
    '76000000-0000-4000-8000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'phase2-collaborator@example.test', '', now(), now(), now(),
    '{}'::jsonb, '{}'::jsonb
  ),
  (
    '76000000-0000-4000-8000-000000000003',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'phase2-payment@example.test', '', now(), now(), now(),
    '{}'::jsonb, '{}'::jsonb
  );

insert into public.user_subscriptions (user_id, plan_code, status)
values
  ('76000000-0000-4000-8000-000000000001', 'analyse', 'active'),
  ('76000000-0000-4000-8000-000000000003', 'decouverte', 'active');

insert into public.auction_sales (id, source_name, source_url, title)
values
  (
    '76000000-1000-4000-8000-000000000001',
    'phase-2-test', 'https://example.test/phase-2/sale-1', 'Phase 2 sale one'
  ),
  (
    '76000000-1000-4000-8000-000000000002',
    'phase-2-test', 'https://example.test/phase-2/sale-2', 'Phase 2 sale two'
  );

insert into public.sale_workspaces (id, user_id, sale_id)
values (
  '76000000-2000-4000-8000-000000000001',
  '76000000-0000-4000-8000-000000000001',
  '76000000-1000-4000-8000-000000000001'
);

insert into public.sale_workspace_collaborators (
  id, workspace_id, owner_id, invited_by, invited_email, role, status, revoked_at
) values (
  '76000000-3000-4000-8000-000000000001',
  '76000000-2000-4000-8000-000000000001',
  '76000000-0000-4000-8000-000000000001',
  '76000000-0000-4000-8000-000000000001',
  'phase2-collaborator@example.test',
  'commenter', 'revoked', now()
);

set local role service_role;

select is(
  (
    select reused
    from public.enqueue_data_refresh_bounded(
      '76000000-0000-4000-8000-000000000001',
      '76000000-1000-4000-8000-000000000001',
      'cadastre',
      false
    )
  ),
  false,
  'the first refresh tuple creates a request'
);

select is(
  (
    select reused
    from public.enqueue_data_refresh_bounded(
      '76000000-0000-4000-8000-000000000001',
      '76000000-1000-4000-8000-000000000001',
      'cadastre',
      true
    )
  ),
  true,
  'an exact active refresh tuple is reused before quota accounting'
);

select is(
  (
    select count(*)::integer
    from public.data_refresh_requests
    where user_id = '76000000-0000-4000-8000-000000000001'
      and source_url = 'https://example.test/phase-2/sale-1'
      and request_kind = 'cadastre'
  ),
  1,
  'exact refresh deduplication leaves one active row'
);

select lives_ok(
  $$select * from public.enqueue_data_refresh_bounded(
      '76000000-0000-4000-8000-000000000001',
      '76000000-1000-4000-8000-000000000001',
      'dpe',
      false
    );
    select * from public.enqueue_data_refresh_bounded(
      '76000000-0000-4000-8000-000000000001',
      '76000000-1000-4000-8000-000000000001',
      'full',
      false
    )$$,
  'three distinct active requests fit the per-user queue budget'
);

select throws_ok(
  $$select * from public.enqueue_data_refresh_bounded(
      '76000000-0000-4000-8000-000000000001',
      '76000000-1000-4000-8000-000000000002',
      'cadastre',
      false
    )$$,
  'P0001',
  'DATA_REFRESH_USER_ACTIVE_LIMIT',
  'a fourth distinct active request is rejected atomically'
);

select throws_ok(
  $$update public.sale_workspace_collaborators
    set status = 'accepted',
        collaborator_user_id = '76000000-0000-4000-8000-000000000002',
        accepted_at = now(),
        revoked_at = null
    where id = '76000000-3000-4000-8000-000000000001'$$,
  '23514',
  'Revoked collaboration rows cannot be reactivated.',
  'a revoked collaboration remains terminal even for a privileged writer'
);

select lives_ok(
  $$select * from public.record_stripe_payment_state(
      'pi_phase2_refund_first',
      '76000000-0000-4000-8000-000000000003',
      'refunded',
      'evt_phase2_refund_first',
      'charge.refunded',
      1785175200,
      'cancelled',
      true
    )$$,
  'a refund is durably recorded even before checkout delivery'
);

select is(
  (
    select granted
    from public.grant_analysis_access_from_payment(
      'cs_phase2_delayed',
      'pi_phase2_refund_first',
      '76000000-0000-4000-8000-000000000003',
      'cus_phase2',
      2900,
      'eur',
      '2026-07-27T17:00:00Z'::timestamptz,
      'evt_phase2_checkout_delayed',
      1785171600,
      30
    )
  ),
  false,
  'a delayed checkout cannot grant access after a prior refund'
);

select is(
  (
    select state
    from public.stripe_payment_lifecycle
    where payment_intent_id = 'pi_phase2_refund_first'
  ),
  'refunded',
  'the terminal refund remains the effective payment state'
);

select is(
  (
    select count(*)::integer
    from public.stripe_checkout_access_grants
    where checkout_session_id = 'cs_phase2_delayed'
  ),
  0,
  'the refused delayed checkout creates no access grant'
);

select ok(
  not app_private.has_active_analysis_access('76000000-0000-4000-8000-000000000003'),
  'the refunded payment leaves no active Analyse entitlement'
);

select * from finish();

rollback;
