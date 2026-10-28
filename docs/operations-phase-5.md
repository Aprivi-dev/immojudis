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

| Clé                               | Condition                                                                                                                                                                                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cron.stale`                      | aucun succès récent pour un cron attendu                                                                                                                                                                       |
| `stripe.webhook.unhealthy`        | webhook échoué depuis moins d'une heure ou bloqué plus de 15 min                                                                                                                                               |
| `pipeline.import.unhealthy`       | 3 imports échoués dans l'heure (ou 1 avec une file qui attend), import actif depuis plus de 3 h ou file âgée de plus de 30 min                                                                                 |
| `refresh_queue.stale`             | requête de rafraîchissement en attente depuis plus de 30 min                                                                                                                                                   |
| `dvf.freshness`                   | données absentes, import DVF bloqué, vieux de plus de 220 j ou échec plus récent que le dernier import réussi                                                                                                  |
| `retention.sale.overdue`          | vente échue depuis plus de 2 h non purgée, ou 6 passages de purge avec des ventes restantes (`docs/runbooks/retention-sale-overdue.md`)                                                                        |
| `catalogue.invalidation.backlog`  | boîte d'invalidation du cache public : ligne de plus de 2 h ou plus de 1 000 lignes (`docs/runbooks/catalogue-invalidation-backlog.md`)                                                                        |
| `alerts.delivery.late`            | notification d'alerte en file dont la date prévue a plus de 26 h (`docs/runbooks/alerts-delivery-late.md`)                                                                                                     |
| `flood_risk.observation.degraded` | observation d'inondation : au moins la moitié des appels en échec sur les 3 dernières passes (30 échecs au moins), ou 2 des 3 dernières passes en échec « dégradée » / `source_degraded` ; critique après 12 h |
| `flood_risk.write_blocked`        | écritures d'inondation bloquées par le verrou de publication (`writeBusy` sur 3 passes) ou reliquat qui ne baisse pas sur 6 passes                                                                             |
| `pepites.evaluation.stale`        | mode des pépites autre que « on » depuis plus d'une heure, ou dernière évaluation de plus de 6 h ; critique à 24 h                                                                                             |
| `reference.anil_rents.stale`      | édition ANIL de décembre non chargée au 15 janvier (millésime de l'année précédente) ; critique 60 jours plus tard                                                                                             |

`cron.stale` attend les tâches quotidiennes de Vercel toutes les 27 h (`docs/operations/planification.md`).
L'observateur du pipeline ajoute `pipeline.scheduler.disabled`, `pipeline.inventory.stale`,
`pipeline.source.<source>.publication_stale` et `.stale_listings` (un runbook par alerte dans
`docs/runbooks/`). Pour un regard extérieur à cette chaîne : `docs/operations/supervision-externe.md`.

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
`x-request-id`. Il contrôle aussi `/login` (balise `noindex`), un 404 réel pour une vente inconnue et
les signaux de référencement, selon l'état d'indexation **attendu**, donné par la variable
`SEO_INDEXING_ENABLED` (variable de dépôt GitHub, à garder égale à celle de Vercel ; absente, le
workflow attend un site ouvert ; l'option `--indexing open|closed` la remplace en local) :

- **ouvert** (`true`) : `robots.txt` avec `Sitemap:` et sans `Disallow: /`, `/sitemap.xml` (au
  moins 10 URL) et le premier `sales/sitemap/N.xml` (au moins 100 URL, option `--min-sale-urls`),
  absence d'`X-Robots-Tag` sur `/`, et une fiche prise dans le sitemap (200, canonical égal à son
  adresse, JSON-LD valide avec `RealEstateListing`, pas de `noindex`) ;
- **fermé** (variable absente ou autre valeur) : `X-Robots-Tag: noindex` sur `/` et `robots.txt`
  sans `Sitemap:`.

Exécution locale ou manuelle :

```bash
npm run ops:smoke -- --origin https://immojudis.com
SEO_INDEXING_ENABLED=true npm run ops:smoke -- --origin https://immojudis.com
```

## Politique navigateur

Deux politiques coexistent (plan P4-04) :

- la politique historique (`'unsafe-inline'`), appliquée par `next.config.ts` avec HSTS en production ;
- une CSP stricte à nonce (`src/proxy.ts`, `script-src 'nonce-…' 'strict-dynamic'`, `connect-src` limité au projet
  Supabase, `frame-src` explicite), **non envoyée par défaut**. Elle l'était en
  `Content-Security-Policy-Report-Only` jusqu'au 17/10/2026 : un nonce n'atteint que les pages rendues à la
  demande, et les pages statiques ou en cache (accueil, fiches, `/sales` sans filtre) n'en portent pas. Chaque
  script (26 fichiers `_next/static` et 9 scripts en ligne par page) était donc signalé, jusqu'à 35
  `POST /api/csp-report` par visite sur Safari et Firefox. Mesuré sur Vercel : même `/sales`, rendu à la demande,
  ne portait aucun attribut `nonce` sur ses 34 balises `<script>` (cause non établie, à élucider avant
  d'appliquer la politique). Elle n'est envoyée que dans les deux cas ci-dessous ; les violations arrivent sur
  `POST /api/csp-report` et sont journalisées (`scope: "csp-report"`).

Voie vers une CSP stricte (décision de sécurité distincte, à prendre après élucidation des nonces absents sur
Vercel) :

1. Prévisualiser avec `CSP_NONCE_DYNAMIC=true` : la politique stricte repasse en rapport seul et toutes les
   pages deviennent dynamiques pour recevoir un nonce (coût : plus de cache statique ni CDN, donc plus
   d'ISR, y compris pour `/sales` sans filtre). Vérifier les violations restantes (widget ClimaScore en iframe
   `srcdoc`, lecteur de documents sur des hôtes tiers : les ajouter à `CSP_FRAME_SRC_EXTRA`).
2. Après 7 jours sans violation (à relever dans les logs Vercel), mettre `CSP_REPORT_ONLY=false` : la politique
   stricte est appliquée, la politique historique retirée et le rendu dynamique forcé automatiquement.
3. Alternative qui garde les pages statiques : l'intégrité des sous-ressources de Next.js
   (`experimental.sri`, politique à empreintes au lieu de nonces).

Rollback : remettre `CSP_REPORT_ONLY=true` et retirer `CSP_NONCE_DYNAMIC` (ou le mettre à `false`), puis
redéployer.

## `/sales` sans filtre servi depuis le cache

L'adresse nue `/sales` (aucun paramètre) est servie par une page statique régénérée toutes les 5 minutes
(ISR, `src/app/sales/defaut/page.tsx`) ; `src/proxy.ts` y réécrit la requête, le visiteur et les robots
continuent de voir `/sales`. Toute adresse avec un paramètre (`?page=2`, un filtre, `?utm_source=…`) reste
rendue à la demande par `src/app/sales/page.tsx`, avec ses annonces dans le HTML. Détails et pièges
(`usePathname`) : en-tête de `src/lib/sales-isr.ts`.

À vérifier après un déploiement :

```bash
curl -sI https://immojudis.com/sales          # x-vercel-cache: HIT (ou STALE), cache-control: s-maxage=300
curl -sI "https://immojudis.com/sales?page=2" # cache-control: private, no-cache, no-store (rendu à la demande)
```

- Une annonce publiée apparaît sur `/sales` après 5 à 10 minutes (cache de la première page, puis page
  régénérée).
- Un retrait, une annulation ou une modification disparaît de `/sales` après le même délai de 5 à 10 minutes,
  sauf si le pipeline l'annonce à `POST /api/pipeline/revalidate-sale` (`Authorization: Bearer $CRON_SECRET`,
  corps `{ "saleIds": ["<uuid>", …] }`). Chaque appel, quel que soit le nombre de ventes, expire la fiche de
  chaque vente (`sale-<id>` et `/sales/<id>`), le cache de données du catalogue (étiquette `public-catalogue`)
  et la page statique `/sales/defaut` : la destination de la réécriture, pas `/sales`, car le proxy ne
  s'exécute pas pour une revalidation. Le prochain visiteur déclenche alors une lecture fraîche. Les retraits
  et les annulations doivent donc figurer dans la liste envoyée, au même titre que les ventes publiées ou
  modifiées.
- **Aucun appelant dans ce dépôt.** Ni le pipeline Python (`services/data-pipeline/`) ni un workflow GitHub
  n'appelle encore la route : tant qu'ils ne le font pas, retraits, annulations et modifications attendent la
  fenêtre de 5 à 10 minutes. Câbler l'appel (étape finale du pipeline, avec `CRON_SECRET` et l'adresse du site
  en secrets) reste à faire.
- `/sales/defaut` répond aussi, avec `X-Robots-Tag: noindex, nofollow` : c'est la page interne, jamais liée
  ni dans un plan de site. Sa canonique est `/sales`.
- Tant que la CSP à nonce est servie (`CSP_REPORT_ONLY=false` ou `CSP_NONCE_DYNAMIC=true`), le proxy ne
  réécrit plus : `/sales` est rendu à la demande, comme toutes les pages.
- Retour en arrière : annuler le commit « `/sales` sans filtre servi depuis le cache » (le proxy n'écrit plus,
  `/sales` redevient entièrement dynamique) et redéployer.
- Si la base tombe pendant une régénération, la page statique ne se régénère pas (elle lève l'erreur) :
  Vercel garde la dernière bonne page et retente à la requête suivante, au lieu de garder 5 minutes une page
  sans annonces. Le `next build` reste possible sans base (page produite sans liste).

### Contrôle des en-têtes après déploiement

`/sales` (page statique `/sales/defaut`, réécrite par le proxy) et `/sales?page=2` (rendu à la demande) ne
passent pas par le même chemin de rendu : les en-têtes de sécurité doivent pourtant être identiques. À
comparer après chaque déploiement, et après toute bascule de `CSP_REPORT_ONLY` ou `CSP_NONCE_DYNAMIC`
(qui exige un redéploiement complet) :

```bash
SITE=https://immojudis.com
SECURITY='^(content-security-policy|x-frame-options|permissions-policy|strict-transport-security|referrer-policy|x-content-type-options|cross-origin-opener-policy):'
# Noms en minuscules, fins de ligne retirées : la page en cache et la page rendue à la demande
# n'écrivent pas la casse des noms de la même façon (`content-security-policy` / `Content-Security-Policy`).
normalise() { tr -d '\r' | grep -iE "$SECURITY" | awk '{ i = index($0, ":"); print tolower(substr($0, 1, i - 1)) substr($0, i) }' | sort; }
curl -sI "$SITE/sales"        | normalise > /tmp/sales.headers
curl -sI "$SITE/sales?page=2" | normalise > /tmp/sales-page2.headers
diff /tmp/sales.headers /tmp/sales-page2.headers && echo "en-têtes de sécurité identiques"
wc -l < /tmp/sales.headers   # 7 lignes : CSP (historique), X-Frame-Options, Permissions-Policy, HSTS, Referrer-Policy, X-Content-Type-Options, COOP

