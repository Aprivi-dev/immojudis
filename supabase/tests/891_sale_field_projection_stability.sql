-- 20261117100200 : la projection est stable en UNE application.
--   * critère générique : après toute application, la simulation rend « changed = false », une seconde application
--     ne change rien et ne réécrit pas la ligne ; la simulation annonce ce que l'application fait ;
--   * le cas qui a montré le défaut : une pièce reçoit une opposition sans avoir été affichée, puis une autre pièce
--     est acceptée sur le même champ ;
--   * un essai aléatoire court et reproductible (graine fixe) : décisions, écritures directes de la collecte,
--     reclassements en terrain, sur trois ventes.
begin;

set local timezone = 'UTC';

select plan(7);

insert into auth.users (id) values ('89100000-0000-4000-8000-0000000000a1');
insert into public.user_profiles (user_id, email, user_role) values
  ('89100000-0000-4000-8000-0000000000a1', 'registre-admin-891@example.test', 'admin')
on conflict (user_id) do update set user_role = excluded.user_role;

insert into public.auction_sales (
  id, source_name, source_url, status, sale_date, city, property_type, starting_price_eur,
  raw_payload, sale_procedure, sale_venue_type,
  surface_m2, app_surface_m2, app_surface_kind, surface_source, surface_confidence, habitable_surface_m2,
  land_surface_m2, rooms_count, bedrooms_count, occupancy_status, visit_dates
)
select ('89100000-1000-4000-8000-00000000000' || n)::uuid, 'licitor', 'https://example.test/891/sale-' || n,
  'upcoming', current_timestamp + interval '20 days', 'Alphaville', 'house', 90000, '{}'::jsonb, '{}'::jsonb,
  'tribunal', 50, 50, 'habitable', 'listing_text', 0.7, 50, 300, 2, 1, 'occupied', '[]'::jsonb
from generate_series(1, 4) n;

-- Douze pièces par vente, chacune d'un dossier distinct. L'identifiant porte la vente puis le rang.
create temporary table stability_claims on commit drop as
select
  ('89100000-2000-4000-8000-000000000' || sale.n || to_char(piece.position, 'FM00'))::uuid as id,
  ('89100000-1000-4000-8000-00000000000' || sale.n)::uuid as sale_id,
  piece.position, piece.field_key, piece.value_jsonb
from generate_series(1, 4) sale(n),
  (values
    (1, 'property.surface_m2', '54'::jsonb), (2, 'property.surface_m2', '56'), (3, 'property.surface_m2', '50.4'),
    (4, 'property.surface_m2', '50'), (5, 'property.surface_m2', '61'),
    (6, 'property.rooms_count', '3'), (7, 'property.rooms_count', '4'), (8, 'property.rooms_count', '2'),
    (9, 'property.occupancy_status', '"vacant"'), (10, 'property.occupancy_status', '"rented"'),
    (11, 'property.land_surface_m2', '320'), (12, 'property.land_surface_m2', '300.5')
  ) piece(position, field_key, value_jsonb);

insert into public.auction_fact_claims (
  id, auction_sale_id, field_key, value_jsonb, evidence_kind, evidence_locator, confidence_score,
  extractor_name, extractor_version, created_by
)
select id, sale_id, field_key, value_jsonb, 'professional_email',
  jsonb_build_object('case_id', '89100000-3000-4000-8000-' || right(id::text, 12)), 0.6, 'information_agent', 'v1',
  '89100000-0000-4000-8000-0000000000a1'
from stability_claims;

create temporary table stability_log (step integer, kind text, detail text) on commit drop;

-- Une décision, puis l'application et ses contrôles. Rend false si la décision est refusée par le journal.
create function pg_temp.decide_and_check(
  p_step integer, p_claim uuid, p_decision text, p_reason text
) returns boolean
language plpgsql as $$
declare
  v_claim record;
  v_simulated jsonb;
  v_applied jsonb;
  v_before jsonb;
  v_after jsonb;
  v_again jsonb;
