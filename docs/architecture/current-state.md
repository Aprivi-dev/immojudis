# Outcome Graph — état actuel

_Audit du dépôt au 30 juillet 2026. Ce document décrit le socle existant avant la généralisation d’Outcome Graph. Le statut exact de la tranche verticale livrée dans le worktree est suivi dans [`IMPLEMENTATION_STATUS.md`](../../IMPLEMENTATION_STATUS.md)._

## Synthèse

ImmoJudis est déjà une application web Next.js reliée à Supabase et à un pipeline Python de collecte et d’enrichissement. Le dépôt possède une authentification Supabase, une offre premium « Analyse » intégrée à Stripe, des politiques RLS, un modèle de ventes judiciaires, des comparables DVF et un registre de modèles de valorisation.

Le modèle historique reste toutefois centré sur une ligne mutable par annonce dans `auction_sales`. Une date, un statut et un prix d’adjudication y représentent toute la trajectoire. Il ne permet pas encore, à lui seul, de représenter sans ambiguïté plusieurs lots, reports, audiences de surenchère, versions de résultat, preuves, snapshots pré-audience et prédictions. Les capacités existantes de valorisation, de suivi d’audience ou d’historique d’annonce ne doivent donc pas être comptées comme un Outcome Graph complet.

## Organisation du dépôt et outillage

### Application web

- Le dépôt racine est un projet **npm**, pas encore un workspace `pnpm`. `package.json` déclare `npm@11.18.0`, Node `>=24.15.0 <25` et un `package-lock.json` commis.
- Le runtime web est **Next.js 16 App Router**, React 19 et TypeScript en mode `strict`.
- Les pages dans `src/app` délèguent encore souvent leur rendu à des composants historiques dans `src/routes`. Les API serveur résident dans `src/app/api` et la logique métier dans `src/lib`.
- Tailwind CSS 4, TanStack Query et les composants Radix constituent le socle UI.
- La production web est préparée pour Vercel. Les en-têtes de sécurité et l’observabilité Vercel sont configurés dans l’application.

### Pipeline de données

- `services/data-pipeline` est un service Python séparé, mais pas encore un package de monorepo orchestré depuis la racine.
- Son installation actuelle utilise **pip** et des fichiers `requirements*.txt`, pas encore `uv`. `pyproject.toml` borne Python à `>=3.11,<3.13`; la CI teste Python 3.11 et 3.12.
- Le pipeline utilise notamment Pydantic, psycopg, le client Supabase, httpx, pytest et Ruff. Les dépendances de valorisation et Docling sont optionnelles.
- Le worker est lancé par GitHub Actions, sur planification ou à la demande. Ce n’est pas encore le conteneur long-running et la file générique `FOR UPDATE SKIP LOCKED` demandés par la cible.
- La CI sépare les jobs web npm, pipeline pip, migrations/pgTAP et E2E Playwright.
- `supabase/migrations` est l’autorité de schéma. `services/data-pipeline/sql/schema.sql` est explicitement réservé aux bases locales jetables et ne doit pas être appliqué à une base hébergée.

Cette architecture npm/pip est opérationnelle. La recommandation `pnpm`/`uv` du cahier des charges constitue une migration d’outillage distincte : elle ne doit pas être simulée dans la documentation ni mélangée à une migration de données sans validation complète de la CI.

## Composants en place

| Composant | État actuel | Point d’intégration Outcome Graph |
|---|---|---|
| Authentification | Supabase Auth, jeton Bearer côté API | Réutiliser `requireSupabaseAuthContext` sur chaque route protégée |
| Abonnements | Stripe Checkout/Portal/Webhook et `user_subscriptions` | Réutiliser le résolveur d’accès Analyse, sans nouveau système de paiement |
| Base | PostgreSQL Supabase, PostGIS, migrations versionnées et RLS | Ajouter le registre de façon additive dans la même source de vérité |
| Stockage | Bucket privé `listing-request-documents` pour les dépôts professionnels | Créer un bucket privé séparé pour les preuves Outcome Graph |
| Lecture produit | Vues Supabase et API Next sur `auction_sales` | Conserver un pont explicite de l’annonce existante vers lot/audience |
| Collecte | Pipeline Python multi-source, normalisation, déduplication, PDF/LLM | Produire des artefacts et événements versionnés au lieu d’écraser l’historique |
| Marché | DVF, cadastre, DPE, valorisation et modèles versionnés | Réutiliser les sorties datées dans les snapshots, sans les confondre avec une preuve de résultat |
| Exploitation | GitHub Actions, tables de runs/alertes, Vercel Analytics | Ajouter métriques de couverture, revue, snapshots et scoring |

## Schéma actuel pertinent

Le schéma complet est construit par les migrations `supabase/migrations`. Les groupes suivants sont les points d’ancrage utiles à Outcome Graph.

