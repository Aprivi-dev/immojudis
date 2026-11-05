-- Galerie : les photos trouvées dans les pièces jointes (public.sale_document_photos, migration précédente)
-- s'ajoutent APRÈS les photos des sources, dans le tableau `media` des trois vues de la fiche :
--   * public.v_auction_sales_app       (compte Analyse ; aussi lue par les vues de recherche *_search) ;
--   * public.v_auction_sales_discovery (compte Découverte : « toutes les photos », décision du 11/10/2026) ;
--   * public.v_auction_sales_unlocked  (ventes débloquées).
-- et la page publique d'une vente (app_private.get_public_sale_details) compte ces photos dans photo_count.
--
-- Une entrée ajoutée a la forme des autres : {"type": "image", "url": <URL publique du fichier 1600 px>,
-- "source": "Pièce jointe de la vente", "mirror": {"path640", "path1600", "width", "height"}}. L'URL est celle
-- d'un objet du bucket public `sale-photos` (forme `{SUPABASE_URL}/storage/v1/object/public/sale-photos/...`,
-- celle de src/lib/photo-mirror.ts) : elle passe les filtres du site (http(s), ni pdf ni svg, aucun mot de
-- logo) ; `mirror` donne au site le srcset 640w / 1600w des copies. Ordre : document, puis rang dans le
-- document. Une URL déjà présente n'est pas répétée, et 12 photos au plus sont ajoutées (le pipeline n'en
-- garde pas davantage). Seules les lignes `stored` sortent : une photo retirée à la main (`withdrawn`)
-- disparaît aussitôt de la galerie.
--
-- Rien d'autre ne change : la sélection et les filtres des photos des sources (http, extensions, mots de
-- logo, dédoublonnage, ordre), les colonnes, les droits, les options (security_invoker, security_barrier) et
-- les prédicats de garde des vues. Les définitions actuelles ont été réécrites sur place par plusieurs
-- migrations : on les relit (pg_get_viewdef / pg_get_functiondef) au lieu de les recopier, on remplace une
-- seule expression, et on refuse de continuer si elle n'apparaît pas exactement une fois (même méthode que
-- 20261101110000 et 20261103110000). Rejouable : une définition déjà à jour est laissée.
--
-- Droits : les trois vues sont des vues definer dont les fonctions s'exécutent avec les droits de l'appelant.
-- app_private.sale_document_photo_media est donc SECURITY DEFINER (search_path vide) pour lire une table
-- fermée aux rôles du navigateur ; elle ne rend que les photos `stored` de la vente demandée, et n'est
-- accordée qu'à authenticated et service_role (comme les vues), jamais à anon.
--
-- La sauvegarde de v_auction_sales_app (app_private.catalogue_view_backups, retour arrière de
-- 20261110120000) reçoit le même remplacement : un retour arrière garde les photos des pièces jointes.
--
-- Retour arrière (sans toucher aux vues) : remplacer le corps de la fonction par `select p_media` (même
-- signature) ; les vues rendent alors exactement les médias d'avant.
begin;

set local lock_timeout = '5s';

create or replace function app_private.sale_document_photo_media(p_media pg_catalog.jsonb, p_sale_id uuid)
returns pg_catalog.jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(p_media, '[]'::pg_catalog.jsonb) || coalesce(
    (
      select pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'type', 'image',
                 'url', photo.public_url,
                 'source', 'Pièce jointe de la vente',
                 'mirror', pg_catalog.jsonb_build_object(
                   'path640', photo.path_640,
                   'path1600', photo.path_1600,
                   'width', photo.width,
                   'height', photo.height
                 )
               )
               order by photo.document_url, photo.position, photo.id
             )
        from (
          select candidate.id, candidate.document_url, candidate.position, candidate.public_url,
                 candidate.path_640, candidate.path_1600, candidate.width, candidate.height
            from public.sale_document_photos candidate
           where candidate.sale_id = p_sale_id
             and candidate.status = 'stored'
             and candidate.public_url ~* '^https?://'
             -- Dédoublonnage : une URL déjà dans la galerie n'est pas répétée.
             and not (
               coalesce(p_media, '[]'::pg_catalog.jsonb)
                 @> pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('url', candidate.public_url))
             )
           order by candidate.document_url, candidate.position, candidate.id
           limit 12
        ) photo
    ),
    '[]'::pg_catalog.jsonb
  );
$function$;

