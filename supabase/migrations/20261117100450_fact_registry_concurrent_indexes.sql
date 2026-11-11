begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Registre des pièces, lot R2a, étape A6 (plan du 11/11/2026, section 10 ; annexe 08, points 1 et 3 c).
--
-- Deux index, ENREGISTRÉS ici et construits hors transaction (« create index concurrently ») par
-- scripts/apply-supabase-concurrent-index-operations.mjs, à la suite de l'application des migrations (étape
-- « Apply reviewed concurrent index operations » du workflow). Même convention que 20261008121940 et
-- 20261109130000 : la migration ne prend aucun verrou sur les tables ; chaque définition ci-dessous est recopiée
-- mot pour mot dans la liste blanche du script, qui refuse d'exécuter tout SQL venu de la base qui ne lui
-- correspond pas, puis vérifie l'index dans le catalogue (unicité, expression et prédicat compris).
--
--   1. public.auction_sales_held_fields_idx : index partiel des ventes dont held_fields n'est pas nulle. Il sert
--      public.get_sale_field_baselines sans argument et le contrôle quotidien (20261117100500), qui cherchent
--      « les ventes qui tiennent ou mémorisent un champ » sans parcourir toute la table. Vide tant que rien
--      n'est tenu ; coût d'écriture nul pour une ligne dont held_fields est nulle.
--      Mesure : explain (analyze, buffers) select id from public.auction_sales where held_fields is not null;
--      avant : parcours séquentiel de la table ; après : parcours de l'index.
--   2. public.auction_fact_claims_agent_fact_key : index UNIQUE partiel sur l'identifiant du fait de l'agent
--      d'information porté par une observation (evidence_locator ->> 'information_agent_fact_id'). Un même fait
--      relu ne peut plus produire deux observations (une des trois barrières d'idempotence du noyau du lot R2c),
--      et la recherche de l'observation d'un fait devient une lecture d'index quand la requête répète le prédicat
--      « evidence_locator ? 'information_agent_fact_id' » (le pont actuel ne le répète pas : son gain viendra avec
--      le noyau du lot R2c).
--      PRÉALABLE EN PRODUCTION (lecture seule, annexe 08, mesure F.8) : aucune valeur en double, sinon la
--      construction échoue (l'opération passe à « failed », rien d'autre n'est touché, à relancer après examen) :
--        select evidence_locator->>'information_agent_fact_id', count(*) from public.auction_fact_claims
--        where evidence_locator ? 'information_agent_fact_id' group by 1 having count(*) > 1;
--
-- Verrous : aucun dans cette migration. La construction prend un SHARE UPDATE EXCLUSIVE sur la table et attend la
-- fin des transactions en cours : possible pendant un import, plus rapide en dehors.
--
-- Retour arrière, par une nouvelle migration (« drop index concurrently » est refusé dans une migration) : drop
-- index if exists ordinaire des deux index, sous lock_timeout de 2 s et entre deux lots de publication, et
-- suppression des deux lignes ci-dessous ; dans la même PR, retirer les deux entrées de la liste blanche du
-- script. Détail dans docs/runbooks/registre-des-pieces-r2a.md.
insert into app_private.concurrent_index_operations (
  operation_key, schema_name, table_name, index_name, create_sql
)
values
  (
    '20261117100450:auction_sales_held_fields_idx',
    'public',
    'auction_sales',
    'auction_sales_held_fields_idx',
    'create index concurrently if not exists "auction_sales_held_fields_idx" on "public"."auction_sales" ("id") where ("held_fields" is not null)'
  ),
  (
    '20261117100450:auction_fact_claims_agent_fact_key',
    'public',
    'auction_fact_claims',
    'auction_fact_claims_agent_fact_key',
    'create unique index concurrently if not exists "auction_fact_claims_agent_fact_key" on "public"."auction_fact_claims" (("evidence_locator" ->> ''information_agent_fact_id'')) where ("evidence_locator" ? ''information_agent_fact_id'')'
  )
on conflict (operation_key) do nothing;

commit;
