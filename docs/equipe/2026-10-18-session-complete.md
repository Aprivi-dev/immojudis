# Session complète de l'équipe : état des lieux après les PR #266 à #274 (18/10/2026)

Date : 18/10/2026. Chef d'orchestre : `/equipe`.

**Mission.** « Lancer une nouvelle session de travail avec tous les agents » : faire auditer Immojudis par chaque
spécialiste dans son état du 18/10. Cela couvre les PR #267 à #274 : vitesse, photos hébergées, ISR de `/sales`, route
`/api/catalogue/preview`, visibilité matérialisée. Le but est de dresser la liste de ce qui reste avant l'ouverture au
public. Périmètre principal : `git diff 9f123d8..HEAD`, soit 109 commits et 290 fichiers.

**Agents lancés (11).** `code-reviewer`, `data-pipeline`, `qualite-donnees`, `ux-designer`, `seo-expert`,
`juridique-rgpd`, `testeur-qa`, `product-explorer`, `veille-concurrentielle`, `performance-web`, `redacteur-contenu`
(propositions seulement). Le `developpeur` n'intervient qu'après validation.

**Statut.** Aucun fichier de code ni de contenu n'a été modifié, et rien n'a été écrit en base. `qualite-donnees` n'a fait
que des SELECT limités, entre 13:17 et 13:35 UTC.

**Effets de bord signalés.**

- `qualite-donnees` et `veille-concurrentielle` : des GET en lecture vers les sites sources et concurrents (vench,
  avoventes, encheresimmobilieres, info-encheres, licitor, petitesaffiches, etc.).
- `performance-web` : un `npm ci` et un `npm run build` dans le dépôt (`node_modules/` et `.next/` sont ignorés par git).
  Ce `npm ci` est entré en collision avec celui de `testeur-qa` et de `code-reviewer` (`ENOTEMPTY`). `testeur-qa` a alors
  refait ses tests sur une copie dans `/tmp/qa-equipe/repo`.
- `testeur-qa` n'a arrêté que son propre serveur.
- `git status` est propre en fin de session.

## Synthèse

Les correctifs de vitesse du 17/10 tiennent leurs promesses :

- un clic sur `/sales` est passé de 2,2–2,7 s à 0,5–0,9 s sur mobile ;
- la base répond en 22 ms au lieu de 5,4 s ;
- le code est sain : toutes les suites sont vertes.

Ce qui sépare le site d'une ouverture crédible tient en quatre points :

1. **Les données visibles.**
   - Près de la moitié du catalogue est faite de copies : 819 lignes en trop sur 1 646.
   - Le balayage qui doit les supprimer ne tourne jamais en collecte planifiée. Activé tel quel, il effacerait favoris,
     notes et alertes des fiches fusionnées.
   - Douze surfaces sont fausses : une maison à 4,7 M€ affichée « 35 m² », avec la surface d'une vente voisine.
   - 22 ventes ont disparu de leur source et restent affichées, dont 2 qui répondent « 410 Gone » chez Vench.
   - Aucune des réparations attendues n'a été lancée : 130002, noms de tribunaux, purge des noms, recalcul.
2. **Une échéance technique le 22/10.** Quatre tests du pipeline contiennent la date « 22 octobre 2026 ». À partir de ce
   jour, la CI du pipeline sera rouge sur chaque pull request.
3. **Le site est ouvert à l'indexation alors que les mentions légales disent « pas encore toutes publiées ».** Vérifié
   par le chef : `robots.txt` publie trois sitemaps, soit environ 1 625 fiches, et `/legal` affiche la phrase. La partie A
   du 15/10 est inchangée (décodage Licitor actif par défaut, filtre des noms troué, politique de confidentialité
   absolue). Les photos de toutes les sources sont hébergées depuis le test du 16/10, sans liste de sources autorisées.
4. **Des textes promettent plus que le produit.**
   - Export « gratuit ».
   - Plafond « réservé à Analyse » sur deux pages, alors que le compte gratuit l'ouvre.
   - Plafond « pour toutes les ventes ».
   - Message « annuaire réservé à Analyse » alors qu'il est inclus dans le gratuit.

### Vérifications (chef d'orchestre, 18/10, machine au calme)

| Vérification                       | Résultat                                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------------------------- |
| `npx tsc --noEmit`                 | OK                                                                                            |
| `npm run lint`                     | OK                                                                                            |
| `npm test` (Vitest)                | 5 281 OK, 8 ignorés, 0 échec (543 fichiers)                                                   |
| `npm run test:security-invariants` | OK (29 contrôles)                                                                             |
| Pipeline `ruff` + `pytest`         | OK, 4 177 tests, 153 ignorés (PostgreSQL) — `data-pipeline` ; 5 échecs réels à horloge + 45 j |
| Playwright du dépôt                | 129 OK, 7 ignorés volontairement, 0 échec (desktop et mobile) — `testeur-qa`                  |
| `npm run build` + `build:budgets`  | OK ; plus gros chunk à 99,3 % de son plafond (`mapbox-gl`) — `performance-web`                |

Sous la charge des agents (load average 14), deux tests Vitest ont échoué : `SearchPage.view.test.tsx`, carte au premier
geste avec un délai de 500 ms, et `information-agent-robots.test.ts`, seuil de 50 ms. Les deux passent au calme. Ce sont
des tests fragiles (point 49), pas des régressions.

### Contrôles en production faits par le chef (curl, 18/10)

- `/sales` : `x-vercel-cache: HIT`, aucun `set-cookie`.
- `/sales/defaut` : `x-robots-tag: noindex, nofollow`.
- `/sales?page=2` : `MISS`, `private, no-store`. Canonique `/sales`, 24 liens de fiches avec `?from=`.
- `www.immojudis.com` : redirection **307 temporaire** vers `immojudis.com`. Le SEO la croyait absente ; elle existe mais
  n'est pas permanente.
