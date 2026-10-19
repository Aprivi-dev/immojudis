begin;

select plan(3);

-- Convergence de dérive (13/10/2026) : la copie de sauvegarde des parcelles de
-- l'État a ses colonnes nullables, comme en production. Un rejeu sans cette
-- migration les laisserait NOT NULL (clause LIKE).

select ok(
  to_regclass('app_private.cessions_point_parcels_backup_20261011') is not null,
  'the backup table exists after the replay'
);

select is(
  (
    select count(*)::integer
      from pg_attribute
     where attrelid = 'app_private.cessions_point_parcels_backup_20261011'::regclass
       and attnum > 0
       and not attisdropped
       and attnotnull
  ),
  0,
  'no column of the backup table is NOT NULL'
);

select ok(
  not has_table_privilege(
    'authenticated', 'app_private.cessions_point_parcels_backup_20261011', 'select'
  )
  and not has_table_privilege(
    'anon', 'app_private.cessions_point_parcels_backup_20261011', 'select'
  ),
  'the backup table stays unreadable by anon and authenticated'
);

select * from finish();

rollback;
