# Supervision indépendante (`/api/health` et sonde externe)

Mis à jour le 20 octobre 2026.

## Pourquoi

Toutes les alertes de l'application sont évaluées par une seule chaîne : Supabase `pg_cron`
(toutes les 15 min) appelle `/api/cron/operational-health` sur Vercel, qui évalue les alertes en base
et les transmet à GitHub Actions (`operational-alert.yml`). Si un maillon de cette chaîne s'arrête
(site tombé, `pg_cron` désactivé, secret Vault perdu, GitHub qui ne planifie plus), personne n'est
averti : il n'y a plus de signal du tout, pas même une alerte ouverte. Le test de fumée
(`production-smoke.yml`, toutes les 30 min) vit lui aussi sur GitHub.

Il faut donc un regard extérieur à cette chaîne : un service gratuit qui appelle `/api/health` et
écrit au propriétaire quand la réponse change.

## La route `GET /api/health`

Publique, sans détail sensible, jamais mise en cache (`cache-control: no-store`). Elle dit seulement
deux choses :

- l'âge du dernier succès de `operational-health` (la tâche qui évalue toutes les alertes) ;
- l'âge de la dernière collecte réussie (la plus récente `last_publication_complete_at` des sources).

Exemple de réponse :

```json
{
  "status": "ok",
  "checkedAt": "2026-10-20T12:00:00.000Z",
  "operationalHealth": { "ageMinutes": 7, "maxMinutes": 45, "ok": true },
  "collection": { "ageHours": 5.2, "maxHours": 18, "ok": true }
}
```

| Cas                                                                                  | Statut HTTP                       | `status`   |
| ------------------------------------------------------------------------------------ | --------------------------------- | ---------- |
| `operational-health` a réussi il y a 45 min ou moins ET collecte réussie il y a 18 h | 200                               | `ok`       |
| dernier succès de `operational-health` de plus de 45 min (ou jamais)                 | 503                               | `degraded` |
| dernière collecte réussie de plus de 18 h (ou jamais)                                | 503                               | `degraded` |
| base de données injoignable                                                          | 503                               | `degraded` |
| site ou route injoignable                                                            | pas de réponse, 5xx (côté Vercel) |            |

Le détail d'une erreur reste dans les journaux Vercel (`scope: "api.health"`), jamais dans la
réponse.

Les seuils sont dans `src/lib/health-status.ts` (45 min, 18 h). Ils suivent ceux de `cron.stale`
(`operational-health` : 45 min) et de `pipeline.source.<source>.missed` (18 h).

## Poser la sonde (une fois, par le propriétaire)

Exemple avec UptimeRobot (offre gratuite) ; tout service équivalent convient (Better Stack, Uptime
Kuma hébergé ailleurs, Healthchecks.io avec un script externe…). L'important : un service qui ne
dépend ni de Vercel, ni de Supabase, ni de GitHub.

1. Créer un compte sur https://uptimerobot.com et, dans « Integrations & alerts », vérifier que
   l'adresse e-mail du propriétaire est un contact d'alerte (ajouter un second canal, par exemple
   l'application mobile ou Telegram, si possible : un e-mail seul se perd).
2. « Add New Monitor », type **HTTP(s)** (ou « Keyword »).
   - URL : `https://immojudis.com/api/health`.
   - Intervalle : 5 minutes (le minimum de l'offre gratuite).
   - Pour le type Keyword : mot-clé `"status":"ok"`, alerte quand il est **absent** (sensible à la
     casse). Avec le type HTTP(s) simple, l'alerte se déclenche sur le 503.
   - Délai maximal : 30 secondes. Contacts d'alerte : ceux de l'étape 1.
3. Régler « alerte après 2 échecs consécutifs » (si l'option existe) : un passage tardif de
   `operational-health` d'un quart d'heure ne doit réveiller personne, mais 45 minutes sans succès
   oui. La route elle-même ne devient `degraded` qu'au-delà de 45 minutes.
4. Vérifier : couper le monitor 1 minute et le relancer, ou appeler l'URL à la main
   (`curl -si https://immojudis.com/api/health`) et lire `status`.

Aucun secret n'est nécessaire : la route est publique et ne donne que des âges.

## Test de fumée (`scripts/check-production-smoke.mjs`)

Le test de fumée GitHub exige aussi `/api/health` :

- `status: "ok"` (200) : réussi ;
- `operational-health` plus ancien que 45 min mais pas plus de **60 min**, collecte fraîche : toléré
  (un tick de 15 min en retard ne doit pas faire échouer le test, qui passe toutes les 30 min) ;
- tout autre état dégradé (plus de 60 min, collecte de plus de 18 h, base injoignable, route absente
  ou répondant 404) : échec.

Le même test vérifie `/tribunaux/justice-tj-1-93` (200), l'ancienne adresse `/tribunaux/bobigny`
(un seul 308 vers une adresse `/tribunaux/justice-tj-…`), un tribunal inconnu (404),
`/audiences-a-venir` (la page ne dit pas « momentanément indisponibles ») et, indexation ouverte, au
moins 10 pages `/tribunaux/justice-tj-` dans `/sitemap.xml` (option `--min-tribunal-urls`).

## Que faire quand la sonde alerte

1. Appeler `curl -s https://immojudis.com/api/health` : lire quel âge dépasse son seuil.
2. `operationalHealth.ok = false` : la tâche `operational-health` ne réussit plus. Suivre
   `docs/runbooks/operational-health-arret.md`.
3. `collection.ok = false` : plus de collecte réussie depuis plus de 18 h. Suivre
   `docs/runbooks/pipeline-source-missed.md` (et `pipeline-scheduler-disabled.md` si le pilote est
   coupé).
4. Pas de réponse du tout : état de Vercel (https://www.vercel-status.com) et du déploiement de
   production.
