-- 20261116100500 : déclencheur de retenue aaab_auction_sales_hold_projected_fields (lot R1, étape M4).
--   * chemin rapide : une vente qui ne tient rien se réécrit comme avant, sans évènement ;
--   * vente tenue, ré-import par le rôle de la collecte (insert … on conflict (source_url) do update) :
--     même valeur d'annonce, écho de la valeur tenue, valeur qui ne dit rien : la pièce reste, sans évènement ;
--     nouvelle valeur : évènement, puis la pièce reste (keep_and_review, défaut) ou l'annonce passe et le champ
--     est libéré (listing_wins_and_review, réglage en données) ;
--   * le groupe de surface (cinq colonnes) reste cohérent, à la retenue comme à la libération ; content_changed_at
--     ne bouge pas quand la retenue annule une réécriture ;
--   * nombre de chambres incompatible avec le nombre de pièces tenu : l'écrivain n'échoue jamais ;
--   * une annonce qui oscille n'ajoute pas un évènement à chaque import ;
--   * toute écriture de held_fields hors projection est refusée (42501), et toujours pour un rôle de l'API.
begin;

set local timezone = 'UTC';

select plan(79);

-- Déclencheurs : forme et ordre -----------------------------------------------------------------------------------
select ok(
  (select pg_get_triggerdef(oid) from pg_trigger
     where tgrelid = 'public.auction_sales'::regclass and tgname = 'aaab_auction_sales_hold_projected_fields')
    ~ 'BEFORE UPDATE OF surface_m2, app_surface_m2, app_surface_kind, surface_source, surface_confidence, land_surface_m2, rooms_count, bedrooms_count, occupancy_status, visit_dates, held_fields ON public\.auction_sales FOR EACH ROW WHEN \(\(\(old\.held_fields IS NOT NULL\) OR \(new\.held_fields IS DISTINCT FROM old\.held_fields\)\)\) EXECUTE FUNCTION app_private\.hold_projected_sale_fields\(\)',
  'the hold trigger fires before an update of the held columns, only for a sale that holds a field'
);

select is(
  (select array_agg(tgname::text order by tgname) from (
     select tgname from pg_trigger
     where tgrelid = 'public.auction_sales'::regclass and not tgisinternal
       and (tgtype & 2) = 2 and (tgtype & 16) = 16
     order by tgname limit 3) first_triggers),
  array[
    'aaaa_auction_sales_retention_tombstone_guard_update', 'aaab_auction_sales_held_fields_role_guard',
    'aaab_auction_sales_hold_projected_fields'
  ],
  'the role guard then the hold run right after the retention guard, before every other BEFORE UPDATE trigger'
);

select ok(
  (select pg_get_triggerdef(oid) from pg_trigger
     where tgrelid = 'public.auction_sales'::regclass and tgname = 'aaab_auction_sales_held_fields_role_guard')
    ~ 'BEFORE UPDATE OF held_fields ON public\.auction_sales FOR EACH ROW WHEN \(\(new\.held_fields IS DISTINCT FROM old\.held_fields\)\) EXECUTE FUNCTION app_private\.refuse_api_role_held_fields_write\(\)',
  'the role guard only fires when a statement changes held_fields'
);

select ok(
  (select prosrc !~* 'to_jsonb\s*\(\s*(new|old)\s*\)' and prosrc !~* 'raw_payload'
          and prosrc !~* 'auction_fact_claims|auction_fact_claim_decisions|auction_fact_source_precedence'
          and prosrc !~* 'project_sale_fields\s*\('
     from pg_proc where oid = 'app_private.hold_projected_sale_fields()'::regprocedure),
  'the hold function is passive: no whole-row conversion, no raw_payload, no claim, no decision, no projection call'
);

select ok(
  (select not prosecdef from pg_proc
     where oid = 'app_private.refuse_api_role_held_fields_write()'::regprocedure)
  and (select prosecdef and proconfig @> array['search_path=""']::text[]
         from pg_proc where oid = 'app_private.hold_projected_sale_fields()'::regprocedure),
  'the role guard reads the calling role (security invoker); the hold writes the queue (security definer)'
);

select is(
  (select count(*)::integer
     from unnest(array[
       'app_private.hold_projected_sale_fields()', 'app_private.refuse_inserted_held_fields()',
       'app_private.refuse_api_role_held_fields_write()', 'app_private.refuse_api_role_registry_origin()',
       'app_private.stamp_fact_registry_event()']) routine(signature)
     cross join unnest(array['anon', 'authenticated', 'service_role']) api_role(name)
     where has_function_privilege(api_role.name, routine.signature, 'execute')),
  0,
  'no API role can execute the trigger functions of the registry'
);

-- Jeu d'essai ---------------------------------------------------------------------------------------------------
insert into auth.users (id) values ('88200000-0000-4000-8000-0000000000a1');
insert into public.user_profiles (user_id, email, user_role) values
  ('88200000-0000-4000-8000-0000000000a1', 'registre-admin-882@example.test', 'admin')
on conflict (user_id) do update set user_role = excluded.user_role;

insert into public.auction_sales (
  id, source_name, source_url, status, sale_date, city, property_type, starting_price_eur,
  raw_payload, sale_procedure, sale_venue_type,
  surface_m2, app_surface_m2, app_surface_kind, surface_source, surface_confidence,
  land_surface_m2, rooms_count, bedrooms_count, occupancy_status, visit_dates
)
select
  ('88200000-1000-4000-8000-00000000000' || sale.n)::uuid, 'licitor', 'https://example.test/882/' || sale.slug,
  'upcoming', current_timestamp + interval '20 days', 'Alphaville', 'house', 90000, '{}'::jsonb, '{}'::jsonb,
  'tribunal', sale.surface_m2, 50, 'habitable', 'listing_text', 0.7, null, sale.rooms_count, 1, 'occupied',
  '[]'::jsonb
from (values
  -- 0 : témoin, ne tient rien. 1 : réglage par défaut (keep_and_review). 2 : réglage inverse.
  (0, 'control', 50, 2), (1, 'kept', 50, 2), (2, 'released', 50, 2),
  -- 4 et 5 : réglage inverse, nombre de pièces seul (annonce : 2 pièces, puis 6 pièces).
  (4, 'rooms-low', 50, 2), (5, 'rooms-high', 50, 6),
  -- 6 (réglage inverse) et 7 (défaut) : l'annonce donne 120 m² en surface_m2 et 50 m² en app_surface_m2.
  (6, 'group-released', 120, 2), (7, 'group-kept', 120, 2)
) sale(n, slug, surface_m2, rooms_count);