# Pas de cookie, cache actif sur /sales (un cookie empêcherait le CDN de le servir)
curl -sI "$SITE/sales" | grep -iE '^(set-cookie|x-vercel-cache|cache-control|age):'
```

Attendu :

- **Aucune différence** entre les deux listes d'en-têtes de sécurité. Les sept doivent être présents :
  `Content-Security-Policy` (la politique historique, tant que la CSP à nonce n'est pas servie), `X-Frame-Options`,
  `Permissions-Policy`, `Strict-Transport-Security`, `Referrer-Policy`, `X-Content-Type-Options` et
  `Cross-Origin-Opener-Policy`. Une différence, ou un en-tête absent de `/sales`, est un défaut du déploiement :
  ne pas ouvrir l'indexation avant de l'avoir compris.
- **`/sales` : pas de `set-cookie`**, `x-vercel-cache: HIT` (ou `STALE`, ou `PRERENDER` juste après un
  déploiement) et `cache-control: public, s-maxage=300` ou équivalent. Répéter l'appel : `x-vercel-cache` doit
  passer à `HIT`. `MISS` à chaque appel, ou un `set-cookie`, signifie que la page n'est pas servie depuis le
  cache.
- `/sales?page=2` : `cache-control: private, no-cache, no-store` et aucun `x-vercel-cache: HIT` (rendu à la
  demande).

Un test unitaire (`src/lib/security-headers.test.ts`) vérifie que la règle d'en-têtes de `next.config.ts`
(`/(.*)`) couvre `/sales/defaut` ; ce contrôle vérifie, lui, ce que le CDN envoie réellement.

## Validation de livraison

- Node `24.15.0` et npm `11.18.0` sont épinglés, conformément au runtime Node 24.x actuellement fourni par Vercel.
- Python est limité à `>=3.12,<3.13` (verrous hachés générés pour CPython 3.12) et testé en 3.12.
- La CI exécute typecheck, lint, tests unitaires et accessibilité, build/budgets, audit npm/pip,
  migrations pgTAP, test de quota concurrent et parcours Playwright inscription-vers-partage.
- Le workflow `production-smoke.yml` surveille le déploiement indépendamment du scheduler interne.
