# Mise en production de la branche du 20/10/2026 (migrations, déploiement, réparations)

Ce document est la marche à suivre pour mettre en production la branche `claude/laughing-ramanujan-vv6y9w`
(chantiers du 20/10/2026 et corrections de la relecture, chantier R1). Il est destiné au propriétaire, qui
applique les migrations et lance les réparations : **aucun agent n'écrit en production**. Compte-rendu
d'origine : `docs/equipe/2026-10-20-session-complete.md`.

En une phrase : **CI pgTAP verte, puis les 37 migrations dans l'ordre, puis le déploiement, puis les
réparations (comptage d'abord), avec un contrôle après chaque étape. Les trois interrupteurs d'envoi
d'emails restent `off`.**

## 1. Ce que contient la mise en production

| Lot | Migrations                                                          | Quoi                                                                                                                                              |
| --- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | `20261029100000` à `20261029100300` (4)                             | Mesure par compte (purge sûre), page des audiences rapide, rétention des ventes passées et en quarantaine, plafond d'exports d'agenda             |
| B   | `20261029110000` à `20261029110200` (3)                             | Offre de lancement : adresse canonique, plafonds séparés, prix des instantanés                                                                    |
| C   | `20261029120000` à `20261029120200` (3)                             | Bande d'écart durcie, détails du plafond quotidien (`daily_account`, `daily_shared`), Pilotage v2                                                 |
| D   | `20261029130000` à `20261029150100` (4)                             | Preuve du consentement aux rappels, codes d'échec, report des rappels à la fusion, retrait des ventes absentes (plancher des petites sources)     |
| E   | `20261029160000` à `20261029190000` (7)                             | Date « Données vérifiées le », alertes de santé, observateur du pipeline, politique de lecture, tribunaux (identité), fiche (code tribunal), prix |
| F   | `20261030110000` à `20261030130000` (10)                            | Ventes sous la fourchette, retour sur les signaux, consentements « Ma semaine » et résultats, journaux d'envoi, clics, relevé mensuel des avocats |
| G   | `20261031100000` à `20261031100500` (6, corrections du chantier R1) | Voir le tableau ci-dessous                                                                                                                        |

Lot G (corrections de la relecture, chantier R1) :

| Migration                                                       | Point | Effet                                                                                                                                                         |
| --------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20261031100000_normalize_source_url_requires_path`             | 8     | Une adresse source réduite au domaine n'a plus de clé : elle ne fusionne plus deux annonces                                                                   |
| `20261031100100_public_source_group_ids`                        | 1     | Plus aucune clé SHA-256 ne sort des listes publiques : un identifiant de groupe (`source_group`) la remplace ; `get_public_tribunal_sales` change de colonnes |
| `20261031100200_public_catalogue_verified_at_unknown_source`    | 3     | La date « Données vérifiées le » est inconnue (accueil sans date) si une source du périmètre n'a jamais de publication complète                               |
| `20261031100300_offer_opening_attempts`                         | 5     | Suivi des essais d'envoi à la liste d'attente (`notify_attempts`, `notify_attempted_at`) et file `get_offer_opening_queue` (comptes non confirmés écartés)    |
| `20261031100400_notification_consent_server_only`               | 6     | Version du texte de consentement posée par le rôle de service seul ; le navigateur n'écrit plus les colonnes des trois consentements                          |
| `20261031100500_admin_pilotage_launch_offer_accounts_canonical` | 7     | Le Pilotage compte les comptes de l'offre de lancement avec la règle canonique                                                                                |

Aucune migration ne supprime de donnée. Les deux seules qui changent la forme d'une fonction publique sont
`20261029100100` (audiences) et `20261031100100` / `20261029180000` (ventes d'un tribunal) : l'application
lit les anciennes et les nouvelles formes.

## 2. Prérequis (avant d'appliquer quoi que ce soit)

1. **La CI pgTAP est verte sur la branche.** Les tests pgTAP n'ont jamais été exécutés sur un vrai Supabase :
   ni par les agents ni localement. Ceux de cette mise en production : 496, 510, 511, 520, 530 à 640 et,
   pour le chantier R1, **650 à 655** (les tests 496, 531, 550, 590, 596 et 630 ont été mis à jour). Un défaut critique (`position(… in …)` refusé par PostgreSQL)
   a déjà été trouvé à la relecture : la CI l'aurait arrêté.
2. `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run test:security-invariants` verts (le chef les lance
   après la fusion).
3. **Hors collecte** : aucune exécution du pipeline en cours (les migrations prennent des verrous de 5 s,
   `set local lock_timeout`, sur `auction_sales` notamment ; si un verrou n'est pas obtenu la migration échoue
   sans rien casser, on relance). Vérifier dans GitHub Actions qu'aucun workflow de collecte n'est en cours.
4. **Sauvegarde** : une sauvegarde Supabase récente (ou une branche) avant la première migration.
5. **Ce qui attend la santé des sources** : voir l'étape 5, « Points d'attention » (la sonde `/api/health`
   devient plus sévère).
6. **Variables : aucune nouvelle.** Vérifier que `SALE_REMINDERS_MODE`, `WEEKLY_DIGEST_MODE` et
   `SALE_RESULTS_MODE` valent `off` (ou sont absentes) dans Vercel.

Lecture seule, pour voir ce qui est en attente (ne modifie rien) :

```bash
node scripts/apply-supabase-migrations.mjs --dry-run
```

## 3. Ordre exact

L'ordre recommandé est **migrations, puis déploiement du code, puis réparations**. Le code déployé fonctionne
aussi **avant** les migrations (voir la section 6) : un retard de l'une ou l'autre étape ne casse rien.

### Étape 0 : la fusion dans `main`

Le workflow de migrations ne s'exécute que depuis `main` : la branche doit donc y être fusionnée d'abord (pull
request, relue, CI verte). **Selon la configuration de l'intégration Git de Vercel, cette fusion déclenche le
déploiement de `main` avant l'application des migrations.** C'est sans danger : le code déployé fonctionne
avec ou sans les migrations (section 5). L'ordre « migrations puis code » reste le plus propre quand on peut
retarder le déploiement (désactiver momentanément le déploiement automatique, ou déployer en préproduction
d'abord) ; il n'est pas obligatoire.

### Étape 1 : les migrations (lots A à G, dans l'ordre des numéros)

Le workflow « Apply Supabase Migrations » (`workflow_dispatch` depuis `main`, saisie `production`) applique
**tout ce qui est en attente, dans l'ordre des versions, une migration par transaction**, et s'arrête à la
première qui échoue : les précédentes restent appliquées, la suivante est annulée entière. Il n'a pas
d'option « jusqu'à telle version » : une exécution applique les 37 migrations. Les lots ci-dessus servent à
**contrôler après coup** et, si l'exécution s'arrête, à savoir où.

Si le workflow s'arrête : lire le message, corriger (nouvelle migration, jamais la modification d'une migration
déjà appliquée), relancer ; la reprise commence à la migration en échec.

Après l'exécution, contrôler lot par lot (requêtes en **lecture seule**, dans l'éditeur SQL ou `psql`) :

**Lot A**

```sql
select to_regprocedure('public.get_public_upcoming_hearings(integer)') is not null as audiences,
       to_regprocedure('app_private.normalize_source_url(text)') is not null as cle_adresse;
select indexname from pg_indexes
 where tablename = 'account_product_events' and indexname like '%once_per_day%' order by 1;  -- 2 lignes
\timing on
select (public.get_public_upcoming_hearings(30) ->> 'total_count')::int as audiences_30_jours;  -- moins de 5 s
```

**Lot B**

```sql
select app_private.canonical_email('Jo.Hn+promo@gmail.com') as attendu_johnatgmail;    -- 'john@gmail.com'
select count(*) as comptes_inscrits from app_private.account_email_identity;            -- 0 tant que la réparation n'est pas faite
select to_regprocedure('public.get_launch_offer_account_eligibility(uuid)') is not null as rpc_eligibilite;
```

**Lot C**

```sql
select conname, convalidated from pg_constraint
 where conname = 'account_product_events_type_detail_check';                            -- convalidated = true
select public.admin_pilotage_summary() -> 'snapshot' as snapshot;                      -- des nombres, aucune personne
```

**Lot D**

```sql
select column_name from information_schema.columns
 where table_name = 'user_notification_preferences' and column_name = 'sale_reminders_consent_text_version';  -- 1 ligne
select tgname from pg_trigger where tgname = 'immojudis_user_notification_preferences_reminder_consent';      -- 1 ligne
select to_regprocedure('app_private.withdraw_missing_source_sales(text,boolean,timestamptz)') is not null as retrait_absence;
```

**Lot E**

```sql
select public.get_public_catalogue_verified_at() as donnees_verifiees_le;   -- une date récente, ou NULL (voir le lot G)
select count(*) from public.get_public_tribunal_sales('justice_tj_1_93', 30);                -- des lignes, sans erreur
select job_name from cron.job where jobname like 'immojudis-%' order by 1;                    -- les tâches planifiées existent toujours
```

**Lot F**

```sql
select to_regclass('public.sale_signal_feedback') is not null as retours,
       to_regclass('public.weekly_digest_dispatches') is not null as journal_semaine,
       to_regclass('public.sale_result_dispatches') is not null as journal_resultats;
select column_name from information_schema.columns
 where table_name = 'user_notification_preferences'
   and column_name in ('weekly_digest_enabled', 'sale_results_enabled') order by 1;          -- 2 lignes
```

**Lot G** (chantier R1)

```sql
-- point 8 : une adresse réduite au domaine n'a plus de clé
select app_private.normalize_source_url('https://licitor.com/') is null as sans_cle,
       app_private.normalize_source_url('https://www.licitor.com/annonce/1/2/vente.html') as avec_cle;
-- point 1 : plus de source_keys ; un source_group (uuid) à la place
select pg_get_function_result('public.get_public_tribunal_sales(text, integer)'::regprocedure);
select (public.get_public_upcoming_hearings(30) -> 'hearings' -> 0) ? 'source_keys' as ancienne_cle;  -- false
-- point 3 : quelle source du périmètre n'a jamais de publication complète (si NULL à l'accueil)
select state.source_name, state.last_publication_complete_at
  from public.auction_source_state state
 where state.enabled order by state.last_publication_complete_at nulls first;