-- Pièces d'un avocat (même dossier) : surface 54, terrain 800, 3 pièces, libre. Ventes 1 et 2 : les quatre ;
-- ventes 4 et 5 : le nombre de pièces ; ventes 6 et 7 : la surface.
insert into public.auction_fact_claims (
  id, auction_sale_id, field_key, value_jsonb, evidence_kind, evidence_locator, confidence_score,
  extractor_name, extractor_version, created_by
)
select
  ('88200000-2000-4000-8000-0000000000' || sale.n || piece.suffix)::uuid,
  ('88200000-1000-4000-8000-00000000000' || sale.n)::uuid,
  piece.field_key, piece.value_jsonb, 'professional_email',
  jsonb_build_object('case_id', '88200000-3000-4000-8000-00000000000' || sale.n),
  0.6, 'information_agent', 'v1', '88200000-0000-4000-8000-0000000000a1'
from (values (1, 'all'), (2, 'all'), (4, 'rooms'), (5, 'rooms'), (6, 'surface'), (7, 'surface')) sale(n, pieces)
join (values
  ('1', 'property.surface_m2', '54'::jsonb, 'surface'),
  ('2', 'property.land_surface_m2', '800'::jsonb, null),
  ('3', 'property.rooms_count', '3'::jsonb, 'rooms'),
  ('4', 'property.occupancy_status', '"vacant"'::jsonb, null)
) piece(suffix, field_key, value_jsonb, family)
  on sale.pieces = 'all' or sale.pieces = piece.family;

insert into public.auction_fact_claim_decisions (
  claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id, recipient_kind, received_at
)
select claim.id, claim.auction_sale_id, claim.field_key, 'accepted', 'single_lot', 'admin',
  '88200000-0000-4000-8000-0000000000a1', 'source_lawyer', '2026-10-12 09:00:00+00'
from public.auction_fact_claims claim
where claim.id::text like '88200000-2000-%';

-- Ventes 1 et 7 : projetées avec le réglage par défaut. Les autres : après le réglage inverse, posé en données.
select app_private.project_sale_fields('88200000-1000-4000-8000-000000000001', null, true) ->> 'changed';
select app_private.project_sale_fields('88200000-1000-4000-8000-000000000007', null, true) ->> 'changed';
update public.auction_fact_fields set on_listing_change = 'listing_wins_and_review';
select app_private.project_sale_fields(('88200000-1000-4000-8000-00000000000' || n)::uuid, null, true)
  ->> 'changed'
from unnest(array[2, 4, 5, 6]) n;

select results_eq(
  $$select surface_m2, app_surface_m2, app_surface_kind, surface_source, surface_confidence,
           land_surface_m2, rooms_count, occupancy_status
      from public.auction_sales where id = '88200000-1000-4000-8000-000000000001'$$,
  $$values (54::numeric, 54::numeric, 'fact_registry_lawyer_email', 'fact_registry_lawyer_email',
            0.85::numeric, 800::numeric, 3, 'vacant')$$,
  'the projection wrote the four pieces of the lawyer on the kept sale'
);

select is(
  (select array_agg(field.key || ':' || (field.value ->> 'on_listing_change') order by field.key)
     from public.auction_sales sale, jsonb_each(sale.held_fields) field
     where sale.id = '88200000-1000-4000-8000-000000000001'),
  array[
    'property.land_surface_m2:keep_and_review', 'property.occupancy_status:keep_and_review',
    'property.rooms_count:keep_and_review', 'property.surface_m2:keep_and_review'
  ],
  'the kept sale holds four fields with the default setting copied in each entry'
);

select is(
  (select count(*)::integer
     from public.auction_sales sale, jsonb_each(sale.held_fields) field
     where sale.id = '88200000-1000-4000-8000-000000000002'
       and field.value ->> 'on_listing_change' = 'listing_wins_and_review'),
  4,
  'the other sale holds four fields with the opposite setting, set in data'
);

-- Date de contenu ancienne, pour voir si une écriture la change (now() est fixe dans une transaction).
update public.auction_sales set content_changed_at = '2026-01-01 00:00:00+00'
where id::text like '88200000-1000-%';

create temporary table hold_marks on commit drop as
select id, held_fields from public.auction_sales where id::text like '88200000-1000-%';
grant select on hold_marks to service_role;

-- Ré-import de la collecte : la requête de _transaction_write, colonnes de la fiche concernées.
prepare reimport(text, numeric, numeric, text, text, numeric, numeric, integer, integer, text) as
  insert into public.auction_sales (
    source_name, source_url, status, city, property_type, starting_price_eur, raw_payload, sale_procedure,
    surface_m2, app_surface_m2, app_surface_kind, surface_source, surface_confidence,
    land_surface_m2, rooms_count, bedrooms_count, occupancy_status, visit_dates, updated_at
  ) values (
    'licitor', $1, 'upcoming', 'Alphaville', 'house', 90000, '{}'::jsonb, '{}'::jsonb,
    $2, $3, $4, $5, $6, $7, $8, $9, $10, '[]'::jsonb, statement_timestamp()
  )
  on conflict (source_url) do update set
    source_name = excluded.source_name, status = excluded.status, city = excluded.city,
    property_type = excluded.property_type, starting_price_eur = excluded.starting_price_eur,
    raw_payload = excluded.raw_payload, sale_procedure = excluded.sale_procedure,
    surface_m2 = excluded.surface_m2, app_surface_m2 = excluded.app_surface_m2,
    app_surface_kind = excluded.app_surface_kind, surface_source = excluded.surface_source,
    surface_confidence = excluded.surface_confidence, land_surface_m2 = excluded.land_surface_m2,
    rooms_count = excluded.rooms_count, bedrooms_count = excluded.bedrooms_count,
    occupancy_status = excluded.occupancy_status, visit_dates = excluded.visit_dates,
    updated_at = excluded.updated_at;

-- Chemin rapide --------------------------------------------------------------------------------------------------
set local role service_role;
execute reimport('https://example.test/882/control', 61, 61, 'carrez', 'pdf', 0.9, 300, 4, 2, 'rented');
reset role;

select results_eq(
  $$select surface_m2, app_surface_m2, app_surface_kind, surface_source, surface_confidence,
           land_surface_m2, rooms_count, bedrooms_count, occupancy_status, held_fields
      from public.auction_sales where id = '88200000-1000-4000-8000-000000000000'$$,
  $$values (61::numeric, 61::numeric, 'carrez', 'pdf', 0.9::numeric, 300::numeric, 4, 2, 'rented',
            null::jsonb)$$,
  'fast path: a sale that holds nothing is rewritten by the collection as before'
);

