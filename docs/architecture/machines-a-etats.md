# Machines à états d'Immojudis

Mise à jour : 2026-11-11. Ce document dit **où vit chaque cycle de vie** de l'application (un
parcours d'écran, une demande, un abonnement, une tâche du pipeline), s'il est écrit à un seul
endroit ou éparpillé, et comment en écrire un nouveau.

À lire avant de toucher à un statut, à un `useState` qui dit « où on en est », ou à un
`update({ status: … })`. Le test `src/lib/state-machine.registry.test.ts` échoue si une machine
`*-machine.ts` n'est pas listée ici, n'a pas de test, ou si un fichier cité ici n'existe plus.

## 1. Pourquoi, et quand

Une **machine à états implicite**, c'est un cycle de vie que le code tient sans le nommer :

- plusieurs `useState` qui, ensemble, disent l'étape (`loading` + `error` + `data`), et qui
  laissent écrire des combinaisons impossibles ;
- un statut en base modifié par des `update` dispersés, sans liste des passages permis ;
- un « état courant » recalculé à plusieurs endroits à partir des mêmes colonnes, par des copies
  qui finissent par diverger.

Ce que cela coûte, vu dans ce dépôt : un « localisation en cours » qui ne s'arrête jamais, un
message d'erreur par-dessus une carte qui fonctionne, un bouton figé sur « Vérification… », une
mission bloquée en `sending`.

On écrit une machine explicite **quand au moins une de ces conditions est vraie** :

1. deux valeurs d'état ou plus doivent toujours changer ensemble ;
2. une réponse tardive (réseau, tâche) peut arriver dans un état qui ne l'attend plus ;
3. certains passages sont interdits (un état final ne se rouvre pas) ;
4. la même dérivation d'état existe déjà ailleurs.

Un simple booléen `open`, ou un `busy` posé et retiré dans un `try / finally`, n'a pas besoin de
machine.

## 2. La convention

### Côté TypeScript : `defineMachine`

`src/lib/state-machine.ts` fournit `defineMachine(initial, table)`, sans dépendance :

```ts
type State = { status: "idle" } | { status: "loading" } | { status: "ready"; data: Report };
type Event = { type: "STARTED" } | { type: "LOADED"; data: Report } | { type: "CLOSED" };

export const reportMachine = defineMachine<State, Event>(
  { status: "idle" },
  {
    idle: { STARTED: () => ({ status: "loading" }) },
    loading: {
      LOADED: (_state, event) => ({ status: "ready", data: event.data }),
      CLOSED: () => ({ status: "idle" }),
    },
    ready: { CLOSED: () => ({ status: "idle" }) },
  },
);
```

Les règles :

- **Un état, une variante.** Les données d'un état vivent dans sa variante (`ready` porte `data`).
  Une donnée qui n'a de sens que dans un état ne peut alors pas exister dans un autre.
- **Un événement non listé est ignoré** : `transition` rend l'état reçu, tel quel. C'est ce qui
  rend les états impossibles impossibles (une erreur après `ready`, la réponse d'une demande
  abandonnée).
- **La table nomme tous les états** : le typage refuse un état oublié.
- **Un fichier `*-machine.ts`** à côté de ce qu'il pilote, pur (ni React, ni réseau), avec son test
  `*-machine.test.ts` qui joue des suites d'événements, et une ligne dans la section 3.
- **Dans un composant** : `const [state, dispatch] = useReducer(machine.transition, machine.initial)`.
  Ce qu'affiche l'écran se lit dans `state` (`state.status === "located" ? state.point : null`),
  jamais dans un second `useState` tenu en parallèle. Si la lecture passe par une fonction qui
  rend un objet, appelez-la dans un `useMemo` : sinon la règle
  `react-hooks/preserve-manual-memoization` du compilateur React signale une erreur ailleurs dans
  le composant.
