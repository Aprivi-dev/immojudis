begin;

set local lock_timeout = '5s';

-- Convergence de dérive (run 79 de « Apply Supabase Migrations », 13/10/2026).
-- 20261016110000_remove_state_point_parcels crée la copie de sauvegarde avec
-- « create table if not exists ... (like public.auction_cadastre_parcels) », qui
-- recopie les NOT NULL de la table source. En production la table existait déjà
-- (copie faite avant la migration, comme l'annonce le commentaire de cette
-- migration) et sans ces NOT NULL : « if not exists » l'a laissée telle quelle. Le
-- rejeu des migrations produit donc des colonnes NOT NULL, la production des
-- colonnes nullables.
-- On aligne sur la production : lever un NOT NULL ne peut pas échouer sur des
-- données existantes et ne change aucune ligne. La table reste une simple copie de
-- sauvegarde, sans lecteur applicatif, privée à app_private. Idempotent : sans
-- effet si la table est absente ou déjà nullable ; une colonne de clé primaire est
-- laissée telle quelle.
do $converge$
declare
  backup_table constant regclass := to_regclass('app_private.cessions_point_parcels_backup_20261011');
  backup_column record;
begin
  if backup_table is null then
    return;
  end if;

  for backup_column in
    select a.attname
      from pg_attribute a
     where a.attrelid = backup_table
       and a.attnum > 0
       and not a.attisdropped
       and a.attnotnull
       and not exists (
         select 1
           from pg_index i
          where i.indrelid = a.attrelid
            and i.indisprimary
            and a.attnum = any (i.indkey)
       )
     order by a.attnum
  loop
    execute format(
      'alter table app_private.cessions_point_parcels_backup_20261011 alter column %I drop not null',
      backup_column.attname
    );
  end loop;
end;
$converge$;

commit;
