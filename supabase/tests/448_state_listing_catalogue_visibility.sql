begin;

select plan(13);

-- Marqueur state_listing des cessions de l'État : visibilité sans sale_date,
-- sans rien changer à la rétention. Les lignes insérées sont annulées en fin de test.

select ok(
  app_private.state_listing_is_live(jsonb_build_object(
    'source_name', 'cessions_etat',
    'state_listing', jsonb_build_object(
      'active', true,
      'observed_at', to_char((current_timestamp - interval '2 days') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"+00:00"'),
      'reason', 'procedure_pending'
    )
  )),
  'a cessions listing observed active two days ago is live'
);

select ok(
  not app_private.state_listing_is_live(jsonb_build_object(
    'source_name', 'cessions_etat',
    'state_listing', jsonb_build_object(
      'active', true,
      'observed_at', to_char((current_timestamp - interval '20 days') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"+00:00"')
    )
  )),
  'a listing not observed for 20 days leaves the catalogue'
);

select ok(
  not app_private.state_listing_is_live(jsonb_build_object(
    'source_name', 'cessions_etat',
    'state_listing', jsonb_build_object(
      'active', true,
      'observed_at', to_char((current_timestamp - interval '1 day') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"+00:00"'),
      'listing_end_estimate', to_char(current_date - 3, 'YYYY-MM-DD')
    )
  )),
  'a listing whose estimated publication end has passed is not live'
);

select ok(
  app_private.state_listing_is_live(jsonb_build_object(
    'source_name', 'cessions_etat',
    'state_listing', jsonb_build_object(
      'active', true,
      'observed_at', to_char((current_timestamp - interval '1 day') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"+00:00"'),
      'listing_end_estimate', to_char(current_date + 20, 'YYYY-MM-DD')
    )
  )),
  'a listing whose estimated publication end is ahead stays live'
);

select ok(
  not app_private.state_listing_is_live(jsonb_build_object(
    'source_name', 'licitor',
    'state_listing', jsonb_build_object(
      'active', true,
      'observed_at', to_char(current_timestamp at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"+00:00"')
    )
  )),
  'the undated rule is reserved to the cessions_etat source'
);

select ok(
  not app_private.state_listing_is_live(
    '{"source_name": "cessions_etat", "state_listing": {"active": true, "observed_at": "hier"}}'::jsonb
  )
  and not app_private.state_listing_is_live(null)
  and not app_private.state_listing_is_live('[]'::jsonb),
  'malformed markers are not live and never raise'
);

select is(
  app_private.sale_catalogue_entry_is_live(null, '{}'::jsonb),
  false,
  'an undated sale without marker is still invisible (false, not null)'
);

select ok(
  app_private.sale_catalogue_entry_is_live(current_timestamp + interval '3 days', '{}'::jsonb)
  and not app_private.sale_catalogue_entry_is_live(current_timestamp - interval '3 days', '{}'::jsonb),
  'dated sales keep their catalogue cutoff'
);

insert into public.auction_sales (id, source_name, source_url, status, sale_date, raw_payload)
values
  (
    'c4470000-0000-4000-8000-000000000001'::uuid,
    'cessions_etat',
    'https://cessions.immobilier-etat.gouv.fr/biens/pgtap-procedure-a-venir',
    'upcoming',
    null,
    jsonb_build_object(
      'source_name', 'cessions_etat',
      'state_listing', jsonb_build_object(
        'active', true,
        'observed_at', to_char((current_timestamp - interval '1 day') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"+00:00"'),
        'reason', 'procedure_pending'
      )
    )
  ),
  (
    'c4470000-0000-4000-8000-000000000002'::uuid,
    'cessions_etat',
    'https://cessions.immobilier-etat.gouv.fr/biens/pgtap-annonce-perimee',
    'upcoming',
    null,
    jsonb_build_object(
      'source_name', 'cessions_etat',
      'state_listing', jsonb_build_object(
        'active', true,
        'observed_at', to_char((current_timestamp - interval '30 days') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"+00:00"')
      )
    )
  );

select ok(
  app_private.auction_sale_is_publicly_visible('c4470000-0000-4000-8000-000000000001'::uuid),
  'a fresh « Procédure à venir » state listing is publicly visible'
);

select ok(
  not app_private.auction_sale_is_publicly_visible('c4470000-0000-4000-8000-000000000002'::uuid),
  'a stale state listing is not publicly visible'
);

select is(
  (select catalogue_expiry_deadline from public.auction_sales where id = 'c4470000-0000-4000-8000-000000000001'::uuid),
  null::timestamptz,
  'retention keeps a null catalogue deadline: no invented date, no purge, no null-date tombstone'
);

select is(
  (select retention_deadline from public.auction_sales where id = 'c4470000-0000-4000-8000-000000000001'::uuid),
  null::timestamptz,
  'the historical retention deadline is unchanged (null) for an undated listing'
);

select ok(
  has_function_privilege('anon', 'app_private.state_listing_is_live(jsonb)', 'execute')
  and has_function_privilege('authenticated', 'app_private.state_listing_is_live(jsonb)', 'execute'),
  'catalogue readers can evaluate the undated visibility rule'
);

select * from finish();

rollback;
