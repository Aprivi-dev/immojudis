# Exploitation applicative — phase 5

La supervision des données, les SLO, les alertes externes et les runbooks sont détaillés dans
[`operations-phase-3.md`](operations-phase-3.md).

## Corrélation des requêtes

Toutes les requêtes applicatives reçoivent un `x-request-id`. Un identifiant entrant n'est conservé
que s'il respecte le format sûr défini dans `src/lib/request-id.ts`. Les routes API critiques et les
crons écrivent des lignes JSON contenant au minimum `scope`, `requestId`, `timestamp`, `status` et
`durationMs`.

Les erreurs API exposent un code stable (`AUTH_REQUIRED`, `FORBIDDEN`, `INVALID_REQUEST`,
`RATE_LIMITED`, `CONFIGURATION_ERROR` ou `INTERNAL_ERROR`) et ne renvoient pas le message interne
pour les erreurs serveur.

Les parcours commerciaux critiques couverts sont le webhook Stripe, le checkout, le portail de
facturation, la création/liste des rapports, les exports, le feed API et les demandes de refresh.
Les succès comme les erreurs sont journalisés une seule fois avec leur durée et leur statut HTTP.

## Santé opérationnelle

Supabase Cron appelle `/api/cron/operational-health` toutes les 15 minutes et Vercel conserve un
passage quotidien de secours compatible Hobby. L'accès exige `CRON_SECRET`.
La fonction `public.evaluate_operational_health` est exécutable uniquement par `service_role` et
maintient des alertes dédupliquées dans `public.operational_alerts`.

| Clé                         | Condition                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `cron.stale`                | aucun succès récent pour un cron attendu                                                                      |
| `stripe.webhook.unhealthy`  | webhook échoué depuis moins d'une heure ou bloqué plus de 15 min                                              |
| `pipeline.import.unhealthy` | import échoué, actif depuis plus de 3 h ou file âgée de plus de 30 min                                        |
| `refresh_queue.stale`       | requête de rafraîchissement en attente depuis plus de 30 min                                                  |
| `dvf.freshness`             | données absentes, import DVF bloqué, vieux de plus de 220 j ou échec plus récent que le dernier import réussi |

Une file âgée de plus de deux heures ou un import bloqué produit une sévérité `critical`. Pour
inspecter l'état courant avec un rôle opérateur :

```sql
select alert_key, category, severity, status, details, first_seen_at, last_seen_at
from public.operational_alerts
order by status, severity, last_seen_at desc;
```

Le panneau `/admin` calcule aussi le SLO du contrôle de santé sur une fenêtre glissante de 30 jours
(`success / (success + failed)`) et affiche la mesure à côté de la cible de 99,5 %. Les exécutions
encore `running` ne sont pas comptées dans le dénominateur.

## Télémétrie et disponibilité publique

`@vercel/analytics` et `@vercel/speed-insights` sont chargés dans le layout racine afin de suivre
les visites et les Web Vitals réels sans bloquer le rendu. Les Runtime Logs Vercel restent la source
primaire pour corréler une erreur serveur à son `x-request-id`.

Le workflow GitHub **Production smoke** appelle toutes les 30 minutes cinq surfaces publiques :
accueil, liste des ventes, annonce exemple, mentions légales et annuaire d'avocats. Il vérifie le
statut HTTP, le type de contenu, le contrat JSON, les URL canoniques et la conservation du
`x-request-id`. Exécution locale ou manuelle :

```bash
npm run ops:smoke -- --origin https://immojudis.com
```

## Politique navigateur

La CSP est appliquée par défaut avec HSTS en production. Elle inclut `frame-ancestors 'none'`,
`object-src 'none'`, `nosniff`, une politique de référent strict et une Permissions Policy
restrictive. Utiliser `CSP_REPORT_ONLY=true` uniquement pendant un diagnostic temporaire de
déploiement.

## Validation de livraison

- Node `24.15.0` et npm `11.18.0` sont épinglés, conformément au runtime Node 24.x actuellement fourni par Vercel.
- Python est limité à `>=3.11,<3.13` et testé en 3.11/3.12.
- La CI exécute typecheck, lint, tests unitaires et accessibilité, build/budgets, audit npm/pip,
  migrations pgTAP, test de quota concurrent et parcours Playwright inscription-vers-partage.
- Le workflow `production-smoke.yml` surveille le déploiement indépendamment du scheduler interne.
