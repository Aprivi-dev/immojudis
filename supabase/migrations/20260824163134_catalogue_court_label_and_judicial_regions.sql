begin;

create or replace function app_private.normalize_court_label(p_value text)
returns text
language sql
stable
strict
security invoker
set search_path = ''
as $function$
  select nullif(
    btrim(
      regexp_replace(
        extensions.unaccent(pg_catalog.lower(pg_catalog.btrim(p_value))),
        '[^a-z0-9]+',
        ' ',
        'g'
      )
    ),
    ''
  );
$function$;

revoke all on function app_private.normalize_court_label(text) from public;
grant execute on function app_private.normalize_court_label(text)
  to service_role;

create table public.outcome_court_official_references (
  id uuid primary key default gen_random_uuid(),
  court_id uuid not null references public.outcome_courts(id) on delete restrict,
  court_code text not null check (nullif(btrim(court_code), '') is not null),
  official_origin_code text not null check (official_origin_code ~ '^[0-9]+$'),
  official_srj_code text not null check (official_srj_code ~ '^[0-9]+$'),
  official_name text not null check (nullif(btrim(official_name), '') is not null),
  judicial_region_origin_code text not null check (
    judicial_region_origin_code ~ '^[0-9]+$'
  ),
  judicial_region_srj_code text not null check (
    judicial_region_srj_code ~ '^[0-9]+$'
  ),
  judicial_region text not null check (
    nullif(btrim(judicial_region), '') is not null
  ),
  source_name text not null check (source_name = 'justice_open_data'),
  source_url text not null check (
    source_url =
      'https://www.data.gouv.fr/datasets/liste-des-juridictions-competentes-pour-les-communes-de-france'
  ),
  observed_on date not null,
  reference_sha256 text not null check (
    reference_sha256 ~ '^[0-9a-f]{64}$'
  ),
  created_at timestamptz not null default now(),
  unique (court_id, reference_sha256),
  unique (observed_on, official_origin_code, official_srj_code)
);

create index outcome_court_official_references_current_idx
  on public.outcome_court_official_references(court_id, observed_on desc, created_at desc);

create table public.auction_sale_court_label_assignments (
  id uuid primary key default gen_random_uuid(),
  source_key text not null,
  auction_sale_id uuid references public.auction_sales(id) on delete set null,
  source_url_snapshot text not null,
  source_label_snapshot text not null check (
    nullif(btrim(source_label_snapshot), '') is not null
  ),
  normalized_source_label text not null,
  court_id uuid not null references public.outcome_courts(id) on delete restrict,
  court_code text not null check (nullif(btrim(court_code), '') is not null),
  court_name text not null check (nullif(btrim(court_name), '') is not null),
  matched_label text not null check (nullif(btrim(matched_label), '') is not null),
  normalized_matched_label text not null,
  mapping_method text not null check (
    mapping_method in (
      'source_tribunal_label_exact',
      'source_tribunal_label_unique_prefix'
    )
  ),
  candidate_count smallint not null default 1 check (candidate_count = 1),
  created_at timestamptz not null default now(),
  unique (
    source_key,
    normalized_source_label,
    court_code,
    mapping_method
  ),
  constraint auction_sale_court_label_source_key_check check (
    source_key = app_private.auction_sale_catalogue_source_key(source_url_snapshot)
  ),
  constraint auction_sale_court_label_normalized_source_check check (
    normalized_source_label =
      app_private.normalize_court_label(source_label_snapshot)
  ),
  constraint auction_sale_court_label_normalized_match_check check (
    normalized_matched_label =
      app_private.normalize_court_label(matched_label)
  )
);

create index auction_sale_court_label_assignments_sale_idx
  on public.auction_sale_court_label_assignments(auction_sale_id, created_at desc)
  where auction_sale_id is not null;

create or replace function app_private.guard_court_enrichment_audit_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  raise exception using
    errcode = '55000',
    message = 'Court enrichment audit rows are immutable.';
end;
$function$;

revoke all on function app_private.guard_court_enrichment_audit_mutation()
  from public;

create trigger guard_outcome_court_official_reference_before_mutation
before update or delete on public.outcome_court_official_references
for each row execute function app_private.guard_court_enrichment_audit_mutation();

create trigger guard_auction_sale_court_label_assignment_before_mutation
before update or delete on public.auction_sale_court_label_assignments
for each row execute function app_private.guard_court_enrichment_audit_mutation();