### Annonces et actifs

| Table ou vue | Rôle actuel | Limite pour Outcome Graph |
|---|---|---|
| `tribunals` | Référentiel de tribunaux par code texte | La cible demande un référentiel `courts` UUID plus riche et agrégé |
| `auction_sales` | Ligne canonique mutable par `source_url`; bien, audience et résultat aplatis; statut limité à `upcoming`, `past`, `adjudicated`, `unknown` | Une seule trajectoire; pas de dossier/lot/round; état `unknown` trop large |
| `properties` | Projection normalisée du bien, reliée un-à-un par `source_url` | Cascade depuis `auction_sales`; pas un lot judiciaire multi-biens indépendant |
| `judicial_sales` | Projection normalisée de la vente judiciaire | Cascade depuis `auction_sales`; une date, un statut et un prix; pas d’historique de rounds |
| `auction_observations` | Dernière observation brute par `source_url` | Upsert mutable et réécriture de `observed_at`, pas un journal append-only |
| `auction_documents` | Métadonnées et extraction des documents d’annonce | Ligne mutable; fichiers gardés dans le cache/disque du worker, pas dans un coffre de preuves objet durable |
| `auction_extractions` | Résultat d’extraction versionné par provider/hash | N’exprime pas le rapprochement dossier/lot/audience ni une revue indépendante |
| `auction_sale_history` | Ancienne et nouvelle ligne JSON lors d’un changement | Journalise les updates significatifs, pas les inserts/deletes; sans FK et sans immutabilité stricte |
| `v_auction_sales_app`, `v_auction_sales_discovery` | Modèles de lecture complet et découverte | Les contrats de lecture restent centrés sur `auction_sales.id` |

### Enrichissement et valorisation

- `dvf_import_batches`, `dvf_transactions` et `dvf_market_statistics` fournissent les comparables de marché.
- `auction_cadastre_parcels`, `auction_dpe_diagnostics` et `auction_urban_planning_signals` enrichissent les annonces.
- `valuation_model_versions`, `valuation_estimates` et `auction_sale_market_estimates` versionnent l’estimation de marché. Ils peuvent alimenter un snapshot, mais ne remplacent ni `model_versions` ni `auction_predictions` d’Outcome Graph.
- `auction_features`, `auction_surfaces`, `auction_risks`, `auction_risk_occurrences`, `auction_score_factors` et `auction_scoring_versions` portent l’analyse d’investissement actuelle. Leur score n’est pas l’indice de pression concurrentielle spécifié.

### Comptes et offre premium

- `user_profiles.account_tier` vaut `free` ou `premium`; `user_role` vaut actuellement `user` ou `admin`.
- `user_subscriptions` conserve l’offre, le statut et la période d’accès Stripe.
- `stripe_webhook_events`, `stripe_checkout_access_grants` et `stripe_payment_lifecycle` rendent les paiements idempotents et réconciliables.
- Les tables de rapports, favoris, alertes, espaces de travail, exports et quotas constituent des précédents de RLS et de contrôle d’usage, sans constituer le registre Outcome Graph.

## Flux de données actuel

### Collecte

```text
sources web codées dans le worker et activées par environnement
→ collecte HTTP/PDF
→ normalisation Pydantic
→ déduplication multi-source
→ enrichissements géographiques, documentaires et de marché
→ upsert mutable de auction_sales
→ synchronisation de properties, judicial_sales et tables d’enrichissement
→ vues de lecture Supabase
→ API et UI Next.js
```

L’écriture principale utilise PostgreSQL direct quand `SUPABASE_DB_URL` est présent, puis PostgREST avec la clé `service_role` pour les projections; un repli entièrement PostgREST existe. Cette voie privilégiée contourne la RLS par conception et doit rester réservée aux workers de confiance.

Les connecteurs appliquent déjà des contrôles d’origine, de redirection et de `robots.txt`. Leur activation reste cependant pilotée par le code et l’environnement : aucune table suivie ne matérialise encore la décision juridique `allowed_automated`, `allowed_manual`, `partner_only`, `disabled` ou `prohibited`.

### Expiration

Le pipeline marque puis supprime aujourd’hui des ventes expirées et plusieurs dépendances. C’est acceptable pour un catalogue mutable, mais incompatible avec un registre historique d’entraînement. Les tables Outcome Graph ne doivent pas être placées sous une cascade depuis `auction_sales` et ne doivent jamais rejoindre la liste de nettoyage des annonces.

### Lecture web

Le navigateur obtient une session Supabase puis transmet un jeton Bearer aux routes Next. Le serveur valide l’utilisateur, charge son profil et utilise soit un client Supabase lié au jeton, soit le client serveur `service_role` après un contrôle explicite. L’UI de la fiche vente reste adressée par `auction_sales.id`; le futur registre doit donc conserver un lien stable vers cet identifiant pendant la migration.

