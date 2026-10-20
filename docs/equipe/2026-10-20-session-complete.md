# Session complète de l'équipe : état des lieux après la PR #275 (20/10/2026)

Date : 20/10/2026. Chef d'orchestre : `/equipe`.

**Mission.** « Lancer une nouvelle session de travail avec toute l'équipe » : faire auditer Immojudis après
l'exécution du 19/10. La PR #275 a codé les 74 points du 18/10, sauf le juridique : 138 commits, 679 fichiers et
28 migrations `20261028*`. Le but est de dresser la liste de ce qui reste avant l'ouverture au public. Périmètre
principal : `git diff 7db69b3..HEAD` (`main` à `814e690`).

**Agents lancés (18).**

- Équipe principale (11) : `code-reviewer`, `data-pipeline`, `qualite-donnees`, `ux-designer`, `seo-expert`,
  `juridique-rgpd`, `testeur-qa`, `product-explorer`, `veille-concurrentielle`, `performance-web`, `redacteur-contenu`
  (propositions seulement).
- Renforts, utilisés pour la première fois (7) : `securite-applicative`, `expert-postgres`, `audit-code-ia`,
  `protection-donnees-code`, `statisticien`, `fiabilite-sre`, `audit-accessibilite`.

Le `developpeur` n'intervient qu'après validation.

**Statut.** Aucun fichier de code ni de contenu n'a été modifié. `git status` est propre en fin de session.

**Effets de bord signalés.**

- **Environnement.** Le dépôt exige Node 24.15 et npm 11.18 (`engine-strict`), alors que la machine démarre en Node 22.
  Le chef a pris le Node 24.15 de `/opt/nvm`, mis npm à jour en 11.21 dans ce Node, puis lancé un seul `npm ci` pour
  toute l'équipe : aucune collision cette fois.
- **`qualite-donnees`.** Des SELECT entre 09:37 et 09:50 UTC. **Une requête `create temp view x as select 1; select 1`
  est passée** : la vue était temporaire, donc rien de durable. Le garde-fou
  `.claude/hooks/supabase-lecture-seule.mjs` bloque bien cette requête quand le chef le lance à la main. C'est son
  branchement dans l'en-tête de l'agent qui n'a pas joué dans cette session (point 52).
- **`performance-web`.** Un `npm run build` dans le dépôt, un second build de `c1fb7b7` dans le dossier temporaire, et
  des serveurs locaux sur les ports 3200 et 3201, arrêtés depuis.
- **`testeur-qa`.** Il a travaillé sur une copie du dépôt dans le dossier temporaire (port 3100, arrêté).
- **Requêtes externes.** GET publics vers immojudis.com, les sites sources et les concurrents. `seo-expert` a lu les
  en-têtes HTTP via un service tiers (hackertarget), avec des URL publiques seulement.

## Synthèse

La PR #275 a tenu l'essentiel de ce qu'elle promettait :

- les 28 migrations sont appliquées en production et les tâches planifiées n'ont pas échoué depuis 3 jours ;
- toutes les suites sont vertes ;
- le JavaScript initial des pages publiques baisse partout ;
- l'échéance du 22/10 (tests du pipeline datés) est réglée.

Ce qui reste avant l'ouverture au public :

1. **Deux défauts graves introduits par la PR.**
   - Un index unique de la table de mesure par compte peut **bloquer la purge des ventes**. Deux événements du même
     type, le même jour et sur deux ventes, entrent en collision à la suppression de la seconde.
   - **`/audiences-a-venir` est en panne en production.** La fonction SQL met 20 s, alors que la limite est de 3 s pour
     un visiteur. Elle renvoie en plus aux visiteurs anonymes les adresses des annonces d'origine.