with official_mapping (
  court_code,
  official_origin_code,
  official_srj_code,
  court_name,
  official_name,
  judicial_region_origin_code,
  judicial_region_srj_code,
  judicial_region
) as (
  values
    ('agen', '1', '119', 'TJ Agen', 'Tribunal judiciaire d''Agen', '1', '14', 'Cour d''Appel d''Agen'),
    ('bayonne', '1', '159', 'TJ Bayonne', 'Tribunal judiciaire de Bayonne', '1', '21', 'Cour d''Appel de Pau'),
    ('bergerac', '1', '78', 'TJ Bergerac', 'Tribunal judiciaire de Bergerac', '1', '9', 'Cour d''Appel de Bordeaux'),
    ('bordeaux', '1', '94', 'TJ Bordeaux', 'Tribunal judiciaire de Bordeaux', '1', '9', 'Cour d''Appel de Bordeaux'),
    ('dax', '1', '107', 'TJ Dax', 'Tribunal judiciaire de Dax', '1', '21', 'Cour d''Appel de Pau'),
    ('justice_tj_1_100', '1', '100', 'TJ Châteauroux', 'Tribunal judiciaire de Châteauroux', '1', '3', 'Cour d''Appel de Bourges'),
    ('justice_tj_1_101', '1', '101', 'TJ Tours', 'Tribunal judiciaire de Tours', '1', '13', 'Cour d''Appel d''Orléans'),
    ('justice_tj_1_102', '1', '102', 'TJ Bourgoin-Jallieu', 'Tribunal judiciaire de Bourgoin-Jallieu', '1', '12', 'Cour d''Appel de Grenoble'),
    ('justice_tj_1_103', '1', '103', 'TJ Grenoble', 'Tribunal judiciaire de Grenoble', '1', '12', 'Cour d''Appel de Grenoble'),
    ('justice_tj_1_104', '1', '104', 'TJ Vienne', 'Tribunal judiciaire de Vienne', '1', '12', 'Cour d''Appel de Grenoble'),
    ('justice_tj_1_106', '1', '106', 'TJ Lons-le-Saunier', 'Tribunal judiciaire de Lons-le-Saunier', '1', '6', 'Cour d''Appel de Besançon'),
    ('justice_tj_1_109', '1', '109', 'TJ Blois', 'Tribunal judiciaire de Blois', '1', '13', 'Cour d''Appel d''Orléans'),
    ('justice_tj_1_111', '1', '111', 'TJ Roanne', 'Tribunal judiciaire de Roanne', '1', '23', 'Cour d''Appel de Lyon'),
    ('justice_tj_1_112', '1', '112', 'TJ Saint-Etienne', 'Tribunal judiciaire de Saint-Etienne', '1', '23', 'Cour d''Appel de Lyon'),
    ('justice_tj_1_113', '1', '113', 'TJ Tribunal judiciaire du Puy-en-Velay', 'Tribunal judiciaire du Puy-en-Velay', '1', '20', 'Cour d''Appel de Riom'),
    ('justice_tj_1_114', '1', '114', 'TJ Nantes', 'Tribunal judiciaire de Nantes', '1', '11', 'Cour d''Appel de Rennes'),
    ('justice_tj_1_115', '1', '115', 'TJ Saint-Nazaire', 'Tribunal judiciaire de Saint-Nazaire', '1', '11', 'Cour d''Appel de Rennes'),
    ('justice_tj_1_116', '1', '116', 'TJ Montargis', 'Tribunal judiciaire de Montargis', '1', '13', 'Cour d''Appel d''Orléans'),
    ('justice_tj_1_117', '1', '117', 'TJ Orléans', 'Tribunal judiciaire d''Orléans', '1', '13', 'Cour d''Appel d''Orléans'),
    ('justice_tj_1_118', '1', '118', 'TJ Cahors', 'Tribunal judiciaire de Cahors', '1', '14', 'Cour d''Appel d''Agen'),
    ('justice_tj_1_121', '1', '121', 'TJ Mende', 'Tribunal judiciaire de Mende', '1', '7', 'Cour d''Appel de Nîmes'),
    ('justice_tj_1_122', '1', '122', 'TJ Angers', 'Tribunal judiciaire d''Angers', '1', '15', 'Cour d''Appel d''Angers'),
    ('justice_tj_1_125', '1', '125', 'TJ Cherbourg-en-Cotentin', 'Tribunal judiciaire de Cherbourg-en-Cotentin', '1', '2', 'Cour d''Appel de Caen'),
    ('justice_tj_1_126', '1', '126', 'TJ Coutances', 'Tribunal judiciaire de Coutances', '1', '2', 'Cour d''Appel de Caen'),
    ('justice_tj_1_127', '1', '127', 'TJ Châlons-en-Champagne', 'Tribunal judiciaire de Châlons-en-Champagne', '1', '16', 'Cour d''Appel de Reims'),
    ('justice_tj_1_128', '1', '128', 'TJ Reims', 'Tribunal judiciaire de Reims', '1', '16', 'Cour d''Appel de Reims'),
    ('justice_tj_1_129', '1', '129', 'TJ Chaumont', 'Tribunal judiciaire de Chaumont', '1', '5', 'Cour d''Appel de Dijon'),
    ('justice_tj_1_130', '1', '130', 'TJ Laval', 'Tribunal judiciaire de Laval', '1', '15', 'Cour d''Appel d''Angers'),
    ('justice_tj_1_131', '1', '131', 'TJ Val de Briey', 'Tribunal judiciaire de Val de Briey', '1', '17', 'Cour d''Appel de Nancy'),
    ('justice_tj_1_132', '1', '132', 'TJ Nancy', 'Tribunal judiciaire de Nancy', '1', '17', 'Cour d''Appel de Nancy'),
    ('justice_tj_1_133', '1', '133', 'TJ Bar-le-Duc', 'Tribunal judiciaire de Bar-le-Duc', '1', '17', 'Cour d''Appel de Nancy'),
    ('justice_tj_1_134', '1', '134', 'TJ Verdun', 'Tribunal judiciaire de Verdun', '1', '17', 'Cour d''Appel de Nancy'),
    ('justice_tj_1_135', '1', '135', 'TJ Lorient', 'Tribunal judiciaire de Lorient', '1', '11', 'Cour d''Appel de Rennes'),
    ('justice_tj_1_136', '1', '136', 'TJ Vannes', 'Tribunal judiciaire de Vannes', '1', '11', 'Cour d''Appel de Rennes'),
    ('justice_tj_1_137', '1', '137', 'TJ Metz', 'Tribunal judiciaire de Metz', '1', '18', 'Cour d''Appel de Metz'),
    ('justice_tj_1_138', '1', '138', 'TJ Sarreguemines', 'Tribunal judiciaire de Sarreguemines', '1', '18', 'Cour d''Appel de Metz'),
    ('justice_tj_1_139', '1', '139', 'TJ Thionville', 'Tribunal judiciaire de Thionville', '1', '18', 'Cour d''Appel de Metz'),
    ('justice_tj_1_140', '1', '140', 'TJ Nevers', 'Tribunal judiciaire de Nevers', '1', '3', 'Cour d''Appel de Bourges'),
    ('justice_tj_1_141', '1', '141', 'TJ Avesnes-sur-Helpe', 'Tribunal judiciaire d''Avesnes-sur-Helpe', '1', '19', 'Cour d''Appel de Douai'),
    ('justice_tj_1_142', '1', '142', 'TJ Cambrai', 'Tribunal judiciaire de Cambrai', '1', '19', 'Cour d''Appel de Douai'),
    ('justice_tj_1_143', '1', '143', 'TJ Douai', 'Tribunal judiciaire de Douai', '1', '19', 'Cour d''Appel de Douai'),
    ('justice_tj_1_144', '1', '144', 'TJ Dunkerque', 'Tribunal judiciaire de Dunkerque', '1', '19', 'Cour d''Appel de Douai'),
    ('justice_tj_1_146', '1', '146', 'TJ Lille', 'Tribunal judiciaire de Lille', '1', '19', 'Cour d''Appel de Douai'),
    ('justice_tj_1_147', '1', '147', 'TJ Valenciennes', 'Tribunal judiciaire de Valenciennes', '1', '19', 'Cour d''Appel de Douai'),
    ('justice_tj_1_148', '1', '148', 'TJ Beauvais', 'Tribunal judiciaire de Beauvais', '1', '28', 'Cour d''Appel d''Amiens'),
    ('justice_tj_1_149', '1', '149', 'TJ Compiègne', 'Tribunal judiciaire de Compiègne', '1', '28', 'Cour d''Appel d''Amiens'),
    ('justice_tj_1_150', '1', '150', 'TJ Senlis', 'Tribunal judiciaire de Senlis', '1', '28', 'Cour d''Appel d''Amiens'),
    ('justice_tj_1_151', '1', '151', 'TJ Alençon', 'Tribunal judiciaire d''Alençon', '1', '2', 'Cour d''Appel de Caen'),
    ('justice_tj_1_152', '1', '152', 'TJ Argentan', 'Tribunal judiciaire d''Argentan', '1', '2', 'Cour d''Appel de Caen'),
    ('justice_tj_1_153', '1', '153', 'TJ Arras', 'Tribunal judiciaire d''Arras', '1', '19', 'Cour d''Appel de Douai'),
    ('justice_tj_1_154', '1', '154', 'TJ Béthune', 'Tribunal judiciaire de Béthune', '1', '19', 'Cour d''Appel de Douai'),
    ('justice_tj_1_155', '1', '155', 'TJ Boulogne-sur-Mer', 'Tribunal judiciaire de Boulogne-sur-Mer', '1', '19', 'Cour d''Appel de Douai'),
    ('justice_tj_1_156', '1', '156', 'TJ Saint-Omer', 'Tribunal judiciaire de Saint-Omer', '1', '19', 'Cour d''Appel de Douai'),
    ('justice_tj_1_157', '1', '157', 'TJ Clermont-Ferrand', 'Tribunal judiciaire de Clermont-Ferrand', '1', '20', 'Cour d''Appel de Riom'),
    ('justice_tj_1_161', '1', '161', 'TJ Tarbes', 'Tribunal judiciaire de Tarbes', '1', '21', 'Cour d''Appel de Pau'),
    ('justice_tj_1_162', '1', '162', 'TJ Perpignan', 'Tribunal judiciaire de Perpignan', '1', '10', 'Cour d''Appel de Montpellier'),
    ('justice_tj_1_163', '1', '163', 'TJ Saverne', 'Tribunal judiciaire de Saverne', '1', '22', 'Cour d''Appel de Colmar'),
    ('justice_tj_1_164', '1', '164', 'TJ Strasbourg', 'Tribunal judiciaire de Strasbourg', '1', '22', 'Cour d''Appel de Colmar'),
    ('justice_tj_1_165', '1', '165', 'TJ Colmar', 'Tribunal judiciaire de Colmar', '1', '22', 'Cour d''Appel de Colmar'),
    ('justice_tj_1_166', '1', '166', 'TJ Mulhouse', 'Tribunal judiciaire de Mulhouse', '1', '22', 'Cour d''Appel de Colmar'),
    ('justice_tj_1_167', '1', '167', 'TJ Lyon', 'Tribunal judiciaire de Lyon', '1', '23', 'Cour d''Appel de Lyon'),
    ('justice_tj_1_168', '1', '168', 'TJ Villefranche-sur-Saône', 'Tribunal judiciaire de Villefranche-sur-Saône', '1', '23', 'Cour d''Appel de Lyon'),
    ('justice_tj_1_170', '1', '170', 'TJ Vesoul', 'Tribunal judiciaire de Vesoul', '1', '6', 'Cour d''Appel de Besançon'),
    ('justice_tj_1_171', '1', '171', 'TJ Chalon-sur-Saône', 'Tribunal judiciaire de Chalon-sur-Saône', '1', '5', 'Cour d''Appel de Dijon'),
    ('justice_tj_1_172', '1', '172', 'TJ Mâcon', 'Tribunal judiciaire de Mâcon', '1', '5', 'Cour d''Appel de Dijon'),
    ('justice_tj_1_173', '1', '173', 'TJ Tribunal judiciaire du Mans', 'Tribunal judiciaire du Mans', '1', '15', 'Cour d''Appel d''Angers'),
    ('justice_tj_1_174', '1', '174', 'TJ Albertville', 'Tribunal judiciaire d''Albertville', '1', '24', 'Cour d''Appel de Chambéry'),
    ('justice_tj_1_175', '1', '175', 'TJ Chambéry', 'Tribunal judiciaire de Chambéry', '1', '24', 'Cour d''Appel de Chambéry'),
    ('justice_tj_1_176', '1', '176', 'TJ Annecy', 'Tribunal judiciaire d''Annecy', '1', '24', 'Cour d''Appel de Chambéry'),
    ('justice_tj_1_177', '1', '177', 'TJ Bonneville', 'Tribunal judiciaire de Bonneville', '1', '24', 'Cour d''Appel de Chambéry'),
    ('justice_tj_1_178', '1', '178', 'TJ Thonon-les-Bains', 'Tribunal judiciaire de Thonon-les-Bains', '1', '24', 'Cour d''Appel de Chambéry'),
    ('justice_tj_1_180', '1', '180', 'TJ Dieppe', 'Tribunal judiciaire de Dieppe', '1', '26', 'Cour d''Appel de Rouen'),
    ('justice_tj_1_181', '1', '181', 'TJ Tribunal judiciaire du Havre', 'Tribunal judiciaire du Havre', '1', '26', 'Cour d''Appel de Rouen'),
    ('justice_tj_1_182', '1', '182', 'TJ Rouen', 'Tribunal judiciaire de Rouen', '1', '26', 'Cour d''Appel de Rouen'),
    ('justice_tj_1_183', '1', '183', 'TJ Fontainebleau', 'Tribunal judiciaire de Fontainebleau', '9', '14815', 'Cour d''Appel de Paris'),
    ('justice_tj_1_184', '1', '184', 'TJ Meaux', 'Tribunal judiciaire de Meaux', '9', '14815', 'Cour d''Appel de Paris'),
    ('justice_tj_1_185', '1', '185', 'TJ Melun', 'Tribunal judiciaire de Melun', '9', '14815', 'Cour d''Appel de Paris'),
    ('justice_tj_1_186', '1', '186', 'TJ Versailles', 'Tribunal judiciaire de Versailles', '1', '27', 'Cour d''Appel de Versailles'),
    ('justice_tj_1_188', '1', '188', 'TJ Niort', 'Tribunal judiciaire de Niort', '1', '29', 'Cour d''Appel de Poitiers'),
    ('justice_tj_1_190', '1', '190', 'TJ Amiens', 'Tribunal judiciaire d''Amiens', '1', '28', 'Cour d''Appel d''Amiens'),
    ('justice_tj_1_192', '1', '192', 'TJ Albi', 'Tribunal judiciaire d''Albi', '1', '8', 'Cour d''Appel de Toulouse'),
    ('justice_tj_1_193', '1', '193', 'TJ Castres', 'Tribunal judiciaire de Castres', '1', '8', 'Cour d''Appel de Toulouse'),
    ('justice_tj_1_194', '1', '194', 'TJ Montauban', 'Tribunal judiciaire de Montauban', '1', '8', 'Cour d''Appel de Toulouse'),
    ('justice_tj_1_195', '1', '195', 'TJ Draguignan', 'Tribunal judiciaire de Draguignan', '1', '1', 'Cour d''Appel d''Aix-en-Provence'),
    ('justice_tj_1_196', '1', '196', 'TJ Toulon', 'Tribunal judiciaire de Toulon', '1', '1', 'Cour d''Appel d''Aix-en-Provence'),
    ('justice_tj_1_197', '1', '197', 'TJ Avignon', 'Tribunal judiciaire d''Avignon', '1', '7', 'Cour d''Appel de Nîmes'),
    ('justice_tj_1_198', '1', '198', 'TJ Carpentras', 'Tribunal judiciaire de Carpentras', '1', '7', 'Cour d''Appel de Nîmes'),
    ('justice_tj_1_199', '1', '199', 'TJ La Roche-sur-Yon', 'Tribunal judiciaire de La Roche-sur-Yon', '1', '29', 'Cour d''Appel de Poitiers'),
    ('justice_tj_1_200', '1', '200', 'TJ Tribunal judiciaire des Sables-d''Olonne', 'Tribunal judiciaire des Sables-d''Olonne', '1', '29', 'Cour d''Appel de Poitiers'),
    ('justice_tj_1_201', '1', '201', 'TJ Poitiers', 'Tribunal judiciaire de Poitiers', '1', '29', 'Cour d''Appel de Poitiers'),
    ('justice_tj_1_202', '1', '202', 'TJ Limoges', 'Tribunal judiciaire de Limoges', '1', '30', 'Cour d''Appel de Limoges'),
    ('justice_tj_1_203', '1', '203', 'TJ Epinal', 'Tribunal judiciaire d''Epinal', '1', '17', 'Cour d''Appel de Nancy'),
    ('justice_tj_1_205', '1', '205', 'TJ Auxerre', 'Tribunal judiciaire d''Auxerre', '9', '14815', 'Cour d''Appel de Paris'),
    ('justice_tj_1_206', '1', '206', 'TJ Sens', 'Tribunal judiciaire de Sens', '9', '14815', 'Cour d''Appel de Paris'),
    ('justice_tj_1_207', '1', '207', 'TJ Belfort', 'Tribunal judiciaire de Belfort', '1', '6', 'Cour d''Appel de Besançon'),
    ('justice_tj_1_208', '1', '208', 'TJ Évry-Courcouronnes', 'Tribunal judiciaire d''Évry-Courcouronnes', '9', '14815', 'Cour d''Appel de Paris'),
    ('justice_tj_1_209', '1', '209', 'TJ Nanterre', 'Tribunal judiciaire de Nanterre', '1', '27', 'Cour d''Appel de Versailles'),
    ('justice_tj_1_210', '1', '210', 'TJ Bobigny', 'Tribunal judiciaire de Bobigny', '9', '14815', 'Cour d''Appel de Paris'),
    ('justice_tj_1_211', '1', '211', 'TJ Créteil', 'Tribunal judiciaire de Créteil', '9', '14815', 'Cour d''Appel de Paris'),
    ('justice_tj_1_212', '1', '212', 'TJ Pontoise', 'Tribunal judiciaire de Pontoise', '1', '27', 'Cour d''Appel de Versailles'),
    ('justice_tj_1_213', '1', '213', 'TJ Basse-Terre', 'Tribunal judiciaire de Basse-Terre', '1', '31', 'Cour d''Appel de Basse-Terre'),
    ('justice_tj_1_214', '1', '214', 'TJ Pointe-à-Pitre', 'Tribunal judiciaire de Pointe-à-Pitre', '1', '31', 'Cour d''Appel de Basse-Terre'),
    ('justice_tj_1_215', '1', '215', 'TJ Fort-de-France', 'Tribunal judiciaire de Fort-de-France', '1', '32', 'Cour d''Appel de Fort-de-France'),
    ('justice_tj_1_216', '1', '216', 'TJ Cayenne', 'Tribunal judiciaire de Cayenne', '9', '43116', 'Cour d''appel de Cayenne'),
    ('justice_tj_1_217', '1', '217', 'TJ Saint-Denis-de-La-Réunion', 'Tribunal judiciaire de Saint-Denis-de-La-Réunion', '1', '33', 'Cour d''Appel de Saint-Denis-de-La Réunion'),
    ('justice_tj_1_218', '1', '218', 'TJ Saint-Pierre', 'Tribunal judiciaire de Saint-Pierre', '1', '33', 'Cour d''Appel de Saint-Denis-de-La Réunion'),
    ('justice_tj_1_221', '1', '221', 'TJ Tribunal de Première Instance de Mata-Utu', 'Tribunal de Première Instance de Mata-Utu', '1', '37', 'Cour d''Appel de Nouméa'),
    ('justice_tj_1_222', '1', '222', 'TJ Tribunal de Première Instance de Papeete', 'Tribunal de Première Instance de Papeete', '1', '36', 'Cour d''Appel de Papeete'),
    ('justice_tj_1_223', '1', '223', 'TJ Tribunal de Première Instance de Nouméa', 'Tribunal de Première Instance de Nouméa', '1', '37', 'Cour d''Appel de Nouméa'),
    ('justice_tj_1_39', '1', '39', 'TJ Bourg-en-Bresse', 'Tribunal judiciaire de Bourg-en-Bresse', '1', '23', 'Cour d''Appel de Lyon'),
    ('justice_tj_1_40', '1', '40', 'TJ Laon', 'Tribunal judiciaire de Laon', '1', '28', 'Cour d''Appel d''Amiens'),
    ('justice_tj_1_41', '1', '41', 'TJ Saint-Quentin', 'Tribunal judiciaire de Saint-Quentin', '1', '28', 'Cour d''Appel d''Amiens'),
    ('justice_tj_1_42', '1', '42', 'TJ Soissons', 'Tribunal judiciaire de Soissons', '1', '28', 'Cour d''Appel d''Amiens'),
    ('justice_tj_1_43', '1', '43', 'TJ Cusset', 'Tribunal judiciaire de Cusset', '1', '20', 'Cour d''Appel de Riom'),
    ('justice_tj_1_44', '1', '44', 'TJ Montluçon', 'Tribunal judiciaire de Montluçon', '1', '20', 'Cour d''Appel de Riom'),
    ('justice_tj_1_45', '1', '45', 'TJ Moulins', 'Tribunal judiciaire de Moulins', '1', '20', 'Cour d''Appel de Riom'),
    ('justice_tj_1_46', '1', '46', 'TJ Digne-les-Bains', 'Tribunal judiciaire de Digne-les-Bains', '1', '1', 'Cour d''Appel d''Aix-en-Provence'),
    ('justice_tj_1_47', '1', '47', 'TJ Gap', 'Tribunal judiciaire de Gap', '1', '12', 'Cour d''Appel de Grenoble'),
    ('justice_tj_1_48', '1', '48', 'TJ Grasse', 'Tribunal judiciaire de Grasse', '1', '1', 'Cour d''Appel d''Aix-en-Provence'),
    ('justice_tj_1_49', '1', '49', 'TJ Nice', 'Tribunal judiciaire de Nice', '1', '1', 'Cour d''Appel d''Aix-en-Provence'),
    ('justice_tj_1_50', '1', '50', 'TJ Privas', 'Tribunal judiciaire de Privas', '1', '7', 'Cour d''Appel de Nîmes'),
    ('justice_tj_1_51', '1', '51', 'TJ Charleville-Mézières', 'Tribunal judiciaire de Charleville-Mézières', '1', '16', 'Cour d''Appel de Reims'),
    ('justice_tj_1_52', '1', '52', 'TJ Foix', 'Tribunal judiciaire de Foix', '1', '8', 'Cour d''Appel de Toulouse'),
    ('justice_tj_1_53', '1', '53', 'TJ Troyes', 'Tribunal judiciaire de Troyes', '1', '16', 'Cour d''Appel de Reims'),
    ('justice_tj_1_54', '1', '54', 'TJ Carcassonne', 'Tribunal judiciaire de Carcassonne', '1', '10', 'Cour d''Appel de Montpellier'),
    ('justice_tj_1_55', '1', '55', 'TJ Narbonne', 'Tribunal judiciaire de Narbonne', '1', '10', 'Cour d''Appel de Montpellier'),
    ('justice_tj_1_57', '1', '57', 'TJ Rodez', 'Tribunal judiciaire de Rodez', '1', '10', 'Cour d''Appel de Montpellier'),
    ('justice_tj_1_58', '1', '58', 'TJ Aix-en-Provence', 'Tribunal judiciaire d''Aix-en-Provence', '1', '1', 'Cour d''Appel d''Aix-en-Provence'),
    ('justice_tj_1_59', '1', '59', 'TJ Marseille', 'Tribunal judiciaire de Marseille', '1', '1', 'Cour d''Appel d''Aix-en-Provence'),
    ('justice_tj_1_60', '1', '60', 'TJ Tarascon', 'Tribunal judiciaire de Tarascon', '1', '1', 'Cour d''Appel d''Aix-en-Provence'),
    ('justice_tj_1_61', '1', '61', 'TJ Caen', 'Tribunal judiciaire de Caen', '1', '2', 'Cour d''Appel de Caen'),
    ('justice_tj_1_62', '1', '62', 'TJ Lisieux', 'Tribunal judiciaire de Lisieux', '1', '2', 'Cour d''Appel de Caen'),
    ('justice_tj_1_63', '1', '63', 'TJ Aurillac', 'Tribunal judiciaire d''Aurillac', '1', '20', 'Cour d''Appel de Riom'),
    ('justice_tj_1_64', '1', '64', 'TJ Angoulême', 'Tribunal judiciaire d''Angoulême', '1', '9', 'Cour d''Appel de Bordeaux'),
    ('justice_tj_1_66', '1', '66', 'TJ La Rochelle', 'Tribunal judiciaire de La Rochelle', '1', '29', 'Cour d''Appel de Poitiers'),
    ('justice_tj_1_67', '1', '67', 'TJ Saintes', 'Tribunal judiciaire de Saintes', '1', '29', 'Cour d''Appel de Poitiers'),
    ('justice_tj_1_68', '1', '68', 'TJ Bourges', 'Tribunal judiciaire de Bourges', '1', '3', 'Cour d''Appel de Bourges'),
    ('justice_tj_1_69', '1', '69', 'TJ Brive-la-Gaillarde', 'Tribunal judiciaire de Brive-la-Gaillarde', '1', '30', 'Cour d''Appel de Limoges'),
    ('justice_tj_1_71', '1', '71', 'TJ Ajaccio', 'Tribunal judiciaire d''Ajaccio', '1', '4', 'Cour d''Appel de Bastia'),
    ('justice_tj_1_72', '1', '72', 'TJ Bastia', 'Tribunal judiciaire de Bastia', '1', '4', 'Cour d''Appel de Bastia'),
    ('justice_tj_1_73', '1', '73', 'TJ Dijon', 'Tribunal judiciaire de Dijon', '1', '5', 'Cour d''Appel de Dijon'),
    ('justice_tj_1_76', '1', '76', 'TJ Saint-Brieuc', 'Tribunal judiciaire de Saint-Brieuc', '1', '11', 'Cour d''Appel de Rennes'),
    ('justice_tj_1_77', '1', '77', 'TJ Guéret', 'Tribunal judiciaire de Guéret', '1', '30', 'Cour d''Appel de Limoges'),
    ('justice_tj_1_80', '1', '80', 'TJ Besançon', 'Tribunal judiciaire de Besançon', '1', '6', 'Cour d''Appel de Besançon'),
    ('justice_tj_1_81', '1', '81', 'TJ Montbéliard', 'Tribunal judiciaire de Montbéliard', '1', '6', 'Cour d''Appel de Besançon'),
    ('justice_tj_1_82', '1', '82', 'TJ Valence', 'Tribunal judiciaire de Valence', '1', '12', 'Cour d''Appel de Grenoble'),
    ('justice_tj_1_84', '1', '84', 'TJ Evreux', 'Tribunal judiciaire d''Evreux', '1', '26', 'Cour d''Appel de Rouen'),
    ('justice_tj_1_85', '1', '85', 'TJ Chartres', 'Tribunal judiciaire de Chartres', '1', '27', 'Cour d''Appel de Versailles'),
    ('justice_tj_1_86', '1', '86', 'TJ Brest', 'Tribunal judiciaire de Brest', '1', '11', 'Cour d''Appel de Rennes'),
    ('justice_tj_1_88', '1', '88', 'TJ Quimper', 'Tribunal judiciaire de Quimper', '1', '11', 'Cour d''Appel de Rennes'),
    ('justice_tj_1_89', '1', '89', 'TJ Alès', 'Tribunal judiciaire d''Alès', '1', '7', 'Cour d''Appel de Nîmes'),
    ('justice_tj_1_90', '1', '90', 'TJ Nîmes', 'Tribunal judiciaire de Nîmes', '1', '7', 'Cour d''Appel de Nîmes'),
    ('justice_tj_1_92', '1', '92', 'TJ Toulouse', 'Tribunal judiciaire de Toulouse', '1', '8', 'Cour d''Appel de Toulouse'),
    ('justice_tj_1_93', '1', '93', 'TJ Auch', 'Tribunal judiciaire d''Auch', '1', '14', 'Cour d''Appel d''Agen'),
    ('justice_tj_1_96', '1', '96', 'TJ Béziers', 'Tribunal judiciaire de Béziers', '1', '10', 'Cour d''Appel de Montpellier'),
    ('justice_tj_1_97', '1', '97', 'TJ Montpellier', 'Tribunal judiciaire de Montpellier', '1', '10', 'Cour d''Appel de Montpellier'),
    ('justice_tj_1_98', '1', '98', 'TJ Rennes', 'Tribunal judiciaire de Rennes', '1', '11', 'Cour d''Appel de Rennes'),
    ('justice_tj_1_99', '1', '99', 'TJ Saint-Malo', 'Tribunal judiciaire de Saint-Malo', '1', '11', 'Cour d''Appel de Rennes'),
    ('justice_tj_9_15273', '9', '15273', 'TJ Paris', 'Tribunal judiciaire de Paris', '9', '14815', 'Cour d''Appel de Paris'),
    ('justice_tj_9_41809', '9', '41809', 'TJ Mamoudzou', 'Tribunal judiciaire de Mamoudzou', '1', '33', 'Cour d''Appel de Saint-Denis-de-La Réunion'),
    ('justice_tj_9_48312', '9', '48312', 'TJ Saumur', 'Tribunal judiciaire de Saumur', '1', '15', 'Cour d''Appel d''Angers'),
    ('justice_tj_9_48313', '9', '48313', 'TJ St Gaudens', 'Tribunal judiciaire de St Gaudens', '1', '8', 'Cour d''Appel de Toulouse'),
    ('justice_tj_9_48314', '9', '48314', 'TJ Tulle', 'Tribunal judiciaire de Tulle', '1', '30', 'Cour d''Appel de Limoges'),
    ('justice_tj_9_7677', '9', '7677', 'TJ Tribunal de Première Instance de Saint-Pierre-et-Miquelon', 'Tribunal de Première Instance de Saint-Pierre-et-Miquelon', '9', '2895', 'Tribunal Supérieur d''Appel de Saint-Pierre-et-Miquelon'),
    ('libourne', '1', '95', 'TJ Libourne', 'Tribunal judiciaire de Libourne', '1', '9', 'Cour d''Appel de Bordeaux'),
    ('mont_de_marsan', '1', '108', 'TJ Mont-de-Marsan', 'Tribunal judiciaire de Mont-de-Marsan', '1', '21', 'Cour d''Appel de Pau'),
    ('pau', '1', '160', 'TJ Pau', 'Tribunal judiciaire de Pau', '1', '21', 'Cour d''Appel de Pau'),
    ('perigueux', '1', '79', 'TJ Périgueux', 'Tribunal judiciaire de Périgueux', '1', '9', 'Cour d''Appel de Bordeaux')
)
insert into public.outcome_court_official_references (
  court_id,
  court_code,
  official_origin_code,
  official_srj_code,
  official_name,
  judicial_region_origin_code,
  judicial_region_srj_code,
  judicial_region,
  source_name,
  source_url,
  observed_on,
  reference_sha256
)
select
  court.id,
  mapping.court_code,
  mapping.official_origin_code,
  mapping.official_srj_code,
  mapping.official_name,
  mapping.judicial_region_origin_code,
  mapping.judicial_region_srj_code,
  mapping.judicial_region,
  'justice_open_data',
  'https://www.data.gouv.fr/datasets/liste-des-juridictions-competentes-pour-les-communes-de-france',
  date '2026-07-28',
  encode(
    extensions.digest(
      convert_to(
        concat_ws(
          '|',
          mapping.court_code,
          mapping.official_origin_code,
          mapping.official_srj_code,
          mapping.official_name,
          mapping.judicial_region_origin_code,
          mapping.judicial_region_srj_code,
          mapping.judicial_region,
          '2026-07-28'
        ),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
from official_mapping mapping
join public.outcome_courts court
  on court.code = mapping.court_code
 and court.active
 and court.court_type = 'tribunal_judiciaire'
on conflict (court_id, reference_sha256) do nothing;

-- The July 2026 Ministry registry no longer contains a TJ de Marmande. It
-- exposes a Tribunal de proximité de Marmande instead. Keep the historical
-- row, but remove it from the current active-TJ directory only while it has no
-- catalogue, Outcome or published-statistics dependency.
do $block$
begin
  if exists (
    select 1
    from public.outcome_courts court
    where court.code = 'marmande'
      and court.active
      and (
        exists (
          select 1
          from public.auction_sales sale
          where sale.tribunal_code = court.code
        )
        or exists (
          select 1
          from public.auction_cases case_row
          where case_row.court_id = court.id
        )
        or exists (
          select 1
          from public.tribunal_statistics_snapshots snapshot
          where snapshot.court_id = court.id
        )
      )
  ) then
    raise exception using
      errcode = '55000',
      message =
        'The obsolete TJ Marmande row has dependencies and requires a reviewed migration.';
  end if;

  update public.outcome_courts court
  set active = false,
      updated_at = now()
  where court.code = 'marmande'
    and court.active;
end;
$block$;

do $block$
declare
  missing_codes text;
  conflicting_codes text;
begin
  select string_agg(court.code, ', ' order by court.code)
  into missing_codes
  from public.outcome_courts court
  where court.active
    and court.court_type = 'tribunal_judiciaire'
    and not exists (
      select 1
      from public.outcome_court_official_references reference
      where reference.court_id = court.id
    );

  if missing_codes is not null then
    raise exception using
      errcode = '23514',
      message = 'Active courts missing an official Justice reference: ' || missing_codes;
  end if;

  select string_agg(court.code, ', ' order by court.code)
  into conflicting_codes
  from public.outcome_courts court
  join lateral (
    select reference.judicial_region
    from public.outcome_court_official_references reference
    where reference.court_id = court.id
    order by reference.observed_on desc, reference.created_at desc
    limit 1
  ) current_reference on true
  where court.active
    and court.court_type = 'tribunal_judiciaire'
    and nullif(btrim(court.judicial_region), '') is not null
    and court.judicial_region is distinct from current_reference.judicial_region;

  if conflicting_codes is not null then
    raise exception using
      errcode = '23514',
      message = 'Canonical court regions conflict with the official Justice reference: '
        || conflicting_codes;
  end if;
end;
$block$;

with current_references as (
  select distinct on (reference.court_id)
    reference.court_id,
    reference.judicial_region
  from public.outcome_court_official_references reference
  order by reference.court_id, reference.observed_on desc, reference.created_at desc
)
update public.outcome_courts court
set judicial_region = reference.judicial_region,
    updated_at = now()
from current_references reference
where court.id = reference.court_id
  and nullif(btrim(court.judicial_region), '') is null;

create or replace function app_private.resolve_unique_active_court_label(
  p_source_label text
)
returns table (
  court_id uuid,
  court_code text,
  court_name text,
  matched_label text,
  normalized_source_label text,
  normalized_matched_label text,
  mapping_method text
)
language sql
stable
security invoker
set search_path = ''
as $function$
  with source_label as (
    select app_private.normalize_court_label(p_source_label) as normalized_label
  ),
  court_labels as (
    select
      court.id as court_id,
      court.code as court_code,
      court.name as court_name,
      court.name as matched_label,
      app_private.normalize_court_label(court.name) as normalized_matched_label
    from public.outcome_courts court
    where court.active
      and court.court_type = 'tribunal_judiciaire'

    union

    select
      court.id,
      court.code,
      court.name,
      tribunal.canonical_name,
      app_private.normalize_court_label(tribunal.canonical_name)
    from public.outcome_courts court
    join public.tribunals tribunal on tribunal.code = court.code
    where court.active
      and court.court_type = 'tribunal_judiciaire'

    union

    select
      court.id,
      court.code,
      court.name,
      alias.value,
      app_private.normalize_court_label(alias.value)
    from public.outcome_courts court
    join public.tribunals tribunal on tribunal.code = court.code
    cross join lateral jsonb_array_elements_text(
      case
        when jsonb_typeof(tribunal.aliases) = 'array' then tribunal.aliases
        else '[]'::jsonb
      end
    ) alias(value)
    where court.active
      and court.court_type = 'tribunal_judiciaire'
  ),
  candidates as (
    select
      label.*,
      source.normalized_label as normalized_source_label,
      length(label.normalized_matched_label) as matched_length
    from source_label source
    join court_labels label
      on source.normalized_label = label.normalized_matched_label
      or source.normalized_label like label.normalized_matched_label || ' %'
    where source.normalized_label ~
      '^(?:tj|tgi|tribunal judiciaire|tribunal de grande instance)(?: |$)'
      and label.normalized_matched_label ~
        '^(?:tj|tgi|tribunal judiciaire|tribunal de grande instance)(?: |$)'
  ),
  longest_candidates as (
    select candidate.*
    from candidates candidate
    where candidate.matched_length = (
      select max(candidate_length.matched_length)
      from candidates candidate_length
    )
  )
  select
    candidate.court_id,
    candidate.court_code,
    candidate.court_name,
    candidate.matched_label,
    candidate.normalized_source_label,
    candidate.normalized_matched_label,
    case
      when candidate.normalized_source_label = candidate.normalized_matched_label
        then 'source_tribunal_label_exact'
      else 'source_tribunal_label_unique_prefix'
    end
  from longest_candidates candidate
  where (
    select count(distinct unique_candidate.court_id)
    from longest_candidates unique_candidate
  ) = 1
  order by
    (candidate.normalized_source_label = candidate.normalized_matched_label) desc,
    candidate.matched_length desc,
    candidate.matched_label
  limit 1;
$function$;

revoke all on function app_private.resolve_unique_active_court_label(text)
  from public;

create or replace function public.reconcile_catalogue_court_labels(
  p_min_sale_date date,
  p_max_sale_date date
)
returns table (
  scanned_count bigint,
  assigned_count bigint,
  exact_label_count bigint,
  prefix_label_count bigint,
  unresolved_count bigint,
  complete boolean
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  total_scanned bigint := 0;
  total_assigned bigint := 0;
  total_exact bigint := 0;
  total_prefix bigint := 0;
  total_unresolved bigint := 0;
begin
  if p_min_sale_date is null
    or p_max_sale_date is null
    or p_min_sale_date > p_max_sale_date then
    raise exception using
      errcode = '22023',
      message = 'A valid inclusive sale-date range is required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('immojudis:catalogue-court-label-reconciliation:v1', 0)
  );

  select count(*)
  into total_scanned
  from public.auction_sales sale
  where sale.sale_date >= p_min_sale_date
    and sale.sale_date < p_max_sale_date + 1
    and sale.sale_venue_type = 'tribunal'
    and sale.sale_verification_status in ('verified', 'cross_checked')
    and sale.tribunal_code is null;

  insert into public.auction_sale_court_label_assignments (
    source_key,
    auction_sale_id,
    source_url_snapshot,
    source_label_snapshot,
    normalized_source_label,
    court_id,
    court_code,
    court_name,
    matched_label,
    normalized_matched_label,
    mapping_method,
    candidate_count
  )
  select
    app_private.auction_sale_catalogue_source_key(sale.source_url),
    sale.id,
    sale.source_url,
    sale.tribunal,
    resolution.normalized_source_label,
    resolution.court_id,
    resolution.court_code,
    resolution.court_name,
    resolution.matched_label,
    resolution.normalized_matched_label,
    resolution.mapping_method,
    1
  from public.auction_sales sale
  cross join lateral app_private.resolve_unique_active_court_label(
    sale.tribunal
  ) resolution
  where sale.sale_date >= p_min_sale_date
    and sale.sale_date < p_max_sale_date + 1
    and sale.sale_venue_type = 'tribunal'
    and sale.sale_verification_status in ('verified', 'cross_checked')
    and sale.tribunal_code is null
    and nullif(btrim(sale.tribunal), '') is not null
  on conflict (
    source_key,
    normalized_source_label,
    court_code,
    mapping_method
  ) do nothing;

  with resolved_sales as (
    select
      sale.id as sale_id,
      resolution.court_code,
      resolution.normalized_source_label,
      resolution.mapping_method
    from public.auction_sales sale
    cross join lateral app_private.resolve_unique_active_court_label(
      sale.tribunal
    ) resolution
    where sale.sale_date >= p_min_sale_date
      and sale.sale_date < p_max_sale_date + 1
      and sale.sale_venue_type = 'tribunal'
      and sale.sale_verification_status in ('verified', 'cross_checked')
      and sale.tribunal_code is null
      and nullif(btrim(sale.tribunal), '') is not null
  )
  update public.auction_sales sale
  set tribunal_code = resolution.court_code,
      updated_at = now()
  from resolved_sales resolution
  where sale.id = resolution.sale_id
    and sale.tribunal_code is null
    and exists (
      select 1
      from public.auction_sale_court_label_assignments assignment
      where assignment.auction_sale_id = sale.id
        and assignment.normalized_source_label =
          resolution.normalized_source_label
        and assignment.court_code = resolution.court_code
        and assignment.mapping_method = resolution.mapping_method
    );

  get diagnostics total_assigned = row_count;

  select
    count(*) filter (
      where assignment.mapping_method = 'source_tribunal_label_exact'
    ),
    count(*) filter (
      where assignment.mapping_method =
        'source_tribunal_label_unique_prefix'
    )
  into total_exact, total_prefix
  from public.auction_sale_court_label_assignments assignment
  join public.auction_sales sale on sale.id = assignment.auction_sale_id
  where sale.sale_date >= p_min_sale_date
    and sale.sale_date < p_max_sale_date + 1
    and sale.sale_venue_type = 'tribunal'
    and sale.sale_verification_status in ('verified', 'cross_checked')
    and sale.tribunal_code = assignment.court_code
    and app_private.normalize_court_label(sale.tribunal) =
      assignment.normalized_source_label;

  select count(*)
  into total_unresolved
  from public.auction_sales sale
  where sale.sale_date >= p_min_sale_date
    and sale.sale_date < p_max_sale_date + 1
    and sale.sale_venue_type = 'tribunal'
    and sale.sale_verification_status in ('verified', 'cross_checked')
    and sale.tribunal_code is null;

  return query select
    total_scanned,
    total_assigned,
    total_exact,
    total_prefix,
    total_unresolved,
    total_unresolved = 0;
end;
$function$;

alter table public.outcome_court_official_references enable row level security;
alter table public.auction_sale_court_label_assignments enable row level security;

revoke all on table public.outcome_court_official_references
  from anon, authenticated, service_role;
revoke all on table public.auction_sale_court_label_assignments
  from anon, authenticated, service_role;

grant select, insert on table public.outcome_court_official_references
  to service_role;
grant select, insert on table public.auction_sale_court_label_assignments
  to service_role;

revoke all on function public.reconcile_catalogue_court_labels(date, date)
  from public, anon, authenticated;
grant execute on function public.reconcile_catalogue_court_labels(date, date)
  to service_role;

comment on table public.outcome_court_official_references is
  'Append-only Ministry of Justice references linking each active TJ to its official court of appeal.';
comment on table public.auction_sale_court_label_assignments is
  'Append-only proof for exact or unique-prefix catalogue tribunal-label assignments; it does not assert territorial competence.';
comment on function public.reconcile_catalogue_court_labels(date, date) is
  'Assigns only verified tribunal sales whose normalized source tribunal label resolves to one unique active court.';

notify pgrst, 'reload schema';

commit;
