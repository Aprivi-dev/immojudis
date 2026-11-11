-- 20261117100700 : la vue des observations ne montre que la dernière génération de la collecte.
--   * une observation « candidate » de l'extracteur immojudis.pipeline.fact_claims est masquée quand la même
--     vente porte une observation de ce même extracteur d'une génération plus haute ;
--   * la génération se compare en entier (v10 > v9) ; une version illisible reste visible et ne masque rien ;
--   * un autre extracteur, une observation sans extracteur, une observation déjà relue ne sont jamais masqués ;
--   * une génération plus haute masque quel que soit son statut ; une observation rattachée à un lot seul ne
--     masque rien et n'est pas masquée ;
--   * option security_invoker, droits et colonnes de la vue inchangés ; la lecture par vente passe par l'index.
begin;

set local timezone = 'UTC';

select plan(14);

-- Jeu d'essai ---------------------------------------------------------------------------------------------------
insert into public.auction_sales (id, source_name, source_url, status, starting_price_eur)
select ('89000000-1000-4000-8000-00000000000' || n)::uuid, 'licitor', 'https://example.test/890/sale-' || n,
  'upcoming', 90000
from generate_series(1, 8) n;

insert into public.outcome_courts (id, code, name)
values ('89000000-4000-4000-8000-000000000001', 'TJ-890', 'Tribunal judiciaire du test 890');
insert into public.auction_cases (id, court_id, court_case_number, procedure_type)
values ('89000000-5000-4000-8000-000000000001', '89000000-4000-4000-8000-000000000001', 'RG-890-1',
  'saisie_immobiliere');
insert into public.auction_lots (id, auction_case_id, property_type, initial_starting_price_eur)
values ('89000000-6000-4000-8000-000000000001', '89000000-5000-4000-8000-000000000001', 'house', 90000);

-- Une observation par ligne : code (vente puis rang), champ, extracteur, version. L'identifiant porte le code.
create temporary table claim_fixture (
  code text primary key, sale text, lot boolean, field_key text, extractor_name text, extractor_version text
) on commit drop;
insert into claim_fixture values
  -- Vente 1 : une seule génération (version 2).
  ('11', '1', false, 'property.surface_m2', 'immojudis.pipeline.fact_claims', 'auction_fact_claims_v2'),
  ('12', '1', false, 'property.rooms_count', 'immojudis.pipeline.fact_claims', 'auction_fact_claims_v2'),
  -- Vente 2 : versions 2 et 3 ; la version 3 n'émet plus le nombre de pièces.
  ('21', '2', false, 'property.surface_m2', 'immojudis.pipeline.fact_claims', 'auction_fact_claims_v2'),
  ('22', '2', false, 'property.rooms_count', 'immojudis.pipeline.fact_claims', 'auction_fact_claims_v2'),
  ('23', '2', false, 'property.surface_m2', 'immojudis.pipeline.fact_claims', 'auction_fact_claims_v3'),
  -- Vente 3 : versions 9 et 10 (comparaison en entier, pas en texte).
  ('31', '3', false, 'property.surface_m2', 'immojudis.pipeline.fact_claims', 'auction_fact_claims_v9'),
  ('32', '3', false, 'property.surface_m2', 'immojudis.pipeline.fact_claims', 'auction_fact_claims_v10'),
  -- Vente 4 : version 2 et trois versions que l'expression ne lit pas.
  ('41', '4', false, 'property.surface_m2', 'immojudis.pipeline.fact_claims', 'auction_fact_claims_v2'),
  ('42', '4', false, 'property.rooms_count', 'immojudis.pipeline.fact_claims', 'v3'),
  ('43', '4', false, 'property.land_surface_m2', 'immojudis.pipeline.fact_claims', 'auction_fact_claims_v'),
  ('44', '4', false, 'property.occupancy_status', 'immojudis.pipeline.fact_claims', 'auction_fact_claims_v1234567'),
  -- Vente 5 : version 3 de la collecte, et des observations d'un autre extracteur ou sans extracteur.
  ('51', '5', false, 'property.surface_m2', 'immojudis.pipeline.fact_claims', 'auction_fact_claims_v3'),
  ('52', '5', false, 'property.rooms_count', 'immojudis-fact-claims', 'auction_fact_claims_v2'),
  ('53', '5', false, 'property.land_surface_m2', null, null),
  -- Vente 6 : une version 2 déjà acceptée, à côté de son jumeau version 3.
  ('61', '6', false, 'property.surface_m2', 'immojudis.pipeline.fact_claims', 'auction_fact_claims_v2'),
  ('62', '6', false, 'property.surface_m2', 'immojudis.pipeline.fact_claims', 'auction_fact_claims_v3'),
  -- Vente 7 : la version 3 est rejetée ; elle masque quand même la version 2.
  ('71', '7', false, 'property.surface_m2', 'immojudis.pipeline.fact_claims', 'auction_fact_claims_v2'),
  ('72', '7', false, 'property.surface_m2', 'immojudis.pipeline.fact_claims', 'auction_fact_claims_v3'),
  -- Vente 8 : une version 2 ; et, rattachées au lot seul, une version 2 et une version 3.
  ('81', '8', false, 'property.surface_m2', 'immojudis.pipeline.fact_claims', 'auction_fact_claims_v2'),
  ('91', null, true, 'property.surface_m2', 'immojudis.pipeline.fact_claims', 'auction_fact_claims_v2'),
  ('92', null, true, 'property.rooms_count', 'immojudis.pipeline.fact_claims', 'auction_fact_claims_v3');

