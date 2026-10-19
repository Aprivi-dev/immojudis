-- Pages /tribunaux/[slug] (migration 20261028160200) : le référentiel public des tribunaux.
--   * la fonction publique est accessible sans compte, la fonction privée est SECURITY DEFINER à
--     search_path fixé, l'enveloppe publique est SECURITY INVOKER ;
--   * seuls code, nom, ville et département sortent ;
--   * un tribunal sans aucune vente est rendu (la page « aucune vente à venir » en a besoin).
begin;

select plan(6);

insert into public.tribunals (code, canonical_name, department, city)
values ('c500-tj-vide', 'TJ C500 Sansvente', '33', 'Sansvente');

select has_function(
  'public', 'get_public_tribunal_directory', array[]::text[],
  'the public tribunal directory RPC exists'
);
select ok(
  has_function_privilege('anon', 'public.get_public_tribunal_directory()', 'execute')
  and has_function_privilege('authenticated', 'public.get_public_tribunal_directory()', 'execute'),
  'signed-out visitors and accounts may read the directory'
);
select ok(
  (select prosecdef from pg_proc where oid = 'app_private.get_public_tribunal_directory()'::regprocedure)
  and (select coalesce(proconfig::text, '') like '%search_path=%'
         from pg_proc where oid = 'app_private.get_public_tribunal_directory()'::regprocedure),
  'the read is a security definer function with a fixed search_path'
);
select ok(
  not (select prosecdef from pg_proc where oid = 'public.get_public_tribunal_directory()'::regprocedure),
  'the public wrapper is security invoker'
);
select is(
  pg_get_function_result('public.get_public_tribunal_directory()'::regprocedure),
  'TABLE(code text, canonical_name text, city text, department text)',
  'the contract is the public identity of a court: code, name, city, department'
);

set local role anon;
select is(
  (select row(canonical_name, city, department)::text
     from public.get_public_tribunal_directory() where code = 'c500-tj-vide'),
  '("TJ C500 Sansvente",Sansvente,33)',
  'a court without any sale is listed for a signed-out visitor'
);
reset role;

select * from finish();
rollback;
