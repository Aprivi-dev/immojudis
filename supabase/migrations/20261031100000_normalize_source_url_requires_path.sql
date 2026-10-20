begin;

set local lock_timeout = '5s';

-- Chantier R1, point 8 (relecture de code du 20/10/2026) : normalize_source_url (20261029100100).
--
-- Une adresse réduite à son nom de domaine (« https://licitor.com/ », « www.example.com ») donnait la clé
-- « licitor.com » : deux annonces dont l'adresse source est une page d'accueil auraient alors été
-- fusionnées par le regroupement des doublons (pages /tribunaux/[slug] et /audiences-a-venir), alors que
-- rien n'identifie une annonce. La fonction ne rend désormais une clé que si l'adresse a un nom de
-- domaine ET un chemin non vide (après retrait de la barre finale).
--
-- Les paramètres de requête restent ignorés : aucune source du pipeline ne s'en sert pour identifier une
-- annonce (services/data-pipeline/src/sources : les pages de détail sont identifiées par leur chemin,
-- « /annonce/<id>/… » Licitor, « vente-<id>.html » Info-Enchères et Vench, « …-<id>.aspx » AGRASC,
-- « /annonce-immo-… » notaires, « /encheres/immobilier/… » Enchères publiques ; « ?page=N » et « ?p=N »
-- ne servent qu'à paginer des listes, « ?id=… » à des téléchargements de pièces, jamais une annonce).
-- Si une source se mettait à identifier ses annonces par la requête, il faudrait la garder ici.
--
-- Même signature, mêmes droits : create or replace. Sans effet de bord sur les données.

create or replace function app_private.normalize_source_url(p_url text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $function$
  select
    case
      when pg_catalog.strpos(parts.host, '.') > 0 and parts.path <> ''
        then pg_catalog.lower(parts.host || parts.path)
    end
  from (
    select
      pg_catalog.regexp_replace(
        pg_catalog.regexp_replace(
          pg_catalog.regexp_replace(split.authority, '^[^@]*@', ''),
          ':[0-9]*$',
          ''
        ),
        '^www\.',
        '',
        'i'
      ) as host,
      pg_catalog.regexp_replace(split.path, '/+$', '') as path
    from (
      select
        coalesce((pg_catalog.regexp_match(rest.value, '^([^/?#]*)'))[1], '') as authority,
        coalesce((pg_catalog.regexp_match(rest.value, '^[^/?#]*(/[^?#]*)'))[1], '') as path
      from (
        select pg_catalog.regexp_replace(
          pg_catalog.btrim(coalesce(p_url, '')),
          '^[a-zA-Z][a-zA-Z0-9+.-]*://',
          ''
        ) as value
      ) rest
    ) split
  ) parts;
$function$;

revoke all on function app_private.normalize_source_url(text) from public, anon, authenticated;
grant execute on function app_private.normalize_source_url(text) to service_role;

comment on function app_private.normalize_source_url(text) is
  'Adresse source réduite à ce qui l''identifie (sans protocole, www., paramètres, ancre ni barre finale, en minuscules) ; nulle sans nom de domaine ni chemin non vide (une adresse réduite au domaine n''identifie aucune annonce).';

commit;