insert into public.auction_fact_claims (
  id, auction_sale_id, lot_id, field_key, value_jsonb, evidence_kind, source_url, evidence_locator,
  confidence_score, extractor_name, extractor_version
)
select
  ('89000000-2000-4000-8000-0000000000' || fixture.code)::uuid,
  ('89000000-1000-4000-8000-00000000000' || fixture.sale)::uuid,
  case when fixture.lot then '89000000-6000-4000-8000-000000000001'::uuid end,
  fixture.field_key, to_jsonb(fixture.code::integer), 'source_listing',
  'https://example.test/890/listing-' || fixture.code, '{}'::jsonb, 0.8, fixture.extractor_name,
  fixture.extractor_version
from claim_fixture fixture;

update public.auction_fact_claims
set claim_status = 'accepted', resolution_actor_type = 'human', resolved_at = statement_timestamp()
where id = '89000000-2000-4000-8000-000000000061';
update public.auction_fact_claims
set claim_status = 'rejected', resolution_actor_type = 'human', resolved_at = statement_timestamp(),
    resolution_note = 'Rejected in the fixture.'
where id = '89000000-2000-4000-8000-000000000072';

create function pg_temp.visible(p_prefix text) returns text[]
language sql stable as $$
  select coalesce(array_agg(right(model.claim_id::text, 2) order by model.claim_id), array[]::text[])
  from public.v_auction_fact_claims_read_model model
  where model.claim_id::text like '89000000-2000-4000-8000-0000000000' || p_prefix || '%';
$$;

-- 1. Une seule génération : rien n'est masqué --------------------------------------------------------------------
select is(pg_temp.visible('1'), array['11', '12'], 'a sale with version 2 only shows all its claims');

-- 2. Deux générations : seule la plus haute reste ----------------------------------------------------------------
select is(
  pg_temp.visible('2'),
  array['23'],
  'with versions 2 and 3 only version 3 is shown, even for a field that version 3 no longer emits'
);

-- 3. Comparaison en entier ---------------------------------------------------------------------------------------
select is(pg_temp.visible('3'), array['32'], 'version 10 hides version 9: generations are compared as integers');

-- 4. Version illisible -------------------------------------------------------------------------------------------
select is(
  pg_temp.visible('4'),
  array['41', '42', '43', '44'],
  'a version that the pattern does not read (v3, empty suffix, seven digits) is shown, hides nothing, and raises no error'
);

-- 5. Autre extracteur, extracteur absent -----------------------------------------------------------------------
select is(
  pg_temp.visible('5'),
  array['51', '52', '53'],
  'a claim of another extractor, or without extractor, is never hidden by the pipeline generation'
);

-- 6. Observation déjà relue --------------------------------------------------------------------------------------
select results_eq(
  $$select right(claim_id::text, 2), fact_status, is_publishable
      from public.v_auction_fact_claims_read_model
      where claim_id::text like '89000000-2000-4000-8000-00000000006%' order by claim_id$$,
  $$values ('61', 'accepted', true), ('62', 'candidate', false)$$,
  'an accepted version 2 claim stays visible, and publishable, next to its version 3 twin'
);