- **Le poids compte.** `/sales` n'a presque aucune marge sous son budget JavaScript
  (`scripts/check-build-budgets.mjs`) : mesurez avec `npm run build` puis `npm run build:budgets`
  avant de pousser un changement sur cette page. `defineMachine` ne rend que `initial`, `table` et
  `transition` pour cette raison ; `acceptedEvents(machine, status)` sert aux tests.
- **Côté serveur** : la table TypeScript dit ce qui est permis, mais c'est l'écriture qui protège.
  Une transition se fait par une mise à jour conditionnelle (`.eq("status", étatAttendu)` ou
  `.in("status", étatsPermis)`), et un résultat vide se traite comme « quelqu'un est passé avant ».

Pas de bibliothèque (XState ou autre) : les parcours du site tiennent en une table, et une
dépendance de plus pèserait sur le navigateur et sur les prochaines sessions d'agents.

### Côté base : la convention existe déjà

Le modèle à copier est `ingestion_jobs` dans
`supabase/migrations/20260730141957_outcome_source_ingestion.sql` :

- un `CHECK` pour le vocabulaire, et des `CHECK` de forme (les colonnes de bail ne sont remplies
  que dans l'état `leased`, la date de fin correspond à l'état final) ;
- un déclencheur de garde qui porte la table des passages permis, l'immuabilité des états finaux
  et le compteur de tentatives ;
- des fonctions `SECURITY DEFINER` qui font un « comparer puis écrire » sur le statut et le jeton
  de bail ;
- un test pgTAP par passage interdit (`supabase/tests/110_outcome_source_ingestion.sql`).

Variantes du même esprit : approbation d'un modèle
(`supabase/migrations/20260801133817_outcome_evaluation_gate.sql`), lignes successives au lieu
d'une mise à jour (`supabase/migrations/20260731154054_judilibre_match_review_guard.sql`), rang
monotone des statuts d'email (`supabase/migrations/20261110210000_email_send_log.sql`), bail avec
jeton (`supabase/migrations/20261108110000_cron_lease.sql`).

Toute nouvelle garde en base passe par une migration relue (voir `supabase/README.md`) : aucun
agent n'écrit dans la base de production.

## 3. Machines explicites

### Écrites avec `defineMachine`

| Machine                               | Fichier                                    | Branchée dans                            | Ce que la table garantit                                                                                                                                                |
| ------------------------------------- | ------------------------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adresse d'une recherche « autour de » | `src/lib/search/around-address-machine.ts` | `src/components/search/SearchPage.tsx`   | Le centre appartient à son adresse : effacer ou changer l'adresse retire le centre et arrête « localisation en cours » ; la réponse d'une ancienne adresse est ignorée. |
| Aperçu Mapbox d'une annonce           | `src/lib/mapbox-preview-machine.ts`        | `src/components/MapboxPreviewButton.tsx` | Une erreur Mapbox après l'affichage ne recouvre plus la carte ; un résultat arrivé après la fermeture est ignoré.                                                       |

### Déjà explicites sous une autre forme (à garder comme modèles)

| Machine                                                                           | Où                                                                   | Forme                                                                          |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Offre Analyse lue par la page                                                     | `src/hooks/use-billing-offer.ts`                                     | Union `loading / error / ready` : une erreur ne se lit jamais comme « fermé ». |
| Porte de double authentification admin                                            | `src/components/admin/AdminMfaGate.tsx`                              | Union `checking / challenge / open`.                                           |
| Consentement Google Analytics                                                     | `src/lib/google-analytics-state.ts`                                  | État dérivé d'un magasin unique.                                               |
| Badge « Pépite »                                                                  | `src/hooks/use-sale-pepite.ts`                                       | Statut dérivé une seule fois de deux lectures.                                 |
| Stabilité d'une pépite                                                            | `src/lib/pepite-policy.ts`                                           | Fonction de transition pure (`applyPepiteStability`).                          |
| Demande d'ouverture de l'offre                                                    | `src/lib/offer-opening-notification.ts`                              | Constructeur de modification pur (`buildOfferOpeningPatch`).                   |
| Tâches d'ingestion, versions de modèle, rapprochements Judilibre, faits d'annonce | migrations citées en 2                                               | Déclencheurs de garde et fonctions en base.                                    |
| Journal d'envoi des emails                                                        | `supabase/migrations/20261110210000_email_send_log.sql`              | Rang monotone.                                                                 |
| Notifications d'alerte                                                            | `src/lib/alert-notifications.ts`, `src/lib/email-alerts.ts`          | Toutes les écritures filtrent `delivery_status = queued`.                      |
| Mode du pilote automatique de l'agent                                             | `supabase/migrations/20261110230000_information_agent_autopilot.sql` | Passages par une seule fonction en base.                                       |

