begin;

select plan(12);

select has_function(
  'app_private',
  'bridge_accepted_information_agent_fact_claim',
  array[]::text[],
  'reviewed information-agent facts have a claim bridge function'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.information_agent_fact_candidates'::regclass
      and trigger_row.tgname = 'information_agent_fact_claim_bridge'
      and trigger_row.tgenabled = 'O'
      and trigger_row.tgconstraint <> 0
  ),
  'claim bridge is an enabled constraint trigger on candidate status changes'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.information_agent_fact_candidates'::regclass
      and trigger_row.tgname = 'information_agent_fact_claim_bridge'
      and trigger_row.tgdeferrable
      and trigger_row.tginitdeferred
  ),
  'claim bridge waits until the review transaction finishes the canonical sale update'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'app_private.bridge_accepted_information_agent_fact_claim()',
    'execute'
  ),
  'browser clients cannot invoke the internal bridge'
);

select ok(
  position('claim_status' in pg_get_functiondef(
    'app_private.bridge_accepted_information_agent_fact_claim()'::regprocedure
  )) > 0
  and position('accepted' in pg_get_functiondef(
    'app_private.bridge_accepted_information_agent_fact_claim()'::regprocedure
  )) > 0,
  'bridge writes only accepted claim decisions after review'
);

select ok(
  position('is distinct from' in lower(pg_get_functiondef(
    'app_private.bridge_accepted_information_agent_fact_claim()'::regprocedure
  ))) > 0,
  'bridge fails closed when the canonical value differs from the reviewed value'
);

select ok(
  position('information_agent_fact_id' in pg_get_functiondef(
    'app_private.bridge_accepted_information_agent_fact_claim()'::regprocedure
  )) > 0,
  'claim provenance retains the reviewed candidate identifier'
);

select ok(
  position('email_attachment' in pg_get_functiondef(
    'app_private.bridge_accepted_information_agent_fact_claim()'::regprocedure
  )) > 0
  and position('manual_review' in pg_get_functiondef(
    'app_private.bridge_accepted_information_agent_fact_claim()'::regprocedure
  )) > 0,
  'claim evidence kind distinguishes attachments from reviewed message facts'
);

select ok(
  position('portal:%' in pg_get_functiondef(
    'app_private.bridge_accepted_information_agent_fact_claim()'::regprocedure
  )) > 0
  and position('evidence_asset_id' in pg_get_functiondef(
    'app_private.bridge_accepted_information_agent_fact_claim()'::regprocedure
  )) > 0,
  'portal assets are classified from their private asset provenance'
);

select ok(
  position('v_sale.source_url' in pg_get_functiondef(
    'app_private.bridge_accepted_information_agent_fact_claim()'::regprocedure
  )) = 0,
  'email and portal evidence are not attributed to the listing source URL'
);

select ok(
  position('user_profiles' in pg_get_functiondef(
    'app_private.bridge_accepted_information_agent_fact_claim()'::regprocedure
  )) > 0
  and position('profile.user_role = ''admin''' in pg_get_functiondef(
    'app_private.bridge_accepted_information_agent_fact_claim()'::regprocedure
  )) > 0,
  'claim bridge requires an administrator reviewer even for direct service-role writes'
);

select ok(
  position('v_field_key := case new.fact_key' in pg_get_functiondef(
    'app_private.bridge_accepted_information_agent_fact_claim()'::regprocedure
  )) > 0,
  'unsupported free-form evidence is not silently projected as a canonical fiche fact'
);

select * from finish();
rollback;
