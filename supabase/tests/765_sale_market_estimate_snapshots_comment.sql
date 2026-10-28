begin;

select plan(3);

-- Migration 20261108170000 : commentaire de table seulement. Les instantanés notariaux ne sont pas
-- « anonymes » : le jour, le département, le type et la mise à prix retrouvent l'annonce publique.
select ok(
  obj_description('app_private.sale_market_estimate_snapshots'::regclass, 'pg_class') like '%réidentifiables par recoupement avec l''annonce publique%',
  'the snapshot table comment says the rows can be re-identified by cross-checking the public announcement'
);

select ok(
  obj_description('app_private.sale_market_estimate_snapshots'::regclass, 'pg_class') not like '%Ne contient pas de donnée directement identifiante%',
  'the snapshot table comment no longer claims the rows hold no personal data at all'
);

-- Aucun droit n'a changé : la table reste réservée au rôle de service.
select ok(
  not has_table_privilege('authenticated', 'app_private.sale_market_estimate_snapshots', 'select')
    and not has_table_privilege('anon', 'app_private.sale_market_estimate_snapshots', 'select'),
  'anon and authenticated still cannot read the snapshot table'
);

select * from finish();

rollback;