begin
  select * into strict v_claim from stability_claims where id = p_claim;
  begin
    insert into public.auction_fact_claim_decisions (
      claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id, reason_code, recipient_kind,
      received_at
    ) values (
      v_claim.id, v_claim.sale_id, v_claim.field_key, p_decision, 'single_lot', 'admin',
      '89100000-0000-4000-8000-0000000000a1', p_reason, 'source_lawyer',
      case when p_decision = 'accepted' then timestamptz '2026-11-01' + p_step * interval '1 minute' end
    );
  exception when others then
    return false;
  end;
  v_simulated := app_private.project_sale_fields(v_claim.sale_id, null, false);
  select to_jsonb(sale) - 'updated_at' into v_before from public.auction_sales sale where sale.id = v_claim.sale_id;
  v_applied := app_private.project_sale_fields(v_claim.sale_id, null, true);
  select to_jsonb(sale) - 'updated_at' into v_after from public.auction_sales sale where sale.id = v_claim.sale_id;
  if v_simulated -> 'changed' is distinct from v_applied -> 'changed'
    or v_simulated -> 'fields' is distinct from v_applied -> 'fields'
  then
    insert into stability_log values (p_step, 'simulation differs from application', v_claim.field_key);
  end if;
  if (v_applied ->> 'changed')::boolean is distinct from (v_before is distinct from v_after) then
    insert into stability_log values (p_step, 'changed flag differs from the row', v_claim.field_key);
  end if;
  -- Le critère : après une application, la simulation n'a plus rien à changer.
  if (app_private.project_sale_fields(v_claim.sale_id, null, false) ->> 'changed')::boolean then
    insert into stability_log values (
      p_step, 'not stable after one application',
      format('%s %s %s', v_claim.field_key, v_claim.value_jsonb, p_decision));
  end if;
  v_again := app_private.project_sale_fields(v_claim.sale_id, null, true);
  select to_jsonb(sale) - 'updated_at' into v_before from public.auction_sales sale where sale.id = v_claim.sale_id;
  if (v_again ->> 'changed')::boolean or v_before is distinct from v_after then
    insert into stability_log values (p_step, 'a second application changes the sale', v_claim.field_key);
  end if;
  return true;
end;
$$;

-- Le cas qui a montré le défaut (vente 4) : « 4 pièces » opposée sans avoir été affichée, puis « 3 pièces » acceptée.
select ok(
  pg_temp.decide_and_check(0, '89100000-2000-4000-8000-000000000407', 'opposed', 'professional_opposition')
  and (select held_fields is null from public.auction_sales where id = '89100000-1000-4000-8000-000000000004'),
  'an opposition to a piece that was never displayed leaves no entry by itself'
);

select ok(
  pg_temp.decide_and_check(0, '89100000-2000-4000-8000-000000000406', 'accepted', null),
  'another piece is then accepted on the same field'
);

select results_eq(
  $$select sale.rooms_count, sale.held_fields #> '{property.rooms_count,value}',
           sale.held_fields #> '{property.rooms_count,echo}',
           app_private.project_sale_fields(sale.id, null, false) ->> 'changed'
      from public.auction_sales sale where sale.id = '89100000-1000-4000-8000-000000000004'$$,
  $$values (3, '3'::jsonb, '[{"value": 4}]'::jsonb, 'false')$$,
  'one application is enough: the opposed value is remembered at once, and the simulation has nothing left to change'
);

select is(
  (select count(*)::integer from stability_log),
  0,
  'in that case the application is what the simulation announced, and a second application changes nothing'
);

-- Essai aléatoire, graine fixe : 220 pas sur les ventes 1 à 3.
do $trial$
declare
  v_step integer;
  v_sale uuid;
  v_claim uuid;
  v_position integer;
  v_draw double precision;
  v_decision text;
  v_reason text;
  v_assignments text[];
  c_surface numeric[] := array[50, 54, 56, 50.4, 61, 70, 54.5, 51, null];
  c_rooms integer[] := array[2, 3, 4, 5, null];
  c_occupancy text[] := array['occupied', 'vacant', 'rented', null];
  c_land numeric[] := array[300, 320, 300.5, 900, null];
  c_source text[] := array['listing_text', 'pdf', 'fact_registry', 'ocr'];
