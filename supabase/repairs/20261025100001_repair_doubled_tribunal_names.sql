-- REPARATION MANUELLE DE DONNEES, PAS UNE MIGRATION DE SCHEMA.
-- Ne pas placer ce fichier dans supabase/migrations : le workflow « Apply Supabase Migrations »
-- applique tout ce qui s'y trouve, sans essai. Procedure complete : supabase/repairs/README.md.
--
-- Point 26 (2026-10-15) : noms canoniques du referentiel public.tribunals au prefixe double.
--
-- NON APPLIQUEE : a relire, puis a lancer par le proprietaire du projet avec psql (psql 13 ou plus) :
--
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/repairs/20261025100001_repair_doubled_tribunal_names.sql
--       -> mode COMPTAGE SEULEMENT (defaut) : aucune ecriture, la transaction est annulee (rollback).
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -v apply=1 -f supabase/repairs/20261025100001_repair_doubled_tribunal_names.sql
--       -> mode APPLICATION : ecrit, dans une seule transaction.
--
-- Idempotente : une seconde execution ne trouve plus aucun nom a reparer.
--
-- Constat : pour les tribunaux dont le nom officiel commence par « du » ou « des » (Tribunal judiciaire
-- du Mans, du Havre, des Sables-d'Olonne...), l'ancien code produisait le nom court « TJ Tribunal judiciaire
-- du Mans » (court_competence._short_court_name ne retirait que « de » et « d' »). Le code est corrige
-- (« TJ Le Mans », « TJ Le Havre », « TJ Les Sables-d'Olonne »), et un recalcul (recompute-existing-sales)
-- reecrit ces noms de lui-meme. Cette reparation les corrige tout de suite, sans attendre, et de facon
-- coherente :
--   1. public.tribunals : canonical_name et aliases (l'ancien nom est remplace par le nouveau) ;
--   2. public.auction_sales et public.judicial_sales : le texte tribunal des lignes rattachees a ce code ;
--   3. public.auction_sales.raw_payload : court_name des preuves tribunal_assignment et
--      tribunal_label_assignment. app_private.catalogue_bridge_court_*  exige que ces trois valeurs soient
--      egales (sale.tribunal = court_name de la preuve = canonical_name) : les corriger a moitie casserait le
--      rapprochement des tribunaux.
-- Un nom nouveau deja porte par un autre code (canonical_name est unique) n'est pas touche : il est liste
-- comme conflit, a traiter a la main.
-- Rien d'autre n'est modifie : ni code de tribunal, ni rattachement, ni date de mise a jour des ventes.
-- Les copies d'origine sont gardees dans app_private.tribunal_name_repair_backup_20261025 et
-- app_private.tribunal_name_repair_sales_backup_20261025.
--
-- Les variantes de libelle des ventes (« TJ St Gaudens », « TJ Briey », « Tribunal Judiciaire d'Arras (Pas de
-- Calais) »...) et « TJ En L'Etude Du Notaire » ne se corrigent pas ici : c'est le recalcul des ventes qui les
-- rattache (code de tribunal.py / court_competence.py).
--
-- A verifier avant et apres (lecture seule) :
--   select code, canonical_name from public.tribunals
--    where canonical_name ~* '^TJ Tribunal judiciaire';
--   (apres : 0 ligne)
--
-- Retour arriere : voir la fin du fichier.

\set ON_ERROR_STOP on
\if :{?apply}
\else
  \set apply off
\endif

\if :apply
  \echo === MODE APPLICATION : les noms de tribunaux seront modifies ===
\else
  \echo === MODE COMPTAGE SEULEMENT : aucune ecriture. Relancer avec -v apply=1 pour appliquer. ===
\endif

begin;
set local lock_timeout = '5s';

-- Plan : table temporaire, calculee dans les deux modes. Meme regle que court_competence._short_court_name :
-- seuls « du » et « des » changent de forme (« du Mans » -> « Le Mans », « des Sables-d'Olonne » ->
-- « Les Sables-d'Olonne ») ; « de » et « d' » sont retires (« de Pau » -> « Pau », « d'Arras » -> « Arras ») ;
-- le reste garde sa casse d'origine (« de La Roche-sur-Yon » -> « La Roche-sur-Yon », « de la Roche » ->
-- « la Roche » : Python ne recase pas, et l'ancien code ne doublait le prefixe que pour « du » et « des »).
-- m[1] = « d' », m[2] = article suivi d'espaces, m[3] = le reste du nom.
create temporary table tribunal_name_plan on commit drop as
select t.code,
       t.canonical_name as old_name,
       'TJ ' || case lower(coalesce(m[1], m[2]))  -- 'd''' et 'de' : pas d'article
                  when 'du' then 'Le '
                  when 'des' then 'Les '
                  else ''
                end || m[3] as new_name
  from public.tribunals t
 cross join lateral regexp_match(
         t.canonical_name,
         '^TJ Tribunal judiciaire (?:(d'')|(du|des|de) +)(.+)$',
         'i') as m
 where m is not null;

alter table tribunal_name_plan add column conflict boolean;
update tribunal_name_plan p
   set conflict = exists (
     select 1 from public.tribunals other
      where other.canonical_name = p.new_name and other.code <> p.code
   ) or (
     select count(*) from tribunal_name_plan same where same.new_name = p.new_name
   ) > 1;

-- Mode comptage : le plan est calcule, la transaction devient en lecture seule (rien ne s'ecrit
-- dans les tables) puis se termine par un rollback.
\if :apply
\else
  set transaction read only;
\endif

-- Comptage (les deux modes) : ce que l'application modifierait.
select count(*) filter (where not conflict) as noms_a_corriger,
       count(*) filter (where conflict) as noms_en_conflit_non_touches
  from tribunal_name_plan;

select code, old_name, new_name, conflict
  from tribunal_name_plan
 order by code;

select p.code,
       (select count(*) from public.auction_sales s where s.tribunal_code = p.code and s.tribunal = p.old_name)
         as ventes_texte_tribunal,
       (select count(*) from public.judicial_sales j where j.tribunal_code = p.code and j.tribunal = p.old_name)
         as ventes_judiciaires
  from tribunal_name_plan p
 where not p.conflict
 order by p.code;

\if :apply
  create table if not exists app_private.tribunal_name_repair_backup_20261025 (
    code text primary key,
    canonical_name text not null,
    aliases jsonb,
    backed_up_at timestamptz not null default now()
  );
  revoke all on app_private.tribunal_name_repair_backup_20261025 from public, anon, authenticated;

  create table if not exists app_private.tribunal_name_repair_sales_backup_20261025 (
    table_name text not null,
    source_url text not null,
    tribunal text,
    assignment_court_name text,
    label_assignment_court_name text,
    backed_up_at timestamptz not null default now(),
    primary key (table_name, source_url)
  );
  revoke all on app_private.tribunal_name_repair_sales_backup_20261025 from public, anon, authenticated;

  insert into app_private.tribunal_name_repair_backup_20261025 (code, canonical_name, aliases)
  select t.code, t.canonical_name, t.aliases
    from public.tribunals t
    join tribunal_name_plan p on p.code = t.code and not p.conflict
  on conflict (code) do nothing;

  insert into app_private.tribunal_name_repair_sales_backup_20261025
    (table_name, source_url, tribunal, assignment_court_name, label_assignment_court_name)
  select 'auction_sales', s.source_url, s.tribunal,
         s.raw_payload #>> '{tribunal_assignment,court_name}',
         s.raw_payload #>> '{tribunal_label_assignment,court_name}'
    from public.auction_sales s
    join tribunal_name_plan p on p.code = s.tribunal_code and not p.conflict
   where s.tribunal = p.old_name
      or s.raw_payload #>> '{tribunal_assignment,court_name}' = p.old_name
      or s.raw_payload #>> '{tribunal_label_assignment,court_name}' = p.old_name
  on conflict (table_name, source_url) do nothing;

  insert into app_private.tribunal_name_repair_sales_backup_20261025 (table_name, source_url, tribunal)
  select 'judicial_sales', j.source_url, j.tribunal
    from public.judicial_sales j
    join tribunal_name_plan p on p.code = j.tribunal_code and not p.conflict
   where j.tribunal = p.old_name
  on conflict (table_name, source_url) do nothing;

  -- 1. Preuves du rattachement (raw_payload) : court_name = nouveau nom.
  update public.auction_sales s
     set raw_payload = jsonb_set(s.raw_payload, '{tribunal_assignment,court_name}', to_jsonb(p.new_name))
    from tribunal_name_plan p
   where not p.conflict
     and s.tribunal_code = p.code
     and s.raw_payload #>> '{tribunal_assignment,court_name}' = p.old_name;

  update public.auction_sales s
     set raw_payload = jsonb_set(s.raw_payload, '{tribunal_label_assignment,court_name}', to_jsonb(p.new_name))
    from tribunal_name_plan p
   where not p.conflict
     and s.tribunal_code = p.code
     and s.raw_payload #>> '{tribunal_label_assignment,court_name}' = p.old_name;

  -- 2. Texte du tribunal des ventes et des ventes judiciaires.
  update public.auction_sales s
     set tribunal = p.new_name
    from tribunal_name_plan p
   where not p.conflict and s.tribunal_code = p.code and s.tribunal = p.old_name;

  update public.judicial_sales j
     set tribunal = p.new_name
    from tribunal_name_plan p
   where not p.conflict and j.tribunal_code = p.code and j.tribunal = p.old_name;

  -- 3. Referentiel : nom canonique, puis alias (l'ancien nom est retire, le nouveau ajoute).
  update public.tribunals t
     set canonical_name = p.new_name,
         aliases = (
           select coalesce(jsonb_agg(to_jsonb(alias) order by alias), '[]'::jsonb)
             from (
               select alias
                 from jsonb_array_elements_text(
                        case when jsonb_typeof(t.aliases) = 'array' then t.aliases else '[]'::jsonb end
                      ) as existing(alias)
                where alias <> p.old_name
               union
               select p.new_name
             ) merged
         ),
         updated_at = now()
    from tribunal_name_plan p
   where not p.conflict and t.code = p.code;

  \echo === Application terminee : relancer la requete de controle de l en-tete. ===
\endif

\if :apply
  commit;
\else
  rollback;
\endif

-- Retour arriere (a executer a la main, hors de ce fichier) :
--   update public.tribunals t
--      set canonical_name = b.canonical_name, aliases = b.aliases, updated_at = now()
--     from app_private.tribunal_name_repair_backup_20261025 b
--    where t.code = b.code;
--   update public.auction_sales s
--      set tribunal = b.tribunal,
--          raw_payload = case when b.assignment_court_name is not null
--            then jsonb_set(s.raw_payload, '{tribunal_assignment,court_name}', to_jsonb(b.assignment_court_name))
--            else s.raw_payload end
--     from app_private.tribunal_name_repair_sales_backup_20261025 b
--    where b.table_name = 'auction_sales' and s.source_url = b.source_url;
--   update public.auction_sales s
--      set raw_payload = jsonb_set(s.raw_payload, '{tribunal_label_assignment,court_name}',
--                                  to_jsonb(b.label_assignment_court_name))
--     from app_private.tribunal_name_repair_sales_backup_20261025 b
--    where b.table_name = 'auction_sales' and s.source_url = b.source_url
--      and b.label_assignment_court_name is not null;
--   update public.judicial_sales j
--      set tribunal = b.tribunal
--     from app_private.tribunal_name_repair_sales_backup_20261025 b
--    where b.table_name = 'judicial_sales' and j.source_url = b.source_url;
