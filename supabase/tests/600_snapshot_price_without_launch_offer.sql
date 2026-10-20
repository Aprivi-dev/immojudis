-- Instantanés des ventes suivies : le déclencheur s'appuie sur le droit durable (20261029190000).
-- Le comportement de snapshot_price_access est couvert par 542 ; la capture isolée et le code postal par
-- 530. Ici : le déclencheur appelle bien snapshot_price_access, plus has_active_analysis_access, et garde
-- son sous-bloc d'exception.
begin;

select plan(4);

select ok(
  pg_catalog.pg_get_functiondef('app_private.snapshot_followed_sale_before_delete()'::regprocedure)
    like '%app_private.snapshot_price_access(followed.user_id)%',
  'le déclencheur lit le droit durable (snapshot_price_access)'
);

select ok(
  pg_catalog.pg_get_functiondef('app_private.snapshot_followed_sale_before_delete()'::regprocedure)
    not like '%has_active_analysis_access%',
  'le déclencheur ne lit plus has_active_analysis_access (offre de lancement comprise)'
);

select ok(
  pg_catalog.pg_get_functiondef('app_private.snapshot_followed_sale_before_delete()'::regprocedure)
    like '%exception when others then%',
  'la capture reste isolée dans un sous-bloc d''exception'
);

select is(
  (
    select pg_catalog.array_to_string(p.proconfig, ',')
    from pg_catalog.pg_proc p
    where p.oid = 'app_private.snapshot_followed_sale_before_delete()'::regprocedure
  ),
  'search_path=""',
  'search_path vide'
);

select * from finish();
rollback;