-- point 5 : la file de la liste d'attente
select public.get_offer_opening_queue(1) - 'recipients' as file;       -- { total, needs_review }
-- point 6 : le navigateur n'écrit plus ces colonnes
select has_column_privilege('authenticated', 'public.user_notification_preferences',
                            'sale_reminders_enabled', 'UPDATE') as navigateur_peut_ecrire;     -- false
-- point 7 : le Pilotage
select public.admin_pilotage_summary() #>> '{snapshot,launch_offer_accounts}' as comptes_offre;
```

Ensuite, **régénérer les types** : `npm run db:types` (les types de `src/integrations/supabase/types.ts`
ont été complétés à la main pour `get_offer_opening_queue` et les colonnes `notify_*`).

### Étape 2 : les réparations liées aux migrations (comptage, puis application)

Les réparations sont dans `supabase/repairs/` (voir son `README.md`). **Aucune n'est lancée par la CI ni par
le workflow de migrations.** Pour chacune : d'abord le comptage (par défaut, aucune écriture, transaction
annulée), relire le résultat, puis `-v apply=1`.

1. **`20261029110000_backfill_account_email_identity.sql`**, juste après le lot B (idéalement avant le
   déploiement) :

   ```bash
   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/repairs/20261029110000_backfill_account_email_identity.sql
   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -v apply=1 -f supabase/repairs/20261029110000_backfill_account_email_identity.sql
   ```

   Effet à connaître : après cette réparation, deux comptes confirmés d'une même boîte (`a+1@x.fr`,
   `a+2@x.fr`) n'ont plus l'offre de lancement que pour le plus ancien. Contrôle (lecture seule) :
   `select canonical_email, count(*) from app_private.account_email_identity where email_confirmed_at is not null group by 1 having count(*) > 1 order by 2 desc;`

2. **`20261029100200_recompute_past_quarantined_deadlines.sql`**, après le lot A, **hors collecte**. Une
   alerte `retention.sale.overdue` s'ouvre pendant le rattrapage : c'est attendu (voir
   `docs/runbooks/retention-sale-overdue.md`). Contrôle avant et après : voir l'en-tête du fichier.
3. **`20261030100001_count_workspace_status_not_in_dossier.sql`** : comptage seul, facultatif.

### Étape 3 : le déploiement du code (Vercel)

Déployer la branche fusionnée dans `main` comme d'habitude. Le code déployé s'adapte à l'état de la base
(section 6) : si une migration n'était pas encore appliquée, il se replie sans rien exposer.

Contrôles juste après le déploiement :

| URL / commande                                                            | Attendu                                                                                                                                                                                                          |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `curl -si https://immojudis.com/api/health`                               | `200` et `"status":"ok"` ; en-tête `cache-control: public, s-maxage=30` ; `collection` donne `enabledSources` et `lateSources`. Un `503` `degraded` dit quel âge dépasse son seuil (voir le point d'attention 1) |
| `https://immojudis.com/audiences-a-venir`                                 | La page se charge en quelques secondes, sans « momentanément indisponibles » ; une même vente publiée par deux sources n'y figure qu'une fois                                                                    |
| `https://immojudis.com/tribunaux/justice-tj-1-93`                         | La liste des prochaines ventes s'affiche ; pas de doublon évident                                                                                                                                                |
| `https://immojudis.com/`                                                  | « Données vérifiées le … » : une date récente, ou aucune date (source jamais collectée en entier)                                                                                                                |
| `https://immojudis.com/sitemap.xml`                                       | Pages `/tribunaux/justice-tj-…` et `/audiences-a-venir` (si au moins 3 audiences)                                                                                                                                |
| `https://immojudis.com/compte` (compte connecté)                          | Aucune case « Me rappeler l'audience », « Ma semaine » ni alerte de résultat (les trois interrupteurs sont `off`)                                                                                                |
| `https://immojudis.com/admin/pilotage`, `/admin/clients` (administrateur) | Les chiffres s'affichent ; « Prévenir la liste d'attente » indique les destinataires (adresse confirmée) et, s'il y en a, les demandes « à vérifier »                                                            |
| `node scripts/check-production-smoke.mjs --origin https://immojudis.com`  | Réussi (il échouait tant que `/api/health` et la réparation des audiences n'étaient pas déployés)                                                                                                                |

Puis configurer la sonde externe sur `/api/health` si ce n'est pas fait : `docs/operations/supervision-externe.md`.

### Étape 4 : ce qui reste `off`, et ce qui n'est pas lancé

- `SALE_REMINDERS_MODE`, `WEEKLY_DIGEST_MODE`, `SALE_RESULTS_MODE` : **restent `off`** tant que la politique de
  confidentialité et le registre ne sont pas mis à jour (textes juridiques, non validés). Pour les rappels,
  passage à `internal` puis `on` selon `docs/runbooks/activation-rappels-audience.md` ; la migration
  `20261029130000` (lot D) et la route serveur sont prêtes. Aucune case de consentement n'est proposée en `off`.
- **L'email d'ouverture de l'offre** (liste d'attente) : ne pas envoyer de lot réel avant relecture du texte
  (`src/lib/admin-offer-opening-notifier.ts`). L'envoi d'essai à soi-même reste possible.