select isnt(
  (select content_changed_at from public.auction_sales where id = '88200000-1000-4000-8000-000000000000'),
  '2026-01-01 00:00:00+00'::timestamptz,
  'fast path: the content date of the rewritten sale moves, as before'
);

select is(
  (select count(*)::integer from public.auction_sale_field_hold_events
     where sale_id = '88200000-1000-4000-8000-000000000000'),
  0,
  'fast path: no hold event for a sale that holds nothing'
);

-- (a) Même valeur d'annonce : l'annonce dit toujours 50 m², 2 pièces, occupé ----------------------------------
set local role service_role;
execute reimport('https://example.test/882/kept', 50, 50, 'habitable', 'listing_text', 0.7, null, 2, 1, 'occupied');
execute reimport('https://example.test/882/released', 50, 50, 'habitable', 'listing_text', 0.7, null, 2, 1, 'occupied');
reset role;

select results_eq(
  $$select surface_m2, app_surface_m2, app_surface_kind, surface_source, surface_confidence,
           land_surface_m2, rooms_count, occupancy_status
      from public.auction_sales
      where id in ('88200000-1000-4000-8000-000000000001', '88200000-1000-4000-8000-000000000002')
      order by id$$,
  $$values
      (54::numeric, 54::numeric, 'fact_registry_lawyer_email', 'fact_registry_lawyer_email', 0.85::numeric,
        800::numeric, 3, 'vacant'),
      (54::numeric, 54::numeric, 'fact_registry_lawyer_email', 'fact_registry_lawyer_email', 0.85::numeric,
        800::numeric, 3, 'vacant')$$,
  '(a) an unchanged listing does not erase the pieces, in either setting'
);

-- (b) Écho : la collecte renvoie la valeur tenue (rétro-remplissage), avec ses propres étiquettes --------------
set local role service_role;
execute reimport('https://example.test/882/kept', 54, 54, 'habitable', 'listing_text', 0.7, 800, 3, 1, 'vacant');
execute reimport('https://example.test/882/released', 54.5, 54.5, 'habitable', 'listing_text', 0.7, 801, 3, 1, 'vacant');
reset role;

select results_eq(
  $$select surface_m2, app_surface_m2, app_surface_kind, surface_source, surface_confidence,
           land_surface_m2, rooms_count, occupancy_status
      from public.auction_sales
      where id in ('88200000-1000-4000-8000-000000000001', '88200000-1000-4000-8000-000000000002')
      order by id$$,
  $$values
      (54::numeric, 54::numeric, 'fact_registry_lawyer_email', 'fact_registry_lawyer_email', 0.85::numeric,
        800::numeric, 3, 'vacant'),
      (54::numeric, 54::numeric, 'fact_registry_lawyer_email', 'fact_registry_lawyer_email', 0.85::numeric,
        800::numeric, 3, 'vacant')$$,
  '(b) an echo of the held value, exact or within tolerance, keeps the piece and its whole surface group'
);

-- (c) Valeur qui ne dit rien : nulle, surface nulle ou négative, occupation « unknown » ------------------------
set local role service_role;
execute reimport('https://example.test/882/kept', null, null, null, null, null, null, null, 1, 'unknown');
execute reimport('https://example.test/882/released', null, null, null, null, null, null, null, 1, null);
execute reimport('https://example.test/882/kept', 0, 0, 'habitable', 'listing_text', 0.7, -5, null, 1, 'unknown');
execute reimport('https://example.test/882/released', -12, 0, 'habitable', 'listing_text', 0.7, 0, null, 1, null);
reset role;

select results_eq(
  $$select surface_m2, app_surface_m2, app_surface_kind, surface_source, surface_confidence,
           land_surface_m2, rooms_count, occupancy_status
      from public.auction_sales
      where id in ('88200000-1000-4000-8000-000000000001', '88200000-1000-4000-8000-000000000002')
      order by id$$,
  $$values
      (54::numeric, 54::numeric, 'fact_registry_lawyer_email', 'fact_registry_lawyer_email', 0.85::numeric,
        800::numeric, 3, 'vacant'),
      (54::numeric, 54::numeric, 'fact_registry_lawyer_email', 'fact_registry_lawyer_email', 0.85::numeric,
        800::numeric, 3, 'vacant')$$,
  '(c) a listing that says nothing (null, zero or negative surface, unknown occupancy) keeps the pieces'
);

select is(
  (select count(*)::integer from public.auction_sale_field_hold_events
     where sale_id in ('88200000-1000-4000-8000-000000000001', '88200000-1000-4000-8000-000000000002')
       and event like 'listing_changed%'),
  0,
  '(a) (b) (c) write no review event'
);

select is(
  (select count(*)::integer from public.auction_sales sale join hold_marks mark using (id)
     where sale.held_fields is distinct from mark.held_fields),
  0,
  '(a) (b) (c) leave held_fields untouched'
);

select is(
  (select array_agg(content_changed_at order by id) from public.auction_sales
     where id in ('88200000-1000-4000-8000-000000000001', '88200000-1000-4000-8000-000000000002')),
  array['2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00']::timestamptz[],
  'a rewrite cancelled by the hold does not move the content date (the hold runs before the dating trigger)'
);

-- (d) Nouvelle valeur, réglage par défaut : la pièce reste, le cas part en relecture ---------------------------
set local role service_role;
execute reimport('https://example.test/882/kept', 60, 60, 'carrez', 'pdf', 0.9, 900, 4, 1, 'rented');
reset role;

select results_eq(
  $$select surface_m2, app_surface_m2, app_surface_kind, surface_source, surface_confidence,
           land_surface_m2, rooms_count, bedrooms_count, occupancy_status
      from public.auction_sales where id = '88200000-1000-4000-8000-000000000001'$$,
  $$values (54::numeric, 54::numeric, 'fact_registry_lawyer_email', 'fact_registry_lawyer_email',
            0.85::numeric, 800::numeric, 3, 1, 'vacant')$$,
  '(d) keep_and_review: the changed listing does not replace the pieces'
);

select results_eq(
  $$select field_key, event, held_value, listing_value, incoming_value, decision_id is not null
      from public.auction_sale_field_hold_events
      where sale_id = '88200000-1000-4000-8000-000000000001' and event like 'listing_changed%'
      order by field_key$$,
  $$values
      ('property.land_surface_m2', 'listing_changed_kept', '800'::jsonb, null::jsonb, '900'::jsonb, true),
      ('property.occupancy_status', 'listing_changed_kept', '"vacant"'::jsonb, '"occupied"'::jsonb,
        '"rented"'::jsonb, true),
      ('property.rooms_count', 'listing_changed_kept', '3'::jsonb, '2'::jsonb, '4'::jsonb, true),
      ('property.surface_m2', 'listing_changed_kept', '54'::jsonb, '50'::jsonb, '60'::jsonb, true)$$,
  '(d) keep_and_review: one review event per field, with the held, previous and new listing values'
);

