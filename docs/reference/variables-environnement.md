# Variables d'environnement : référence du lot « pépites, inondation, loyers, essai »

Mise à jour : 2026-10-28. Chaque ligne a été relue dans le code. Pour les variables de déploiement générales
(Supabase, Stripe, Resend, indexation…), voir le tableau de `docs/vercel_setup.md`, `.env.example` et le
README.

## Comment l'application lit sa configuration

Il n'y a pas **un seul** module de lecture. `src/lib/env.ts` (`serverEnv()` côté serveur, `publicEnv()` pour les
variables `NEXT_PUBLIC_*`) est le circuit commun : valeurs nettoyées, une valeur vide vaut « non définie ». Mais
34 fichiers de `src/` (hors tests) lisent encore `process.env` directement, par exemple `alert-matches.ts`,
`fee-regime.server.ts`, `rate-limit.ts`, `mapbox.ts`, `land-risks-provider.ts` et les routes `src/app/api/cron/*`
(`positiveNumberFromEnv` de `src/lib/cron-jobs.ts`). Pour trouver où une variable est lue :
`grep -rn NOM_DE_LA_VARIABLE src scripts services`.

Une variable Vercel ne s'applique qu'à un **nouveau déploiement** (redéploiement), et les variables
`NEXT_PUBLIC_*` sont figées au build.

## Variables serveur du lot

| Variable                           | Lue dans                                                             | Valeur et effet                                                                                                                                                                                                                                                                                                               |
| ---------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PEPITE_RULE_V2_ENABLED`           | `serverEnv` (`pepite-rule-switch.server.ts`)                         | `true` ou `1` : règle `pepite-v2.1` appliquée. Absente ou autre valeur : `pepite-v1.2` (défaut). Redéploiement nécessaire. Procédure : `docs/runbooks/pepite-v2-ouverture.md`.                                                                                                                                                |
| `SALE_FLOOD_RISK_BATCH_LIMIT`      | `serverEnv` (route) ; `process.env` (runner GitHub)                  | Ventes observées par passage du traitement d'inondation. Défaut 150, borné à 1000. Depuis le 27/10/2026, le runner GitHub Actions lit la **variable de dépôt GitHub** du même nom (`vars.SALE_FLOOD_RISK_BATCH_LIMIT`) ; la variable Vercel ne compte qu'en retour arrière (`SALE_FLOOD_RISK_RUNNER=vercel`).                 |
| `SALE_FLOOD_RISK_RUNNER`           | `serverEnv` (`sale-flood-risk-dispatch.server.ts`)                   | `vercel` : la route `/api/cron/sale-flood-risk` fait elle-même les appels à Géorisques (retour arrière). Absente ou autre valeur (défaut) : la route déclenche le workflow GitHub `sale-flood-risk.yml`. Voir `docs/runbooks/georisques-pannes-inondation.md`.                                                                |
| `SALE_PEPITES_BATCH_LIMIT`         | `process.env` (`api/cron/sale-pepites/route.ts`)                     | Ventes (ré)évaluées par passage du calcul des pépites. Défaut 300, borné à 2000.                                                                                                                                                                                                                                              |
| `LISTING_COMPLETENESS_BATCH_LIMIT` | `process.env` (`api/cron/listing-completeness/route.ts`)             | Ventes recalculées par passage de la complétude des annonces. Défaut 300, borné à 2000.                                                                                                                                                                                                                                       |
| `VALUATION_PRECOMPUTE_BATCH_LIMIT` | `process.env` (`api/cron/precompute-valuations/route.ts`)            | Estimations pré-calculées par passage. Défaut 75, borné à 100.                                                                                                                                                                                                                                                                |
| `SMART_ALERT_CRON_SALE_LIMIT`      | `process.env` (`api/cron/smart-alerts/route.ts`, `alert-matches.ts`) | Plafond de ventes chargées par compte à chaque évaluation des alertes. Défaut 6000, maximum 20000. (`SMART_ALERT_CRON_USER_LIMIT` n'existe plus : le lot évalue tous les comptes qui ont une alerte active.)                                                                                                                  |
| `CEILING_FEE_REGIMES_OPEN`         | `process.env` (`fee-regime.server.ts`, `parseOpenFeeRegimes`)        | Absente : tous les régimes de frais définis sont ouverts. Présente, **même vide** : seuls les régimes listés (séparés par des virgules : `tribunal`, `notary_auction`, `notary_online`) sont ouverts, le tribunal toujours. `tribunal` seul ferme les ventes notariales.                                                      |
| `ALERT_RENT_BASIS_SWITCH_AT`       | `process.env` (`alert-matches.ts`, `isRentBasisSilentPass`)          | Date ISO UTC. Pendant 48 h à partir de cette date, les alertes à rendement déjà évaluées avant elle enregistrent leurs nouvelles correspondances sans notification. Absente ou invalide : aucune base silencieuse. À poser lors d'un changement de loyers, à **retirer** ensuite. Voir `docs/runbooks/import-annuel-anil.md`. |
| `GEORISQUES_API_TOKEN`             | `process.env` (`land-risks-provider.ts`, `resolveToken`)             | Facultatif. Présent : le dossier foncier utilise l'API Géorisques v2 (la couche TRI y reste « non vérifiée »). Absent : API v1 sans jeton. Le contrôle d'inondation des pépites appelle toujours l'API v1.                                                                                                                    |
| `RATE_LIMIT_IP_SALT`               | `process.env` (`rate-limit.ts`, `hashClientIp`)                      | Facultatif. Sel de l'empreinte d'adresse IP des limites de débit. Absent ou vide : sel fixe du code (`immojudis-ip-rate-limit`). Le changer remet à zéro les compteurs par adresse.                                                                                                                                           |
| `NEXT_PUBLIC_MAPBOX_STYLE_ID`      | `process.env` (`mapbox.ts`, `getMapboxStylePath`)                    | Facultatif. Repli de `NEXT_PUBLIC_MAPBOX_STYLE`, lu seulement si ce dernier est absent. Défaut `mapbox/streets-v12`. Inliné au build.                                                                                                                                                                                         |

Les mêmes réglages, avec leurs commentaires, sont dans `.env.example`.

## Achat d'une vente à l'unité (lot 3, 15/11/2026)

Aucune n'est requise pour le build (`scripts/lib/launch-config.mjs` n'émet que des avertissements) : sans elles,
l'achat reste fermé et `GET /api/billing/offer` répond `saleUnlock.open: false`. Elles figurent aussi dans `.env.example`. Procédure : `docs/runbooks/ouverture-paiements.md`, § 8.

| Variable                        | Lue dans                                                   | Valeur et effet                                                                                                                                                                                                                                                                                 |
| ------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STRIPE_SALE_UNLOCK_PRICE_ID`   | `serverEnv` (`sale-unlock-checkout-readiness.ts`)          | Price Stripe de l'achat (`price_…`) : paiement unique, 19 € (1 900 centimes), EUR, actif, « inclusive ». Relu chez Stripe avant chaque session ; un Price différent refuse la session. Absent ou mal formé : achat fermé, et le rapprochement quotidien ne contrôle pas les achats.             |
| `STRIPE_SALE_UNLOCK_SALES_OPEN` | `serverEnv` (`sale-unlock-checkout-readiness.ts`)          | Interrupteur, **fermé par défaut** (comme `STRIPE_ANALYSIS_SALES_OPEN` depuis le 16/11/2026) : seule la valeur `true` (casse et espaces indifférents) ouvre l'achat, si le reste des paiements est configuré. Le fermer n'empêche ni le webhook, ni les remboursements, ni l'usage des crédits. |
| `STRIPE_ANALYSIS_PRODUCT_ID`    | `serverEnv` (`billing.ts`, `prepareUnitPurchaseDeduction`) | Facultatif. Produit Stripe de l'offre Analyse (`prod_…`) : le bon de réduction des achats à l'unité déduits du premier mois ne vaut que pour ce produit. Absent : le bon vaut pour la session d'abonnement (qui ne contient que ce produit).                                                    |