-- 7. Une génération plus haute masque quel que soit son statut ----------------------------------------------
select is(
  pg_temp.visible('7'),
  array[]::text[],
  'a rejected version 3 claim still hides its version 2 twin: the rejected fact does not come back'
);

-- 8. Lot seul ------------------------------------------------------------------------------------------------------
select is(
  pg_temp.visible('8') || pg_temp.visible('9'),
  array['81', '91', '92'],
  'claims attached to a lot only are unchanged, and a detached version 3 hides nothing on any sale'
);

-- 9. Option, droits et colonnes inchangés ----------------------------------------------------------------------
select is(
  (select reloptions from pg_class where oid = 'public.v_auction_fact_claims_read_model'::regclass),
  array['security_invoker=true'],
  'the view still runs with the rights of its reader (security_invoker = true)'
);

select is(
  (select array_agg(api_role.name || ':' || privilege.name order by api_role.name, privilege.name)
     from unnest(array['anon', 'authenticated', 'service_role']) api_role(name)
     cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) privilege(name)
     where has_table_privilege(api_role.name, 'public.v_auction_fact_claims_read_model', privilege.name)),
  array['service_role:SELECT'],
  'the server role alone reads the view, and nobody writes through it'
);

select is(
  (select array_agg(attribute.attname::text order by attribute.attnum)
     from pg_attribute attribute
     where attribute.attrelid = 'public.v_auction_fact_claims_read_model'::regclass and attribute.attnum > 0),
  array[
    'claim_id', 'auction_sale_id', 'lot_id', 'field_key', 'value_jsonb', 'fact_status', 'is_publishable',
    'conflict_group', 'evidence_kind', 'source_id', 'raw_artifact_id', 'source_record_id',
    'artifact_extraction_id', 'source_url', 'evidence_locator', 'confidence_score', 'captured_at', 'resolved_at',
    'resolution_note', 'created_at', 'updated_at'
  ],
  'the view keeps its twenty-one columns, in the same order'
);

set local role service_role;
select is(
  (select count(*)::integer from public.v_auction_fact_claims_read_model
     where auction_sale_id = '89000000-1000-4000-8000-000000000002'),
  1,
  'the server role reads the filtered view (the fiche of sale 2 counts one claim, not three)'
);
reset role;

-- 10. Plan de la lecture par vente -----------------------------------------------------------------------------
-- Le filtre sur la vente doit descendre dans le sous-ensemble groupé : sans cela chaque fiche agrégerait toutes
-- les observations. Le parcours séquentiel est écarté pour le temps du test (la table du jeu d'essai est petite) :
-- l'assertion porte sur la condition d'index des DEUX lectures de la table.
create function pg_temp.sale_read_plan() returns text
language plpgsql as $$
declare
  v_line text;
  v_plan text := '';
begin
  for v_line in
    explain (costs off)
    select field_key, fact_status, value_jsonb, confidence_score, captured_at
    from public.v_auction_fact_claims_read_model
    where auction_sale_id = '89000000-1000-4000-8000-000000000002'
      and field_key in ('property.surface_m2', 'property.rooms_count')
  loop
    v_plan := v_plan || v_line || E'\n';
  end loop;
  return v_plan;
end;
$$;

set local enable_seqscan = off;
select ok(
  pg_temp.sale_read_plan() !~ 'Seq Scan'
  and (select count(*) = 2 from regexp_matches(
         pg_temp.sale_read_plan(),
         'Index Cond: \(\(?auction_sale_id = ''89000000-1000-4000-8000-000000000002''::uuid\)', 'g')),
  'the read of one sale filters both reads of the claims by the sale, through an index: no sequential scan'
);
reset enable_seqscan;

-- La vue ne lit la version que par l'expression ancrée : pas de comparaison de chaînes.
select ok(
  (select (select count(*) from regexp_matches(
             pg_get_viewdef('public.v_auction_fact_claims_read_model'::regclass),
             'regexp_match\([a-z]+\.extractor_version, ''\^auction_fact_claims_v\(\[0-9\]\{1,6\}\)\$''::text\)\)\[1\]\)::integer',
             'g')) = 2
          and pg_get_viewdef('public.v_auction_fact_claims_read_model'::regclass)
            ~ 'extractor_name = ''immojudis\.pipeline\.fact_claims''::text'),
  'the generation is read by one anchored pattern, as an integer, for the extractor of the pipeline'
);

select * from finish();
rollback;
