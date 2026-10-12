begin;
select plan(12);

select is(app_private.sale_street_key('38 avenue des Valampes 13180 Gignac-la-Nerthe'), '38 valampes', 'street key: number and street word');
select is(app_private.sale_street_key('Quartier Capeau 38, av. de Valampes, Gignac'), '38 valampes', 'street key: abbreviated street type');
select is(app_private.sale_street_key('142, rue du Général Leclerc, Rosny-sous-Bois'), '142 leclerc', 'street key: titles are not the street name');
select is(app_private.sale_street_key('Boulevard du Président Kennedy, 93420 Villepinte'), null, 'street key: no number, no key');

insert into public.auction_sales (id, source_name, source_url, status, sale_date, starting_price_eur, city, property_type, address, habitable_surface_m2, raw_payload)
values
  ('c4540000-0000-4000-8000-000000000001', 'pgtap', 'https://example.test/pgtap-passage-current', 'upcoming',
   '2026-12-10T09:00:00+01:00', 120000, 'Montreuil', 'apartment', '63 rue de Chantereines, 93100 Montreuil', 52.66, '{}'::jsonb),
  ('c4540000-0000-4000-8000-000000000002', 'pgtap', 'https://example.test/pgtap-passage-previous', 'past',
   '2026-09-16T09:00:00+02:00', 170000, 'Montreuil', 'apartment', '63, rue Chantereines Montreuil', 52.66, '{}'::jsonb),
  ('c4540000-0000-4000-8000-000000000003', 'pgtap', 'https://example.test/pgtap-passage-other-street', 'past',
   '2026-09-16T09:00:00+02:00', 90000, 'Montreuil', 'apartment', '63 rue de Paris, Montreuil', 52.66, '{}'::jsonb);

select is(
  (select count(*)::int from public.auction_sale_timeline where sale_id = 'c4540000-0000-4000-8000-000000000001' and event_kind = 'first_seen'),
  1,
  'a new listing is recorded as first seen'
);

update public.auction_sales set starting_price_eur = 90000 where id = 'c4540000-0000-4000-8000-000000000001';
select is(
  (select previous_value::text || '→' || new_value::text from public.auction_sale_timeline
    where sale_id = 'c4540000-0000-4000-8000-000000000001' and event_kind = 'starting_price_changed'),
  '120000→90000',
  'a lowered starting price keeps the previous and the new value'
);

-- Two sources alternating between their values: the return is not a new change.
update public.auction_sales set starting_price_eur = 120000 where id = 'c4540000-0000-4000-8000-000000000001';
update public.auction_sales set starting_price_eur = 90000.4 where id = 'c4540000-0000-4000-8000-000000000001';
select is(
  (select count(*)::int from public.auction_sale_timeline where sale_id = 'c4540000-0000-4000-8000-000000000001' and event_kind = 'starting_price_changed'),
  1,
  'alternation and rounding are not recorded as price changes'
);

update public.auction_sales set sale_date = '2026-12-10T14:00:00+01:00' where id = 'c4540000-0000-4000-8000-000000000001';
select is(
  (select count(*)::int from public.auction_sale_timeline where sale_id = 'c4540000-0000-4000-8000-000000000001' and event_kind = 'sale_date_changed'),
  0,
  'a new time on the same day is not a new hearing date'
);

update public.auction_sales set sale_date = '2027-01-14T09:00:00+01:00', status = 'postponed' where id = 'c4540000-0000-4000-8000-000000000001';
select is(
  (select array_agg(event_kind order by event_kind) from public.auction_sale_timeline
    where sale_id = 'c4540000-0000-4000-8000-000000000001' and event_kind in ('sale_date_changed', 'postponed')),
  array['postponed', 'sale_date_changed'],
  'a postponement records the move and the new date'
);

select is(
  jsonb_array_length(public.get_sale_passages('c4540000-0000-4000-8000-000000000001') -> 'previous_passages'),
  1,
  'the earlier hearing at the same address is a previous passage; another street is not'
);
select is(
  (public.get_sale_passages('c4540000-0000-4000-8000-000000000001') -> 'previous_passages' -> 0 ->> 'starting_price_eur')::numeric,
  170000::numeric,
  'the previous passage carries its starting price'
);

select ok(
  not has_function_privilege('authenticated', 'public.get_sale_passages(uuid)', 'execute'),
  'passages are served by the Analyse API only'
);

select * from finish();
rollback;