- Toujours en attente de décision (hors de cette mise en production) : balayage des doublons, réparations de
  données du 18/10, purge des noms, `LICITOR_DECODE_PROTECTED_EMAILS=false`, `www` en 308, indexation,
  identité de l'éditeur, `valuation:publish`, `release:prepare`.

### Étape 5 : points d'attention

1. **`/api/health` devient plus sévère.** Il compare désormais chaque source **activée** à 36 h (et non plus
   la plus récente à 18 h). Une source activée figée (Enchères Immobilières, dont la cause du blocage de
   publication n'est pas trouvée) ou jamais collectée en entier rend le site `degraded` : le test de fumée GitHub
   (toutes les 30 min) échoue et la sonde externe de type « mot-clé » alerte. _Mise à jour du 23/10/2026 : la route
   répond désormais 200 tant que la base répond, la fraîcheur se lit dans `status` (`docs/operations/supervision-externe.md`) ;
   elle ne répond 503 que base injoignable._ **Avant le déploiement**, lire :

   ```sql
   select source_name, last_publication_complete_at
     from public.auction_source_state
    where enabled
    order by last_publication_complete_at nulls first;
   ```

   Toute ligne à `NULL` ou de plus de 36 h : corriger la collecte (`docs/runbooks/pipeline-source-publication-stale.md`),
   ou, par décision du propriétaire, désactiver la source (`enabled = false`, hors de cette mise en production).
   La même source rend aussi la date de l'accueil inconnue (point 3 du lot G).

2. **La page des audiences** devrait passer de plus de 20 s à quelques secondes (non mesuré).
3. **Liste d'attente : « demandes à vérifier ».** Une demande dont l'envoi a été tenté sans confirmation il y
   a plus de 23 h (au-delà, la clé d'idempotence de Resend n'existe plus) ou 3 fois n'est plus relancée toute
   seule. Avant de la reprendre : retrouver l'email dans le journal d'envoi de Resend (destinataire, clé
   `immojudis-offer-opening-<user_id>`) ; si rien n'est parti, remettre les compteurs à zéro :
   `update public.offer_opening_notifications set notify_attempts = 0, notify_attempted_at = null where user_id = '<user_id>';`
   (si l'email est parti : poser `notified_at` à la main).
4. **Consentements** : le navigateur n'écrit plus ces colonnes ; seule la route serveur le fait (rôle de
   service). Une opération de maintenance en SQL qui doit poser une version du texte passe par
   `set role service_role`.

5. **Écart connu : `precompute-valuations` désactivé dans le dépôt, actif en production.** Le dépôt
   désactive la tâche `pg_cron` `immojudis-market-valuations` (migration `20260910160206`, « collecte et
   enrichissement sur action explicite » : `cron.alter_job(jobid, active := false)`), alors que
   `docs/operations/planification.md` la décrit « toutes les 5 min » et qu'elle a été constatée active en production lors du
   diagnostic de session du 23/10/2026 (lecture seule, à revérifier par les requêtes ci-dessous). Aucune migration du
   dépôt ne la réactive : l'état réel vient donc d'une action manuelle sur la base (ou d'un état antérieur
   jamais reproduit dans le dépôt). Conséquences : une base reconstruite depuis les migrations n'aurait pas ce
   pré-calcul, et la tâche n'est pas supervisée par `cron.stale` (`docs/runbooks/valuation-queue-degraded.md`).
   Vérifier l'état réel avant de décider (lecture seule) :

   ```sql
   select jobname, schedule, active from cron.job where jobname = 'immojudis-market-valuations';

   select status, started_at, finished_at, error_message
   from public.operational_job_runs
   where job_name = 'precompute-valuations'
   order by started_at desc
   limit 5;
   ```

   Décision du propriétaire : soit consigner l'état voulu par une migration (activer ou désactiver
   explicitement, avec son test pgTAP), soit couper la tâche en production. Tant que ce n'est pas fait, le
   dépôt et la production divergent : ne pas s'appuyer sur la migration `20260910160206` pour dire que la
   tâche est arrêtée.