begin
  perform setseed(0.27);
  for v_step in 1..220 loop
    v_sale := ('89100000-1000-4000-8000-00000000000' || (1 + floor(random() * 3))::integer)::uuid;
    v_draw := random();
    if v_draw < 0.45 then
      v_position := 1 + floor(random() * 12)::integer;
      select id into v_claim from stability_claims where sale_id = v_sale and position = v_position;
      v_draw := random();
      if v_draw < 0.5 then
        v_decision := 'accepted'; v_reason := null;
      elsif v_draw < 0.7 then
        v_decision := 'withdrawn';
        v_reason := (array['entry_error', 'authorization_withdrawn', 'other'])[1 + floor(random() * 3)::integer];
      elsif v_draw < 0.9 then
        v_decision := 'opposed'; v_reason := 'professional_opposition';
      else
        v_decision := 'rejected'; v_reason := 'other';
      end if;
      if pg_temp.decide_and_check(v_step, v_claim, v_decision, v_reason) then
        insert into stability_log values (v_step, 'decision', v_decision);
      end if;
    else
      -- Écriture directe de la collecte (rôle serveur), sous-ensemble aléatoire de colonnes.
      v_assignments := array[]::text[];
      if random() < 0.5 then
        v_assignments := v_assignments || format('app_surface_m2 = %L', c_surface[1 + floor(random() * 9)::integer]);
      end if;
      if random() < 0.5 then
        v_assignments := v_assignments || format('surface_m2 = %L', c_surface[1 + floor(random() * 9)::integer]);
      end if;
      if random() < 0.3 then
        v_assignments := v_assignments
          || format('habitable_surface_m2 = %L', c_surface[1 + floor(random() * 9)::integer]);
      end if;
      if random() < 0.2 then
        v_assignments := v_assignments
          || format('carrez_surface_m2 = %L', c_surface[1 + floor(random() * 9)::integer]);
      end if;
      if random() < 0.3 then
        v_assignments := v_assignments || format('surface_source = %L', c_source[1 + floor(random() * 4)::integer]);
      end if;
      if random() < 0.3 then
        v_assignments := v_assignments || format('rooms_count = %L', c_rooms[1 + floor(random() * 5)::integer]);
      end if;
      if random() < 0.3 then
        v_assignments := v_assignments
          || format('occupancy_status = %L', c_occupancy[1 + floor(random() * 4)::integer]);
      end if;
      if random() < 0.3 then
        v_assignments := v_assignments || format('land_surface_m2 = %L', c_land[1 + floor(random() * 5)::integer]);
      end if;
      if random() < 0.05 then
        v_assignments := v_assignments
          || format('property_type = %L', (array['land', 'house'])[1 + floor(random() * 2)::integer]);
      end if;
      continue when cardinality(v_assignments) = 0;
      begin
        perform set_config('role', 'service_role', true);
        execute format(
          'update public.auction_sales set %s where id = %L', array_to_string(v_assignments, ', '), v_sale);
        perform set_config('role', 'none', true);
        insert into stability_log values (v_step, 'write', null);
      exception when others then
        perform set_config('role', 'none', true);
        insert into stability_log values (v_step, 'write refused', sqlerrm);
      end;
    end if;
  end loop;
end;
$trial$;

select ok(
  (select count(*) filter (where kind = 'decision') >= 60
          and count(*) filter (where kind = 'decision' and detail = 'opposed') >= 8
          and count(*) filter (where kind = 'write') >= 70
     from stability_log),
  'the random trial played enough decisions, oppositions and direct writes to mean something'
);

select is(
  (select coalesce(string_agg(distinct kind, ', '), 'none') from stability_log
     where kind not in ('decision', 'write', 'write refused')),
  'none',
  'random trial (fixed seed): after every application the simulation answers changed = false, a second application changes nothing, and the simulation announced what the application did'
);

select is(
  (select count(*)::integer from stability_log where kind = 'write refused' and detail !~ 'auction_sales_'),
  0,
  'no direct write of the collection is refused by the registry (only by the constraints of the table itself)'
);

select * from finish();
rollback;
