# Point d'étape de l'équipe : où en est-on depuis le 13/10 ? (15/10/2026)

Date : 15/10/2026. Chef d'orchestre : `/equipe`.

**Mission.** Refaire auditer Immojudis par chaque spécialiste depuis la première session
(`2026-10-13-premiere-session.md`), pour mesurer ce qui a bougé et ce qui reste avant
l'ouverture au public. Périmètre principal : tout ce qui a été fusionné après le commit
`90b5801` (fin de la première session), soit 285 fichiers. Cela comprend :

- les déblocages Découverte (#243) ;
- la complétude des fiches (#262, #263) ;
- l'agent d'information (#261, #265) ;
- le registre Licitor (#258) ;
- l'extraction des avocats Vench et Petites Affiches (#260) ;
- les workflows (#239, #240, #264).

**Agents lancés (8).** `code-reviewer`, `data-pipeline`, `qualite-donnees`, `ux-designer`,
`seo-expert`, `juridique-rgpd`, `testeur-qa`, `product-explorer`. `veille-concurrentielle`
n'a pas été relancé (édition du 13/10). `redacteur-contenu` et `developpeur` n'interviennent
qu'après validation.

**Statut.** Aucun fichier de code ni de contenu modifié. Aucune écriture en base :
`qualite-donnees` n'a fait que des SELECT limités (mesures du 15/10 entre 07:40 et 07:48 UTC).

**Effets de bord signalés par les agents.**

- `data-pipeline` : une requête HEAD est partie vers licitor.com (image d'une fixture, réponse
  410), effet de bord d'un script de vérification. Il a aussi lancé un PostgreSQL 16 jetable en
  local, supprimé ensuite.
- `testeur-qa` : un `pkill -f "next start"` lancé par erreur. Sans effet sur les vérifications
  du chef, toutes terminées normalement.

## Synthèse

Le code est sain et les suites sont au vert. Ce qui sépare encore le site d'une ouverture crédible
tient en trois points :

1. **Les données visibles.**
   - Elles progressent nettement : sans département de 21 % à 3,3 %, sans coordonnées de 40 % à
     15 %.
   - Les doublons entre sources restent massifs : jusqu'à 1 008 lignes en trop sur 1 890 ventes
     visibles.
   - Les réparations du 13/10 et la purge des noms de particuliers n'ont pas été lancées en
     production.
   - Nouveaux défauts : surfaces de parcelle affichées comme surface habitable, tribunaux non
     rattachés.
2. **Le registre Licitor et l'agent d'information.**
   - Le décodage des adresses masquées est actif par défaut, sur un accord oral.
   - Les captures HTML gardent les adresses sous une forme réversible, sans purge.
   - Le registre n'est pas rafraîchi pour une fiche qui ne change pas.
   - Les emails en clair de Vench et Petites Affiches ne passent pas par le filtre qui écarte
     greffes, Ordre, CARPA et adresses noreply.
3. **Les déblocages gratuits (#243).** Ils fonctionnent, mais :
   - les aperçus payants de la fiche ne proposent pas de débloquer ;
   - l'accueil et l'onboarding disent encore que le plafond est payant ;
   - la lecture des pièces, désormais ouverte aux comptes gratuits, laisse passer des noms écrits
     « NOM Prénom ».

Le reste bloque hors code : la société (donc mentions légales, Stripe, double authentification),
la relecture par un avocat et le courrier à Licitor.

### Vérifications (chef d'orchestre, 15/10)

| Vérification                       | Résultat                                                         |
| ---------------------------------- | ---------------------------------------------------------------- |
| `npx tsc --noEmit`                 | OK                                                               |
| `npm run lint`                     | OK                                                               |
| `npm test` (Vitest)                | 4 008 OK, 7 ignorés (466 fichiers)                               |
| `npm run test:security-invariants` | OK (28 contrôles)                                                |
| Pipeline `ruff` + `pytest`         | OK, 3 924 tests, 149 ignorés (PostgreSQL, LLM, `lightgbm`)       |
| Playwright (du dépôt)              | 92 OK, 6 ignorés volontairement, 0 échec (desktop et mobile)     |
| Playwright (déblocage, hors dépôt) | 17 scénarios OK ; Axe : un seul constat modéré (`heading-order`) |

Environnement : Node 22 au lieu de 24 (`npm ci --engine-strict=false`). Playwright 1.63 attend un
navigateur `chromium_headless_shell-1243` : seul le 1194 est préinstallé dans ce conteneur.
`testeur-qa` a contourné le problème par `executablePath`.

### Avant (13/10) et maintenant (15/10), production

| Mesure                               | 13/10                | 15/10                                                                 |
| ------------------------------------ | -------------------- | --------------------------------------------------------------------- |
| Ventes à venir visibles              | 1 968                | 1 890                                                                 |
| Sans département                     | 21 %                 | 3,3 %                                                                 |
| Sans coordonnées                     | 40 %                 | 15,1 %                                                                |
| Doublons (commune, jour, prix)       | 1 077 lignes en trop | 1 008 lignes en trop (439 paires Vench / PA)                          |
| Dates invraisemblables               | 11                   | 0                                                                     |
| Licitor multi-lots clonés            | 9 annonces           | 12 annonces (28 lignes)                                               |
| Point GPS fantôme                    | 5                    | 1 visible, 2 en quarantaine                                           |
| Noms de particuliers dans les textes | 5 ventes             | 3 à 5 ventes (estimation SQL)                                         |
| Migrations du 13/10 et suivantes     | à appliquer          | toutes appliquées (jusqu'à `20261024100100`)                          |
| Réparations 130001, 130002, 130003   | à appliquer          | non appliquées (pas de table de sauvegarde)                           |
| Purge `redact_personal_data`         | à appliquer          | semble non appliquée                                                  |
| Sources                              | -                    | `cessions_etat` indisponible depuis le 14/10 05:12 UTC (`robots.txt`) |

## Conflits entre agents et arbitrages

- **Décodage Licitor.**
  - `code-reviewer` : actif seulement sur `true`.
  - `data-pipeline` : coupé sur toute valeur inconnue.
  - `juridique-rgpd` : poser la variable à `false` dès maintenant.
  - **Tranché :** les trois se cumulent. Le code passe en « coupé par défaut » (point 1). Le
    propriétaire peut poser `LICITOR_DECODE_PROTECTED_EMAILS=false` sans attendre : aucun envoi
    réel n'est possible tant que la société n'existe pas, donc le registre n'a pas d'usage.
- **Repère « Annonce bien renseignée ».**
  - UX : garder le libellé, rendre la réserve visible.
  - Code et pipeline : « Fiche détaillée » ou un seuil plus haut.
  - **Tranché :** réserve visible et libellé unique (point 41) ; changer le libellé ou le seuil
    reste **discutable**, c'est un choix de produit.
- **Noindex des fiches minces (SEO) et doublons (données).** Le seuil d'indexation n'a de sens
  qu'après le dédoublonnage. Le point 17 vient donc après le point 23.
- **Simulateur de frais.** Le SEO veut le sortir du sitemap tant que le barème n'est pas validé.
  La page porte déjà l'avertissement et le contenu a été relu le 13/10 : **discutable** (point 16).
- **Méta de `/offres`.** Le SEO et le juridique demandent tous les deux le retrait du prix :
  fusionnés au point 15.
- **Formulaire des professionnels.** L'UX propose de garder le jeton en `sessionStorage` (point
  38), alors que le code le retire volontairement de l'URL. `sessionStorage` reste propre à
  l'onglet et n'apparaît ni dans l'historique ni dans le Referer : **gardé**, à faire relire par
  `code-reviewer`.
- **Licitor multi-lots.** Le compte-rendu du 13/10 dit « à trancher » à un endroit et « une fiche
  par lot : oui » dans la table des décisions. On garde la décision « une fiche par lot » (effort
  L, plus tard) et on ajoute une quarantaine automatique tout de suite (point 24).

## Tableau des propositions

Priorités : Critique / Haute / Moyenne / Basse. Effort : S < 1 h, M < 1 jour, L > 1 jour.

### A. Données personnelles, registre Licitor et agent d'information

| N°  | Agent                     | Proposition                                                                                                                                                                                                                  | Priorité            | Effort | Avis du chef                                                                   |
| --- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------ | ------------------------------------------------------------------------------ |
| 1   | code, pipeline, juridique | Décodage Licitor coupé par défaut : actif seulement sur `true` exact (`licitor.py:336`, `data-pipeline.yml:155`, `.env.example`) ; variable transmise aux workflows de recalcul et d'audit                                   | Haute               | S      | garder                                                                         |
| 2   | pipeline, juridique       | Captures HTML Licitor : retirer les `data-cfemail` avant stockage (`licitor_history_run.py:120`) ; fonction `app_private` qui supprime les lignes décodées quand on coupe le décodage ; runbook                              | Haute               | M      | garder                                                                         |
| 3   | testeur-qa                | Filtre des noms : formes « NOM Prénom » et rôles sans civilité (`personal-data-filter.ts`), avec le miroir Python et la fixture partagée ; la lecture des pièces est ouverte aux comptes gratuits depuis #243                | Haute               | M      | garder (reproduit par le chef)                                                 |
| 4   | data-pipeline             | Emails en clair Vench et Petites Affiches : appliquer le filtre greffe, Ordre, CARPA, noreply (`professional_contact.py:66`), avec test paramétré                                                                            | Moyenne             | S      | garder                                                                         |
| 5   | data-pipeline             | Ventes en quarantaine exclues du registre (`internal_contacts.py:108`)                                                                                                                                                       | Moyenne             | S      | garder                                                                         |
| 6   | code-reviewer             | Le registre écrit les adresses de professionnels opposés par identité (`internal_contacts.py:53`)                                                                                                                            | Moyenne             | M      | discutable : sans objet si 1 coupe le décodage ; à faire avant de le réactiver |
| 7   | juridique-rgpd            | Dossiers partagés de l'agent (`information_agent_cases`) : purge à 12 et 24 mois, destinataire vidé à l'opposition                                                                                                           | Haute (avant envoi) | M      | garder                                                                         |
| 8   | code-reviewer             | Tests de la route d'opposition (GET n'écrit rien, POST, 400, 503, limite de débit) ; secret lu via `env.ts`                                                                                                                  | Moyenne             | S      | garder                                                                         |
| 9   | juridique-rgpd            | Politique de confidentialité : phrase sur les noms de particuliers non absolue, captures HTML, transferts hors UE (après vérification prestataire par prestataire)                                                           | Haute               | S      | garder (contenu, à faire valider par un avocat)                                |
| 10  | juridique-rgpd            | Calendrier de trésorerie du plafond : « Consignation » devient « Garantie pour enchérir » ; surenchère « toute personne, par avocat, saisie et licitation » ; intérêts de retard à sourcer (`bid-ceiling-engine.ts:575-610`) | Moyenne             | S      | garder                                                                         |
| 11  | juridique-rgpd            | CGV : citation « L. 224-25-12 et suivants », essai lu depuis `ANALYSIS_TRIAL_DAYS` (au lieu de 7 jours en dur). Sort de l'abonnement après suspension et clause de modification du prix : décision du propriétaire           | Haute (vente)       | M      | garder (partie mécanique) / discutable (le reste)                              |
| 12  | juridique, UX             | Mise en relation : récapitulatif « avocat désigné parmi les cabinets qui rémunèrent Immojudis ; vous pouvez en choisir un autre »                                                                                            | Moyenne             | S      | garder                                                                         |
| 13  | juridique-rgpd            | Mesure d'audience : lien « Mesure d'audience » en pied de page vers l'interrupteur ; durée de conservation écrite                                                                                                            | Moyenne             | S      | garder                                                                         |

### B. Référencement avant ouverture

| N°  | Agent          | Proposition                                                                                                                                                      | Priorité                | Effort | Avis du chef                                             |
| --- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------ | -------------------------------------------------------- |
| 14  | seo-expert     | Interrupteur d'indexation (`SEO_INDEXING_ENABLED`, fermé par défaut) : en-tête `noindex` partout et `robots.txt` sans sitemap tant qu'il est fermé               | Critique (conditionnel) | S      | garder, sous réserve de la décision n° 3 du propriétaire |
| 15  | seo, juridique | `/offres` : méta description sans prix tant que l'offre est fermée, dérivée de `resolveAnalysisOfferLabel()`                                                     | Haute                   | S      | garder                                                   |
| 16  | seo-expert     | Simulateur de frais hors sitemap (ou `noindex`) jusqu'à validation du barème                                                                                     | Haute                   | S      | discutable (avertissement déjà présent)                  |
| 17  | seo-expert     | `noindex, follow` des fiches publiques minces (ville, date, type précis, surface ou prix) ; même prédicat dans le sitemap ; seuil compté d'abord                 | Haute                   | M      | garder, après le point 23                                |
| 18  | seo-expert     | Test de fumée de production : `robots.txt`, `sitemap.xml`, absence de `X-Robots-Tag`, une fiche réelle, `noindex` de `/login`                                    | Moyenne                 | S      | garder                                                   |
| 19  | seo-expert     | Maillage : pas de `?from=/sales` sans filtre ; bloc « Pour aller plus loin » sur la fiche ; pagination en liens `?page=`                                         | Moyenne                 | S+M    | garder                                                   |
| 20  | seo-expert     | Métadonnées : fabrique `pageMetadata` (Open Graph par page), titres d'articles ≤ 60 caractères, `dateModified`, fil d'Ariane, adresse de démonstration en `.com` | Basse à Moyenne         | M      | garder                                                   |
| 21  | seo-expert     | Sitemaps séparés (pages, ressources, fiches), Search Console et Bing ; `lastmod` des fiches sur un changement réel                                               | Moyenne                 | M      | garder (pour le jour de l'ouverture)                     |
| 22  | seo-expert     | Performance : image principale, polices, carte chargée à la demande                                                                                              | Moyenne                 | M      | discutable : mesurer d'abord (Lighthouse)                |

### C. Données et pipeline

| N°  | Agent             | Proposition                                                                                                                                                                                                        | Priorité | Effort | Avis du chef                                               |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------ | ---------------------------------------------------------- |
| 23  | qualité, pipeline | Dédoublonnage : défaut `DEDUPE_RECONCILE_ENABLED=false` dans le code (`config.py:269`) ; balayage au-delà des 2 000 premières lignes ; journal des paires candidates à relire avant activation par le propriétaire | Critique | M      | garder                                                     |
| 24  | qualité, pipeline | Licitor multi-lots : quarantaine automatique (`multi_lot_sale` et plusieurs lots) à la place de la liste fixe de 130003, qui ne couvre plus les 3 nouvelles annonces                                               | Haute    | S      | garder                                                     |
| 25  | qualite-donnees   | Surfaces : plafond de plausibilité par type (appartement au plus 500 m², sinon surface de terrain) ; « surface non établie » pour immeubles et multi-lots                                                          | Haute    | M      | garder                                                     |
| 26  | qualite-donnees   | Tribunaux : retrait du suffixe « (Département) » avant rattachement (35 ventes) ; noms doublés du référentiel (« TJ Tribunal judiciaire du Mans ») ; alias ; « En l'étude du notaire » Vench en vente notariale    | Haute    | M      | garder                                                     |
| 27  | qualite-donnees   | Carrez inférieure à 60 % de l'habitable : afficher l'habitable                                                                                                                                                     | Moyenne  | S      | discutable (un seul cas, seuil à calibrer)                 |
| 28  | qualite-donnees   | Petites Affiches : heure absente stockée à 01:00 ou 02:00 : marquer « date seule »                                                                                                                                 | Basse    | S      | garder (vérifier liste, fiche, export)                     |
| 29  | data-pipeline     | Registre Licitor jamais rafraîchi pour une fiche inchangée : recopier `internal_contacts` (`source_detail.py:148`), test, runbook                                                                                  | Haute    | S      | garder (bug réel, sans effet tant que 1 coupe le décodage) |
| 30  | data-pipeline     | Alerte dédiée aux jobs d'enrichissement épuisés                                                                                                                                                                    | Moyenne  | S      | garder                                                     |
| 31  | data-pipeline     | Garde des traces de rétention étendue à la publication finale (`main.py:1006`)                                                                                                                                     | Moyenne  | M      | discutable (non reproduit)                                 |
| 32  | data-pipeline     | Purges de `run_data_retention` isolées (une erreur ne saute plus la purge du registre)                                                                                                                             | Basse    | S      | garder                                                     |
| 33  | data-pipeline     | Test PostgreSQL du SQL du registre ; `requires-python` à 3.12 (verrou non installable en 3.11) ; filtre serveur des oppositions                                                                                    | Basse    | S      | garder                                                     |

### D. Parcours, déblocages et interface

| N°  | Agent              | Proposition                                                                                                                                                                          | Priorité            | Effort | Avis du chef                                    |
| --- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- | ------ | ----------------------------------------------- |
| 34  | ux-designer        | « Débloquer cette vente (il vous reste N sur 3) » depuis chaque aperçu payant (ancre `#debloquer`) ; quota épuisé et offre fermée : date de retour et « Me prévenir de l'ouverture » | Haute               | M      | garder                                          |
| 35  | ux-designer        | Après « Confirmer le déblocage » : garder la vue avec un bandeau, sans squelette plein écran ; en cas d'échec : « Votre déblocage est conservé. [Réessayer] » (pas de `throw`)       | Haute               | M      | garder                                          |
| 36  | ux-designer        | Promesse du compte gratuit cohérente : accueil, onboarding, login mobile (3 ventes en détail par mois) ; récapitulatif d'onboarding faux pour un département                         | Haute               | S      | garder (aligné sur les CGV, art. 2)             |
| 37  | ux-designer        | Liens vers `/login` avec motif (`fiche`, `offre`) depuis l'essai, les avocats, les rapports, les comparaisons et `AuthGate`                                                          | Moyenne             | S      | garder                                          |
| 38  | ux-designer        | Formulaire des professionnels : jeton conservé dans l'onglet (`sessionStorage`), messages distincts (lien tronqué, panne), liens confidentialité et opposition                       | Haute (avant envoi) | M      | garder                                          |
| 39  | ux-designer        | Formulaire des professionnels : focus sur l'erreur et le succès, `aria-invalid`, focus visible sur le téléversement, cibles de 44 px                                                 | Moyenne             | S      | garder                                          |
| 40  | ux-designer        | Admin de l'agent : rouvrir un dossier envoyé, titre de la vente sur chaque ligne, motif de rejet, explication visible du bouton grisé                                                | Moyenne             | M      | garder                                          |
| 41  | ux, code, pipeline | « Annonce bien renseignée » : réserve visible avec lien vers `/classement-des-annonces`, libellé unique, pastilles en 12 px, raccourci « Trier par date de vente »                   | Moyenne             | S      | garder / discutable (nouveau libellé ou seuil)  |
| 42  | ux-designer        | Statistiques des tribunaux : message d'erreur avec « Réessayer », « Fourchette centrale des prix finaux », tableau accessible                                                        | Moyenne             | S      | garder                                          |
| 43  | ux, juridique      | Plafond : retirer « conseillée » et « mieux vaut ne pas enchérir », un seul nom (« Enchère plafond »), onglet « Prix et plafond », glossaire élargi                                  | Moyenne             | S      | garder                                          |
| 44  | ux, qa             | Déblocages : compteur et date de remise à zéro sur `/compte`, pastille « Débloquée » sur les cartes, pied de carte adapté                                                            | Moyenne             | M      | garder                                          |
| 45  | ux-designer        | Cibles tactiles restantes (listes de tri, plafond, `Terme`, bouton d'opposition)                                                                                                     | Basse               | S      | garder                                          |
| 46  | testeur-qa         | Email collé au texte (`…frTél`) lu « …frT » par l'agent (`contacts.ts:620`)                                                                                                          | Basse               | S      | garder (reproduit par le chef)                  |
| 47  | testeur-qa         | Bouton « Débloquer » proposé sur une vente non débloquable : exposer `unlockable` dans le statut                                                                                     | Basse               | S      | garder                                          |
| 48  | qa, code           | Replis quand une fonction ou une colonne n'est pas encore migrée (`getSaleUnlockStatus`, `completeness_tier`)                                                                        | Basse               | S      | garder (préventif : migrations déjà appliquées) |
| 49  | code-reviewer      | Déblocage limité à 24 mois dans `current_user_unlocked_sale` ; procédure de restitution promise par les CGV                                                                          | Basse               | S      | garder                                          |
| 50  | code-reviewer      | `ai-review` sur une vente débloquée : ne renvoyer que les champs du plafond, avec test                                                                                               | Basse               | S      | garder (à vérifier pendant l'exécution)         |
| 51  | code-reviewer      | Test pgTAP du correctif Stripe (abonnement remplacé)                                                                                                                                 | Basse               | S      | garder                                          |
| 52  | code-reviewer      | Horodatage d'une nouvelle migration obligatoirement postérieur au dernier                                                                                                            | Basse               | S      | garder                                          |
| 53  | testeur-qa         | E2E : fiche connectée et déblocage (mock serveur de `ci.supabase.co`), date de fixture passée, `/classement-des-annonces` et `/sales` dans `frontend-quality`                        | Moyenne             | M      | garder                                          |
| 54  | code-reviewer      | Estimation de marché : champ discriminant explicite au lieu de la présence de `recentTransactions`                                                                                   | Basse               | S      | discutable (supposé, non reproduit)             |

### E. Produit

| N°  | Agent            | Proposition                                                                        | Priorité | Effort | Avis du chef                           |
| --- | ---------------- | ---------------------------------------------------------------------------------- | -------- | ------ | -------------------------------------- |
| 55  | product-explorer | Export agenda `.ics` sur la fiche (dates sourcées seulement)                       | Moyenne  | S      | garder                                 |
| 56  | product-explorer | Changements des ventes suivies affichés dans `/favoris` (l'API existe, sans email) | Moyenne  | M      | garder                                 |
| 57  | product-explorer | Badge « déjà passé » dans la recherche                                             | Moyenne  | S      | discutable (dépend du dédoublonnage)   |
| 58  | product-explorer | Formule annuelle                                                                   | Moyenne  | S      | discutable (Stripe et société d'abord) |

**Lots proposés.**

- **Lot 1, avant ouverture, petits efforts :** 1, 4, 5, 8, 10, 15, 24, 29, 36, 46, 47, et 14
  selon la décision du propriétaire.
- **Lot 2, avant ouverture, efforts moyens :** 2, 3, 7, 9, 23, 25, 26, 34, 35, 38, puis 17
  après 23.
- **Lot 3, juste après :** le reste des « garder ».

## Points écartés

- **Vues de recherche qui appellent une fonction par ligne (code n° 7).** Négligeable à 1 900
  ventes ; à revoir si le catalogue grossit.
- **Fenêtre de mélange des versions de complétude (code n° 11).** Environ 6 h à chaque changement
  de règle, sans effet sur les données.
- **Hachage HMAC des oppositions par identité (code n° 10).** Déjà prévu au runbook avant
  d'étendre l'agent ; hors de cette session.
- **Plafond et notes sur le compte, questions-réponses IA sur les pièces (produit).** Après
  l'ouverture.
- **`SearchAction` et `FAQPage` (SEO).** Sans effet en recherche, rien à faire.
- **Sortir `/classement-des-annonces` du sitemap (SEO).** Page utile à la confiance, on la garde.
- **Taux d'emails exploitables (données D11).** Information, pas une action ; la définition diffère
  de celle du 14/10.

## À faire par le propriétaire (hors code)

1. **Données, cette semaine.**
   - Lancer la réparation 130002 (point GPS fantôme) en comptage, puis avec `-v apply=1`.
     130003 sera remplacée par le point 24, ou lancée telle quelle en attendant.
   - Lancer `python -m src.redact_personal_data`, puis `--apply`, puis `--check`.
   - Lancer `recompute-existing-sales` sur `vench` en `dry_run=true`, puis en réel : 185 ventes
     sans coordonnées.
2. **Licitor.** Poser dès maintenant `LICITOR_DECODE_PROTECTED_EMAILS=false` (variable du dépôt
   GitHub), jusqu'à l'accord écrit.
3. **Indexation.** Décider si le site doit être indexé avant la création de la société. Si non, le
   point 14 s'impose. Plus largement, trancher noir sur blanc : ouverture en lecture seule sans
   vente, ou ouverture complète.
4. **Dédoublonnage.** Une fois le point 23 livré, relire la liste des paires, puis activer le
   balayage.
5. **Cessions de l'État.** La source est indisponible depuis le 14/10 : vérifier à la main son
   `robots.txt`.
6. **Hors code, inchangé depuis le 13/10.**
   - Société, puis `NEXT_PUBLIC_LEGAL_*`, `ADMIN_MFA_REQUIRED=true` et retrait de
     `ALLOW_INCOMPLETE_LAUNCH_CONFIG`.
   - Stripe : portail avec résiliation en fin de période.
   - Relecture par un avocat : CGV, confidentialité, barème, contrat de visibilité des avocats,
     mise en balance et AIPD de l'agent.
   - Courrier à Licitor.
   - Redirections `www` et `.fr` vers le domaine canonique.