L'achat reprend aussi toute la configuration des paiements Analyse (`analysisCheckoutReadiness` : clé, mode de la
clé, webhook, identité légale, emails), sauf `STRIPE_ANALYSIS_SALES_OPEN` : fermer la souscription Analyse ne ferme
pas l'achat à l'unité. Le prix est une constante du code, `SALE_UNLOCK_PRICE_CENTS` (`src/lib/analysis-offer.ts`),
égale à `app_private.sale_unlock_purchase_amount_cents()` en base (vérifié par `billing.sale-unlock.test.ts`).

## Ce qui ressemble à une variable mais n'en est pas

Ces noms circulent dans les comptes-rendus et les commentaires, mais ce sont des **constantes du code** : les
changer demande une pull request, pas une variable Vercel.

| Nom                                              | Où                                  | Valeur et remarque                                                                                                                                                      |
| ------------------------------------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PEPITE_V2_EFFECTIVE_DATE`                       | `src/app/methode-pepites/method.ts` | Date d'entrée en vigueur de la règle `pepite-v2`, en toutes lettres, `null` tant qu'elle n'est pas renseignée. À renseigner par PR à l'ouverture, avec `page.test.tsx`. |
| `PEPITE_EXTREME_START_RATIO_MIN` et `_MAX`       | `src/lib/pepite-policy.ts`          | 0,1 et 1,5. Les changer crée une nouvelle version de règle.                                                                                                             |
| `ANIL_CURRENT_EDITION`                           | `src/lib/rent-source-notice.ts`     | Millésime et date de la carte des loyers citée hors fiche de vente. À mettre à jour à chaque import annuel.                                                             |
| `STRIPE_CHECKOUT_TRIAL_OFFERED`                  | `src/lib/analysis-offer.ts`         | `false` : le checkout n'ajoute aucun essai Stripe. Le remettre à `true` ouvrirait un second essai de 7 jours avec carte.                                                |
| `ANALYSIS_TRIAL_DAYS`                            | `src/lib/analysis-offer.ts`         | 7 : durée de l'essai à l'inscription (la base la porte aussi : `signup_trial_ends_at`).                                                                                 |
| `PUBLIC_PAST_SALE_PAGES_ENABLED` et `_INDEXABLE` | (aucune)                            | N'existent pas : pages non implémentées (voir `docs/vercel_setup.md`).                                                                                                  |

Et une variable de la documentation qui n'est lue par aucun code : `SMART_ALERT_CRON_USER_LIMIT` (retirée de
`.env.example` et de `docs/vercel_setup.md`). Par ailleurs, `METEOSTAT_RAPIDAPI_KEY` figure dans `.env.example`
mais n'est lue nulle part dans `src/`, `services/` ni `scripts/` (vérifié le 28/10/2026) ; non retirée ici,
hors du périmètre validé.