2. **Les données visibles n'ont presque pas bougé depuis le 18/10.**
   - 809 lignes en double et 0 fusion : le balayage n'a jamais été lancé.
   - Les réparations et la purge des noms n'ont pas été lancées.
   - Licitor est en échec depuis le 19/10 (budget d'exécution dépassé).
3. **La bande « écart au marché » dit plus que ce qu'elle mesure.**
   - 65 % des ventes sont « pas assez fiable ».
   - 86 % des biens occupés tombent mécaniquement en « nettement sous la valeur de marché ».
   - Le libellé « proche » couvre une fourchette qui va jusqu'à ±50 %.
4. **L'offre de lancement a ouvert de nouvelles portes.**
   - Exports et plusieurs fonctions coûteuses n'ont aucun plafond quotidien, alors qu'ils sont ouverts à tout compte
     confirmé.
   - La politique de confidentialité affirme « sans identifiant de personne » alors que la mesure par compte est en
     production.
   - Les CGV prévoient 30 jours de préavis et ne disent rien de l'offre.
   - La fiche publique ne mentionne pas l'offre, et les cartes la répètent 24 fois.
5. **Les rappels d'audience ne sont pas prêts à être activés.** Le suivi ne voit pas les ventes retirées, annulées ou
   adjugées, alors que le consentement promet de les signaler. Il n'y a aucune garde de fraîcheur. Les emails partent
   sans vérifier que l'adresse est confirmée.
6. **Des défauts visibles par tous.**
   - Le numéro de la page courante de `/sales` est invisible (blanc sur blanc).
   - `/sales` déborde à 320 px.
   - Retirer un favori efface « Mon dossier », et « Annuler » ne le restaure pas.

### Vérifications

| Vérification                                    | Résultat                                                                                                     | Par                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------- |
| `npx tsc --noEmit`                              | OK                                                                                                           | code-reviewer, QA, audit IA |
| `npm run lint`                                  | OK, aucun avertissement                                                                                      | code-reviewer               |
| `npm test` (Vitest), machine au calme           | 6 422 OK, 8 ignorés, 0 échec (615 fichiers, 248 s)                                                           | chef, 10:20 UTC             |
| `npm run test:security-invariants`              | OK (30 contrôles, dont `launch-offer-switch-and-access-functions`)                                           | chef, sécurité              |
| Pipeline `ruff` + `pytest`                      | OK, 4 501 tests, 154 ignorés (PostgreSQL) ; horloge à +3, +45 et +60 j : OK ; à +400 j : 9 échecs (n° 17)    | data-pipeline               |
| Playwright du dépôt (desktop et mobile)         | 155 OK, 9 ignorés volontairement, 0 échec                                                                    | testeur-qa                  |
| `npm run build` + `build:budgets`               | OK ; JS total à 99,0 % du plafond ; plus gros chunk (`mapbox-gl`) à 99,72 %                                  | performance-web             |
| Axe en production (10 pages, desktop et mobile) | 0 violation sur la fiche, les pages tribunal, les audiences, `/login` et la méthode ; défauts aux n° 3 et 44 | audit-accessibilite         |

Sous charge, deux tests Vitest ont dépassé leur délai dans la copie de QA (`SearchPage.account.test.tsx`). Le
pipeline a un test de durée fragile (n° 17). Ce sont des tests fragiles, pas des régressions.

### Production au 20/10 (contrôles du chef, de `qualite-donnees` et de `fiabilite-sre`)

| Mesure                                         | 18/10                          | 20/10                                                                                                |
| ---------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Migrations `20261028*`                         | à appliquer                    | **28 sur 28 appliquées**                                                                             |
| Ventes à venir visibles                        | 1 646                          | 1 651                                                                                                |
| Doublons (commune, jour, prix)                 | 819 lignes                     | **809 lignes** ; 341 paires au même n° d'annonce Vench / PA ; 0 fusion                               |
| Ventes absentes de leur source encore visibles | 22                             | 1 (24 retirées automatiquement)                                                                      |
| Surfaces étrangères (Enchères Immobilières)    | 12                             | 0                                                                                                    |
| Ventes judiciaires sans tribunal               | 71                             | 14                                                                                                   |
| Noms de particuliers certains                  | 2                              | 1, plus des contacts nominatifs d'études notariales sur environ 7 fiches                             |
| Point GPS fantôme                              | 1                              | 1 (`8ff95700`)                                                                                       |
| Réparations et purge des noms                  | non lancées                    | **non lancées**                                                                                      |
| Licitor                                        | OK                             | **8 runs en échec depuis le 19/10**, dernier inventaire complet 19/10 09:23                          |
| Enchères Immobilières, publication complète    | 08/10                          | 08/10                                                                                                |
| Tâches planifiées (3 jours)                    | -                              | 0 échec                                                                                              |
| Alertes ouvertes                               | -                              | 5, dont `cron.stale` ouverte depuis le 15/07 (3 082 occurrences) et `licitor.missed` depuis le 16/09 |
| Comptes                                        | -                              | 5 (1 non confirmé)                                                                                   |
| `/audiences-a-venir`                           | -                              | « Audiences momentanément indisponibles » (STALE)                                                    |
| `www`                                          | 307                            | 307                                                                                                  |
| `robots.txt`                                   | `Allow: /`                     | `Allow: /`, 3 sitemaps (181 + environ 1 400 URL)                                                     |
| `/legal`                                       | « pas encore toutes publiées » | inchangé                                                                                             |
| `/api/health`                                  | -                              | 404                                                                                                  |

Échantillon de 10 fiches tirées au hasard : mise à prix, date et tribunal exacts à 9 sur 9 (une source illisible).
Les défauts portent sur la surface, le type de bien et le sens de « mise à prix » chez les notaires.

Complétude des fiches visibles :

- surface manquante : 46 % (PA 88 %) ;
- coordonnées manquantes : 17 % (Vench 223, sans aucun essai de géocodage) ;
- occupation inconnue : 56 %.

Bandes d'écart au marché en production :

- 1 001 ventes en « pas assez fiable » (65 %), 243 sans bande (16 %), 198 « sous » (13 %), 100 « proche » (6,5 %),
  5 « au-dessus » ;
- côté tribunal, la mise à prix médiane d'une bande « sous » vaut 45 % de la valeur estimée ;
- biens occupés : 86 % en « sous » ; biens libres : 44 %.

### Ce qui est vérifié et sain (ne pas reproposer)

- **Liens d'email suivis.** Pas de redirection ouverte : jeton HMAC comparé à temps constant, destination reconstruite
  côté serveur.
- **Événements par compte.** RLS sans politique, `service_role` seul, liste fermée d'événements.
- **`/admin/pilotage` et interrupteur de l'offre.** Accès administrateur, avec MFA si elle est activée.
- **« Mon dossier » et instantanés.** Les droits sont accordés colonne par colonne.
- **Migrations.** Fonctions `security definer` avec `search_path` vide, 28 migrations atomiques et idempotentes, un
  test pgTAP par migration.
- **Droit Analyse / offre de lancement.** La même règle (interrupteur, profil, email confirmé) est appliquée en SQL et en
  TypeScript, sauf le suivi des changements (n° 21).
- **Fusion des doublons.** Le report des données est correct : favoris, notes, rapports et alertes suivent la fiche
  conservée. Il manque seulement le journal des rappels (n° 10).
- **Retrait des ventes absentes.** Le compteur n'avance que sur un run réussi.
- **Invalidation du cache.** Contrat respecté entre le pipeline et la route.
- **Pages `/tribunaux/<code>`.** Redirections 308 en une étape, 404 sur un code inconnu, `noindex` pour un tribunal sans
  vente, 0 octet de JavaScript propre à la page.
- **Vitesse.** Le JavaScript initial baisse sur toutes les pages publiques (`/tribunaux` −260 Ko), et Sonner n'est plus
  chargé au premier rendu.
- **Export `.ics`.** Conforme à l'octet.
- **Accessibilité.** Rien ne repose sur la couleur seule (bandes, pastille). Les pages tribunal et audiences ont 0
  violation Axe.
- **Pipeline.** Échéance du 22/10 réglée. Décodage pymupdf corrigé. Garde des surfaces répétées en place.

## Conflits entre agents et arbitrages

- **Libellé « proche » de la bande.** L'UX propose de resserrer « proche » à ±15 %. Le statisticien propose de
  plafonner la largeur de la fourchette et d'exiger plus de comparables.
  - Arbitrage : une seule refonte (n° 19), sur les mesures de `qualite-donnees` ; la proposition de l'UX est absorbée.
- **`LaunchOfferNote` rendu côté serveur (`performance-web` n° 12).** Il supprimerait le décalage de mise en page, mais
  une coupure de l'offre pourrait mettre jusqu'à 90 s à se voir, au-delà des 60 s voulues par le propriétaire.
  - Arbitrage : écarté. On garde la réservation d'espace (n° 25).
- **Sonder le prix via la liste d'attente (veille n° 1).** L'enquête pose déjà deux questions de prix
  (`survey_price_*`). Le statisticien rappelle qu'une liste d'attente auto-sélectionnée ne mesure pas une intention
  d'achat.
  - Arbitrage : écarté ; les deux avis vont dans les questions au propriétaire.
- **Cron `sale-change-monitor` en échec (`expert-postgres` n° 2).** Hypothèse démentie par la production : les 28
  migrations sont appliquées et le cron réussit chaque jour.
- **Job de valorisations désactivé (`fiabilite-sre` n° 7).** `precompute-valuations` tourne toutes les 15 min en
  production (09:45 UTC). Constat écarté.
- **Gravité de l'index unique de mesure.** Le `code-reviewer` juge que rien n'est critique ; il n'a pas vu ce point,
  relevé par `protection-donnees-code` et vérifié par le chef dans la migration.
  - Arbitrage : Critique (n° 1).
- **Ce qui relève du juridique.** Le 19/10, le propriétaire a exclu les points juridiques. Ceux d'aujourd'hui sont isolés
  en partie I : ils portent sur des textes devenus faux depuis la PR #275 (mesure par compte, offre de lancement), et
  pas seulement sur des choix de prudence.

## Tableau des propositions

Légende : priorité Critique / Haute / Moyenne / Basse ; effort S (moins d'une demi-journée), M (environ un jour),
L (plus). « Nouveau » = introduit ou révélé par la PR #275 ; « ouvert » = déjà au rapport du 18/10.

### A. Urgent : production

| N°  | Agents                                      | Proposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Priorité | Effort | Avis du chef               |
| --- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------ | -------------------------- |
| 1   | protection-données, SRE, postgres           | **Purge des ventes bloquée par la mesure** : l'index `account_product_events_once_per_day_idx` utilise `coalesce(sale_id, 0…)` et la FK est `on delete set null` (`20261028180000:30,54-61`). Deux événements du même jour sur deux ventes entrent en collision à la seconde suppression, et le lot de 25 de `purge_expired_auction_sales` échoue en entier. Correction : deux index partiels, plus un test pgTAP à deux ventes. Dans la même migration : capture d'instantané en sous-bloc `exception` (`20261028190100`), purge `busy` signalée et alerte `retention.sale.overdue` | Critique | S      | garder (vérifié)           |
| 2   | données, SEO, UX, QA, sécurité, postgres    | **`/audiences-a-venir` en panne** : `get_public_upcoming_hearings` met 20 s sur 30 jours (4,4 s sur 7), au-delà des 3 s de `anon`. Elle appelle `get_public_sale_calendar_event` ligne par ligne et `limit 1000` tronque 14 audiences sur 1 014. Correction : préfiltre sur des colonnes légères ou table précalculée ; lecture par le serveur (`service_role`), avec retrait d'`anon`, ce qui ferme aussi la fuite de `source_url` et `source_urls` (`20261028160100:35,60-61`) ; clé de fusion en SHA-256 ; ajout au test de fumée de production                                   | Critique | M      | garder (vérifié par curl)  |
| 3   | accessibilité                               | **Pagination de `/sales`** : la page courante est blanche sur blanc (`SearchPagination.tsx:5,239` : `bg-white` l'emporte sur `bg-brand-navy`). `aria-label` interdit sur un `span`. Débordement à 320 px causé par le tri (`SearchHeader.tsx:444-466`, `shrink-0`)                                                                                                                                                                                                                                                                                                                   | Haute    | S      | garder (vu sur la capture) |
| 4   | sécurité, code                              | **Opérations sans plafond quotidien, ouvertes à tout compte confirmé** : export CSV (500 lignes, avec adresse) et flux (`sale-exports.ts`), demandes d'avocat (10 par heure seulement), création de clés d'API, routes `/api/v1/*` sans limite de débit qui passent par `supabaseAdmin`. Ajouter ces opérations à `DAILY_OPERATION_LIMITS` (compte, adresse, global) ; plafond de lignes exportées par jour ; `enforceUserRateLimit` sur la v1                                                                                                                                       | Haute    | M      | garder (vérifié)           |
| 5   | UX                                          | **Retirer un favori efface « Mon dossier »** : `removeFavoriteSale` supprime la ligne qui porte le statut et le plafond (`favorites.ts:150`). « Annuler » recrée une ligne vide. Dialogue si le dossier n'est pas vide, ou restauration réelle à l'annulation                                                                                                                                                                                                                                                                                                                        | Haute    | S à M  | garder (vérifié)           |
| 6   | données, protection-données, postgres, code | **Rétention incomplète** : les ventes `quarantined` (28 échues, dont 7 depuis plus de 30 jours) et `past` (179) n'ont pas de `retention_deadline` et ne sont jamais purgées. `purge_sale_reminder_dispatches` n'est jamais appelée en mode `off` : la mettre dans `run_data_retention`. `ERASURE_TABLES` (`privacy-requests.ts:252`) ne cite ni `account_product_events` ni `sale_reminder_dispatches`. Remplacer le champ `error` libre du journal par un code court                                                                                                                | Haute    | S à M  | garder                     |

### B. Données et pipeline

| N°  | Agents                                | Proposition                                                                                                                                                                                                                                                                                                                                                                       | Priorité | Effort | Avis du chef    |
| --- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | --------------- |
| 7   | données, QA, UX                       | **Doublons** : 809 lignes en trop. Code : fusionner les lots multiples et les groupes de plus de 5 sur l'identifiant d'annonce commun (Malaucène : 7 lots × 2 sources) ; dédoublonner la liste et le compteur des pages tribunal comme `dedupeHearings` (Bobigny : 11 lignes sur 30). Le lancement du balayage revient au propriétaire, après le n° 8                             | Critique | M      | garder (ouvert) |
| 8   | data-pipeline                         | **Garde-fous de fusion avant d'activer `DEDUPE_RECONCILE_ENABLED`** : le chemin `src.main` (`main.py:1034-1037`) supprime et réconcilie sans vérifier que le déclencheur de report est présent et sans plafond de 100. Le déclencheur `carry_sale_user_data` ne transfère pas `sale_reminder_dispatches`, ce qui renverrait des rappels déjà envoyés                              | Haute    | S      | garder          |
| 9   | données                               | **Licitor** : 8 runs en échec « Execution budget exceeded » depuis le 19/10, inventaire de 10 fiches sur 438, alerte critique ouverte depuis le 16/09. Découper l'inventaire ou relever le budget                                                                                                                                                                                 | Haute    | M      | garder          |
| 10  | pipeline, données, protection-données | **Filtre des noms** : formes non retirées (« occupé par Pierre Martin », « héritiers de », « M. et Mme DUPONT », « l'associé de Madame NOM »). Le TypeScript filtre moins de champs que Python. Le PDF et les rapports enregistrés ne sont pas refiltrés à la lecture. Les instantanés copient `title` non filtré et `postal_code` inutile. Texte tronqué (« poursuivant'AIGLE ») | Haute    | M      | garder (ouvert) |
| 11  | pipeline, audit IA                    | **Compteur d'absence** : deux inventaires rapprochés de quelques minutes suffisent à retirer une vente. `last_inventory_complete_at` avance aussi sur un run en échec. Le seuil de 15 % bloque toute petite source. Les seuils Python et SQL ne sont pas comparés par un test                                                                                                     | Moyenne  | S      | garder          |
| 12  | données                               | **Vench** : surface non extraite quand l'en-tête et le texte disent la même valeur (faux conflit `ambiguous_surface`, 17 fiches). 223 fiches sans aucun essai de géocodage, pas même au niveau de la commune                                                                                                                                                                      | Moyenne  | M      | garder          |
| 13  | données                               | **Surfaces et types incohérents** : Carrez supérieur à l'habitable, « box » typé terrain, « Appartement » de 5 m². « Première offre possible » des notaires présentée comme mise à prix                                                                                                                                                                                           | Basse    | S      | garder          |
| 14  | données, SRE                          | **Sources figées** : publication complète d'Enchères Immobilières au 08/10 ; Agrasc sans aucun inventaire complet. Chercher la cause, puis ajouter une alerte (n° 48)                                                                                                                                                                                                             | Moyenne  | M      | garder (ouvert) |
| 15  | pipeline                              | **OCR** : une sortie vide de Tesseract classe la page « vide » définitivement. Contrôler l'encre, puis faire une seconde passe pivotée                                                                                                                                                                                                                                            | Basse    | M      | garder          |
| 16  | pipeline                              | **`dedupe-sweep.yml`** sans étape d'invalidation du cache ; tests encore en `import fitz` (règle ruff à ajouter)                                                                                                                                                                                                                                                                  | Basse    | S      | garder          |
| 17  | pipeline                              | **CI du pipeline** : test de durée à 0,2 s fragile (`test_personal_data.py:205`, à remplacer par un rapport de temps) ; job hebdomadaire à horloge +60 j. `main.py` (2 253 lignes pour un plafond de 2 254) et `information_agent_evidence.py` (1 650 pour 1 650) n'ont plus de marge, avec une échéance au 31/03/2027                                                            | Moyenne  | S      | garder          |

### C. Écart au marché et statistiques

| N°  | Agents                                              | Proposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Priorité | Effort | Avis du chef     |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ---------------- |
| 18  | statisticien                                        | **Statistiques par tribunal, famille « activité des annonces »** : publiées dès 5 observations, sans intervalle (`TRIBUNAL_LISTING_STATISTICS_MIN_SAMPLE = 5`). Passer à 10 au moins (20 pour les sous-groupes) ; intervalle de Wilson pour les parts ; ratio mise à prix / DVF aligné sur la porte de la bande ; deux définitions de délai nommées distinctement                                                                                                                                                                                                                                                   | Haute    | S à M  | garder (vérifié) |
| 19  | statisticien, données, UX, contenu, juridique, code | **Refonte de la bande publique** : libellés descriptifs (« inférieure à la fourchette des ventes comparables », « dans la fourchette » ; plus de « nettement » ni de « proche ») ; phrase « la mise à prix est volontairement basse aux enchères » ; pas de « sous » pour un bien occupé ou loué ; au moins 6 comparables avec jackknife (ou 8), échantillon effectif d'au moins 5, largeur de 60 % au plus, rayon borné ; raisons d'insuffisance séparées (surface inconnue, type, peu de ventes) ; `data-nosnippet` ; DVF expliqué ; journal en cas d'erreur de la RPC. Mesurer d'abord la part de ventes perdues | Haute    | M      | garder           |
| 20  | statisticien, UX, protection-données                | **`/admin/pilotage`** : comptes distincts à côté des occurrences ; fenêtres disjointes (semaine contre semaine précédente) ; inscriptions confirmées seulement ; « actifs » séparés des nouveaux ; administrateurs et comptes de test exclus ; plafond par compte distingué du plafond par adresse ; valeurs masquées sous 5 ; lignes rappels, dossiers et comptes de l'offre ; contraste ; `Dialog` à la place de `window.confirm`. Avec 5 comptes aujourd'hui, ce n'est pas urgent                                                                                                                                | Moyenne  | M      | garder           |

### D. Rappels et suivi des changements (avant `SALE_REMINDERS_MODE=internal`)

| N°  | Agents                                   | Proposition                                                                                                                                                                                                                                                                                                                                                                                                                                               | Priorité | Effort | Avis du chef     |
| --- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ---------------- |
| 21  | code, audit IA, SRE                      | **Le suivi des changements ne voit pas les ventes sorties du catalogue.** `loadSalesByIds` lit `v_auction_sales_app` (statuts à venir), donc une vente retirée, annulée ou adjugée est ignorée (`sale-change-monitor.ts:262`, `continue`). Le consentement promet pourtant de les signaler. Dans le même chantier : droit Analyse recalculé (`accountTier: "premium"` en dur, `:826`, email confirmé ignoré) et lot de 25 comptes par jour à dimensionner | Haute    | M      | garder (vérifié) |
| 22  | SRE, code, sécurité, postgres, juridique | **Rappels sûrs** : pas de J-1 ni de J-7 si la vente n'a pas été vérifiée depuis 36 h ; `readUserEmail` exige un email confirmé (`email-alerts.ts:688`) ; les ventes au-delà de la 300ᵉ sont comptées au lieu d'être ignorées ; consentement et dates posés par un déclencheur, avec la version du texte (aujourd'hui écrits par le navigateur) ; jeton de désinscription valable plus de 60 jours                                                         | Haute    | M      | garder           |
| 23  | produit, UX                              | **Activation mesurée** : mode `internal` d'abord ; tableau des fausses alertes dans le pilotage ; critère écrit de passage à `on` ; consentement proposé dans « Mon dossier » et à l'ajout aux favoris ; libellé court ; un seul vocabulaire (« rappels d'audience »)                                                                                                                                                                                     | Moyenne  | S à M  | garder           |

### E. Offre de lancement

| N°  | Agents                                  | Proposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Priorité | Effort | Avis du chef                  |
| --- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ----------------------------- |
| 24  | contenu, UX                             | **Textes qui promettent plus que le produit** : `/login` « passer à Analyse quand vous le souhaitez » et « sur abonnement résiliable » (`login-page.tsx:105,377-381`) ; `/offres` « pour toutes les ventes » (`offers-page.tsx:69-70`) et onboarding ; prix 59 € sans « tarif prévu » ; FAQ « résilier » et « remboursement » alors que rien n'est souscriptible ; condition « email confirmé » absente du texte de l'offre ; « au lancement officiel » remplacé par « à tout moment, notamment au lancement officiel » | Haute    | S      | garder (vérifié)              |
| 25  | contenu, QA, UX, vitesse, accessibilité | **Affichage de l'offre** : absente de la fiche publique, qui dit « 3 fiches détaillées par mois » (`SalePublicPreview.tsx:274`) ; répétée sur les 24 cartes de `/sales` ; le HTML serveur affiche l'ancienne promesse jusqu'à l'hydratation ; décalage de mise en page de 0,19 sur `/offres` et 0,08 sur `/comment-ca-marche`. Une bannière unique, une ligne courte par carte, une ligne neutre tant que l'état est inconnu, une hauteur réservée                                                                      | Haute    | M      | garder                        |
| 26  | produit, UX, juridique                  | **Préparer la fin de l'offre** : bloc « Ce qui change à la fin de l'offre » dans `/compte` ; étiquette « Inclus pendant l'offre de lancement » sur la fiche ; outil d'envoi à la liste d'attente (`notified_at` n'est jamais écrit) ; message avant la coupure et 30 jours d'accès en lecture ou d'export aux contenus créés                                                                                                                                                                                            | Haute    | M      | garder (avant la coupure)     |
| 27  | sécurité, postgres                      | **Abus de comptes** : email canonique (`+tag`, points Gmail, domaines jetables), l'offre réservée au plus ancien compte ; plafonds globaux distincts pour l'offre et pour les abonnés ; IPv6 hachée au /64 ; `hasConfirmedEmail` lu en SQL avec un cache négatif. Le CAPTCHA relève du propriétaire                                                                                                                                                                                                                     | Moyenne  | M      | garder                        |
| 28  | code                                    | **Prix d'adjudication des instantanés** : copiés sous l'offre de lancement, ils restent lisibles après la coupure. Calculer le droit hors offre, ou masquer le prix                                                                                                                                                                                                                                                                                                                                                     | Basse    | M      | discutable (choix commercial) |
| 29  | code                                    | **Cache de `/api/launch-offer`** : une erreur de 5 s est gardée 30 s par le CDN ; une lecture en cours peut effacer le `reset`                                                                                                                                                                                                                                                                                                                                                                                          | Basse    | S      | garder                        |
| 30  | contenu                                 | **Durée d'essai et documentation** : essai de 7 jours écrit en dur dans 3 composants (`ANALYSIS_TRIAL_DAYS` existe) ; `docs/vercel_setup.md:41,94` parle encore d'un « paiement unique de 29 € »                                                                                                                                                                                                                                                                                                                        | Basse    | S      | garder                        |

### F. Parcours et interface

| N°  | Agents                       | Proposition                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Priorité | Effort | Avis du chef                                                        |
| --- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------------------------------------------------------------------- |
| 31  | code, contenu, UX, juridique | **Surenchère** : la date limite ignore le report au premier jour ouvrable (art. 642 CPC, à confirmer). Plus jamais « Cette fenêtre est échue » ni « C'est le dernier jour » : formulation indicative avec le cas du week-end et des jours fériés, « un avocat de votre choix », `Terme` sur surenchère et adjudication, confirmation avant retrait                                                                                                                   | Haute    | S      | garder (formulation prudente ; le calcul du report attend l'avocat) |
| 32  | SEO, UX, QA                  | **Pages tribunal** : nom du tribunal cliquable sur la fiche (`SalePublicPreview.tsx:207`) ; pages département qui pointent vers la page tribunal et non vers `/sales?tribunal=` (`department-view.tsx:239`) ; bloc d'alerte du département et lien vers les avocats ; titre « Ventes aux enchères au tribunal de X » ; « en Gironde » et non « Dans Gironde » ; 308 pour les majuscules et les soulignés ; nom manquant au référentiel ; compteur et liste cohérents | Haute    | M      | garder                                                              |
| 33  | UX, QA                       | **« Mon plafond »** : champ montant librement saisissable, avec la suggestion du calcul ; `aria-busy` au lieu de `disabled` ; aperçu pour un visiteur ; ligne dans les avantages Découverte ; refus d'un plafond de 0 €                                                                                                                                                                                                                                              | Moyenne  | M      | garder                                                              |
| 34  | UX                           | **« Retour » contextuel** : `safeSalesReturnTo` n'accepte que `/sales` (`navigation.ts:126`). Accepter `/favoris`, `/tribunaux/<code>`, `/audiences-a-venir` et la carte, avec un libellé adapté. Le lien de la fenêtre de la carte passe par le routeur                                                                                                                                                                                                             | Moyenne  | M      | garder (vérifié)                                                    |
| 35  | UX, contenu, juridique, QA   | **Pastille « points à vérifier »** : ne plus afficher « Annonce bien renseignée » à côté d'un point à vérifier (vu en production) ; un seul verbe ; infobulle « liste non exhaustive » ; ancre vers la fiche ; focus visible et zone de 44 px ; présence dans la vue tableau                                                                                                                                                                                         | Moyenne  | S à M  | garder                                                              |
| 36  | UX, produit                  | **« Mon dossier » et le dossier de travail Analyse : une seule porte.** « Mon dossier » serait la source du statut et du plafond ; « Prix envisagé » s'initialiserait avec le plafond enregistré                                                                                                                                                                                                                                                                     | Moyenne  | L      | discutable (attendre l'usage réel)                                  |
| 37  | code                         | **Accueil** : « Données vérifiées le … » prend la date de la source la plus récente (`max`) et masque une source figée, comme Enchères Immobilières. Prendre le `min` des sources actives, ou écrire « dernière collecte réussie »                                                                                                                                                                                                                                   | Moyenne  | S      | garder (vérifié)                                                    |
| 38  | code, contenu                | **Dossier de financement (PDF)** : les règles du tribunal sont appliquées quand le type de vente est inconnu ou en conflit. Les nuances de la garantie de 10 % (débiteur, L. 322-12) et le mot « séquestre » sont à faire valider                                                                                                                                                                                                                                    | Moyenne  | S      | garder (la partie juridique attend l'avocat)                        |
| 39  | UX, contenu                  | **`/audiences-a-venir`, une fois réparée** : « aujourd'hui » et « demain » calculés côté client ; introduction plus courte ; `Terme` ; phrase « une vente reportée n'y est pas » rendue moins absolue ; liens depuis `/sales` et le pied de page ; meta « à date annoncée »                                                                                                                                                                                          | Basse    | S à M  | garder                                                              |
| 40  | UX, contenu                  | **Vocabulaire** : « dossiers » au lieu de « ventes » dans les compteurs ; « dossier » à 6 sens ; « Remporté » / « Non retenu » ; « plan Analyse » ; « ImmoJudis » ; « 2 alertes » pour des risques sur la carte                                                                                                                                                                                                                                                      | Basse    | S à M  | garder                                                              |
| 41  | UX, accessibilité            | **Carte mobile** : libellé court du bouton de suivi (44 px) ; icône liste au lieu de × ; nom « Carte des annonces » ; `locale` Mapbox en français ; « Score » de la fenêtre défini ou retiré                                                                                                                                                                                                                                                                         | Basse    | S      | garder                                                              |
| 42  | QA                           | **Vente passée** : la fiche publique n'affiche aucun signal ; le 409 de l'agenda est trompeur ; « Vente passée » apparaît deux fois sur la carte                                                                                                                                                                                                                                                                                                                     | Basse    | S      | garder                                                              |

### G. Accessibilité

| N°  | Agents            | Proposition                                                                                                                                                                                                                                                                                                    | Priorité | Effort | Avis du chef    |
| --- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | --------------- |
| 43  | accessibilité     | **Focus** : `focus-visible:ring-gold` est à 2,85:1 (45 occurrences). Passer à `outline-gold-soft` (4,9:1) et ajouter un test qui interdit `ring-gold`                                                                                                                                                          | Moyenne  | S      | garder (ouvert) |
| 44  | accessibilité, QA | **Contrastes et noms** : en-têtes du tableau de `/tribunaux` à 4,33:1 ; liens de `/ressources` (`aria-labelledby` réduit au titre) ; `/sales` (un `h1` suivi de `h3`, 24 repères de carrousel, liens homonymes) ; bloc d'alerte de `/tribunaux` sans `h2`. Ajouter ces routes à `e2e/frontend-quality.spec.ts` | Moyenne  | S      | garder          |
| 45  | accessibilité     | **Formulaires et annonces** : `autocomplete` du nom et de l'organisation ; erreurs reliées aux champs ; focus perdu après une action (connexion, alerte, « Mon dossier », rappels) ; région vivante de Sonner montée dès le départ ; « Annuler » de 5 s ; `role="status"` du chargement de la fiche            | Moyenne  | M      | garder          |
| 46  | accessibilité     | **Lot Basse** : cible de 20 px de « bien renseignée » ; valeurs floutées annoncées « Compte gratuit » ; fenêtres des filtres mobiles sans nom ; double signal du mot de passe ; Échap de la pastille ; textes de 9 et 10 px ; état de l'interrupteur de l'offre non annoncé                                    | Basse    | S      | garder          |

### H. Exploitation, supervision et outils

| N°  | Agents                 | Proposition                                                                                                                                                                                                                                                                                                                                                                 | Priorité | Effort | Avis du chef                      |
| --- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | --------------------------------- |
| 47  | SRE, SEO, QA           | **Supervision indépendante** : `/api/health` (âge du dernier passage de `operational-health` et de la dernière collecte), exigée par le test de fumée, avec une sonde externe. Test de fumée étendu à `/tribunaux/<code>`, aux redirections 308, à un 404 et à `/audiences-a-venir` sans « indisponibles »                                                                  | Haute    | M      | garder (`/api/health` répond 404) |
| 48  | SRE, données           | **Alertes qui manquent** : pilote coupé (aucune alerte aujourd'hui) ; `publication_stale` par source ; `freshness_ratio` ; boîte d'invalidation non vidée ; retrait des ventes absentes non tracé. Les échecs partiels comptent comme un succès : Resend non configuré, emails en échec, comptes en échec dans `smart-alerts`                                               | Haute    | S à M  | garder                            |
| 49  | chef (d'après données) | **Alertes permanentes** : `cron.stale` ouverte depuis le 15/07 (3 082 occurrences), `licitor.missed` depuis le 16/09, `enrichment.stalled` depuis le 12/09, `import.unhealthy` depuis le 19/08. Une alerte toujours ouverte n'alerte plus personne : les résoudre ou ajuster leur seuil, et écrire les runbooks manquants (`pipeline.source.*`, `valuation.queue.degraded`) | Moyenne  | S à M  | garder                            |
| 50  | SRE                    | **Crons sur le plan Hobby** : `smart-alerts` et `alert-notifications` tombent dans la même heure, sans ordre garanti. Décaler `alert-notifications` d'une heure ; ajouter `maxDuration` aux trois routes qui n'en ont pas                                                                                                                                                   | Moyenne  | S      | garder                            |
| 51  | postgres               | **Règles pour les prochaines migrations** : `drop trigger` sur `auction_sales` prend un verrou exclusif, donc appliquer hors collecte ou utiliser une création conditionnelle ; pas de réparation de données dans une migration (`110200`) ; politique RLS d'`auction_sales` en `(select …)`, après mesure                                                                  | Moyenne  | S      | garder                            |
| 52  | chef                   | **Garde-fou SQL** : le crochet déclaré dans l'en-tête de `qualite-donnees` n'a pas bloqué un `create temp view`. Déclarer le même crochet au niveau du projet (`.claude/settings.json`, matcher `mcp__Supabase__execute_sql`), et y ajouter un test du script                                                                                                               | Haute    | S      | garder                            |
| 53  | audit IA, QA           | **Tests de façade** : expressions régulières sur une migration remplacée (`launch-offer.test.ts:85-140`) ; constante comparée à elle-même ; invariant de sécurité sans `launch_offer_account_eligible` ; règle « build ou non » dupliquée ; délai de `SearchPage.account.test.tsx` trop court                                                                               | Basse    | S      | garder                            |
| 54  | sécurité, code         | **`calendar_exported`** : jusqu'à environ 43 000 écritures par jour et par compte, sans contrôle de visibilité de la vente. Plafonner et vérifier la visibilité                                                                                                                                                                                                             | Basse    | S      | garder                            |

### I. Juridique et protection des données (textes devenus faux depuis la PR #275)

Ces points touchent des textes juridiques. Le propriétaire les avait exclus le 19/10. Ils sont isolés ici parce que la PR
#275 les a rendus inexacts.

| N°  | Agents                        | Proposition                                                                                                                                                                                                                                                                                                                                                                                                                    | Priorité | Effort                                                                                                                               | Avis du chef                                 |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- | --- | ------------------------------- |
| 55  | juridique, protection-données | **Politique de confidentialité et registre** : « Événements de parcours agrégés, sans identifiant de personne » (`privacy.tsx:117`) est faux depuis la mesure par compte. Ajouter cette mesure, les liens d'email suivis, les rappels, « Mon dossier », les instantanés et les réponses de l'enquête, avec des durées exactes (purge hebdomadaire : 90 jours deviennent environ 97). Le développeur du point 65 a un brouillon | Critique | S à M                                                                                                                                | garder (vérifié)                             |
| 56  | protection-données, juridique | **Opposition et liens suivis** : l'opposition à la mesure d'audience ne couvre pas la mesure par compte (choix gardé dans `localStorage` seulement). Deux options : (A) compter les clics sans `user_id` ; (B) opposition stockée sur le compte et testée dans `record_account_product_event`, plus une mention en pied d'email. Vérifier que le suivi des clics de Resend est désactivé                                       | Haute    | M                                                                                                                                    | garder (choix A ou B au propriétaire)        |
| 57  | juridique, contenu            | **CGV** : clause « offre de lancement » (proposée au rapport juridique, variante avec message préalable recommandée) ; contradiction avec le préavis de 30 jours (`FREE_BENEFIT_NOTICE_DAYS`) ; « trois favoris » au lieu de 10 (`:72`) ; « sept jours » écrit en dur (`:195`) ; prix affiché comme actuel ; rappels indicatifs (§8). Nouvelle version ancrée par sha256                                                       | Critique | S à M                                                                                                                                | garder (texte à faire valider par un avocat) |
| 58  | juridique                     | **Enquête de la liste d'attente** : finalité, durée et contact pour l'entretien à dire au moment de la collecte (`offer-opening-consent.ts`) ; nouvelle version du texte                                                                                                                                                                                                                                                       | Moyenne  | S                                                                                                                                    | garder                                       |
| 59  | juridique                     | **`/legal`** : téléphone de l'hébergeur ; Supabase et Google (Street View) cités ; point de signalement d'un contenu (annonces des professionnels)                                                                                                                                                                                                                                                                             | Moyenne  | S                                                                                                                                    | garder (ouvert)                              |
| 60  | pipeline, juridique           | **Licitor** : le décodage des emails protégés par Cloudflare est actif par défaut (`data-pipeline.yml:157`, `                                                                                                                                                                                                                                                                                                                  |          | 'true'`) et le reste pour toute valeur inconnue (`licitor.py:336-350`), alors que l'accord n'est qu'oral. Le rendre fermé par défaut | Haute                                        | S   | garder (ouvert depuis le 15/10) |

### J. Vitesse et référencement

| N°  | Agents        | Proposition                                                                                                                                                                                                                                                                                                             | Priorité | Effort | Avis du chef    |
| --- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | --------------- |
| 61  | vitesse, code | **Réchauffage après purge** : chaque appel du pipeline vide toutes les pages tribunal, `/audiences-a-venir` et les pages paginées sans les régénérer (rendus à froid de 1 à 4 s). Les ajouter au réchauffage ; purger aussi l'étiquette `public-tribunal-activity` et `/tribunaux`                                      | Haute    | S      | garder          |
| 62  | vitesse       | **Budget du chunk Mapbox** : 99,72 % du plafond, 5 Ko de marge (effet de la mise à jour #279). Lui donner un budget propre ; le plafond lui-même revient au propriétaire                                                                                                                                                | Moyenne  | S      | garder          |
| 63  | vitesse       | **Poids** : `OfferOpeningRequest` et `OfferOpeningSurvey` sont copiés dans 5 routes (accueil −10 à −19 Ko) ; `SectorAlertForm` en 3 copies ; budgets de route trop lâches (accueil à 45 %), sans budget pour les pages tribunal et audiences                                                                            | Moyenne  | S à M  | garder          |
| 64  | vitesse, SEO  | **`/sitemap.xml`** : MISS à chaque requête, 3,5 s (`force-dynamic` plus une lecture en série). Passer en ISR d'une heure ; mettre à jour le `lastmod` de `/tribunaux` (figé au 13/10)                                                                                                                                   | Basse    | S      | garder          |
| 65  | vitesse       | **Accueil** : l'en-tête de secours décale la page (CLS de 0,078 sur 3 essais sur 10, déjà présent avant la PR)                                                                                                                                                                                                          | Basse    | M      | garder (ouvert) |
| 66  | SEO           | **Données structurées et articles** : `availability: SoldOut` après l'audience est une affirmation fausse (`seo.ts:432`) ; date « Mis à jour le » invisible ; fil d'Ariane visible différent du JSON-LD ; descriptions de plus de 160 caractères (`seoDescription`) ; « Chargement de l'annonce… » dans le HTML serveur | Basse    | S      | garder          |

### K. Produit et concurrence (idées)

| N°  | Agents            | Proposition                                                                                                                                                                         | Priorité | Effort | Avis du chef                                           |
| --- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------------------------------------------------------ |
| 67  | produit           | **Retour en un clic** (« Utile » / « Pas pertinent » et motif en liste fermée) sous la bande et les points à vérifier. Les « point faux » alimentent `/admin/quality`               | Moyenne  | S à M  | garder (après le n° 19)                                |
| 68  | produit           | **« Mon démarrage »** : trois gestes guidés (suivre une vente, fixer son plafond, recevoir un rappel), détectés depuis les données existantes                                       | Moyenne  | S à M  | garder                                                 |
| 69  | produit, veille   | **« Mon planning »** dans `/favoris` : ventes suivies triées par audience, export `.ics` de toutes les audiences. Filtre et calendrier des visites sur place (`visit_dates` existe) | Moyenne  | M      | garder                                                 |
| 70  | produit           | **Récapitulatif hebdomadaire « Ma semaine »** (mes audiences, changements, nouvelles ventes du département), au plus un email par jour                                              | Moyenne  | M      | discutable (après n° 21 à 23 et le registre)           |
| 71  | produit           | **Filtres de `/sales`** « sous la fourchette » et « sans point à vérifier »                                                                                                         | Basse    | M      | discutable (après la refonte n° 19)                    |
| 72  | veille            | **Relevé mensuel pour les avocats référencés** (affichages, clics, demandes) et fiche cabinet avec ses ventes à venir                                                               | Moyenne  | M      | discutable (commercial ; contrat des avocats non relu) |
| 73  | veille            | **Alerte de résultat ou de remise en vente** sur les ventes suivies, sans prix dans l'email                                                                                         | Basse    | M      | discutable (dépend de Licitor et du n° 21)             |
| 74  | veille            | **Chiffrage des travaux poste par poste**, prix saisis par l'utilisateur                                                                                                            | Basse    | M à L  | discutable                                             |
| 75  | redacteur-contenu | **Trois articles** : « Vente reportée, retirée ou annulée », « Liquidation judiciaire : l'immeuble vendu aux enchères », « Mise à prix et valeur de marché : lire un écart »        | Moyenne  | M      | garder (relecture juridique ensuite)                   |

### Ordre proposé

- **Lot 1, tout de suite :** 1, 2, 3, 5, 24, 52, 55, 60 et la première étape du 19 (libellés et biens occupés).
- **Lot 2, avant l'ouverture au public :** 4, 6, 7, 8, 9, 10, 18, 19, 25, 31, 32, 37, 47, 48, 56, 57, 61.
- **Lot 3, avant d'activer les rappels :** 21, 22, 23.
- **Lot 4, avant de couper l'offre de lancement :** 26, 27, 28.
- **Lot 5, ensuite :** le reste des « garder ».

## Points écartés

- **Sonder le prix via la liste d'attente (veille n° 1).** Existe déjà : `survey_price_too_expensive_eur` et
  `survey_price_cheap_eur`.
- **Cron `sale-change-monitor` en échec avant les migrations (postgres n° 2).** Démenti par la production : les 28
  migrations sont appliquées et le cron réussit chaque jour.
- **Job de valorisations désactivé (SRE n° 7).** `precompute-valuations` tourne toutes les 15 min.
- **Suffixe lisible dans l'adresse des tribunaux (SEO n° 13, UX n° 9).** Décision D2 du 19/10.
- **`LaunchOfferNote` rendu côté serveur (vitesse n° 12).** Il retarderait la coupure au-delà de 60 s ; la réservation
  d'espace suffit (n° 25).
- **Resserrer « proche » à ±15 % (UX n° 7).** Absorbé par la refonte n° 19.
- **Essai de 30 jours après questionnaire, palier par département, observatoire trimestriel (veille n° 2, 3 et 7).**
  Ils attendent Stripe et la société ; le palier est interdit sans validation par la feuille de route du 23/09 ; le
  chantier des statistiques est gelé jusqu'au lancement.
- **Validation de la bande contre les prix d'adjudication (statisticien).** Il faudrait des prix Licitor et des
  estimations archivées ; c'est une étude, pas un correctif. À revoir après l'accord avec Licitor.
- **MFA administrateur (sécurité n° 11).** Réglage du propriétaire, déjà listé.

## À faire par le propriétaire (hors code)

1. **Décisions toujours en attente du 18/10.**
   - Indexation : confirmer, ou `SEO_INDEXING_ENABLED=false`.
   - Identité de l'éditeur (`NEXT_PUBLIC_LEGAL_*`).
   - `LICITOR_DECODE_PROTECTED_EMAILS=false`.
   - Liste des sources dont les photos sont copiées.
2. **Données, toujours rien de lancé.**
   - Réparations `20261020130002` (point fantôme), `20261020130001` et `130003` : comptage, puis `-v apply=1`.
     `20261025100001` semble inutile (0 nom fautif), à confirmer par son comptage.
   - `python -m src.redact_personal_data`, puis `--apply`, puis `--check` (après le n° 10 de préférence).
   - `recompute-existing-sales` en `dry_run`, puis en réel.
   - Balayage des doublons : seulement après le n° 8. `dedupe-candidates.yml`, relecture, puis
     `DEDUPE_RECONCILE_ENABLED=true` et 4 à 5 passages.
3. **Domaine.** Avant de passer `www` en 308, vérifier que l'URL gardée dans Vault pour les crons `pg_cron` est
   `immojudis.com` et non `www`.
4. **Réglages à poser ou à vérifier.**
   - Vercel : `OPERATIONS_ALERT_EMAIL_TO`, `SENTRY_DSN`.
   - GitHub : `SITE_URL` et `CRON_SECRET`, pour l'invalidation du cache.
   - Resend : suivi des clics désactivé.
   - Supabase Auth : « Confirm email » activé, CAPTCHA et limites d'inscription.
   - `npm run db:types` sur une base locale.
5. **Vercel Hobby.** Usage non commercial : passer en Pro avant d'ouvrir les paiements.
6. **Durées à valider, en tenant compte de la purge hebdomadaire.** 90 jours (environ 97 en pratique), 6 mois
   (6 mois et 7 jours), journal des rappels, liste d'attente à 12 mois.
7. **Prix d'Analyse.** Dans le segment des enchères, aucun prix publié ne dépasse environ 21 € par mois en équivalent
   mensuel : Vench 40 à 250 € par an, Mon Petit MDB 19 € par mois, Adjugé 4,99 €. Les 59 € se défendent pour des
   marchands de biens, pas pour des particuliers. Décision à prendre, avec la réserve du statisticien : la liste
   d'attente ne mesure pas une intention d'achat.
8. **Plafonds de build.** Chunk Mapbox (n° 62) ; plafonds de taille de `main.py` et `information_agent_evidence.py`
   avant le 31/03/2027 (n° 17).
9. **Pour un avocat.**
   - Clause « sans préavis » d'une offre gracieuse (clauses abusives, directive 2019/770) et accès aux contenus après
     la coupure.
   - Liens d'email nominatifs (article 82 de la loi Informatique et Libertés) et mise en balance de la mesure par
     compte.
   - Report de la surenchère (art. 642 CPC).
   - Libellés de l'écart au marché et réutilisation de DVF.
   - Statut de l'éditeur, LCEN et DSA.
   - TVA et médiateur.
   - Contrats de sous-traitance.
   - Contacts nominatifs des études notariales dans les annonces.

## Décision du propriétaire

En attente.