## 4. Inventaire des machines implicites

Relevé du 2026-11-11, par lecture du code. Chaque ligne dit ce qui a été **lu**, pas ce qui a été
reproduit en production : vérifiez dans le fichier avant d'agir. « Corrigé » renvoie à la
session du 2026-11-11 (`docs/equipe/2026-11-11-machines-a-etats.md`).

### 4.1 Interface (composants et crochets)

| Parcours                                                                         | Où                                                                                                                                                                    | Constat                                                                                                                                                                                        | État                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adresse « autour de » sur `/sales`                                               | `src/components/search/SearchPage.tsx`                                                                                                                                | `center` et `geocoding` séparés : « localisation en cours » sans fin, centre de l'ancienne adresse.                                                                                            | **Corrigé** (machine).                                                                                                                                                                                                                                                                                         |
| Aperçu Mapbox                                                                    | `src/components/MapboxPreviewButton.tsx`                                                                                                                              | Erreur après chargement affichée par-dessus la carte.                                                                                                                                          | **Corrigé** (machine).                                                                                                                                                                                                                                                                                         |
| Création d'une alerte                                                            | `src/hooks/use-create-alert.ts`                                                                                                                                       | Lecture des droits en échec lue comme « en cours » : refus sans fin.                                                                                                                           | **Corrigé** (relecture à la demande). Restent : aucune garde contre un double appel (seuls les boutons des appelants sont désactivés) ; la zone surveillée est créée avant l'alerte et reste si l'alerte échoue ; l'export CSV de `src/components/search/SearchPage.tsx` a le même défaut de lecture en échec. |
| Code de double authentification                                                  | `src/components/admin/AdminMfaGate.tsx`                                                                                                                               | Bouton figé si l'appel lève.                                                                                                                                                                   | **Corrigé**.                                                                                                                                                                                                                                                                                                   |
| Enrôlement de la double authentification                                         | `src/components/admin/AdminSecurityPage.tsx`                                                                                                                          | « Chargement… » sans fin si la lecture lève ; boutons figés.                                                                                                                                   | **Corrigé** (état « lecture impossible » avec « Réessayer »).                                                                                                                                                                                                                                                  |
| Connexion / inscription                                                          | `src/app/login/login-page.tsx`                                                                                                                                        | 17 `useState` ; l'erreur d'un mode suivait dans l'autre.                                                                                                                                       | **Corrigé** pour l'erreur. Le panneau « confirmez votre adresse » survit encore à un retour arrière du navigateur.                                                                                                                                                                                             |
| « Me prévenir de l'ouverture »                                                   | `src/components/OfferOpeningRequest.tsx`                                                                                                                              | La demande du compte précédent restait affichée après déconnexion.                                                                                                                             | **Corrigé**. `null` veut encore dire à la fois « pas lu » et « lecture en échec ».                                                                                                                                                                                                                             |
| Dépôt d'un contributeur                                                          | `src/components/information-agent/InformationAgentContributionForm.tsx`                                                                                               | 20 `useState` ; deux façons de dire « envoyé » (`state: "sent"` et `submitted`) ; lien refusé à l'envoi sans consigne.                                                                         | **Corrigé** pour la consigne. La double représentation reste.                                                                                                                                                                                                                                                  |
| Offre ouverte ou non                                                             | `src/hooks/use-analysis-checkout-open.ts`, `src/lib/search/analysis-offer-open.ts`, `src/hooks/use-billing-offer.ts`                                                  | Trois lectures, deux sens : les deux premières lisent une erreur réseau comme « fermé » (choix écrit dans le code), la troisième non. Une panne passagère affiche donc « pas encore ouverte ». | À trancher (5.6).                                                                                                                                                                                                                                                                                              |
| Droits du compte                                                                 | `src/hooks/use-access-plan.ts`, `src/hooks/use-has-analysis-access.ts` et une dizaine de composants                                                                   | Même lecture, traitements différents de l'inconnu et de l'erreur selon l'écran.                                                                                                                | À regrouper.                                                                                                                                                                                                                                                                                                   |
| Abonnement et retour de paiement                                                 | `src/components/BillingActions.tsx`                                                                                                                                   | Lecture du forfait répartie sur 5 `useState` ; « actif » dérivé deux fois. Aucun défaut vu, très testé.                                                                                        | À laisser tant qu'on n'y touche pas.                                                                                                                                                                                                                                                                           |
| Mot de passe oublié                                                              | `src/components/PasswordRecovery.tsx`                                                                                                                                 | 6 booléens pour 6 étapes ; l'ordre du rendu masque les combinaisons impossibles.                                                                                                               | Candidat simple à une union.                                                                                                                                                                                                                                                                                   |
| Favori                                                                           | `src/components/FavoriteButton.tsx`, `src/components/search/SearchResults.tsx`                                                                                        | Même enchaînement écrit deux fois.                                                                                                                                                             | À réunir dans un crochet.                                                                                                                                                                                                                                                                                      |
| Espace de pilotage professionnel                                                 | `src/components/ProfessionalPilotWorkspace.tsx`                                                                                                                       | Synchronisation locale / compte par drapeaux ; conflit reconnu au texte du message d'erreur.                                                                                                   | À reprendre (code d'erreur plutôt que texte).                                                                                                                                                                                                                                                                  |
| Rapport PLU et risques                                                           | `src/components/sale-detail/LandPotentialPanel.tsx`                                                                                                                   | Une seule case d'erreur pour la lecture et l'export.                                                                                                                                           | Mineur.                                                                                                                                                                                                                                                                                                        |
| Vue aérienne 360°                                                                | `src/components/sale-detail/AerialOrbitHero.tsx`                                                                                                                      | Statut + 9 drapeaux ; rotation bien dérivée.                                                                                                                                                   | À laisser (22 tests, aucun défaut vu).                                                                                                                                                                                                                                                                         |
| Session                                                                          | `src/hooks/use-auth.ts`                                                                                                                                               | 6 `useState` voulus (mode dégradé).                                                                                                                                                            | À laisser (partagé par toutes les pages).                                                                                                                                                                                                                                                                      |
| Carte du catalogue                                                               | `src/components/search/MapPanel.tsx`                                                                                                                                  | `mapReady` et `mapError` indépendants. L'écran n'affiche qu'un message fixe : pas d'effet visible.                                                                                             | À laisser.                                                                                                                                                                                                                                                                                                     |
| Déblocage d'une vente, retour d'action, mesure d'audience, formulaire de contact | `src/components/sale-detail/SaleUnlockPanel.tsx`, `src/components/SaleSignalFeedback.tsx`, `src/components/AudienceMeasurement.tsx`, `src/components/ContactForm.tsx` | Un seul écrivain ou état déjà explicite.                                                                                                                                                       | Rien à faire.                                                                                                                                                                                                                                                                                                  |