- `robots.txt` : `Allow: /` et trois sitemaps.
- `/legal` : « les informations de l'éditeur ne sont pas encore toutes publiées ».

### Production : 15/10 → 18/10 (`qualite-donnees`, 13:17–13:35 UTC)

| Mesure                                  | 15/10                | 18/10                                                                  |
| --------------------------------------- | -------------------- | ---------------------------------------------------------------------- |
| Ventes à venir visibles                 | 1 890                | 1 646                                                                  |
| Sans département                        | 3,3 %                | 2,4 % (39, toutes Petites Affiches)                                    |
| Sans coordonnées                        | 15,1 %               | **17,6 %** (289, dont 214 Vench)                                       |
| Doublons (commune, jour, prix)          | 1 008 lignes en trop | 819 lignes en trop (dont 708 certaines : même n° d'annonce Vench / PA) |
| Licitor multi-lots clonés               | 12 annonces          | 0 visible (quarantaine automatique)                                    |
| Point GPS fantôme                       | 1 visible            | 1 visible (`8ff95700…`, Clarac)                                        |
| Noms de particuliers                    | 3 à 5                | 2 certains (`d646599e…`, `dd35da97…`)                                  |
| Libellés de tribunal avec « (Dép.) »    | 35                   | 0 ; mais 71 ventes judiciaires sans tribunal rattaché                  |
| Ventes absentes de leur source          | non mesuré           | **22** (2 en 410 chez Vench)                                           |
| Surface étrangère (Enchères Immo.)      | non mesuré           | **12** (35,01 m² × 9, 73,83 m² × 4)                                    |
| Ancienne / nouvelle règle de visibilité | -                    | 0 écart sur 2 105 lignes                                               |
| Réparations, purge, recalcul            | non lancés           | non lancés                                                             |
| `cessions_etat`                         | indisponible         | **rétablie** (inventaire complet à 10:34 UTC)                          |

### Vitesse : 17/10 → 18/10 (`performance-web`, laboratoire depuis les États-Unis)

| Étape `/sales`        | Mobile 17/10 | Mobile 18/10  | Bureau 17/10 | Bureau 18/10          |
| --------------------- | ------------ | ------------- | ------------ | --------------------- |
| Liste visible         | 3,9 s        | 3,2–3,5 s     | 1,1 s        | 0,6–1,1 s             |
| LCP                   | 4,4 s        | 3,9–4,5 s     | 1,0 s        | 1,0 s                 |
| Liste cliquable       | 5,0 s        | 3,9–4,1 s     | 1,3 s        | 1,0–1,4 s             |
| Clic (page, filtre)   | 2,2–2,75 s   | **0,5–0,9 s** | 1,4–2,0 s    | **0,34–0,77 s**       |
| Carte prête           | -            | 5,7–6,2 s     | 3,7–4,5 s    | 1,4–2,0 s après geste |
| Premier écran (poids) | 780 Ko       | 637 Ko        | -            | 896 Ko                |

Autres pages, LCP mobile :

| Page                     | LCP mobile |
| ------------------------ | ---------- |
| Accueil                  | 3,4 s      |
| Fiches                   | 3,5–3,6 s  |
| `/tribunaux`             | **3,9 s**  |
| `/ressources`            | 3,2 s      |
| `/offres`                | 2,7 s      |
| Page département (Paris) | 2,5 s      |

Sur bureau, toutes les pages sont à 98 ou plus.

## Conflits entre agents et arbitrages

- **Invalidation du cache.**
  - Constat : le même manque relevé par cinq agents (pipeline 1 et 2, code 2, QA 5, performance 7).
  - **Fusionné au point 4.** Retenu : une boîte d'envoi côté base plutôt qu'un appel Python. Elle couvre tous les chemins
    d'écriture et part après le COMMIT. S'y ajoutent les étiquettes de cache CDN sur la route d'aperçu et l'export `.ics`.
- **Dérive de `catalogue_quarantined`.**
  - Constat : relevée par trois agents (code 3, pipeline 10, données 13).
  - **Fusionnée au point 13.**
- **Doublons.**
  - `qualite-donnees` veut activer le balayage tout de suite. `data-pipeline` montre qu'il ne tournerait pas et qu'il
    effacerait des données de comptes.
  - **Tranché :** les points 6 et 7 (transfert des données, heure conservée) précèdent le point 8 (balayage exécutable).
    Ce n'est qu'ensuite que le propriétaire relit les paires et active.
- **Cessions de l'État.**
  - Le pipeline craignait que les fiches sans date disparaissent du catalogue vers le 28/10. Les données montrent que la
    source est rétablie aujourd'hui.
  - **Écarté** comme urgence. Seule une ligne de surveillance est gardée (point 13).
- **Copie des photos.**
  - Le juridique la classe Critique. C'est pourtant un test que le propriétaire a demandé le 16/10.
  - **Présentée comme décision du propriétaire** : quelles sources garder. Le code ajoute la liste blanche (point 15),
    vide par défaut seulement si le propriétaire le confirme.
- **Mention « non validés par un juriste » de l'article sur les frais.**
  - Le rédacteur propose de la remplacer par des sources datées. Le 13/10, la validation juridique de ces taux était un
    préalable.
  - **Discutable** (point 27), à la main du propriétaire.
- **Plafond de surface d'une maison.**
  - `qualite-donnees` veut ramener le plafond de 5 000 à 1 000 m². Le 15/10, on avait choisi « plus de 1 000 m² ne passe
    en terrain que si la source le qualifie ainsi ».
  - **Discutable** pour le plafond. Les autres garde-fous du point 10 sont **gardés**.
- **Fiche publique.** L'UX veut un bloc d'inscription plus haut, une page indexée. Pas de conflit avec le SEO : on ne touche
  ni au h1, ni à la méta, ni au JSON-LD. **Gardé** (point 35).
- **Partie A du 15/10.**
  - Elle a été mise de côté le 15/10. Elle revient parce que rien n'a bougé et que deux agents la relèvent séparément.
  - Elle est re-proposée **en partie** : les points 16 à 18 et 20 gardés, le point 23 « avant tout envoi réel ».

## Tableau des propositions

Priorités : Critique / Haute / Moyenne / Basse. Effort : S < 1 h, M < 1 jour, L > 1 jour.

### A. Urgent (cette semaine)

| N°  | Agent                    | Proposition                                                                                                                                                                                                                                                                                                                                                                                                                                         | Priorité | Effort | Avis du chef                                 |
| --- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | -------------------------------------------- |
| 1   | data-pipeline            | Tests datés : `tests/test_pdf_fact_refresh_contract.py:168,196,213,348` (« 22 octobre 2026 ») et `test_source_audit_regressions.py:48,255` (`2026-11-05`) passent en date relative ; un passage `pytest` à horloge + 60 j dans la CI hebdomadaire                                                                                                                                                                                                   | Critique | S      | garder (CI rouge dès le 22/10)               |
| 2   | qualite-donnees          | Enchères Immobilières : couper la page avant « Consultez d'autres ventes » avant toute extraction (`encheres_immobilieres.py:218-229`), test sur la fiche 9545 ; garde-fou « même surface sur au moins 4 ventes d'une source dans plusieurs villes » ; puis recalcul de la source                                                                                                                                                                   | Critique | S      | garder (vérifié dans le code et la page)     |
| 3   | qualite-donnees          | Ventes disparues de la source : après un inventaire complet réussi, retrait ou quarantaine d'une vente absente des deux derniers inventaires ; migration, pgTAP                                                                                                                                                                                                                                                                                     | Haute    | M      | garder                                       |
| 4   | pipeline, code, QA, perf | Invalidation après retrait : table `app_private.catalogue_invalidations` alimentée par un déclencheur sur bascule de visibilité ; `src/cache_invalidation.py --flush` (lots de 100) dans une étape dédiée de `data-pipeline.yml` (`if: always()`, seule à recevoir `CRON_SECRET`) ; étiquettes de cache CDN purgées par `revalidate-sale` sur `/api/catalogue/preview` et l'export `.ics` (sinon `s-maxage` 60 s) ; préchauffage de `/sales/defaut` | Haute    | M      | garder (reste ouvert du 17/10)               |
| 5   | juridique, données, QA   | Noms de particuliers : formes « NOM Prénom », rôles sans civilité et « à la requête de Madame/Mme X » dans `personal-data-filter.ts`, son miroir Python et la fixture partagée ; phrase de `privacy.tsx:222-224` rendue non absolue                                                                                                                                                                                                                 | Critique | M      | garder (texte à faire valider par un avocat) |

### B. Doublons (dans cet ordre)

| N°  | Agent             | Proposition                                                                                                                                                                                                                                                                 | Priorité | Effort | Avis du chef            |
| --- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ----------------------- |
| 6   | data-pipeline     | Une fusion transfère vers la fiche conservée favoris, notes (`sale_workspaces`), rapports, alertes, suivis et ensembles d'analyse, comme les déblocages (`20261023110000`), avec `on conflict do nothing` ; redirection 308 d'un ancien identifiant vers la fiche conservée | Haute    | M à L  | garder (préalable au 8) |
| 7   | qualite-donnees   | Fusion : pour `sale_date`, garder la valeur avec une heure quand les deux tombent le même jour à Paris (`dedupe.py:196-204`) ; environ 76 ventes                                                                                                                            | Haute    | S      | garder (préalable au 8) |
| 8   | pipeline, données | Balayage exécutable : workflow `dedupe-sweep.yml` (manuel, groupe de concurrence du pipeline, environnement Production) qui appelle `reconcile_duplicate_sales_in_supabase()` ; clé de repli stricte autorisée hors Vench / PA ; groupes de plus de 5 lignes exclus         | Critique | M      | garder                  |

### C. Données et pipeline

| N°  | Agent                   | Proposition                                                                                                                                                                                                                                                   | Priorité | Effort | Avis du chef                               |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------------------------------------------ |
| 9   | qualite-donnees         | Multi-lots hors Licitor (Avoventes, Enchères Immobilières) : étendre la quarantaine automatique (`admission.py:211`) ; 15 ventes                                                                                                                              | Haute    | S      | garder                                     |
| 10  | qualite-donnees         | Surfaces : rejeter habitable = terrain ; « à confirmer » si le texte donne deux valeurs ; un immeuble de plusieurs appartements n'est pas un « appartement » ; plafond maison « habitable » de 5 000 à 1 000 m²                                               | Moyenne  | M      | garder / discutable (le plafond)           |
| 11  | qualite-donnees         | Tribunal : extraction de « Tribunal judiciaire de X » dans la description Avoventes et Enchères Immobilières ; alias « Site Deville », « Saint Gaudens »                                                                                                      | Moyenne  | M      | garder                                     |
| 12  | qualite-donnees         | Département déduit de `reference_communes` quand le nom de commune est unique (34 des 39 ventes)                                                                                                                                                              | Basse    | S      | discutable (écart au principe d'inférence) |
| 13  | code, pipeline, données | Surveillance dans `pipeline_health --report-only` : dérive de `catalogue_quarantined` sur 48 h (complète une fois par semaine), quarantaines par statut seul, fiches de l'État qui sortiront sous 7 jours ; colonne alignée sur les trois clés de quarantaine | Moyenne  | S      | garder                                     |
| 14  | data-pipeline           | Copie des photos : `if: always() && inputs.automatic == true` ; test qui exécute `CANDIDATES_SQL` sur le schéma migré et fait échouer visiblement l'étape                                                                                                     | Moyenne  | S      | garder                                     |
| 15  | pipeline, juridique     | Photos : liste blanche `PHOTO_MIRROR_SOURCES` dans `CANDIDATES_SQL` et `precheck`                                                                                                                                                                             | Haute    | S      | garder (choix des sources : propriétaire)  |

### D. Juridique et RGPD

| N°  | Agent               | Proposition                                                                                                                                                                                                                                                                       | Priorité            | Effort | Avis du chef                               |
| --- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------ | ------------------------------------------ |
| 16  | juridique, pipeline | Décodage Licitor actif seulement sur `true` exact (`licitor.py:336-351`) ; `data-pipeline.yml:157` en `\|\| 'false'` ; `.env.example`, README (partie A, point 1)                                                                                                                 | Haute               | S      | garder                                     |
| 17  | juridique           | Captures HTML Licitor : retirer `data-cfemail` avant stockage (`licitor_history_run.py:179-185`), durée de conservation, purge (partie A, point 2)                                                                                                                                | Haute               | M      | garder                                     |
| 18  | juridique           | Politique de confidentialité : tableau prestataire / pays / garantie ; ajouter Google (Street View), les photos sur Supabase Storage, la région de Supabase, la durée des journaux Vercel ; `user_sale_change_events` au registre et à la matrice                                 | Haute               | S      | garder (contrats à vérifier, avocat)       |
| 19  | juridique           | Traceurs : relever en navigateur ce qu'écrivent la télémétrie Mapbox et l'iframe Street View, puis consentement ou exemption documentée                                                                                                                                           | Haute               | M      | garder (mesurer d'abord)                   |
| 20  | juridique           | Lien « Mesure d'audience » en pied de page ; durée écrite après vérification du contrat Vercel (partie A, point 13)                                                                                                                                                               | Moyenne             | S      | garder                                     |
| 21  | juridique, contenu  | CGV : « sept jours » (`conditions-generales.tsx:195`) devient `ANALYSIS_TRIAL_DAYS` ; statistiques du tribunal promises seulement si disponibles ; suivi des favoris cité à l'art. 2. Clause de modification du prix, sort après suspension : propriétaire                        | Haute (vente)       | S      | garder (mécanique) / discutable (le reste) |
| 22  | juridique           | Calendrier de trésorerie : « Garantie pour enchérir », surenchère « par l'intermédiaire d'un avocat », intérêts de retard sourcés (`bid-ceiling-engine.ts:575-610`) ; « Très rentable à confirmer » devient « Score élevé (hypothèses à confirmer) » (`profitability.ts:739-744`) | Moyenne             | S      | garder                                     |
| 23  | juridique           | Agent d'information : filtre greffe / Ordre / CARPA / noreply sur les emails Vench et PA, quarantaine exclue du registre, purge de `information_agent_cases`, tests de la route d'opposition (partie A, points 4, 5, 7, 8)                                                        | Haute (avant envoi) | M      | garder (avant le premier envoi réel)       |
| 24  | juridique           | Mentions légales : téléphone de l'hébergeur Vercel, Supabase cité comme hébergeur du contenu                                                                                                                                                                                      | Moyenne             | S      | garder                                     |

### E. Contenus et promesses

| N°  | Agent              | Proposition                                                                                                                                                                                                                                                                                                                                                                                    | Priorité | Effort | Avis du chef                                            |
| --- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------------------------------------------------------- |
| 25  | contenu, juridique | Promesses inexactes : export « gratuit » (`login-page.tsx:72`) ; colonne desktop de `/login` sans « selon la vente » (`:116`, `:293-295`) ; `/offres` « pour toutes les ventes » devient « au tribunal » (`offers-page.tsx:52-63`, `:257`) ; « plafond = Analyse » sur `/comment-ca-marche` (`page.tsx:41`) et le simulateur (`page.tsx:55-56`) ; article `prix-plafond-encheres-immobilieres` | Haute    | S      | garder (vérifié)                                        |
| 26  | contenu            | Restes de formulation : « Enchère plafond (simulation) » (`CeilingPlanner.tsx:100`) ; « plan Investisseur » (`sale-change-monitor.ts:556`, `lawyer-referrals.ts:176,260`) ; message faux « Avocats référencés réservés au plan Analyse » (`placement-events/route.ts:19`) ; `RankingExplanation.tsx:36` en trois notes                                                                         | Moyenne  | S      | garder                                                  |
| 27  | redacteur-contenu  | Article sur les frais : remplacer « non validés par un juriste ou un notaire » par les sources datées (Légifrance le 09/10, droits de mutation au 01/06/2026), avec `updatedAt`                                                                                                                                                                                                                | Haute    | S      | discutable (la validation juridique était un préalable) |
| 28  | redacteur-contenu  | Article sur les ventes notariales : vente à la bougie distinguée de la vente interactive, sources redatées                                                                                                                                                                                                                                                                                     | Moyenne  | M      | garder (sources à confirmer)                            |
| 29  | redacteur-contenu  | Guide : date de mise à jour (`guide-dates.ts`), temps de lecture 18 / 23 min, `RELATED_SLUGS` complétés                                                                                                                                                                                                                                                                                        | Basse    | S      | garder                                                  |
| 30  | contenu, SEO       | Nouveaux articles : « Préemption : la commune peut-elle vous évincer ? », « Garantie de 10 % : chèque de banque ou caution ? », « Copropriété aux enchères : charges et assemblées » (puis, plus tard, liquidation, ventes interactives, devenir propriétaire)                                                                                                                                 | Haute    | M ×3   | garder (les trois premiers)                             |

### F. Parcours et interface

| N°  | Agent         | Proposition                                                                                                                                                                                                                                                                                          | Priorité | Effort | Avis du chef                                             |
| --- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | -------------------------------------------------------- |
| 31  | UX, QA        | Session impossible à vérifier : `authError` et `retry()` exposés ; bandeau « Nous n'avons pas pu vérifier votre connexion. [Réessayer] [Se reconnecter] » sur `/sales`, `/favoris`, `/alertes`, `/compte` ; message neutre dans `use-auth.ts`                                                        | Haute    | M      | garder (seule la fiche lit `authError`, vérifié)         |
| 32  | UX, QA        | `/sales` pendant la vérification du compte : pas de « compte gratuit » sur les cartes d'un connecté ; alerte et export attendent `authLoading` (vérifié, `SearchPage.tsx:741`) ; « Actualisation… » sans décaler la liste (`:967`) ; pas de rafraîchissement de 60 s pour l'anonyme (`:362`, `:372`) | Haute    | S      | garder                                                   |
| 33  | ux-designer   | Fiche connectée : garder l'aperçu tant que les droits arrivent, au lieu du squelette ; lien « Voir mon enchère plafond » (`#calculation`) après un déblocage                                                                                                                                         | Haute    | M      | garder                                                   |
| 34  | ux-designer   | Lecture des pièces et historique : états chargement, erreur avec « Réessayer », et « pièces non lisibles automatiquement » au lieu de rien (`DocumentReadingSection.tsx:45,69`, `SalePassagesSection.tsx:64`)                                                                                        | Haute    | S      | garder (vérifié ; formulation à relire)                  |
| 35  | UX, SEO       | Fiche publique : bloc d'inscription sous le prix, promesse ramenée à deux occurrences, `Terme` sur mise à prix et adjudication ; chiffres factices « 000 000 € » en `aria-hidden` et `data-nosnippet`                                                                                                | Haute    | M      | garder (h1, méta, JSON-LD inchangés)                     |
| 36  | ux-designer   | `/sales` mobile : en-tête non collant sous `lg`, comparateur en pastille dans la barre basse, surtitre masqué sous `sm` ; remesurer CLS et LCP                                                                                                                                                       | Haute    | M      | garder                                                   |
| 37  | ux-designer   | Filtres mobiles : pastilles « Type de bien », « Mise à prix max. », « Date de vente » ; bouton « Afficher N annonces » ; « Quelle différence ? » en mode compact ; « Score min » devient « Note minimale (classement Immojudis) »                                                                    | Moyenne  | M      | garder                                                   |
| 38  | UX, QA, perf  | Carte mobile et bouton Retour : préchargement du module au toucher du bouton, titre court, `pushState` pour la carte, la page et les filtres validés, `role="status"`                                                                                                                                | Moyenne  | M      | garder                                                   |
| 39  | testeur-qa    | Saisies et erreurs de recherche : un 400 « page hors bornes » n'est pas une panne ; prix min supérieur au max signalé ; montants plafonnés (plus de `1e30` dans l'URL)                                                                                                                               | Basse    | S      | garder                                                   |
| 40  | ux-designer   | Accessibilité : cibles de 44 px restantes ; cloche (boutons espacés, « Annuler » après « Masquer ») ; 8 arrêts de tabulation par carte ramenés à 5 ; liens d'évitement vers la pagination et la carte ; bordure et focus des champs à 3:1                                                            | Moyenne  | S      | garder                                                   |
| 41  | ux-designer   | Création de compte : aide si l'adresse est déjà inscrite (« vérifiez vos indésirables… connectez-vous ou réinitialisez ») ; « Renvoyer l'email » bloqué 30 s                                                                                                                                         | Moyenne  | S      | garder                                                   |
| 42  | ux-designer   | `/alertes` et cloche : « Voir les ventes de cette alerte » ; pastille de non-lus sur le menu mobile ; état vide « Aucune nouvelle vente pour vos alertes »                                                                                                                                           | Moyenne  | M      | garder                                                   |
| 43  | ux-designer   | Espace personnel : favoris avant le bloc payant ; `/compte` avec « Mon espace » et « Notifications » ; « Mes ventes débloquées » dans le menu ; motifs de connexion favoris et alertes                                                                                                               | Moyenne  | M      | garder                                                   |
| 44  | UX, juridique | Offre fermée : bouton principal « Me prévenir de l'ouverture », « Tarif prévu : 29 € TTC / mois. Pas encore souscriptible. », motif `ouverture` qui enregistre la demande au retour, comparatif en liste sous 640 px                                                                                 | Moyenne  | S à M  | garder                                                   |
| 45  | UX, QA        | Petits restes : « Retour aux ventes » garde la position ; carte d'une vente passée signalée ; champ du plafond qui revient à 0 ; `.ics` avec lien vers la fiche et `DTEND` ; encart avocats déplacé en fin de liste, page 1 seulement                                                                | Basse    | S      | garder / discutable (l'encart avocats, choix commercial) |

### G. Technique et sécurité

| N°  | Agent         | Proposition                                                                                                                                                                                                                                                                                                           | Priorité                            | Effort | Avis du chef                                         |
| --- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------ | ---------------------------------------------------- |
| 46  | code-reviewer | Sources retirées : `loadWithdrawnSources` et `stripWithdrawnSourceContent` aussi dans `loadInitialCatalogue` et `loadPreviewCataloguePage` (vignettes comprises), avec un test                                                                                                                                        | Haute (avant le courrier à Licitor) | M      | garder (vérifié : seule la fiche filtre)             |
| 47  | code, QA      | Charge : règle de limite du pare-feu Vercel sur `/sales`, `/sales/*` et `/api/catalogue/*` ; `limit` limité à 24 / 50 / 100 et prix normalisés côté route ; pas de seau partagé « unknown » ; alerte sur les erreurs du limiteur                                                                                      | Moyenne                             | M      | garder                                               |
| 48  | SEO, code, QA | Test de fumée de production : `/sales` en `HIT` sans `set-cookie` ni `Vary`, annonces présentes dans le HTML ; `/sales/defaut` en noindex ; `?page=2` rendu serveur ; aucun sitemap avec `/sales/defaut` ; `cache-control` de la route d'aperçu                                                                       | Moyenne                             | S      | garder                                               |
| 49  | code, QA      | Petits correctifs : `echoRequestId: false` sur l'export `.ics` ; `/api/cron/sale-retention` dans `EXPECTED_CRONS` ; `import "server-only"` dans `email-unsubscribe-token.ts` et `admin-readiness.ts` ; délai des copies de photos à 1,5 s pour l'ISR seulement ; tests fragiles (carte : 2 s, robots : seuil relatif) | Basse                               | S      | garder                                               |
| 50  | data-pipeline | Décodage des images (Pillow) dans un sous-processus sans les secrets de production                                                                                                                                                                                                                                    | Basse                               | M      | discutable (supposé ; `pip-audit` en place)          |
| 51  | data-pipeline | Second canal d'alerte opérationnelle (email via l'application) en plus de l'échec de workflow GitHub                                                                                                                                                                                                                  | Basse                               | S      | garder (après vérification des notifications GitHub) |

