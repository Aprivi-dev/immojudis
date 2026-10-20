-- Chantier R1, point 8 (migration 20261031100000) : app_private.normalize_source_url ne rend une clé que
-- si l'adresse a un nom de domaine ET un chemin non vide. Une adresse réduite au domaine n'identifie
-- aucune annonce : elle ne doit fusionner deux annonces dans aucune liste.
begin;

select plan(9);

select is(
  app_private.normalize_source_url('https://licitor.com/'),
  null,
  'an address reduced to its domain (with a final slash) has no key'
);
select is(
  app_private.normalize_source_url('www.example.com'),
  null,
  'an address reduced to its domain (no scheme, no path) has no key'
);
select is(
  app_private.normalize_source_url('https://licitor.com/?page=2#top'),
  null,
  'a domain with only a query or an anchor has no key either'
);
select is(
  app_private.normalize_source_url('https://user:pw@www.Example.com:8080///?q=1'),
  null,
  'credentials, port, www. and slashes do not make a path'
);
select is(
  app_private.normalize_source_url('https://www.licitor.com/annonce/1/2/vente.html?x=1#y'),
  'licitor.com/annonce/1/2/vente.html',
  'an announcement address keeps its key (domain and path, no query or anchor)'
);
select is(
  app_private.normalize_source_url('https://user:pw@www.Example.com:8080/a/b/?q=1#h'),
  'example.com/a/b',
  'the credentials, the port, www., the query, the anchor and the final slash are still dropped'
);
select isnt(
  app_private.normalize_source_url('https://licitor.com/annonce/1'),
  app_private.normalize_source_url('https://licitor.com/annonce/2'),
  'two announcements of one site keep two keys'
);
select ok(
  app_private.normalize_source_url(null) is null
  and app_private.normalize_source_url('   ') is null
  and app_private.normalize_source_url('pas une adresse') is null,
  'a null, blank or non-address value has no key'
);
select ok(
  not has_function_privilege('anon', 'app_private.normalize_source_url(text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.normalize_source_url(text)', 'EXECUTE')
  and has_function_privilege('service_role', 'app_private.normalize_source_url(text)', 'EXECUTE'),
  'the key function stays closed to the browser roles'
);

select * from finish();
rollback;