select is(
  (select jsonb_build_object(
     'surface', held_fields #> '{property.surface_m2,listing}',
     'land', held_fields #> '{property.land_surface_m2,listing}',
     'rooms', held_fields #> '{property.rooms_count,listing}',
     'occupancy', held_fields #> '{property.occupancy_status,listing}',
     'values', jsonb_build_array(
       held_fields #> '{property.surface_m2,value}', held_fields #> '{property.rooms_count,value}'))
     from public.auction_sales where id = '88200000-1000-4000-8000-000000000001'),
  '{
     "surface": {"surface_m2": 60, "app_surface_m2": 60, "app_surface_kind": "carrez", "surface_source": "pdf",
                 "surface_confidence": 0.9},
     "land": {"land_surface_m2": 900},
     "rooms": {"rooms_count": 4},
     "occupancy": {"occupancy_status": "rented"},
     "values": [54, 3]
   }'::jsonb,
  '(d) keep_and_review: the entry remembers the new listing value, the held value is unchanged'
);

select is(
  (select content_changed_at from public.auction_sales where id = '88200000-1000-4000-8000-000000000001'),
  '2026-01-01 00:00:00+00'::timestamptz,
  '(d) keep_and_review: the held surface and room count do not move the content date'
);

-- La même annonce au passage suivant : plus d'évènement (la dernière valeur connue de l'annonce est à jour).
set local role service_role;
execute reimport('https://example.test/882/kept', 60, 60, 'carrez', 'pdf', 0.9, 900, 4, 1, 'rented');
reset role;

select is(
  (select count(*)::integer from public.auction_sale_field_hold_events
     where sale_id = '88200000-1000-4000-8000-000000000001' and event like 'listing_changed%'),
  4,
  '(d) keep_and_review: the same listing at the next import writes no second event'
);

-- Une annonce qui oscille entre deux états : un évènement par valeur, pas un par import.
set local role service_role;
execute reimport('https://example.test/882/kept', 50, 50, 'habitable', 'listing_text', 0.7, null, 2, 1, 'occupied');
reset role;

select is(
  (select array_agg(field_key || '=' || incoming_value::text order by seq)
     from public.auction_sale_field_hold_events
     where sale_id = '88200000-1000-4000-8000-000000000001' and event like 'listing_changed%'),
  array[
    'property.land_surface_m2=900', 'property.occupancy_status="rented"', 'property.rooms_count=4',
    'property.surface_m2=60',
    'property.occupancy_status="occupied"', 'property.rooms_count=2', 'property.surface_m2=50'
  ],
  'the listing goes back to its first values: one more event per field that says something'
);

set local role service_role;
execute reimport('https://example.test/882/kept', 60, 60, 'carrez', 'pdf', 0.9, 900, 4, 1, 'rented');
execute reimport('https://example.test/882/kept', 50, 50, 'habitable', 'listing_text', 0.7, null, 2, 1, 'occupied');
execute reimport('https://example.test/882/kept', 60, 60, 'carrez', 'pdf', 0.9, 900, 4, 1, 'rented');
reset role;

select results_eq(
  $$select (select count(*)::integer from public.auction_sale_field_hold_events event
              where event.sale_id = sale.id and event.event like 'listing_changed%'),
           sale.surface_m2, sale.rooms_count,
           sale.held_fields #> '{property.surface_m2,listing,surface_m2}'
      from public.auction_sales sale where sale.id = '88200000-1000-4000-8000-000000000001'$$,
  $$values (7, 54::numeric, 3, '60'::jsonb)$$,
  'a listing that oscillates between two states adds no event; the pieces stay and the last listing value is kept'
);

-- Occupation : la file ne garde que « libre », « occupé », « loué » (jamais qui occupe ni pourquoi) ---------------
set local role service_role;
execute reimport('https://example.test/882/kept', 60, 60, 'carrez', 'pdf', 0.9, 900, 4, 1, 'owner_occupied');
execute reimport('https://example.test/882/kept', 60, 60, 'carrez', 'pdf', 0.9, 900, 4, 1, 'squatted');
reset role;

