# Base de données Supabase : migrations, tests, réparations

- `migrations/` : une migration = un fichier horodaté, jamais modifié après coup (on en écrit une nouvelle).
  Le propriétaire les applique (workflow « Apply Supabase Migrations » ou `npm run db:migrate`) ; aucun
  agent n'écrit en production.
- `tests/` : un test pgTAP par migration, numéroté (`NNN_nom.sql`), rejoué par la CI sur une base éphémère.
- `repairs/` : réparations de données, jamais lancées automatiquement (voir plus bas).
- `maintenance/` : opérations ponctuelles réservées au propriétaire.

## Règles des migrations

1. **Pas de `drop trigger` sur `public.auction_sales`.** `DROP TRIGGER` (et `CREATE TRIGGER`) prend un verrou
   sur la table : les écritures de la collecte attendent, et un `DROP` suivi d'un `CREATE` laisse la table
   sans déclencheur entre les deux. Créer le déclencheur de façon **conditionnelle**, après avoir testé
   `pg_trigger` :

   ```sql
   do $$
   begin
     if not exists (
       select 1 from pg_catalog.pg_trigger
       where tgrelid = 'public.auction_sales'::regclass and tgname = 'mon_declencheur'
     ) then
       create trigger mon_declencheur after update on public.auction_sales
         for each row execute function app_private.ma_fonction();
     end if;
   end $$;
   ```

   Pour changer le comportement d'un déclencheur existant, remplacer le corps de sa fonction
   (`create or replace function`), pas le déclencheur.

2. **Pas de réparation de données dans une migration.** Une migration change le schéma, les fonctions et les
   droits ; elle ne corrige pas des lignes (cas de `20261028110200`, qui exécute une réparation de la dérive
   de `catalogue_quarantined` dans la migration elle-même : à ne pas reproduire). Une réparation s'écrit dans `repairs/`, relue, idempotente, bornée par lot, lancée à la main
   par le propriétaire hors collecte, avec son compte-rendu (`docs/runbooks/chantier-f-reparations-donnees.md`).
   Une migration peut seulement _refuser_ de s'appliquer si la donnée attendue manque.

3. **Appliquer hors collecte.** Toute migration qui touche `auction_sales` (déclencheur, politique, index,
   colonne) se prend un verrou sur la table que les écritures de la collecte font attendre. Ne pas
   l'appliquer pendant un run (vérifier `auction_runs` en `running`, workflow `data-pipeline.yml`).
   Commencer par `set local lock_timeout = '5s';` : si le verrou n'est pas obtenu la migration échoue sans
   effet et se relance. Les index se créent `concurrently` hors transaction
   (`scripts/apply-supabase-concurrent-index-operations.mjs`).

4. **Fonctions `security definer`** : `set search_path = ''`, noms qualifiés, `revoke` à `public`, `anon`,
   `authenticated`, puis `grant` minimal (par défaut `service_role` seul).

5. **Idempotence** : `if not exists`, `create or replace`, gardes qui refusent de deviner quand une définition
   n'a pas la forme attendue (voir `20261029170000`, `20261029170100`).

6. **Politiques RLS** : appeler les fonctions de session en sous-select scalaire, `(select public.is_admin())`,
   `(select public.has_analysis_access())`, `(select auth.uid())` : PostgreSQL les évalue une fois par
   requête (InitPlan) au lieu d'une fois par ligne examinée (`20261029170200`). Une réécriture de politique
   doit rester strictement équivalente, avec un test pgTAP qui compare chaque rôle (anon, gratuit, Analyse,
   administrateur) à l'ancien prédicat (`tests/598_auction_sales_read_policy_initplan.sql`).

7. **Redéfinir une fonction patchée sur place** : plusieurs fonctions d'observation ont été modifiées par
   `pg_get_functiondef` + `replace` (patchs successifs). Avant de la redéfinir entièrement, rejouer la chaîne
   pour obtenir le texte exact en vigueur, et vérifier par une garde que la base en production a bien cette
   forme.

## Tests

Un test pgTAP par migration, dans `tests/`, qui ne laisse aucune trace (`begin; … rollback;`). Pour les
alertes (`app_private.sync_operational_alert`), fixer `p_now` plutôt que s'appuyer sur l'horloge, et
vérifier l'ouverture, le seuil exact et la fermeture spontanée (hystérésis de deux heures).