## Intégration premium existante

Outcome Graph doit s’intégrer à l’offre **Analyse** existante, sans introduire un second mécanisme d’abonnement.

Le calcul canonique de l’accès premium est :

```text
administrateur
OU user_profiles.account_tier = premium
OU user_subscriptions.plan_code = analyse
   ET status dans {trialing, active}
   ET période non expirée
```

Les points d’intégration sont :

1. ajouter une clé de fonctionnalité Outcome Graph à `src/lib/plans.ts`, verrouillée pour Découverte et incluse pour Analyse;
2. l’exposer dans le DTO construit par `src/lib/property-report/entitlements.ts`;
3. authentifier puis appeler `assertFeatureEntitlement` dans chaque API Outcome Graph;
4. protéger toute lecture directe par une RLS basée sur `public.has_analysis_access()`;
5. traiter le composant client de verrouillage comme une indication visuelle, jamais comme une frontière de sécurité.

Une vérification directe de `account_tier` serait incorrecte : elle refuserait les clients Stripe actifs. De même, `AuthGate` protège surtout l’authentification et les rôles de navigation; il n’autorise pas à lui seul une donnée premium.

## Écarts et risques

| Priorité | Écart | Conséquence | Mesure attendue |
|---|---|---|---|
| Bloquant | Pas de dossier → lot → audience | Reports, surenchères et multi-lots ambigus | Introduire des entités UUID et un pont depuis `auction_sales` |
| Bloquant | Écritures et nettoyages mutables | Perte de l’historique et fuite temporelle possible | Isoler un registre append-only avec versions et événements compensatoires |
| Bloquant | Absence et résultat négatif aplatis | `unknown` peut être interprété à tort | Enums et contraintes distincts; aucun défaut implicite négatif |
| Bloquant | Pas de snapshots pré-audience | Impossible d’auditer une prédiction sans fuite | Manifestes, cutoff, versions et tests anti-fuite |
| Élevé | Pas de registre de politiques source | Un connecteur existant n’est pas une autorisation juridique | `data_sources.ingestion_policy`; refus par défaut |
| Élevé | Rôles limités à `user/admin` | Pas d’isolation cabinet/reviewer/analyste | Organisations, memberships et RLS dédiées |
| Élevé | Documents sans chaîne de claims/revues | Prix ou finalité insuffisamment justifiables | Preuves A/B/C, revues append-only et conflits bloquants |
| Élevé | `Decimal` du pipeline historique sérialisé en `float` | Risque d’arrondi pour les montants legacy | Conserver les contrats Outcome Graph en centimes entiers sûrs |
| Élevé | Types Supabase générés en décalage possible | Contournements par casts et erreurs de contrat | Régénérer après chaque migration Outcome Graph |
| Moyen | Worker GitHub Actions non long-running | Latence, reprises et verrous limités | Introduire progressivement `ingestion_jobs` et un worker durable |
| Moyen | npm/pip diffèrent de pnpm/uv cible | Commandes du cahier des charges non disponibles | Migration d’outillage dédiée, avec lockfiles et CI verte |
| Moyen | Bucket de preuve dédié absent | Accès documentaire trop large ou mal attribué | Bucket privé, chemins UUID et URL signées courtes |

## Plan de migration sans rupture

1. **Fondation additive.** Créer les référentiels et tables cœur Outcome Graph sans modifier les contrats existants de `auction_sales`.
2. **Pont legacy.** Relier explicitement une annonce existante à son dossier, lot et round initial. Ce lien ne doit pas placer l’historique sous `ON DELETE CASCADE` depuis l’annonce.
3. **Backfill prudent.** Transformer les lignes existantes en candidats non vérifiés. Une donnée absente reste `unknown`; aucun report, no-bid ou absence de surenchère n’est inféré.
4. **Double écriture contrôlée.** Continuer à alimenter le catalogue existant tout en ajoutant artefacts, événements et versions dans le registre. Mesurer la parité plutôt que basculer immédiatement les lectures.
5. **Revue et preuves.** Ajouter le workflow humain et ne rendre une ligne éligible à l’entraînement qu’après les contrôles A/B requis.
6. **Snapshots puis analytics.** Construire les horizons pré-audience et les statistiques descriptives avant tout modèle avancé.
7. **Restitution premium.** Exposer uniquement des projections validées via une API authentifiée, avec refus explicite si l’échantillon ou la qualité est insuffisant.
8. **Dépréciation différée.** Ne retirer les champs historiques aplatis qu’après parité mesurée, restauration testée et absence de consommateurs résiduels.

Le rollback de la première étape consiste à désactiver la fonctionnalité et les nouvelles routes; il ne doit jamais supprimer les événements, preuves, snapshots ou prédictions déjà écrits.
