-- Galerie : une photo rangée dans le dossier /sites/default/files/ d'un site Drupal n'est plus prise pour une
-- image par défaut (02/11/2026).
--
-- Le filtre des images qui ne sont pas des photos du bien écartait toute adresse contenant le mot « default »
-- entre deux séparateurs, dossier compris. Toutes les photos des Cessions de l'État sont servies depuis
-- https://cessions.immobilier-etat.gouv.fr/sites/default/files/… : aucune des 47 ventes Cessions qui ont des
-- photos n'en affichait une (Bordeaux, 66 rue Lafaurie de Monbadon : « 1_Photos_du_bien_et_de_lenvironnement »
-- écartée), ni une vente AGRASC servie de la même façon.
--
-- « default » n'écarte désormais qu'un nom de fichier (default.png, default_photo.jpg?w=800) ; les autres mots
-- (avatar, logo, icon…) gardent leur règle. Même changement dans src/lib/sale-media.ts.
--
-- Le filtre est écrit une fois dans v_auction_sales_app, v_auction_sales_discovery, v_auction_sales_unlocked,
-- app_private.get_public_sale_details et la sauvegarde de retour arrière de v_auction_sales_app. Les définitions
-- sont relues sur place (pg_get_viewdef / pg_get_functiondef), la seule expression du filtre y est remplacée, et
-- la migration s'arrête si elle n'y apparaît pas exactement une fois (même méthode que 20261111030117).
-- Rejouable : une définition déjà corrigée est laissée.
begin;

set local lock_timeout = '5s';

do $rewrite$
declare
  v_old constant text :=
    '(avatar|brand|default|favicon|icon|icone|logo|placeholder|profile|sprite|user)([/_.-]|$)';
  v_new constant text :=
    '(avatar|brand|favicon|icon|icone|logo|placeholder|profile|sprite|user)([/_.-]|$)'
    || '|(^|[/_.-])default([_.-][^/?#]*)?([?#].*)?$';
  v_view_name text;
  v_before text;
  v_options text;
  v_views integer := 0;
  v_matches integer;
  v_backup text;
  v_function regprocedure;
  v_secdef_before boolean;
  v_config_before text;
  v_acl_before text;
  v_secdef_after boolean;
  v_config_after text;
  v_acl_after text;
begin
  for v_view_name, v_before, v_options in
    select
      view_row.relname,
      pg_catalog.pg_get_viewdef(view_row.oid, true),
      pg_catalog.array_to_string(view_row.reloptions, ', ')
    from pg_catalog.pg_class view_row
    join pg_catalog.pg_namespace schema_row on schema_row.oid = view_row.relnamespace
    where schema_row.nspname = 'public'
      and view_row.relkind = 'v'
      and view_row.relname in ('v_auction_sales_app', 'v_auction_sales_discovery', 'v_auction_sales_unlocked')
    order by view_row.relname
  loop
    v_views := v_views + 1;
    if strpos(v_before, v_new) > 0 then
      continue;
    end if;
    v_matches := (length(v_before) - length(replace(v_before, v_old, ''))) / length(v_old);
    if v_matches <> 1 then
      raise exception using
        errcode = 'P0001',
        message = format('Unexpected definition of public.%s: %s image filters found instead of one.', v_view_name, v_matches);
    end if;
    execute 'create or replace view public.' || quote_ident(v_view_name)
      || case when coalesce(v_options, '') <> '' then ' with (' || v_options || ')' else '' end
      || ' as ' || rtrim(replace(v_before, v_old, v_new), E';\n ');
  end loop;

  if v_views <> 3 then
    raise exception using
      errcode = '42P01',
      message = 'Missing public.v_auction_sales_app, v_auction_sales_discovery or v_auction_sales_unlocked.';
  end if;

  if to_regclass('app_private.catalogue_view_backups') is not null then
    select b.definition into v_backup
      from app_private.catalogue_view_backups b
     where b.view_name = 'v_auction_sales_app';
    if v_backup is not null and strpos(v_backup, v_new) = 0 then
      v_matches := (length(v_backup) - length(replace(v_backup, v_old, ''))) / length(v_old);
      if v_matches = 1 then
        update app_private.catalogue_view_backups
           set definition = replace(v_backup, v_old, v_new)
         where view_name = 'v_auction_sales_app';
      else
        raise warning 'catalogue_view_backups.v_auction_sales_app: % image filters found, backup left unchanged', v_matches;
      end if;
    end if;
  end if;

  v_function := to_regprocedure('app_private.get_public_sale_details(uuid)');
  if v_function is null then
    raise exception using errcode = '42883', message = 'Missing app_private.get_public_sale_details(uuid).';
  end if;
  v_before := pg_catalog.pg_get_functiondef(v_function);
  if strpos(v_before, v_new) = 0 then
    v_matches := (length(v_before) - length(replace(v_before, v_old, ''))) / length(v_old);
    if v_matches <> 1 then
      raise exception using
        errcode = 'P0001',
        message = format('Unexpected definition of %s: %s image filters found instead of one.', v_function, v_matches);
    end if;

    select procedure_row.prosecdef, coalesce(procedure_row.proconfig::text, ''), coalesce(procedure_row.proacl::text, '')
      into v_secdef_before, v_config_before, v_acl_before
      from pg_catalog.pg_proc procedure_row
     where procedure_row.oid = v_function::oid;

    execute replace(v_before, v_old, v_new);

    select procedure_row.prosecdef, coalesce(procedure_row.proconfig::text, ''), coalesce(procedure_row.proacl::text, '')
      into v_secdef_after, v_config_after, v_acl_after
      from pg_catalog.pg_proc procedure_row
     where procedure_row.oid = v_function::oid;

    if v_secdef_after is distinct from v_secdef_before
       or v_config_after is distinct from v_config_before
       or v_acl_after is distinct from v_acl_before then
      raise exception using
        errcode = 'P0001',
        message = format('Rewriting %s changed SECURITY DEFINER, settings or privileges.', v_function);
    end if;
  end if;
end;
$rewrite$;

notify pgrst, 'reload schema';

commit;