### H. Vitesse

| N°  | Agent           | Proposition                                                                                                                                                              | Priorité | Effort | Avis du chef                                   |
| --- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------ | ---------------------------------------------- |
| 52  | performance-web | `/tribunaux` : `adjudication-price-statistics-client.ts:1` importe le client Supabase complet ; passer par `getSupabase()` paresseux (−64 Ko mesurés)                    | Haute    | S      | garder (vérifié)                               |
| 53  | performance-web | Imports directs à la place du barrel `@/lib/client-api`, pour sortir zod du bundle client (−15 à −25 Ko gz estimés)                                                      | Moyenne  | M      | garder (analyse du bundle d'abord)             |
| 54  | performance-web | LCP mobile de `/sales` (3,9 à 4,5 s) : vignette Mapbox plus légère en 1x, hydratation différée des cartes hors écran, CSS inutilisé ; marge du budget de bundle (99,3 %) | Moyenne  | M      | garder                                         |
| 55  | performance-web | Sonner (notifications) monté à la première notification au lieu de toutes les pages (−14 Ko gz)                                                                          | Basse    | M      | garder                                         |
| 56  | performance-web | Variante ISR de `?page=2` et `?page=3`, ou `s-maxage` court sur le HTML paginé                                                                                           | Basse    | M      | discutable (concerne robots et liens partagés) |

### I. Référencement

| N°  | Agent      | Proposition                                                                                                                                                                                                                                                                        | Priorité | Effort   | Avis du chef                                           |
| --- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------- | ------------------------------------------------------ |
| 57  | SEO, code  | Dates fausses : ne plus émettre `lastModified` des fiches et de `/sales` (`sales/sitemap.ts:34`, `sitemap.ts:68-85`) ni `dateModified` (`seo.ts:394-404`) ; puis colonne `content_changed_at` par déclencheur ; « mises à jour le… » de l'accueil sur la dernière collecte réussie | Haute    | S puis M | garder                                                 |
| 58  | seo-expert | Pagination : canonique `/sales?page=N` et titre « page N » au-delà de la page 1 (vérifié : canonique `/sales` aujourd'hui) ; liens numérotés                                                                                                                                       | Moyenne  | S à M    | garder                                                 |
| 59  | seo-expert | Maillage : articles liés par sujet (aujourd'hui toujours les 3 mêmes) ; bloc « Pour comprendre » sur les pages département ; fil d'Ariane visible sur la fiche                                                                                                                     | Moyenne  | S        | garder                                                 |
| 60  | seo-expert | `/tribunaux` : h1 portant la requête ; texte « Vérification de votre accès Analyse… » absent du HTML serveur                                                                                                                                                                       | Basse    | S        | garder                                                 |
| 61  | seo-expert | Pages `/tribunaux/[slug]` sur le modèle des départements (seuil de 3 ventes)                                                                                                                                                                                                       | Moyenne  | L        | garder, après 8 et la réparation des noms de tribunaux |
| 62  | seo-expert | Pas de `?from=` dans les liens du HTML serveur des pages paginées                                                                                                                                                                                                                  | Basse    | S        | discutable (économie d'exploration seulement)          |

### J. Produit et concurrence

| N°  | Agent            | Proposition                                                                                                                                                                   | Priorité | Effort | Avis du chef                                                       |
| --- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------------------------------------------------------------------ |
| 63  | produit, UX      | Alerte en un clic : dernière étape de l'onboarding (case non cochée, vérifié : rien aujourd'hui), pages département, résultats vides ; motif de connexion « alerte » conservé | Haute    | S à M  | garder, après 8 (sinon emails en double)                           |
| 64  | product-explorer | Liste d'attente qualifiée : trois questions facultatives et case « entretien de 20 min » après « Me prévenir de l'ouverture »                                                 | Haute    | S      | garder (registre RGPD et consentement à mettre à jour)             |
| 65  | product-explorer | Mesure : événements serveur par compte (déblocage, quota atteint, plafond calculé, export agenda, clic d'email) et page admin « Pilotage »                                    | Haute    | M      | garder (registre et politique à mettre à jour)                     |
| 66  | produit, veille  | Page publique « audiences à venir » (7 et 30 jours, dates sourcées seulement)                                                                                                 | Moyenne  | M      | garder, après 8                                                    |
| 67  | product-explorer | Rappels J-7 et J-1 et avertissements graves (date changée, retrait) sur les ventes suivies                                                                                    | Moyenne  | M      | discutable (consentement, fausses alertes : envoi interne d'abord) |
| 68  | product-explorer | « Mon dossier » gratuit : plafond et statut enregistrés sur le compte                                                                                                         | Moyenne  | M      | discutable (frontière avec Analyse)                                |
| 69  | product-explorer | Écart au marché public en trois bandes                                                                                                                                        | Moyenne  | M      | discutable (RPC publique, qualité des données)                     |
| 70  | product-explorer | Après l'audience : instantané des ventes suivies et fenêtre de surenchère                                                                                                     | Basse    | L      | discutable (rétention, Licitor)                                    |
| 71  | veille           | Formule annuelle et offre « fondateurs » (MPMDB à 19 €/mois ou 190 €/an)                                                                                                      | Haute    | S      | discutable (société et Stripe d'abord)                             |
| 72  | veille           | Page « Dossier de financement » dans le rapport PDF                                                                                                                           | Moyenne  | M      | discutable                                                         |
| 73  | veille           | Pastille « N points à vérifier » sur les cartes                                                                                                                               | Moyenne  | M      | discutable (formulation, qualité des données)                      |
| 74  | veille           | Favoris du compte gratuit de 3 à 10                                                                                                                                           | Moyenne  | S      | discutable (choix commercial)                                      |

**Lots proposés.**

- **Lot 1, avant le 22/10, petits efforts :** 1, 2, 5, 16, 25, 26, 32, 34, 49, 52 et 57 (première étape).
- **Lot 2, avant l'ouverture :** 3, 4, 6, 7, 8, 9, 15, 18, 22, 31, 33, 35, 36, 46, 48.
- **Lot 3, juste après :** le reste des « garder ».

## Points écartés

- **Disparition des cessions de l'État vers le 28/10 (pipeline n° 5).** La source est rétablie le 18/10. Seule la ligne de
  surveillance est gardée (point 13).
- **Texte rouge illisible sur `/login` (UX n° 11).** Il ne s'affiche que si Supabase n'est pas configuré dans le build,
  jamais en production.
- **Absence de redirection `www` (SEO n° 11).** Faux : la redirection existe, mais en 307. C'est un réglage du propriétaire,
  voir plus bas.
- **Ventes de gré à gré en liquidation (veille n° 6).** Changement de positionnement, hors du périmètre « enchères ».
- **Offre d'achat en PDF (veille).** Sans objet dans une vente judiciaire.
- **Article « Licitor ou tribunal » (contenu).** On ne cite pas de concurrent nommément.
- **`unlock_sale` en SECURITY DEFINER (code n° 9).** Information, aucun défaut.
- **Adresse de démonstration en `.fr`, Open Graph recopié dans la fiche (SEO).** Derrière un drapeau, ou sans effet.

## À faire par le propriétaire (hors code)

1. **Indexation, décision à écrire.** Le site est ouvert aux moteurs depuis le 15/10 alors que `/legal` affiche « pas
   encore toutes publiées ».
   - Soit vous le confirmez.
   - Soit vous posez `SEO_INDEXING_ENABLED=false` (Vercel, Production), puis Redeploy.
2. **Licitor.** Poser `LICITOR_DECODE_PROTECTED_EMAILS=false` (variable du dépôt) dès maintenant, sans attendre le point 16.
3. **Photos.** Décider des sources dont la copie est conservée. Pour les autres, `PHOTO_MIRROR_ENABLED=false` et
   `NEXT_PUBLIC_PHOTO_MIRROR` vide, puis Redeploy.
4. **Données, rien n'a été lancé depuis le 15/10.**
   - Réparations `20261020130002` (point fantôme) et `20261025100001` (noms de tribunaux) : comptage, puis `-v apply=1`.
   - `python -m src.redact_personal_data`, puis `--apply`, puis `--check`.
   - `recompute-existing-sales` en `dry_run=true`, puis en réel, sur `vench`, `petites_affiches` et `licitor`.
     `encheres_immobilieres` après le point 2.
   - Rapport « Dedupe candidates » : seulement après les points 6, 7 et 8. Relire, puis poser
     `DEDUPE_RECONCILE_ENABLED=true`.
5. **Domaine.** Dans Vercel, passer la redirection `www` → `immojudis.com` en permanente (aujourd'hui 307) et vérifier
   `immojudis.fr`.
6. **Surveillance.** Vérifier que les notifications d'échec de workflow GitHub arrivent bien. Expliquer pourquoi
   `last_publication_complete_at` d'Enchères Immobilières date du 08/10.
7. **Valeurs à confirmer.** `TRIBUNAL_STATISTICS_ENABLED` en production (les CGV promettent les statistiques).
8. **Compte de test.** En fournir un, pour mesurer et tester le parcours connecté : ni la vitesse ni la QA n'ont pu le
   faire.
9. **Hors code, inchangé.**
   - Société, puis `NEXT_PUBLIC_LEGAL_*` et `ADMIN_MFA_REQUIRED=true`.
   - Stripe.
   - Relecture par un avocat : CGV, confidentialité, traceurs, mise en balance de l'agent, contrat des avocats.
   - Courrier à Licitor (adresse décodée, statistiques et photos).
   - DPA et mécanismes de transfert de chaque prestataire.

## Décision du propriétaire (19/10/2026)

« Je valide absolument tous les points, sauf tous les points juridiques. »

- **Validés :** tous les numéros, « discutables » compris, sauf la partie D (16 à 24) et les points dont l'objet est
  juridique.
- **Écartés :**
  - 15 : liste des sources autorisées pour les photos ;
  - 27 : mention « non validés par un juriste » ;
  - la phrase de la politique de confidentialité du n° 5. Le filtre des noms, lui, est fait.
- **Non faisable pour l'instant :** 71, la formule annuelle, faute de Stripe et de société.

**Nouvelle demande : offre de lancement.**

- Jusqu'à nouvel ordre, tout compte inscrit reçoit gratuitement les avantages de l'offre Analyse.
- La mention doit dire qu'il s'agit d'une offre de lancement et que ces avantages pourront être retirés sans préavis au
  lancement officiel.

### Organisation de l'exécution

Première vague, en parallèle, un worktree par chantier :

| Chantier | Agent             | Points                                                                |
| -------- | ----------------- | --------------------------------------------------------------------- |
| P1a      | developpeur       | 1, 2, 9, 10, 11, 12                                                   |
| P1b      | developpeur       | 3, 6, 7, 8, 13, 14, 50, 51                                            |
| W1       | developpeur       | 4, 5 (filtre), 46, 47, 48, 49, 57                                     |
| W2       | developpeur       | 32, 36, 37, 38, 39, 40 (recherche), 45 (recherche), 54, 56, 58, 62    |
| W3       | developpeur       | 31, 33, 34, 35, 40 (fiche), 45 (fiche), 59 (fil d'Ariane de la fiche) |
| W4       | developpeur       | offre de lancement, 25, 26, 44, 64, 74                                |
| W5       | developpeur       | 40 (cloche), 41, 42, 43, 63, 67                                       |
| W6       | developpeur       | 52, 53, 55, 59, 60, 61, 66                                            |
| Contenus | redacteur-contenu | 25 (article), 28, 29, 30                                              |

Seconde vague, après fusion, parce qu'elle touche les mêmes fichiers : 65, 68, 69, 70, 72, 73.

## Bilan de l'exécution (19/10/2026)

Tout a été fusionné dans la PR #275. La CI est entièrement verte sur `9c684342` : typage, lint, tests
unitaires et invariants de sécurité, build et budgets, pgTAP, pipeline Python 3.11 et 3.12, parcours
Playwright sur 5 navigateurs et CodeQL.

### Fait

| Vague               | Points                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Première            | P1a, P1b, W1 à W6, contenus. Toutes les propositions validées, sauf 71 (pas de Stripe ni de société).                                                                                                               |
| Offre de lancement  | Avantages Analyse pour tout compte dont l'email est confirmé, interrupteur admin, mention « retirable sans préavis », tarif Analyse à 59 €.                                                                         |
| Relecture de code   | R1 à R13, puis décisions du propriétaire D1 (audiences dédoublonnées sur une identité certaine), D2 (`/tribunaux/<code>` stables, redirection 308) et plafonds quotidiens contre l'abus de l'offre.                 |
| Relecture juridique | Corrections A1 à E7 des articles de `/ressources`, validées par le propriétaire (voir `2026-10-19-relecture-juridique-articles.md`).                                                                                |
| Seconde             | 65 (mesure par compte, `/admin/pilotage`), 68 (« Mon dossier » gratuit), 69 (écart au marché en trois bandes), 70 (instantanés après l'audience), 72 (dossier de financement du PDF), 73 (« N points à vérifier »). |

Le budget JS client total a été relevé trois fois, avec l'accord du propriétaire : 5 750 000, puis
5 850 000, puis 5 950 000. La mesure est de 5 879 382 octets. Les budgets par page sont inchangés.

### Hors de la PR #275

- **PR #236** (OCR des pages de photos) : mise à jour sur `main`, un test de cas limite ajouté, sortie
  du brouillon. CI verte.
- **PR #257** (dépendances Python) : verrous régénérés, imports `pymupdf` (l'avertissement `fitz`
  cassait en silence l'OCR de l'agent d'information), en-tête `cache-control` des photos, audit de
  `requirements-docling.txt` en CI. docling 2.138.0 corrige 8 avis de sécurité. CI verte.
- **PR #254 et #251** : vertes, laissées en l'état sur décision du propriétaire.

### Actions du propriétaire

1. **Migrations.** Appliquer, dans l'ordre, `20261028100000` à `20261028200000`. `20261028160200` doit
   l'être au plus tard avec le déploiement.
2. **Supabase Auth.**
   - Vérifier que « Confirm email » est activé en production.
   - Recommandé : CAPTCHA à l'inscription et limites d'inscription par IP.
3. **Rappels.** Garder `SALE_REMINDERS_MODE=off` jusqu'à la mesure des fausses alertes.
4. **Types.** Lancer `npm run db:types` sur une base locale, puis committer.
5. **Durées à valider.**
   - 90 jours pour les événements produit par compte.
   - 6 mois pour les instantanés des ventes suivies.
   - Surenchère : la date limite est indicative (10 jours calendaires, sans report pour un week-end ou
     un jour férié).
6. **Textes juridiques à intégrer** (non modifiés par l'équipe).
   - **CGV** : « trois favoris » devient 10, et ajouter la clause de l'offre de lancement.
   - **Politique de confidentialité et registre des traitements** : ajouter la liste d'attente, les
     rappels d'audience, la mesure par compte (et ses liens d'email suivis), « Mon dossier » et les
     instantanés des ventes suivies. Le développeur du point 65 a rédigé une proposition de fiche de
     registre et de paragraphe de politique.
7. **Fusionner** #236 et #257 si le propriétaire le décide.

### Limites connues

- **Instantanés après l'audience.** La vente est purgée dès l'audience : la plupart des instantanés
  diront « résultat non connu ».
- **Points à vérifier.** La pastille ne couvre pas la vue tableau de `/sales`. Elle ne compte ni les
  pièces manquantes ni la complétude, que les cartes ne portent pas.
- **Audiences à venir.** Elles ne sont pas fusionnées sur l'adresse, que la fonction publique n'expose
  pas.
- **Espace de travail Analyse.** Son statut et son plafond ne sont pas synchronisés avec « Mon
  dossier ».
