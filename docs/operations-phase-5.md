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

Supabase Cron appelle `/api/cron/operational-health` toutes les 15 minutes. Le traitement des
réponses de l'agent utilise un autre job Supabase toutes les deux minutes. Les deux routes exigent
`CRON_SECRET`.
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

Deux politiques coexistent (plan P4-04) :

- la politique historique (`'unsafe-inline'`), appliquée par `next.config.ts` avec HSTS en production ;
- une CSP stricte à nonce (`src/proxy.ts`, `script-src 'nonce-…' 'strict-dynamic'`, `connect-src` limité au projet
  Supabase, `frame-src` explicite), envoyée en `Content-Security-Policy-Report-Only` tant que
  `CSP_REPORT_ONLY` n'est pas `false` (défaut : rapport seul). Les violations arrivent sur
  `POST /api/csp-report` et sont journalisées (`scope: "csp-report"`).

Passage à l'application, à faire après 7 jours sans violation (à relever dans les logs Vercel) :

1. Prévisualiser avec `CSP_NONCE_DYNAMIC=true` : toutes les pages deviennent dynamiques pour recevoir un
   nonce (coût : plus de cache statique ni CDN). Vérifier les violations restantes (widget ClimaScore en
   iframe `srcdoc`, lecteur de documents sur des hôtes tiers : les ajouter à `CSP_FRAME_SRC_EXTRA`).
2. Mettre `CSP_REPORT_ONLY=false` : la politique stricte est appliquée, la politique historique retirée et
   le rendu dynamique forcé automatiquement.

Rollback : remettre `CSP_REPORT_ONLY=true` (ou retirer la variable) et redéployer.

## Validation de livraison

- Node `24.15.0` et npm `11.18.0` sont épinglés, conformément au runtime Node 24.x actuellement fourni par Vercel.
- Python est limité à `>=3.11,<3.13` et testé en 3.11/3.12.
- La CI exécute typecheck, lint, tests unitaires et accessibilité, build/budgets, audit npm/pip,
  migrations pgTAP, test de quota concurrent et parcours Playwright inscription-vers-partage.
- Le workflow `production-smoke.yml` surveille le déploiement indépendamment du scheduler interne.
