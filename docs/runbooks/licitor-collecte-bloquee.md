# Collecte Licitor bloquée (historique des adjudications)

L'historique des adjudications Licitor est collecté automatiquement depuis le 12/10/2026 (décision du
propriétaire), sans cron propre : après chaque passage de la file d'enrichissement, le lanceur planifié
(`services/data-pipeline/src/autonomous_runner.py`) exécute `python -m src.sources.licitor_history_refresh`.
Ce runbook sert quand l'historique ne bouge plus (scénarios et moyennes par tribunal figés, voir
`docs/runbooks/scenarios-encheres.md`) ou quand le pipeline signale un échec Licitor. Les requêtes SQL
ci-dessous sont en lecture seule ; toute écriture est une action du propriétaire.

## Ce que fait un passage

1. Si Licitor est retiré (`public.set_catalogue_source_withdrawal`, `auction_source_state.catalogue_withdrawn`),
   le passage répond `skipped` (`source_withdrawn`) sans ouvrir de connexion.
2. Connexion à la base (`SUPABASE_DB_URL`, par le pooler Supabase en mode transaction), puis vérification du
   rôle restreint `licitor_collector` : sans lui, le rapport est `collector_role_unavailable`.
3. Création de la campagne mensuelle si elle n'existe pas (`monthly-AAAA-MM`, fenêtre de 36 mois, 90 derniers
   jours relus), puis **un tick** borné : au plus 100 requêtes, 2 s entre deux, `robots.txt` respecté.
4. Attestation des nouveaux lots par la porte statistique (`app_private.attest_licitor_reported_candidates`),
   puis rafraîchissement du cliché des scénarios (forcé si des lots ont été attestés).
5. Le code de sortie (0 si `ok` ou `skipped`, 1 sinon) est noté dans `auction_runs.summary`
   (`licitor_history_exit_code`) **sans changer le statut du passage** : un échec Licitor n'est pas visible
   dans le statut du run, il faut lire ce champ.

## Diagnostic

1. **Le passage a-t-il tourné et qu'a-t-il rendu ?**

   ```sql
   select started_at, status, summary->'licitor_history_exit_code' as licitor_exit
   from public.auction_runs
   order by started_at desc
   limit 10;
   ```

   `licitor_exit` absent : le passage n'a pas lancé Licitor (source `enrichment-queue` non exécutée, ou
   Licitor retiré). `1` : lire le journal du workflow `data-pipeline` à l'étape du lanceur (la ligne JSON du
   rapport : `status`, `tick`, `attested`, `scenario_snapshot`).

2. **Statut du rapport.**
   - `skipped` / `source_withdrawn` : interrupteur de retrait posé. Normal seulement si le propriétaire l'a
     décidé.
   - `collector_role_unavailable` : le rôle `licitor_collector` manque ou n'est pas accordé au rôle de
     connexion (migration `20260828100029`). Voir « Pooler et rôle ».
   - `ok` mais `tick.status` = `disabled_or_paused` : le contrôle de la collecte est coupé.

     ```sql
     select enabled, monthly_enabled, network_paused from licitor_ingestion.control;

     select id, status, stop_reason, network_requests, max_requests, updated_at
     from licitor_ingestion.runs
     order by updated_at desc
     limit 3;
     ```

     `network_paused` se pose quand une campagne est mise en pause pour un blocage de la source (la raison est
     dans `stop_reason` de la campagne, par exemple `three_startup_failures` ou le message de l'erreur
     réseau) : lire cette raison avant de la lever. Une pause pour budget de requêtes ne le pose pas.

   - `tick.status` = `busy` : un autre tick tient le verrou. Attendre ; si cela dure, regarder la campagne
     en cours (`licitor_ingestion.runs`) et son `updated_at`.
   - `tick.status` = `paused` (`request_budget`) : la campagne a épuisé son budget de requêtes
     (`max_requests`, 10 000 par campagne mensuelle, `stop_reason = campaign_request_budget_reached`). La
     campagne du mois suivant repart d'un nouveau budget.
   - `idle` / `completed` : rien à collecter ; l'historique est à jour.

3. **Les lots attestés avancent-ils ?** Si la collecte est `ok` mais que le cliché n'est pas rafraîchi,
   suivre `docs/runbooks/scenarios-encheres.md`.

## Pooler et rôle (incident du 12/10/2026)

Le pipeline atteint la base par le pooler Supabase en **mode transaction** : une connexion serveur est
partagée entre clients, d'une transaction à l'autre. Conséquences, toutes déjà codées dans
`licitor_history_refresh.py` et `licitor_cloud.py` :

- **Le rôle se pose par transaction** : `set local role licitor_collector`, jamais `set role` au niveau de la
  session. Un `set role` de session reste sur la connexion serveur et passe au client suivant : le 12/10/2026,
  d'autres collectes ont reçu « permission denied ». Symptôme actuel d'une régression : des erreurs
  `permission denied for table …` dans **d'autres** workflows du pipeline, juste après un passage Licitor.
  Lire `CollectorRoleConnection` avant de toucher à la connexion.
- **Pas de requêtes préparées** : `psycopg.connect(..., prepare_threshold=None)`. En mode transaction, une
  requête préparée par psycopg après plusieurs exécutions n'existe plus sur la connexion serveur suivante
  (erreurs du type « prepared statement … does not exist » ou « already exists »). Toute nouvelle connexion du pipeline
  doit garder `prepare_threshold=None`.
- **Délais** : `connect_timeout=10`, `statement_timeout=15000` (15 s), `lock_timeout=3000` (3 s). Une requête
  plus longue (par exemple la copie du cliché) échoue avec « canceling statement due to statement timeout » ;
  le rapport le note sans arrêter le reste (`scenario_snapshot.status = error`).
- **Hôte** : la connexion dédiée du collecteur (`LICITOR_DATABASE_URL`, service manuel
  `services/licitor-collector`) exige un identifiant `licitor_collector…` et un hôte `*.supabase.co` ou
  `*.supabase.com`, avec `sslmode=require`.

Vérifications en lecture seule : l'identifiant de connexion utilisé par le workflow (variable
`SUPABASE_DB_URL` du dépôt GitHub, sans l'afficher) est bien celui du pooler en mode transaction, et le rôle
existe :

```sql
select rolname, rolcanlogin from pg_roles where rolname like 'licitor_collector%';
```

## Actions

- Rôle absent ou non accordé : défaut de migration ; ne pas le créer à la main. Écrire une migration, la
  signaler au propriétaire (règle 8 de `supabase/README.md`).
- Campagne en pause après un blocage de la source : ne pas relancer en boucle. Lire la raison, respecter
  `robots.txt`, et laisser le propriétaire décider de lever la pause.
- Besoin d'un tick ponctuel : le service `services/licitor-collector` (`/api/tick`, action manuelle
  authentifiée, production seulement) existe encore ; il répond 409 si Licitor est retiré.
- Régression de connexion (rôle de session, requêtes préparées) : corriger dans le code puis tester avec
  `services/data-pipeline/tests/test_licitor_history_refresh.py` et `test_licitor_cloud_postgres.py`.

## Fermeture

`licitor_history_exit_code` revient à `0` sur deux passages consécutifs, `tick.status` est `completed`,
`idle` ou progresse, et aucune erreur `permission denied` n'apparaît dans les autres workflows.