## 4. Retour arrière

**Le code d'abord.** Rétablir le déploiement Vercel précédent suffit : l'ancien code tolère l'état de la
base après les migrations : il ne fusionne plus les doublons des pages de tribunal (`source_keys` n'est
plus rendu) ; la page des audiences, que l'ancien code lit en anonyme, n'y a plus accès (droit retiré par
`20261029100100`) et garde sa dernière version servie. Pas de migration à annuler pour cela.

**Les migrations** ne se défont pas automatiquement : préférer **corriger vers l'avant** (une nouvelle
migration). Si un retour est vraiment nécessaire, par migration :

| Migration                                        | Retour arrière                                                                                                                                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `20261031100400` (droits, déclencheurs)          | `grant insert, update on table public.user_notification_preferences to authenticated;` puis ré-exécuter les blocs `create or replace function app_private.enforce_*` de `20261029130000` et `20261030120000` |
| `20261031100100` (groupes d'identité)            | Ré-exécuter `20261029180000` (ventes d'un tribunal) et la fonction `app_private.get_public_upcoming_hearings` de `20261029100100`                                                                            |
| `20261031100000`, `100200`, `100500`             | Ré-exécuter la définition précédente (`20261029100100` pour `normalize_source_url`, `20261029160000`, `20261029120200`)                                                                                      |
| `20261031100300` (essais d'envoi)                | `drop function public.get_offer_opening_queue(integer, timestamptz);` (les colonnes `notify_*` peuvent rester) ; le code revient seul à l'ancienne sélection                                                 |
| `20261029120100` (détails du plafond)            | Remettre la contrainte d'avant : `daily`, `unlocks`, `favorites` seulement (le code, lui, replie déjà sur `daily` si la contrainte refuse)                                                                   |
| Les autres (créations de fonctions et de tables) | Les fonctions se remplacent par leur définition précédente ; les tables nouvelles (`sale_signal_feedback`, journaux d'envoi) sont vides tant que les interrupteurs sont `off` et se suppriment sans perte    |

**Les réparations** : chaque fichier de `supabase/repairs/` se termine par sa requête de retour arrière, à
partir de sa table de sauvegarde (`supabase/repairs/README.md`). La réparation de l'identité des comptes se
défait par `truncate app_private.account_email_identity;` (le déclencheur la remplit à nouveau).

## 5. Qui dépend de quoi : le code, avant ou après les migrations

La règle suivie : le code déployé **tolère l'absence** de ce que les migrations ajoutent (repli documenté,
sans exposer de donnée), ou la dépendance est **listée comme « migration avant le code »**. Passage en revue
de chaque fonction, colonne, table ou contrainte ajoutée par les migrations `20261029*`, `20261030*` et
`20261031*` :

| Ajout de la migration                                                                                   | Code qui l'utilise                                 | Si la migration manque (code déployé avant)                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_launch_offer_account_eligibility` (`20261029110000`)                                               | `hasConfirmedEmail` (`launch-offer.server.ts`)     | **Repli** : ancienne règle (email confirmé lu par l'API Auth d'administration) sur `PGRST202` / `42883` ; toute autre erreur reste fermée                                                                                                                                                                              |
| Détails `daily_account` / `daily_shared` (`20261029120100`)                                             | `recordAccountProductEvent`                        | **Repli** : la contrainte refuse (`23514`), l'événement est réécrit avec l'ancien détail `daily`                                                                                                                                                                                                                       |
| `get_public_upcoming_hearings` en document (`20261029100100`)                                           | `upcoming-hearings.server.ts`                      | **Tolère** : lit l'ancien tableau de lignes (service_role y a droit)                                                                                                                                                                                                                                                   |
| `get_public_tribunal_sales`, colonne `source_group` (`20261029180000`, `20261031100100`)                | `tribunal-pages.server.ts`, `upcoming-hearings.ts` | **Tolère** : colonne absente = pas de fusion des doublons ; aucune clé ni adresse ne sort                                                                                                                                                                                                                              |
| `get_public_sale_summary`, `tribunal_code` (`20261029180100`)                                           | `public-sale-summary.ts`                           | **Tolère** : champ facultatif                                                                                                                                                                                                                                                                                          |
| `get_offer_opening_queue`, colonnes `notify_*` (`20261031100300`)                                       | `admin-offer-opening-notifier.ts`                  | **Repli** : ancienne sélection par table, sans suivi des essais (les comptes non confirmés reviennent en tête tant que la migration manque)                                                                                                                                                                            |
| Droits et déclencheurs de consentement (`20261031100400`)                                               | `notification-preferences.ts`                      | Fonctionne **avant et après** : la route écrit avec le rôle de service ; les colonnes de version / `weekly_digest_*` / `sale_results_*` n'existent qu'à partir de `20261029130000` / `20261030120000`, et n'ont d'usage qu'une fois l'interrupteur correspondant ouvert (**migration avant d'ouvrir un interrupteur**) |
| `admin_pilotage_summary` v2 (`20261029120200`, `20261031100500`)                                        | `admin-pilotage.ts`                                | **Tolère** : fonction ancienne ou absente = « non mesuré »                                                                                                                                                                                                                                                             |
| `admin_lawyer_monthly_statement` (`20261030130000`)                                                     | `admin-lawyer-statement.ts`                        | **Tolère** : message « migration à appliquer » (page d'administration)                                                                                                                                                                                                                                                 |
| `list_public_sale_ids_under_market_range` (`20261030110000`)                                            | `search/market-range-filter.ts`                    | **Tolère** : le filtre dit qu'il est indisponible                                                                                                                                                                                                                                                                      |
| `record_sale_signal_feedback`, `sale_signal_feedback` (`20261030110100`)                                | `sale-signal-feedback.server.ts`                   | **Migration avant le code (conseillé)** : sans elle, un clic sur « Utile » / « Pas pertinent » répond une erreur (aucune donnée exposée)                                                                                                                                                                               |
| `admin_sale_signal_feedback_summary` (`20261030110300`)                                                 | `admin-sale-signal-feedback.ts`                    | **Tolère** : « non mesuré »                                                                                                                                                                                                                                                                                            |
| `claim_weekly_digest`, `claim_sale_result`, journaux d'envoi (`20261030120*`)                           | `weekly-digest-store.ts`, `sale-results-store.ts`  | **Migration avant d'ouvrir l'interrupteur** : avec `WEEKLY_DIGEST_MODE` / `SALE_RESULTS_MODE` à `off` le passage s'arrête avant toute lecture                                                                                                                                                                          |
| Journal des rappels et codes d'échec (`20261029130100`)                                                 | `sale-reminders.ts`                                | **Indifférent** : le code n'écrit que des codes courts (acceptés avec ou sans la contrainte)                                                                                                                                                                                                                           |
| Tables des migrations `20261030*` dans l'effacement RGPD                                                | `privacy-requests.ts`                              | **Repli** : une table absente (`sale_signal_feedback`, `weekly_digest_dispatches`, `sale_result_dispatches`) n'a rien à effacer, l'effacement n'échoue pas                                                                                                                                                             |
| `enqueue_data_refresh_bounded` (`20261029110100`)                                                       | `data-refresh.ts`                                  | **Indifférent** : même signature, le code reconnaît les deux messages de plafond                                                                                                                                                                                                                                       |
| `get_public_catalogue_verified_at` (`20261029160000`, `20261031100200`)                                 | `home-catalogue-summary.server.ts`                 | **Tolère** : une date ou aucune                                                                                                                                                                                                                                                                                        |
| `withdraw_missing_source_sales` (`20261029150100`)                                                      | pipeline (`source_absence.py`)                     | **Tolère** : le pipeline vérifie l'existence de la fonction (`to_regprocedure`)                                                                                                                                                                                                                                        |
| Fonctions internes (rétention, alertes de santé, observateur, politiques, déclencheurs de prix, fusion) | aucune                                             | Sans effet sur le code                                                                                                                                                                                                                                                                                                 |

Deux dépendances demandent donc la migration **avant** l'usage, et ne cassent rien tant qu'elles sont
respectées : `record_sale_signal_feedback` (avant le code, sinon une erreur visible sur un clic) et les
consentements, journaux et fonctions d'envoi de « Ma semaine » et des résultats (avant d'ouvrir l'interrupteur).