select results_eq(
  $$select sale.occupancy_status, sale.held_fields #>> '{property.occupancy_status,listing,occupancy_status}',
           (select array_agg(event.incoming_value #>> '{}' order by event.seq)
              from public.auction_sale_field_hold_events event
              where event.sale_id = sale.id and event.field_key = 'property.occupancy_status'
                and event.event like 'listing_changed%')
      from public.auction_sales sale where sale.id = '88200000-1000-4000-8000-000000000001'$$,
  $$values ('vacant', 'owner_occupied', array['rented', 'occupied'])$$,
  'a listing that says who occupies is compared as « occupied »: no new event, and the piece stays'
);

select is(
  (select count(*)::integer from public.auction_sale_field_hold_events
     where concat(held_value::text, listing_value::text, incoming_value::text) ~ 'owner_occupied|squatted'),
  0,
  'the event queue never stores who occupies or why'
);

-- (d) Nouvelle valeur, réglage inverse : seule la surface change d'abord ---------------------------------------
set local role service_role;
execute reimport('https://example.test/882/released', 60, 60, 'carrez', 'pdf', 0.9, null, 2, 1, 'occupied');
reset role;

select results_eq(
  $$select surface_m2, app_surface_m2, app_surface_kind, surface_source, surface_confidence,
           land_surface_m2, rooms_count, occupancy_status
      from public.auction_sales where id = '88200000-1000-4000-8000-000000000002'$$,
  $$values (60::numeric, 60::numeric, 'carrez', 'pdf', 0.9::numeric, 800::numeric, 3, 'vacant')$$,
  '(d) listing_wins_and_review: the changed surface passes with its whole group, the other pieces stay'
);

select is(
  (select array_agg(field.key order by field.key)
     from public.auction_sales sale, jsonb_object_keys(sale.held_fields) field(key)
     where sale.id = '88200000-1000-4000-8000-000000000002'),
  array['property.land_surface_m2', 'property.occupancy_status', 'property.rooms_count'],
  '(d) listing_wins_and_review: the surface is released, the three other fields are still held'
);

select results_eq(
  $$select field_key, event, held_value, listing_value, incoming_value
      from public.auction_sale_field_hold_events
      where sale_id = '88200000-1000-4000-8000-000000000002' and event like 'listing_changed%'$$,
  $$values ('property.surface_m2', 'listing_changed_released', '54'::jsonb, '50'::jsonb, '60'::jsonb)$$,
  '(d) listing_wins_and_review: the release is journaled for review with the three values'
);

select isnt(
  (select content_changed_at from public.auction_sales where id = '88200000-1000-4000-8000-000000000002'),
  '2026-01-01 00:00:00+00'::timestamptz,
  '(d) listing_wins_and_review: a surface that really changes moves the content date'
);

-- Libération durable : la projection suivante ne reprend pas le champ que l'annonce a délogé.
select is(
  app_private.project_sale_fields('88200000-1000-4000-8000-000000000002', null, true)
    #> '{fields,property.surface_m2}',
  '{"state": "pass_through"}'::jsonb,
  'after a release by the listing, the next projection does not take the field back'
);

select results_eq(
  $$select surface_m2, app_surface_m2, held_fields ? 'property.surface_m2'
      from public.auction_sales where id = '88200000-1000-4000-8000-000000000002'$$,
  $$values (60::numeric, 60::numeric, false)$$,
  'the listing value that won stays displayed'
);

-- Il faut une nouvelle décision humaine, postérieure à la libération.
insert into public.auction_fact_claim_decisions (
  claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id, recipient_kind, received_at,
  supersedes_decision_id
)
select decision.claim_id, decision.sale_id, decision.field_key, 'accepted', 'single_lot', 'admin',
  '88200000-0000-4000-8000-0000000000a1', 'source_lawyer', decision.received_at, decision.id
from public.auction_fact_claim_decisions decision
where decision.claim_id = '88200000-2000-4000-8000-000000000021';

select results_eq(
  $$select app_private.project_sale_fields('88200000-1000-4000-8000-000000000002', null, true)
             #>> '{fields,property.surface_m2,state}'$$,
  $$values ('held')$$,
  'a new acceptance, taken after the release, holds the field again'
);

select is(
  (select held_fields #> '{property.surface_m2,listing}' from public.auction_sales
     where id = '88200000-1000-4000-8000-000000000002'),
  '{"surface_m2": 60, "app_surface_m2": 60, "app_surface_kind": "carrez", "surface_source": "pdf",
    "surface_confidence": 0.9}'::jsonb,
  'and its listing block is the listing value that had won'
);

-- Puis tout change : plus rien n'est tenu.
set local role service_role;
execute reimport('https://example.test/882/released', 70, 70, 'carrez', 'pdf', 0.9, 900, 4, 2, 'rented');
reset role;

select results_eq(
  $$select surface_m2, land_surface_m2, rooms_count, bedrooms_count, occupancy_status, held_fields
      from public.auction_sales where id = '88200000-1000-4000-8000-000000000002'$$,
  $$values (70::numeric, 900::numeric, 4, 2, 'rented', null::jsonb)$$,
  '(d) listing_wins_and_review: once every field is released, held_fields is null again'
);

select is(
  (select count(*)::integer from public.auction_sale_field_hold_events
     where sale_id = '88200000-1000-4000-8000-000000000002' and event = 'listing_changed_released'),
  5,
  '(d) listing_wins_and_review: five releases journaled in all (the surface twice)'
);

-- Groupe de surface : annonce où surface_m2 (120) diffère de app_surface_m2 (50) ---------------------------------
select results_eq(
  $$select id, surface_m2, app_surface_m2, held_fields #> '{property.surface_m2,listing}'
      from public.auction_sales
      where id in ('88200000-1000-4000-8000-000000000006', '88200000-1000-4000-8000-000000000007')
      order by id$$,
  $$values
      ('88200000-1000-4000-8000-000000000006'::uuid, 54::numeric, 54::numeric,
        '{"surface_m2": 120, "app_surface_m2": 50, "app_surface_kind": "habitable",
          "surface_source": "listing_text", "surface_confidence": 0.7}'::jsonb),
      ('88200000-1000-4000-8000-000000000007'::uuid, 54::numeric, 54::numeric,
        '{"surface_m2": 120, "app_surface_m2": 50, "app_surface_kind": "habitable",
          "surface_source": "listing_text", "surface_confidence": 0.7}'::jsonb)$$,
  'a piece holds both value columns; the listing block remembers each of them'
);

set local role service_role;
execute reimport('https://example.test/882/group-kept', 120, 50, 'habitable', 'listing_text', 0.7, null, 2, 1, 'occupied');
execute reimport('https://example.test/882/group-released', 120, 50, 'habitable', 'listing_text', 0.7, null, 2, 1, 'occupied');
reset role;

select is(
  (select count(*)::integer from public.auction_sale_field_hold_events
     where sale_id in ('88200000-1000-4000-8000-000000000006', '88200000-1000-4000-8000-000000000007')
       and event like 'listing_changed%'),
  0,
  'the same listing, column by column, is not a change'
);

-- Écriture complète où seule surface_m2 change (app_surface_m2 dit toujours 50).
set local role service_role;
execute reimport('https://example.test/882/group-kept', 130, 50, 'habitable', 'listing_text', 0.7, null, 2, 1, 'occupied');
reset role;

select results_eq(
  $$select sale.surface_m2, sale.app_surface_m2, event.event, event.listing_value, event.incoming_value,
           sale.held_fields #> '{property.surface_m2,listing,surface_m2}',
           sale.held_fields #> '{property.surface_m2,listing,app_surface_m2}'
      from public.auction_sales sale
      join public.auction_sale_field_hold_events event
        on event.sale_id = sale.id and event.event like 'listing_changed%'
      where sale.id = '88200000-1000-4000-8000-000000000007'$$,
  $$values (54::numeric, 54::numeric, 'listing_changed_kept', '120'::jsonb, '130'::jsonb, '130'::jsonb,
            '50'::jsonb)$$,
  'a complete write that only changes surface_m2 is seen as a change of the listing'
);

-- Écriture partielle sur le réglage inverse : la libération ne laisse aucune colonne de la pièce.
update public.auction_sales set surface_m2 = 70 where id = '88200000-1000-4000-8000-000000000006';

select results_eq(
  $$select surface_m2, app_surface_m2, app_surface_kind, surface_source, surface_confidence, held_fields
      from public.auction_sales where id = '88200000-1000-4000-8000-000000000006'$$,
  $$values (70::numeric, 50::numeric, 'habitable', 'listing_text', 0.7::numeric, null::jsonb)$$,
  'a partial write that releases the surface gives the untouched columns their listing value back'
);