comment on function app_private.sale_document_photo_media(pg_catalog.jsonb, uuid) is
  'Ajoute au tableau media d''une vente (photos des sources) ses photos trouvées dans les pièces jointes (sale_document_photos, status stored, 12 au plus, par document puis rang), sans répéter une URL déjà présente. SECURITY DEFINER : la table est fermée aux rôles du navigateur. Appelée par v_auction_sales_app, v_auction_sales_discovery et v_auction_sales_unlocked.';

revoke all on function app_private.sale_document_photo_media(pg_catalog.jsonb, uuid)
  from public, anon, authenticated;
grant execute on function app_private.sale_document_photo_media(pg_catalog.jsonb, uuid)
  to authenticated, service_role;

do $grants$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'lovable_readonly') then
    execute 'grant execute on function app_private.sale_document_photo_media(pg_catalog.jsonb, uuid) to lovable_readonly';
  end if;
end;
$grants$;

do $rewrite$
declare
  -- La colonne media des trois vues, telle que pg_get_viewdef la rend.
  v_media_old constant text := $re$COALESCE\(m\.media, '\[\]'::jsonb\) AS media\M$re$;
  v_media_new constant text :=
    $new$app_private.sale_document_photo_media(COALESCE(m.media, '[]'::jsonb), s.id) AS media$new$;
  v_view_name text;
  v_before text;
  v_after text;
  v_options text;
  v_views integer := 0;
  v_matches integer;
  v_backup text;
  v_photo_count_old constant text := $re$coalesce\(m\.photo_count, 0\)$re$;
  v_photo_count_new constant text :=
    $new$coalesce(m.photo_count, 0) + (select count(*)::integer from public.sale_document_photos dp where dp.sale_id = s.id and dp.status = 'stored')$new$;
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
    v_after := v_before;

    if v_after !~ 'app_private\.sale_document_photo_media\(' then
      select count(*) into v_matches from regexp_matches(v_after, v_media_old, 'g');
      if v_matches <> 1 then
        raise exception using
          errcode = 'P0001',
          message = format(
            'Unexpected definition of public.%s: %s media columns found instead of one; document photos were not added.',
            v_view_name, v_matches
          );
      end if;
      v_after := regexp_replace(v_after, v_media_old, v_media_new);
    end if;

    if v_after <> v_before then
      execute 'create or replace view public.' || quote_ident(v_view_name)
        || case when coalesce(v_options, '') <> '' then ' with (' || v_options || ')' else '' end
        || ' as ' || rtrim(v_after, E';\n ');
    end if;
  end loop;

  if v_views <> 3 then
    raise exception using
      errcode = '42P01',
      message = 'Missing public.v_auction_sales_app, v_auction_sales_discovery or v_auction_sales_unlocked.';
  end if;

  -- Sauvegarde de retour arrière de v_auction_sales_app (20261110120000), quand elle existe.
  if to_regclass('app_private.catalogue_view_backups') is not null then
    select b.definition into v_backup
      from app_private.catalogue_view_backups b
     where b.view_name = 'v_auction_sales_app';
    if v_backup is not null and v_backup !~ 'app_private\.sale_document_photo_media\(' then
      select count(*) into v_matches from regexp_matches(v_backup, v_media_old, 'g');
      if v_matches = 1 then
        update app_private.catalogue_view_backups
           set definition = regexp_replace(v_backup, v_media_old, v_media_new)
         where view_name = 'v_auction_sales_app';
      else
        raise warning 'catalogue_view_backups.v_auction_sales_app: % media columns found, backup left unchanged', v_matches;
      end if;
    end if;
  end if;

  -- Page publique : photo_count compte aussi les photos des pièces jointes.
  v_function := to_regprocedure('app_private.get_public_sale_details(uuid)');
  if v_function is null then
    raise exception using errcode = '42883', message = 'Missing app_private.get_public_sale_details(uuid).';
  end if;
  v_before := pg_catalog.pg_get_functiondef(v_function);
  if v_before !~ 'public\.sale_document_photos' then
    select count(*) into v_matches from regexp_matches(v_before, v_photo_count_old, 'gi');
    if v_matches <> 1 then
      raise exception using
        errcode = 'P0001',
        message = format(
          'Unexpected definition of %s: %s photo_count expressions found instead of one.', v_function, v_matches
        );
    end if;
    v_after := regexp_replace(v_before, v_photo_count_old, v_photo_count_new, 'i');

    select procedure_row.prosecdef, coalesce(procedure_row.proconfig::text, ''), coalesce(procedure_row.proacl::text, '')
      into v_secdef_before, v_config_before, v_acl_before
      from pg_catalog.pg_proc procedure_row
     where procedure_row.oid = v_function::oid;

    execute v_after;

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