### 4.2 Comptes, accès et paiement

| Cycle de vie                                       | Où                                                                                                                            | Constat                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Abonnement Analyse (`user_subscriptions.status`)   | `src/lib/plans.ts`, `src/lib/billing.ts`, `src/lib/admin-subscriptions.ts`, `src/lib/contract-withdrawal.ts`                  | 6 statuts, plus trois pseudo-états sans nom (réservation de paiement, prolongation d'essai, ancien achat unique). Les passages par Stripe sont gardés en base ; les écritures d'administration et de rétractation ne le sont pas. « Abonnement vivant » existe sous le même nom avec deux règles (`src/lib/plans.ts`, `src/lib/admin-signups.ts`). Voir 5.1 et 5.2. |
| Paiement Stripe (`stripe_payment_lifecycle.state`) | `src/lib/billing.ts`                                                                                                          | Gardé en base. Le type TypeScript oublie l'état `paid`.                                                                                                                                                                                                                                                                                                             |
| Journal des webhooks Stripe                        | `src/lib/billing.ts`                                                                                                          | La fonction de fin n'a pas de garde sur l'état de départ ; `ignored` est final.                                                                                                                                                                                                                                                                                     |
| Essai gratuit et offre de lancement                | `src/lib/launch-offer.ts`, `src/lib/launch-offer.server.ts`, `src/lib/entitlements.server.ts`, `src/lib/admin-signups.ts`     | Pas de colonne : l'état se lit dans cinq drapeaux optionnels. « Prolongation d'essai » a trois définitions, dont une plus stricte.                                                                                                                                                                                                                                  |
| Demande de droits (`data_subject_requests.status`) | `src/lib/privacy-requests.ts`, `src/lib/privacy-deadline.ts`, `src/lib/contract-withdrawal.ts`                                | La mise à jour d'administration accepte tout passage, y compris rouvrir une demande close. Voir 5.5.                                                                                                                                                                                                                                                                |
| Clés d'API                                         | `src/lib/api-keys.ts`                                                                                                         | Pas de statut : `revoked_at` et `expires_at`. Une clé expirée non révoquée compte encore dans le quota de 2 clés.                                                                                                                                                                                                                                                   |
| Mise en avant d'un avocat                          | `src/lib/lawyer-directory.ts`, `src/lib/admin-lawyer-referrals.ts`, `src/lib/featured-lawyers.ts`, `src/lib/admin-pepites.ts` | « Mise en avant active » calculée à cinq endroits.                                                                                                                                                                                                                                                                                                                  |
| Statut professionnel                               | `src/lib/account.ts`                                                                                                          | `pending` n'a aucune sortie dans le code (changement manuel en base).                                                                                                                                                                                                                                                                                               |

### 4.3 Demandes et dossiers

| Cycle de vie                                                        | Où                                                                                                                                                                                      | Constat                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dossier de l'agent d'information (`information_agent_cases.status`) | `src/lib/information-agent/send.ts`, `src/lib/information-agent-inbound/case-updates.ts`, `src/lib/information-agent/manual-reply.ts`, `src/lib/information-agent-contribution.ts`      | 7 statuts, aucun type TypeScript. `completed` n'a pas d'écrivain : `review` n'a donc pas de sortie. Les écritures `sent` / `failed` après envoi ne vérifient pas le statut courant. L'ensemble « dossier ouvert » est recopié à une dizaine d'endroits (constante dans `src/lib/information-agent-inbound/types.ts`). |
| Mission de l'agent (`information_agent_missions.status`)            | `src/lib/information-agent/send.ts`, `src/lib/information-agent/mission-store.ts`, `src/lib/information-agent/draft.ts`                                                                 | 9 statuts ; `approved` et `completed` sans écrivain. **`sending` n'a pas de sortie** si le traitement s'arrête entre l'approbation et l'envoi. L'annulation lit puis écrit sans condition. Voir 5.3.                                                                                                                  |
| Traitement des réponses reçues                                      | `src/lib/information-agent-inbound/job-queue.ts`, `src/lib/information-agent-inbound/processing-state.ts`, `src/lib/information-agent-inbound.ts`                                       | Bail avec jeton, sain. Le budget de 10 tentatives est écrit à trois endroits ; deux calendriers de reprise différents.                                                                                                                                                                                                |
| Demande de publication                                              | `src/lib/admin-publication-requests.ts`, `src/lib/publication-requests-client.ts`, `src/app/admin/publications/admin-publications-page.tsx`, `src/components/PublicationStatusPill.tsx` | 3 statuts déclarés à cinq endroits. La mise à jour n'a pas de garde : `rejected → approved` est possible, et un refus peut croiser une approbation.                                                                                                                                                                   |
| Mise en relation avec un avocat                                     | `src/lib/lawyer-referrals.ts`, `src/lib/admin-lawyer-referrals.ts`                                                                                                                      | 6 statuts, tout passage permis côté administration : repasser de `closed` à `sent_to_lawyer` renvoie un email. `matching_status` peut contredire l'avocat désigné.                                                                                                                                                    |
| Suivi d'une vente (dossier favori)                                  | `src/lib/sale-workspaces.ts`, `src/lib/favorite-dossier.ts`, `src/lib/sale-change-monitor.ts`, `src/lib/audience-tracking.ts`                                                           | Deux colonnes pour un même statut (`personal_status`, `tracking_status`) ; une seule est mise à jour, l'autre est encore lue.                                                                                                                                                                                         |
| Partage d'un rapport                                                | `src/lib/property-reports.ts`                                                                                                                                                           | La vue du propriétaire et la vue publique ne calculent pas « partagé » de la même façon.                                                                                                                                                                                                                              |
| Rappels, résumé hebdomadaire, résultats de vente                    | `src/lib/sale-reminders-store.ts`, `src/lib/sale-results-store.ts`, `src/lib/weekly-digest-store.ts`                                                                                    | La prise en charge est gardée en base ; les écritures « envoyé » / « échec » filtrent sur l'identifiant seul.                                                                                                                                                                                                         |

### 4.4 Ventes

| Cycle de vie                                         | Où                                                                                                                                                            | Constat                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Statut d'une vente (`auction_sales.status`)          | `src/lib/sale-window.ts`, `src/lib/listing-evidence.ts`, `src/lib/sale-description.ts`, `src/lib/alert-matches.ts`, `services/data-pipeline/src/normalize.py` | 8 valeurs permises par la base (`supabase/migrations/20260912113935_pipeline_queue_lifecycle.sql`), typé `string` en TypeScript. Des valeurs hors liste sont testées dans le code (`active`, `canceled`, `sold`). L'ensemble « vente en cours » a au moins huit copies qui ne contiennent pas les mêmes valeurs. Aucune garde de passage. |
| Statut affiché sur les pages département et tribunal | `src/lib/department-pages.server.ts`, `src/lib/tribunal-pages.server.ts`                                                                                      | Deux dérivations qui ne traitent pas `unknown` de la même façon.                                                                                                                                                                                                                                                                          |
| Vérification d'une vente                             | `src/lib/sale-procedure.ts`, `src/lib/listing-completeness.ts`                                                                                                | Déclarée trois fois ; valeur de repli différente (`pending` contre `null`) ; « confirmée » recopié une vingtaine de fois.                                                                                                                                                                                                                 |

### 4.5 Pipeline de données et tâches

| Cycle de vie                                                                  | Où                                                                                                                                                                                   | Constat                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exécution du pipeline (`auction_runs.status`)                                 | `services/data-pipeline/src/storage/supabase_client.py`, `services/data-pipeline/src/autonomous_runner.py`, `services/data-pipeline/src/run_finalizer.py`, `src/lib/admin.server.ts` | Aucune contrainte en base, `string` en TypeScript. Deux écritures Python filtrent sur l'identifiant seul : une exécution déjà marquée en échec peut repasser à `running`, puis à `succeeded`. Voir 5.4. |
| Tâches d'enrichissement (`auction_enrichment_jobs.status`)                    | `services/data-pipeline/src/queue_job_state.py`, `services/data-pipeline/src/queued_runner.py`, `services/data-pipeline/src/document_backlog.py`, `src/lib/admin-source-refresh.ts`  | Une dizaine de sites d'écriture sans fonction centrale ; « terminé » et « épuisé » définis de trois façons.                                                                                             |
| Demande de rafraîchissement (`data_refresh_requests.status`)                  | `services/data-pipeline/src/storage/supabase_client.py`, `src/lib/data-refresh.ts`                                                                                                   | `running` n'expire jamais. La prise en charge Python traite une course perdue comme gagnée. Voir 5.4.                                                                                                   |
| Décision par annonce collectée                                                | `services/data-pipeline/src/collection_evidence.py`                                                                                                                                  | Deux gardes différentes pour la même colonne.                                                                                                                                                           |
| État d'une source (disjoncteur)                                               | `services/data-pipeline/src/autonomous_runner.py`, `src/lib/pipeline-status.ts`                                                                                                      | Réparti sur trois colonnes, sans table.                                                                                                                                                                 |
| Photos et pièces                                                              | `services/data-pipeline/src/photo_mirror.py`, `services/data-pipeline/src/pdf_photos.py`, `services/data-pipeline/src/document_reading.py`                                           | Passages écrits dans le texte SQL ; l'enregistrement d'un scan de pièce écrase tout statut, celui d'une photo non.                                                                                      |
| Réservation d'un appel LLM                                                    | `services/data-pipeline/src/enrichment/llm_client.py`                                                                                                                                | La fonction de clôture n'a pas de garde sur l'état de départ.                                                                                                                                           |
| Collecteur Licitor                                                            | `services/data-pipeline/src/sources/licitor_cloud_store.py`                                                                                                                          | Aucun code ne fait sortir une exécution de `paused`.                                                                                                                                                    |
| Alertes opérationnelles, tâches surveillées, extraction des pièces de l'agent | `src/lib/monitored-job.server.ts`, `services/data-pipeline/src/information_agent_evidence.py`                                                                                        | Des états « en cours » sans reprise au délai (détail dans le compte-rendu).                                                                                                                             |

## 5. Points à trancher par le propriétaire

Ces constats touchent l'argent, des données personnelles ou la base : ils n'ont **pas** été
modifiés. Chacun demande une décision, puis une migration ou un changement relu.

1. **Ancien paiement unique.** `src/lib/billing.ts` n'accepte que 59 € pour ce chemin ; la fonction
   en base (`supabase/migrations/20260727180623_phase_2_security_boundaries.sql`) n'accepte que
   29 €. Le chemin ne peut donc pas aboutir, et un test fige la valeur côté TypeScript. À
   supprimer ou à réaligner avant l'ouverture des paiements.
2. **Remboursements et litiges rattachés au compte, pas à l'abonnement.** Le remboursement d'une
   ancienne facture résilie l'abonnement courant ; un litige sur un ancien paiement met en pause
   un nouvel abonnement.
3. **Mission bloquée en `sending`.** Elle est comptée par la supervision, jamais réparée : il faut
   une reprise au délai.
4. **Pipeline.** Écritures sans condition sur `auction_runs`, course perdue traitée comme gagnée
   sur `data_refresh_requests`, `running` sans expiration.
5. **Demandes de droits.** Faut-il pouvoir rouvrir une demande close, et faire redescendre une
   identité « vérifiée » ?
6. **Offre « fermée » en cas de panne réseau.** Garder la prudence actuelle (ne rien promettre) ou
   afficher un état « indisponible » distinct de « pas encore ouverte ».
7. **Passages d'administration libres** (publication, mise en relation avocat) : quels retours en
   arrière sont voulus ?

## 6. Pour les agents

- Avant de modifier un cycle de vie, cherchez-le ici, puis lisez sa table ou ses écrivains.
- Un nouveau cycle de vie côté interface : un fichier `*-machine.ts`, son test, une ligne en 3.
- Un nouveau statut en base : `CHECK`, garde, fonction, test pgTAP, comme en 2.
- Ne « corrigez » pas un point de la section 5 sans décision écrite du propriétaire.
- Un constat de la section 4 se vérifie dans le code avant d'être cité : c'est un relevé daté.