-- Écritures partielles, réglage par défaut (rattrapages, PATCH d'une colonne) ------------------------------------
update public.auction_sales set app_surface_kind = 'habitable', surface_confidence = 0.2
where id = '88200000-1000-4000-8000-000000000001';

select results_eq(
  $$select app_surface_kind, surface_confidence from public.auction_sales
      where id = '88200000-1000-4000-8000-000000000001'$$,
  $$values ('fact_registry_lawyer_email', 0.85::numeric)$$,
  'a direct write of one label of the surface group is held: the group stays consistent'
);

update public.auction_sales set surface_m2 = 72 where id = '88200000-1000-4000-8000-000000000001';

select results_eq(
  $$select surface_m2, app_surface_m2 from public.auction_sales
      where id = '88200000-1000-4000-8000-000000000001'$$,
  $$values (54::numeric, 54::numeric)$$,
  'a direct write of surface_m2 alone is held'
);

select results_eq(
  $$select incoming_value, listing_value from public.auction_sale_field_hold_events
      where sale_id = '88200000-1000-4000-8000-000000000001' and field_key = 'property.surface_m2'
      order by seq desc limit 1$$,
  $$values ('72'::jsonb, '60'::jsonb)$$,
  'a partial write of a new surface is journaled for review'
);

select is(
  (select held_fields #> '{property.surface_m2,listing}' from public.auction_sales
     where id = '88200000-1000-4000-8000-000000000001'),
  '{"surface_m2": 72, "app_surface_m2": 60, "app_surface_kind": "carrez", "surface_source": "pdf",
    "surface_confidence": 0.9}'::jsonb,
  'the listing block only takes the column that the write changed, never the held value of the others'
);

update public.auction_sales set surface_m2 = 72 where id = '88200000-1000-4000-8000-000000000001';

select is(
  (select count(*)::integer from public.auction_sale_field_hold_events
     where sale_id = '88200000-1000-4000-8000-000000000001' and field_key like '%surface_m2'
       and incoming_value = '72'::jsonb),
  1,
  'the same partial write a second time is held without a second event'
);

-- Chambres et pièces, réglage par défaut : la pièce reste, l'écrivain n'échoue pas --------------------------------
update public.auction_sales set bedrooms_count = 3 where id = '88200000-1000-4000-8000-000000000001';

select results_eq(
  $$select rooms_count, bedrooms_count, held_fields ? 'property.rooms_count'
      from public.auction_sales where id = '88200000-1000-4000-8000-000000000001'$$,
  $$values (3, 3, true)$$,
  'a bedroom count compatible with the held room count passes and the room count stays held'
);

select lives_ok(
  $$update public.auction_sales set bedrooms_count = 5 where id = '88200000-1000-4000-8000-000000000001'$$,
  'keep_and_review: a partial write of more bedrooms than the held room count does not fail'
);

select results_eq(
  $$select rooms_count, bedrooms_count, held_fields #> '{property.rooms_count,value}'
      from public.auction_sales where id = '88200000-1000-4000-8000-000000000001'$$,
  $$values (3, 3, '3'::jsonb)$$,
  'keep_and_review: the accepted room count stays and the incompatible bedroom count is not taken'
);

select results_eq(
  $$select event, held_value, incoming_value from public.auction_sale_field_hold_events
      where sale_id = '88200000-1000-4000-8000-000000000001' and field_key = 'property.rooms_count'
      order by seq desc limit 1$$,
  $$values ('listing_changed_kept', '3'::jsonb, '{"rooms_count": 3, "bedrooms_count": 5}'::jsonb)$$,
  'keep_and_review: the case goes to review with the two counts'
);

set local role service_role;
select lives_ok(
  $$execute reimport('https://example.test/882/kept', 60, 60, 'carrez', 'pdf', 0.9, 900, 6, 5, 'rented')$$,
  'keep_and_review: a complete import with more bedrooms than the held room count does not fail'
);
reset role;

select results_eq(
  $$select rooms_count, bedrooms_count, held_fields #> '{property.rooms_count,listing}', surface_m2
      from public.auction_sales where id = '88200000-1000-4000-8000-000000000001'$$,
  $$values (3, 3, '{"rooms_count": 6}'::jsonb, 54::numeric)$$,
  'keep_and_review: the room count stays held, the bedroom count keeps its former value, the listing is remembered'
);

select results_eq(
  $$select event, incoming_value from public.auction_sale_field_hold_events
      where sale_id = '88200000-1000-4000-8000-000000000001' and field_key = 'property.rooms_count'
      order by seq desc limit 1$$,
  $$values ('listing_changed_kept', '{"rooms_count": 6, "bedrooms_count": 5}'::jsonb)$$,
  'keep_and_review: that import is journaled once, with the two counts'
);

set local role service_role;
execute reimport('https://example.test/882/kept', 60, 60, 'carrez', 'pdf', 0.9, 900, 6, 5, 'rented');
reset role;
update public.auction_sales set bedrooms_count = 5 where id = '88200000-1000-4000-8000-000000000001';

select is(
  (select count(*)::integer from public.auction_sale_field_hold_events
     where sale_id = '88200000-1000-4000-8000-000000000001' and field_key = 'property.rooms_count'
       and jsonb_typeof(incoming_value) = 'object'),
  2,
  'keep_and_review: the same incompatible writes, repeated, add no event'
);

-- Chambres et pièces, réglage inverse : libération, sans jamais d'erreur ------------------------------------------
select lives_ok(
  $$update public.auction_sales set bedrooms_count = 5
      where id in ('88200000-1000-4000-8000-000000000004', '88200000-1000-4000-8000-000000000005')$$,
  'listing_wins_and_review: a partial write of more bedrooms than the held room count does not fail'
);

select results_eq(
  $$select id, rooms_count, bedrooms_count, held_fields
      from public.auction_sales
      where id in ('88200000-1000-4000-8000-000000000004', '88200000-1000-4000-8000-000000000005')
      order by id$$,
  $$values
      ('88200000-1000-4000-8000-000000000004'::uuid, null::integer, 5, null::jsonb),
      ('88200000-1000-4000-8000-000000000005'::uuid, 6, 5, null::jsonb)$$,
  'listing_wins_and_review: the field is released to the listing room count when it fits, to nothing otherwise'
);

