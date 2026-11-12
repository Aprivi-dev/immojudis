begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Registre des pièces, lot R2c, étape C0 bis : garde de l'API contre les fonctions d'extension. À appliquer AVANT
-- l'ouverture des droits (20261119100400).
--
-- PostGIS est installé dans le schéma public, et ses fonctions (plusieurs centaines) sont exécutables par anon et
-- authenticated. Elles appartiennent à supabase_admin : le rôle de migration ne peut pas leur retirer ce droit.
-- Plusieurs assemblent du SQL à partir de leurs arguments ; public.st_findextent(text, text) exécute le texte reçu.
-- Une requête de l'API qui l'atteindrait pourrait poser le jeton de la requête au nom d'un administrateur, puis
-- appeler une fonction de décision du registre. Elle n'est pas appelable par /rpc aujourd'hui, mais seulement parce
-- que ses arguments n'ont pas de nom : cette protection ne tient qu'à une règle de PostgREST.
--
-- La garde public.enforce_data_api_object_boundary() (20260826100218), que PostgREST appelle avant chaque requête
-- (pgrst.db_pre_request du rôle authenticator, inchangé), ne refusait que spatial_ref_sys et rpc/st_estimatedextent,
-- et comparait le chemin tel quel : « /rpc/st%5Festimatedextent » la passait. Elle refuse désormais, pour anon et
-- authenticated :
--   1. tout chemin qui contient « % ». Aucun chemin de l'application n'en porte : une table, une vue ou une
--      fonction du dépôt se nomme en lettres, chiffres et tirets bas. Seul le CHEMIN est lu (request.path) : la
--      chaîne de requête, où PostgREST reçoit des filtres encodés, n'est pas concernée ;
--   2. tout appel rpc/<nom> dont <nom>, tel quel ou mis en minuscules, est une fonction du schéma public qui
--      appartient à une extension (pg_depend.deptype = 'e'), quels que soient ses arguments ;
--   3. spatial_ref_sys, comme avant (le nom est comparé en minuscules).
-- service_role n'est pas concerné, comme avant.
--
-- Coût : la garde tourne à chaque requête de l'API. La lecture du catalogue n'a lieu que pour un chemin rpc/, par
-- les index de pg_proc (nom) et de pg_depend (objet). Mesures dans docs/runbooks/registre-des-pieces-r2c.md.
--
-- Verrous : remplacement d'une fonction. Aucun verrou sur une table. Possible pendant un import. Les droits de la
-- fonction (anon, authenticated, service_role) et le réglage du rôle authenticator ne changent pas.
--
-- Retour arrière, par une nouvelle migration : rétablir public.enforce_data_api_object_boundary() de
-- 20260826100218. À ne pas faire tant que les fonctions de décision sont ouvertes.

create or replace function public.enforce_data_api_object_boundary()
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  request_path text := pg_catalog.btrim(
    coalesce(pg_catalog.current_setting('request.path', true), ''),
    '/'
  );
  rpc_name text;
begin
  if current_user not in ('anon', 'authenticated') then
    return;
  end if;

  if pg_catalog.strpos(request_path, '%') > 0 then
    raise insufficient_privilege using
      message = 'Data API access denied for an encoded request path';
  end if;

  if pg_catalog.lower(request_path) in ('spatial_ref_sys', 'rest/v1/spatial_ref_sys') then
    raise insufficient_privilege using
      message = 'Data API access denied for an extension object';
  end if;

  -- Seul un chemin rpc/ lit le catalogue.
  if pg_catalog.strpos(pg_catalog.lower(request_path), 'rpc/') > 0 then
    rpc_name := (pg_catalog.regexp_match(request_path, '(?:^|/)rpc/+([^/]+)', 'i'))[1];
    if rpc_name is not null and exists (
      select 1
      from pg_catalog.pg_proc routine
      join pg_catalog.pg_depend dependency
        on dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
       and dependency.objid = routine.oid
       and dependency.deptype = 'e'
      where routine.pronamespace = 'public'::pg_catalog.regnamespace
        and routine.proname in (rpc_name::pg_catalog.name, pg_catalog.lower(rpc_name)::pg_catalog.name)
    ) then
      raise insufficient_privilege using
        message = 'Data API access denied for an extension object';
    end if;
  end if;
end;
$$;

comment on function public.enforce_data_api_object_boundary() is
  'Garde de PostgREST appelée avant chaque requête de l''API : refuse à anon et authenticated tout chemin encodé (%), spatial_ref_sys, et tout appel rpc/ d''une fonction du schéma public qui appartient à une extension (PostGIS : droits de la plateforme que le rôle du projet ne peut pas retirer).';

commit;
