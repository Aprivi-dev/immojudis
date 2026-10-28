# Pannes du traitement d'inondation (Géorisques, Géoportail de l'urbanisme)

Le traitement d'inondation observe, pour chaque vente à venir, le risque d'inondation (TRI de Géorisques,
puis périmètre des PPRi du Géoportail de l'urbanisme) et stocke un verdict dans la table privée
`auction_sale_flood_risk`. La règle `pepite-v2` le lit quand `PEPITE_RULE_V2_ENABLED` est ouvert. Ce runbook
dit comment lire une panne et que faire.

Alerte concernée : `cron.stale` (la tâche `sale-flood-risk` n'a aucun succès depuis 3 h). Elle ne voit que
l'échec total : une panne partielle (beaucoup d'« inconnus », quelques observations qui réussissent) n'ouvre
aucune alerte, il faut lire les requêtes ci-dessous.

Dernier essai : jamais (à dater après un essai en préproduction ou à blanc).

## Qui fait les appels (depuis la PR #330)

Depuis le 27/10/2026, Géorisques coupe les connexions qui viennent de Vercel (`network_econnreset`). Les
appels partent donc de **GitHub Actions** :

- à chaque heure, à :25, `pg_cron` appelle `/api/cron/sale-flood-risk` ; un filet Vercel quotidien passe à
  05:35 UTC ;
- la route ne fait que **déclencher** le workflow `sale-flood-risk.yml` (« Sale flood risk », `workflow_dispatch`,
  même jeton GitHub et même branche que le pipeline, `src/lib/sale-flood-risk-dispatch.server.ts`). Ce
  déclenchement est suivi dans `operational_job_runs` sous le nom **`sale-flood-risk-dispatch`** ;
- le workflow construit puis exécute `src/jobs/sale-flood-risk-runner.ts` (`npm run flood-risk:build`), qui
  appelle le même `runSaleFloodRiskBatch` que la route : bail, cadence, écritures par paquets, reprise des
  paquets bloqués. Seuls `SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` lui sont donnés. La passe est suivie
  sous le nom **`sale-flood-risk`**, celui que lit `cron.stale` : un workflow en échec, ou qui ne tourne pas,
  fait donc lever l'alerte ;
- la taille de lot vient de la variable de **dépôt GitHub** `SALE_FLOOD_RISK_BATCH_LIMIT` (Settings,
  Secrets and variables, Actions, Variables), 150 par défaut. Ce n'est plus la variable Vercel du même nom
  qui compte, sauf en retour arrière.

**Retour arrière** : poser `SALE_FLOOD_RISK_RUNNER=vercel` dans Vercel (Production) puis redéployer. La route
refait alors les appels elle-même. À ne faire que si les appels depuis GitHub Actions échouent à leur tour, ou
si Géorisques lève sa restriction.

## Fausse alerte ?

- Une alerte transitoire est attendue jusqu'au premier succès qui suit un déploiement ou une migration.
- Une passe `skipped: "busy"` (bail de 6 minutes pris par une autre passe) compte pour un succès.
- Une passe `skipped: "not_migrated"` (tables absentes) compte pour un succès : vérifier que les migrations
  `20261106100000` à `20261106100500` sont appliquées.

## Diagnostic (lecture seule, éditeur SQL de Supabase)

Les dix dernières passes de la tâche et de son déclenchement :

```sql
select job_name, started_at, status, error_message,
       summary->'errors'          as errors,
       summary->>'observed'       as observed,
       summary->>'failed'         as failed,
       summary->>'rateLimited'    as rate_limited,
       summary->>'stoppedByDeadline' as deadline,
       summary->>'remaining'      as remaining
from public.operational_job_runs
where job_name in ('sale-flood-risk', 'sale-flood-risk-dispatch')
order by started_at desc
limit 10;
```

Notes de lecture :

- une passe en échec (`status = 'failed'`) n'enregistre que `error_message`, pas de résumé ;
- `errors` ne garde que les **5 premiers** codes de la passe ;
- l'historique est purgé à 30 jours ;
- le journal complet de la passe est dans l'onglet Actions de GitHub (workflow « Sale flood risk »).

Les causes mémorisées par vente et la répartition des verdicts :

```sql
select last_failure, count(*)
from public.auction_sale_flood_risk
where last_failure is not null
group by 1 order by 2 desc;

select verdict, count(*) from public.auction_sale_flood_risk group by 1 order by 2 desc;

select count(*) filter (where verdict = 'unknown') as inconnus,
       count(*) filter (where verdict = 'unknown'
                          and (last_failure like 'network%' or last_failure like 'http\_%'
                               or last_failure = 'timeout')) as inconnus_par_panne,
       count(*) as total
from public.auction_sale_flood_risk;
```

## Table des codes (`last_failure`, `errors`)

| Code                   | Sens                                                                                                                                                                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http_<statut>`        | La source répond par une erreur HTTP : 502 ou 503 = panne amont, 403 = refus du serveur ou d'un pare-feu, 404 = chemin changé. Un 429 n'est jamais un code (voir ci-dessous).                                                                                                |
| `timeout`              | Appel coupé au bout de 8 s.                                                                                                                                                                                                                                                  |
| `network`              | Échec réseau sans cause lisible.                                                                                                                                                                                                                                             |
| `network_<cause>`      | Échec réseau avec la cause de Node en minuscules : `econnreset` (connexion coupée), `enotfound` (DNS), `econnrefused`, `und_err_connect_timeout`, `redirect` (redirection refusée).                                                                                          |
| `ppri_unreadable`      | Périmètre des PPRi illisible : le verdict déjà connu est conservé, seule la tentative est consignée.                                                                                                                                                                         |
| `unexpected_shape`     | Réponse reçue mais de forme inattendue (le format de la source a peut-être changé).                                                                                                                                                                                          |
| `invalid_position`     | Coordonnées inexploitables pour cette vente.                                                                                                                                                                                                                                 |
| `write_busy_<n>`       | `n` ventes dont l'écriture a été refusée pour cause de verrou ou de délai (codes Postgres 57014, 55P03, 40P01), typiquement pendant une publication du pipeline. Elles sont reprises à la passe suivante. La passe n'échoue que si rien n'a pu être écrit de toute la passe. |
| `attempt_write_<code>` | Une tentative en échec n'a pas pu être consignée (même cause, code Postgres).                                                                                                                                                                                                |

Un **429** n'est pas un code de vente : il arrête la passe (`rateLimited = true`, message « limite de débit
(429) »), et la suivante reprend. Un verdict connu n'est jamais écrasé par « inconnu » après une panne ; la
dernière valeur valable reste utilisée 180 jours, et une tentative en échec est retentée après 6 h.

## Arbre de décision

1. **`network_*` ou `timeout` sur presque toutes les ventes, alors que la source répond depuis un poste**
   (`curl` sur l'API Géorisques) : le blocage vise l'origine des appels.
   - Si les appels partent de GitHub Actions : lire le journal du workflow, vérifier que Géorisques ne bloque
     pas non plus les adresses de GitHub, essayer plus tard.
   - Si le déclenchement est en échec (`sale-flood-risk-dispatch` en `failed`, message « Jeton de
     déclenchement GitHub absent » ou « refusé : HTTP … ») : le jeton GitHub (`GITHUB_SCROLL_TOKEN`) manque
     ou a expiré ; le workflow ne tourne pas, `cron.stale` s'ouvrira après 3 h.
   - Ne pas ouvrir `PEPITE_RULE_V2_ENABLED` tant que les `network_*` persistent (décision du fondateur).
2. **`network_redirect`** : la source a changé d'adresse. Revoir `GEORISQUES_BASE_URL` (`src/lib/land-risks-provider.ts`)
   et l'adresse de l'API Carto dans `src/lib/land-planning-ppri.ts`.
3. **`http_5xx` persistant** : panne de la source, attendre ; la passe retente après 6 h. Rien à faire.
4. **`http_403`** : refus par la source, comme le blocage de Vercel. Même démarche que le point 1.
5. **`write_busy_<n>`** : vérifier qu'une publication du pipeline est en cours
   (`select pid, state, query_start, left(query, 80) from pg_stat_activity where state <> 'idle';`). Aucune
   action tant que les passes suivantes écrivent. Si aucune écriture ne passe pendant plusieurs heures, la
   passe échoue (« ventes verrouillées pendant toute la passe ») et `cron.stale` s'ouvre.
6. **`rateLimited`** : baisser `SALE_FLOOD_RISK_BATCH_LIMIT` (variable de dépôt GitHub, ou Vercel en retour
   arrière), sans redéploiement pour GitHub.
7. **`unexpected_shape`** : le format d'une réponse a changé ; à confier au développeur, avec un exemple de
   code et de date (les journaux ne contiennent ni réponse ni coordonnée).

## Actions

Ne jamais relancer le workflow en boucle. Un déclenchement manuel (onglet Actions, « Sale flood risk », Run
workflow, ou un appel de `/api/cron/sale-flood-risk` avec `Authorization: Bearer $CRON_SECRET`) **écrit en
production** et appelle des services de l'État : un seul à la fois, et seulement après avoir traité la cause.
Le bail empêche deux passes simultanées.

## Effet sur les pépites

- Interrupteur `PEPITE_RULE_V2_ENABLED` fermé (état actuel) : aucun effet, la règle appliquée est `pepite-v1`.
- Interrupteur ouvert : un verdict « inconnu » **empêche l'entrée** d'une nouvelle pépite mais ne fait jamais
  sortir une pépite publiée. Repli : remettre `PEPITE_RULE_V2_ENABLED` à `false` et redéployer, ou l'arrêt
  d'urgence (`docs/runbooks/pepites-arret-urgence.md`).

## Retour à la normale

- Le dernier passage de `sale-flood-risk` est en `success`, avec `observed` supérieur à 0.
- La part de `last_failure` baisse d'une passe à l'autre et le nombre d'« inconnus par panne » tend vers 0
  (requête ci-dessus).
- `cron.stale` se ferme seule, environ deux heures après le premier succès.