select results_eq(
  $$select sale_id, event, held_value, listing_value, incoming_value
      from public.auction_sale_field_hold_events
      where sale_id in ('88200000-1000-4000-8000-000000000004', '88200000-1000-4000-8000-000000000005')
        and event like 'listing_changed%'
      order by sale_id$$,
  $$values
      ('88200000-1000-4000-8000-000000000004'::uuid, 'listing_changed_released', '3'::jsonb, '2'::jsonb,
        '{"rooms_count": 3, "bedrooms_count": 5}'::jsonb),
      ('88200000-1000-4000-8000-000000000005'::uuid, 'listing_changed_released', '3'::jsonb, '6'::jsonb,
        '{"rooms_count": 3, "bedrooms_count": 5}'::jsonb)$$,
  'listing_wins_and_review: both releases are journaled with the two counts'
);

-- Le champ libéré pour ses chambres n'est pas repris non plus par la projection suivante.
select is(
  app_private.project_sale_fields('88200000-1000-4000-8000-000000000005', null, true)
    #> '{fields,property.rooms_count}',
  '{"state": "pass_through"}'::jsonb,
  'a field released for its bedrooms is not taken back by the next projection'
);

-- Une écriture qui ne touche aucune colonne tenue ne passe pas par la retenue --------------------------------
update public.auction_sales set city = 'Betaville', starting_price_eur = 95000
where id = '88200000-1000-4000-8000-000000000001';

select results_eq(
  $$select city, starting_price_eur, surface_m2 from public.auction_sales
      where id = '88200000-1000-4000-8000-000000000001'$$,
  $$values ('Betaville', 95000::numeric, 54::numeric)$$,
  'the other columns of a sale that holds a field are written as before'
);

-- Écritures forgées de held_fields --------------------------------------------------------------------------------
select throws_ok(
  $$update public.auction_sales set held_fields = '{"property.rooms_count": {"value": 9}}'::jsonb
      where id = '88200000-1000-4000-8000-000000000000'$$,
  '42501',
  'auction_sales.held_fields is written only by app_private.project_sale_fields.',
  'forged write: held_fields cannot be set on a sale that holds nothing'
);

select throws_ok(
  $$update public.auction_sales
      set held_fields = jsonb_set(held_fields, '{property.surface_m2,value}', '99'::jsonb), surface_m2 = 99
      where id = '88200000-1000-4000-8000-000000000001'$$,
  '42501',
  'auction_sales.held_fields is written only by app_private.project_sale_fields.',
  'forged write: a held entry cannot be rewritten'
);

select throws_ok(
  $$update public.auction_sales set held_fields = null, surface_m2 = 99
      where id = '88200000-1000-4000-8000-000000000001'$$,
  '42501',
  'auction_sales.held_fields is written only by app_private.project_sale_fields.',
  'forged write: held_fields cannot be emptied to free a field'
);

-- Un rôle de l'API ne l'écrit jamais, même en posant lui-même le réglage de transaction de la projection.
set local role service_role;
select throws_ok(
  $$update public.auction_sales set held_fields = '{}'::jsonb
      where id = '88200000-1000-4000-8000-000000000001'$$,
  '42501',
  'auction_sales.held_fields cannot be written by an API role.',
  'forged write: refused for the server role'
);
select set_config('app.sale_field_projection', '88200000-1000-4000-8000-000000000001', true);
select throws_ok(
  $$update public.auction_sales set held_fields = null, surface_m2 = 99
      where id = '88200000-1000-4000-8000-000000000001'$$,
  '42501',
  'auction_sales.held_fields cannot be written by an API role.',
  'forged write: the server role cannot open held_fields by setting the projection marker itself'
);
select throws_ok(
  $$update public.auction_sales set held_fields = '{"property.rooms_count": {"value": 9}}'::jsonb
      where id = '88200000-1000-4000-8000-000000000000'$$,
  '42501',
  'auction_sales.held_fields cannot be written by an API role.',
  'forged write: nor on a sale that holds nothing'
);
select set_config('app.sale_field_projection', '', true);
reset role;

select throws_ok(
  $$insert into public.auction_sales (source_name, source_url, held_fields)
      values ('licitor', 'https://example.test/882/forged', '{"property.rooms_count": {"value": 9}}'::jsonb)$$,
  '42501',
  'A new auction sale holds no field: auction_sales.held_fields is written only by app_private.project_sale_fields.',
  'forged write: a new sale cannot be inserted with held fields'
);

select throws_ok(
  $$insert into public.auction_sales (source_name, source_url, held_fields)
      values ('licitor', 'https://example.test/882/control', '{}'::jsonb)
      on conflict (source_url) do update set held_fields = excluded.held_fields$$,
  '42501',
  'A new auction sale holds no field: auction_sales.held_fields is written only by app_private.project_sale_fields.',
  'forged write: an upsert cannot carry held_fields either'
);

select is(
  (select held_fields #> '{property.surface_m2,value}' from public.auction_sales
     where id = '88200000-1000-4000-8000-000000000001'),
  '54'::jsonb,
  'the held entry is intact after the refused writes'
);

-- Comparaison des valeurs (fonctions pures) ---------------------------------------------------------------------
select ok(
  app_private.sale_field_values_match('property.surface_m2', '54'::jsonb, '55'::jsonb, 1, 0.02)
  and app_private.sale_field_values_match('property.surface_m2', '100'::jsonb, '102'::jsonb, 1, 0.02)
  and not app_private.sale_field_values_match('property.surface_m2', '54'::jsonb, '56'::jsonb, 1, 0.02)
  and not app_private.sale_field_values_match('property.surface_m2', '54'::jsonb, null, 1, 0.02)
  and app_private.sale_field_values_match('property.rooms_count', '3'::jsonb, '3'::jsonb, null, null)
  and not app_private.sale_field_values_match('property.rooms_count', '3'::jsonb, '4'::jsonb, null, null),
  'numbers match within the larger of the absolute and relative tolerances; counts match exactly'
);

select ok(
  app_private.sale_field_comparable('property.occupancy_status', '"unknown"'::jsonb) is null
  and app_private.sale_field_comparable('property.occupancy_status', '""'::jsonb) is null
  and app_private.sale_field_comparable('property.occupancy_status', '" Vacant "'::jsonb) = '"vacant"'::jsonb
  and app_private.sale_field_comparable('property.occupancy_status', '"owner_occupied"'::jsonb)
    = '"occupied"'::jsonb
  and app_private.sale_field_comparable('property.occupancy_status', '"squatted"'::jsonb) = '"occupied"'::jsonb
  and app_private.sale_field_comparable('sale.visit_dates', '[]'::jsonb) is null
  and app_private.sale_field_comparable('property.surface_m2', 'null'::jsonb) is null
  and app_private.sale_field_comparable('property.surface_m2', '0'::jsonb) is null
  and app_private.sale_field_comparable('property.land_surface_m2', '-3'::jsonb) is null
  and app_private.sale_field_comparable('property.rooms_count', '0'::jsonb) is null,
  'an unknown occupancy, an empty text or list, a JSON null, a zero or negative number say nothing'
);

