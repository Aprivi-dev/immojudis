-- Nom de commune de RECHERCHE et arrondissement d'une vente (migrations 20261108120000 et 20261108120100) :
--   * « Paris 8ème », « Marseille 8e », « Lyon 3e arrondissement », « Lyon Cedex 03 » et « Saint-Denis La Réunion »
--     se ramènent au nom de la commune ; ce que le pipeline calcule (services/data-pipeline/src/reference_data/names.py)
--     est retrouvé à l'identique (tests/test_commune_insee.py::TestLookupNameMirroredInSql) ;
--   * la colonne stockée reference_communes.name_normalized garde la normalisation d'origine ;
--   * l'arrondissement se déduit du code postal puis du nombre écrit dans la ville ;
--   * les deux fonctions restent fermées aux rôles du navigateur.
begin;

select plan(34);

select is(app_private.commune_lookup_name('Paris 8ème'), 'paris', 'lookup name of Paris 8ème');
select is(app_private.commune_lookup_name('Paris 8e'), 'paris', 'lookup name of Paris 8e');
select is(app_private.commune_lookup_name('Paris 1er'), 'paris', 'lookup name of Paris 1er');
select is(app_private.commune_lookup_name('Paris XVIème'), 'paris', 'lookup name of Paris XVIème');
select is(app_private.commune_lookup_name('Paris 15'), 'paris', 'lookup name of Paris 15');
select is(app_private.commune_lookup_name('Marseille 8e'), 'marseille', 'lookup name of Marseille 8e');
select is(app_private.commune_lookup_name('Lyon 3e arrondissement'), 'lyon', 'lookup name of Lyon 3e arrondissement');
select is(app_private.commune_lookup_name('Lyon 3ème arrondissement'), 'lyon', 'lookup name of Lyon 3ème arrondissement');
select is(app_private.commune_lookup_name('Lyon Cedex 03'), 'lyon', 'lookup name of Lyon Cedex 03');
select is(app_private.commune_lookup_name('Villeurbanne CEDEX'), 'villeurbanne', 'lookup name of Villeurbanne CEDEX');
select is(app_private.commune_lookup_name('Saint-Denis La Réunion'), 'saint denis', 'lookup name of Saint-Denis La Réunion');
select is(app_private.commune_lookup_name('Saint-Denis (974)'), 'saint denis', 'lookup name of Saint-Denis (974)');
select is(app_private.commune_lookup_name('Saint-Pierre Martinique'), 'saint pierre', 'lookup name of Saint-Pierre Martinique');
select is(app_private.commune_lookup_name('La Réunion'), 'la reunion', 'lookup name of La Réunion');
select is(app_private.commune_lookup_name('Les 2 Alpes'), 'les 2 alpes', 'lookup name of Les 2 Alpes');
select is(app_private.commune_lookup_name('Le Mans'), 'le mans', 'lookup name of Le Mans');
select is(app_private.commune_lookup_name('Basse-Terre'), 'basse terre', 'lookup name of Basse-Terre');
select is(app_private.commune_lookup_name('Cedex'), 'cedex', 'lookup name of Cedex');
select is(app_private.commune_lookup_name('ST-QUENTIN'), 'saint quentin', 'lookup name of ST-QUENTIN');

select is(app_private.commune_arrondissement('75056', '75008', 'Paris 8ème'), '75108', 'arrondissement of Paris 8ème (75008)');
select is(app_private.commune_arrondissement('75056', '75116', 'Paris 16e'), '75116', 'arrondissement of Paris 16e (75116)');
select is(app_private.commune_arrondissement('75056', '75016', 'Paris'), '75116', 'arrondissement of Paris (75016)');
select is(app_private.commune_arrondissement('75056', '75000', 'Paris 12e'), '75112', 'arrondissement of Paris 12e (75000)');
select is(app_private.commune_arrondissement('75056', '75000', 'Paris'), null::text, 'arrondissement of Paris (75000)');
select is(app_private.commune_arrondissement('13055', '13008', 'Marseille'), '13208', 'arrondissement of Marseille (13008)');
select is(app_private.commune_arrondissement('13055', '13000', 'Marseille 8e'), '13208', 'arrondissement of Marseille 8e (13000)');
select is(app_private.commune_arrondissement('13055', '13000', 'Marseille 17e'), null::text, 'arrondissement of Marseille 17e (13000)');
select is(app_private.commune_arrondissement('69123', '69003', 'Lyon'), '69383', 'arrondissement of Lyon (69003)');
select is(app_private.commune_arrondissement('69123', '69000', 'Lyon 3e'), '69383', 'arrondissement of Lyon 3e (69000)');
select is(app_private.commune_arrondissement('69123', '69000', 'Lyon 10e'), null::text, 'arrondissement of Lyon 10e (69000)');
select is(app_private.commune_arrondissement('37261', '37000', 'Tours'), null::text, 'arrondissement of Tours (37000)');

select is(app_private.normalize_commune_name('Paris 8ème'), 'paris 8eme', 'the stored normalisation is unchanged: the lookup name is a separate function');
select ok(
  not has_function_privilege('anon', 'app_private.commune_lookup_name(text)', 'execute')
  and not has_function_privilege('authenticated', 'app_private.commune_lookup_name(text)', 'execute')
  and not has_function_privilege('anon', 'app_private.commune_arrondissement(text, text, text)', 'execute')
  and not has_function_privilege('authenticated', 'app_private.commune_arrondissement(text, text, text)', 'execute'),
  'the lookup functions are not open to the browser roles'
);
select ok(
  has_function_privilege('service_role', 'app_private.commune_lookup_name(text)', 'execute')
  and has_function_privilege('service_role', 'app_private.commune_arrondissement(text, text, text)', 'execute'),
  'the service role can run them'
);

select * from finish();

rollback;