select ok(
  app_private.sale_field_values_match(
    'sale.visit_dates',
    '["2026-11-20T10:00:00+01:00", "2026-11-18"]'::jsonb,
    '["2026-11-18", "2026-11-20", "2026-11-20"]'::jsonb, null, null)
  and not app_private.sale_field_values_match(
    'sale.visit_dates', '["2026-11-18"]'::jsonb, '["2026-11-18", "2026-11-20"]'::jsonb, null, null),
  'visit dates compare as a sorted list of distinct days'
);

-- Visites : verrouillées par contrainte. Le chemin existe pour le lot qui lèvera le verrou par migration : il
-- est exercé ici en retirant la contrainte dans la transaction du test.
insert into public.auction_sales (
  id, source_name, source_url, status, city, property_type, raw_payload, sale_procedure, visit_dates
) values (
  '88200000-1000-4000-8000-000000000003', 'licitor', 'https://example.test/882/visits', 'upcoming',
  'Alphaville', 'house', '{}'::jsonb, '{}'::jsonb, '["2026-11-18T14:00:00+01:00"]'::jsonb
);
insert into public.auction_fact_claims (
  id, auction_sale_id, field_key, value_jsonb, evidence_kind, evidence_locator, extractor_name,
  extractor_version, created_by
) values (
  '88200000-2000-4000-8000-000000000305', '88200000-1000-4000-8000-000000000003', 'sale.visit_dates',
  '["2026-11-25", "2026-11-20"]'::jsonb, 'professional_email',
  '{"case_id": "88200000-3000-4000-8000-000000000003"}'::jsonb, 'information_agent', 'v1',
  '88200000-0000-4000-8000-0000000000a1'
);
insert into public.auction_fact_claim_decisions (
  claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id
) values (
  '88200000-2000-4000-8000-000000000305', '88200000-1000-4000-8000-000000000003', 'sale.visit_dates',
  'accepted', 'single_lot', 'admin', '88200000-0000-4000-8000-0000000000a1'
);

select is(
  app_private.project_sale_fields('88200000-1000-4000-8000-000000000003', null, true)
    #>> '{fields,sale.visit_dates,state}',
  'pass_through',
  'accepted visit dates hold nothing (hold_enabled is false and locked)'
);

alter table public.auction_fact_fields drop constraint auction_fact_fields_visit_dates_locked;
update public.auction_fact_fields
set hold_enabled = true, on_listing_change = 'keep_and_review'
where field_key = 'sale.visit_dates';

select is(
  app_private.project_sale_fields('88200000-1000-4000-8000-000000000003', null, true)
    #>> '{fields,sale.visit_dates,state}',
  'held',
  'lock lifted: accepted visit dates hold'
);

select is(
  (select visit_dates from public.auction_sales where id = '88200000-1000-4000-8000-000000000003'),
  '["2026-11-20", "2026-11-25"]'::jsonb,
  'lock lifted: held visit dates are written sorted'
);

update public.auction_sales set visit_dates = '["2026-11-18T14:00:00+01:00"]'::jsonb
where id = '88200000-1000-4000-8000-000000000003';
update public.auction_sales set visit_dates = '["2026-11-25T09:00:00+01:00", "2026-11-20"]'::jsonb
where id = '88200000-1000-4000-8000-000000000003';
update public.auction_sales set visit_dates = '[]'::jsonb
where id = '88200000-1000-4000-8000-000000000003';

select results_eq(
  $$select sale.visit_dates,
           (select count(*)::integer from public.auction_sale_field_hold_events event
              where event.sale_id = sale.id and event.event like 'listing_changed%')
      from public.auction_sales sale where sale.id = '88200000-1000-4000-8000-000000000003'$$,
  $$values ('["2026-11-20", "2026-11-25"]'::jsonb, 0)$$,
  'lock lifted: held visit dates survive the same listing, an echo of the same days and an empty list'
);

update public.auction_sales set visit_dates = '["2026-12-02"]'::jsonb
where id = '88200000-1000-4000-8000-000000000003';

select results_eq(
  $$select sale.visit_dates, event.event, event.incoming_value
      from public.auction_sales sale
      join public.auction_sale_field_hold_events event on event.sale_id = sale.id
      where sale.id = '88200000-1000-4000-8000-000000000003' and event.event like 'listing_changed%'$$,
  $$values ('["2026-11-20", "2026-11-25"]'::jsonb, 'listing_changed_kept', '["2026-12-02"]'::jsonb)$$,
  'lock lifted: new visit dates in the listing are journaled and the held dates stay'
);

-- Une entrée inconnue dans held_fields arrête l'écriture au lieu de laisser un champ sans garde ------------------
select set_config('app.sale_field_projection', '88200000-1000-4000-8000-000000000000', true);
update public.auction_sales set held_fields = '{"sale.starting_price_eur": {"value": 1}}'::jsonb
where id = '88200000-1000-4000-8000-000000000000';
select set_config('app.sale_field_projection', '', true);

select throws_ok(
  $$update public.auction_sales set rooms_count = 7 where id = '88200000-1000-4000-8000-000000000000'$$,
  '22023',
  'auction_sales.held_fields holds an unknown field sale.starting_price_eur.',
  'a held entry that the trigger does not know stops the write loudly'
);

-- Le réglage de transaction de la projection ne vaut que pour la vente qu'il nomme ------------------------------
select set_config('app.sale_field_projection', '88200000-1000-4000-8000-000000000000', true);
select throws_ok(
  $$update public.auction_sales set held_fields = null where id = '88200000-1000-4000-8000-000000000001'$$,
  '42501',
  'auction_sales.held_fields is written only by app_private.project_sale_fields.',
  'the projection marker of one sale does not open another sale'
);
select set_config('app.sale_field_projection', '', true);

-- Le rôle de la collecte n'a aucun droit sur la file : c'est la retenue qui écrit --------------------------------
select ok(
  not has_table_privilege('service_role', 'public.auction_sale_field_hold_events', 'INSERT')
  and (select count(*) > 0 from public.auction_sale_field_hold_events
         where sale_id = '88200000-1000-4000-8000-000000000001' and event = 'listing_changed_kept'),
  'the events above were written by the trigger, not by the server role, which cannot insert in the queue'
);

select * from finish();
rollback;
