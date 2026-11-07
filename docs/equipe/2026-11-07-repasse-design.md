# Repasse design, UX et UI de toutes les pages (07/11/2026)

Mission du propriétaire : « demander aux agents qui s'occupent du design, de l'UX et de l'UI de faire une
repasse de toutes les pages », juste après la mise en ligne de la refonte (#434).

- **Périmètre** : les 48 pages publiques et de compte. `/admin` est hors champ.
- **Agents** (lecture seule) :
  - `ux-designer` : parcours ;
  - `optimisation-interface` : captures mesurées à 1440 et 390 px ;
  - `gardien-marque` : charte et ton ;
  - `audit-accessibilite` : Axe sur 33 pages et revue manuelle, RGAA 4.1 / WCAG 2.2 AA.
- **Signalement du propriétaire** : « des textes s'affichent dans des blocs trop étroits, étirés en hauteur et
  illisibles ». Le chef d'orchestre l'a vérifié avec un détecteur de blocs étroits, passé sur 18 pages à 390,
  768, 1024, 1280 et 1440 px.

Les captures et mesures se trouvent dans le dossier de travail de la session (`scratchpad/repasse/`), qui n'est
pas versionné.

## Vérifications du chef d'orchestre

Chaque constat P1 a été vérifié avant d'être retenu :

- **n° 1** : captures `/annonce-exemple` à 1440 px. Le simulateur de financement et les scénarios de travaux
  sont côte à côte, réduits à 400 px chacun. La colonne « Vos paramètres » s'écrit lettre par lettre ; les
  titres « Type/s de/biens » et « Occupatio/n » sont coupés.
- **n° 2** : capture `/sales` à 390 px. Le bouton « Voir sur la carte » recouvre « 100 000 € ».
- **n° 3** : capture `/annonce-exemple`. La pilule de navigation barre la mention « Exemple fictif ».
- **n° 4** : en production, `/api/lawyers/directory?saleId=<vente au TJ d'Aix-en-Provence>` renvoie
  « Barreau de Aix » et 0 avocat. `?bar=Aix-en-Provence` en renvoie 5. Le motif fautif est dans
  `src/lib/lawyer-bar.ts:27-28`.
- **n° 5** : en production, `?department=13` renvoie des avocats de Bourg-en-Bresse, Albi, Angers, Avignon
  et Bordeaux.
- **n° 6** : `src/app/espace-pro/professional-workspace-page.tsx:194, 209, 222` utilise `text-amber-50` et
  `text-red-100` sur `.liquid-panel`, dont le fond est clair (`src/styles.css:567`).
- **n° 7** : `src/app/ventes-encheres-immobilieres/department-view.tsx:77` fait un lien vers `/sales/<id>` sans
  indiquer d'origine.
- **n° 8 et 9** : vérifiés par l'agent accessibilité avec un script Playwright en production (`man5.js`,
  `man11.js`).

## Constats retenus

Priorité : P1 = gêne réelle sur une page clé, P2, P3. Effort : S = moins d'une heure, M = une
demi-journée, L = plus. La mention « [refonte] » signale un défaut introduit par la refonte #434.

| N° | Agent(s) | Proposition | Priorité | Effort | Avis |
| -- | -------- | ----------- | -------- | ------ | ---- |
| 1 | propriétaire, chef | [refonte] Fiche abonné : textes écrasés. Section 04 : travaux et financement en pleine largeur, l'un sous l'autre. Grilles internes (statistiques, scénarios de travaux, simulateur) adaptées à la largeur réelle de leur colonne. Titres de cartes sans coupure en plein mot. | P1 | M | garder |
| 2 | interface | [refonte] `/sales` mobile : le bouton « Voir sur la carte » ne recouvre plus le prix de la première carte (bandeau d'essai sous la première carte, ou bouton affiché après un premier défilement). | P1 | S | garder |
| 3 | interface | `/annonce-exemple` : bandeau « Exemple fictif » sous l'en-tête fixe, en jetons `warning`. | P1 | S | garder |
| 4 | UX | Avocats depuis une fiche : le barreau ne doit plus être coupé au premier tiret (Aix-en-Provence, Saint-Étienne, Bourg-en-Bresse…). Tests ajoutés. L'état vide nomme le barreau et préremplit le champ. | P1 | S | garder |
| 5 | UX | Annuaire des avocats : `?department` filtre vraiment ; la page tribunal passe `bar=` ; sans critère, invitation à choisir un barreau au lieu des avocats de l'Ain ; « Voir les avocats suivants ». | P1 | M | garder |
| 6 | marque, UX | `/espace-pro`, `/publish`, `/mes-droits` : statuts, erreurs et champs presque invisibles (couleurs d'un ancien thème sombre) → `Badge`, jetons `warning` / `danger` / `success`, `.form-input`, 12 px au minimum. | P1 | M | garder |
| 7 | UX | [refonte] Retour depuis une fiche : garder la page département, les ventes débloquées et la comparaison partagée comme origine (`safeSalesReturnTo`, libellés). | P1 | S | garder |
| 8 | accessibilité | Fiche visiteur en mobile : la barre du bas ne cache plus l'élément qui a le focus (`scroll-padding-bottom`, comme `MobileActionBar`). | P1 | S | garder |
| 9 | accessibilité | « Tous les filtres » : Échap rend le focus au bouton d'ouverture (il tombe aujourd'hui sur `body`). | P1 | S | garder |
| 10 | marque, interface, accessibilité | Pages légales : l'or d'accent n'est plus utilisé comme couleur de texte (`text-gold` → `text-gold-text`), surtitres via `Eyebrow` (12 px, 0,14 em), cible du lien d'évitement (`id="contenu"`). Le texte juridique reste inchangé. | P2 | S | garder |
| 11 | marque | Bandeaux d'alerte de la fiche et `AuthConnectionBanner` : couleurs ambre et émeraude brutes → un composant `Notice` partagé (tons warning, success, danger, info) et `Button`. | P2 | S | garder |
| 12 | marque | Espace compte (connexion, compte, ventes débloquées, comparaisons, favoris) : erreurs et actions en rouge et émeraude bruts → jetons, `Button`, variante `danger`. | P2 | M | garder |
| 13 | marque, UX | Titres de page : six échelles différentes (30 à 72 px) → un seul `PageTitle`. Le propriétaire tranche pour un éventuel grand titre sur `/offres` et `/avocats`. | P2 | M | garder |
| 14 | marque | Habillage « liquid / glass » (21 fichiers, ombre, flou, boutons en capitales) → `Card` et `Button`, puis retrait des classes. Ordre : pages légales, `mes-droits`, `login`, `espace-pro`, `publish`. | P2 | L | garder |
| 15 | UX | Pages de compte : trois mises en page (titre décalé de 80 px) → `PageShell` et surtitre « Mon espace ». | P2 | S | garder |
| 16 | interface, UX, marque | `/avocats` : supprimer le vide de 320 px au-dessus du titre ; sur mobile, résultats juste après le formulaire et encadrés « avocat » en dessous ; bleus bruts → `info` ; 10 px → 12 px. | P2 | M | garder |
| 17 | interface, marque | Textes sous 12 px (81 occurrences hors admin), traités par lots : pages légales, ressources, avocats, comparaisons. | P2 | M | garder |
| 18 | UX | Parcours de l'avocat vers l'espace pro : supprimer la boucle de connexion, le mauvais formulaire et les impasses ; ajouter « Publier une vente » sur `/avocats`. | P2 | M | garder |
| 19 | interface | Bouton principal en or sur `/offres` et `/login`, en marine ailleurs : décision du propriétaire, puis alignement. | P2 | S | discutable (décision) |
| 20 | interface | Cibles tactiles de 20 à 32 px sur l'accueil, `/comment-ca-marche` et la fiche → 44 px. | P2 | S | garder |
| 21 | accessibilité | [refonte] Carte des départements : 96 arrêts clavier avant la liste → ronds hors tabulation (la liste reste la voie clavier) ; nom accessible avec le texte visible ; cible de 24 px. | P2 | M | garder |
| 22 | accessibilité | `/sales` : en-tête et pied de page sortis du `main` (repères). | P2 | M | garder |
| 23 | accessibilité | Affichage à 320 px : bouton de menu hors de la pilule, défilement horizontal sur `/offres` (3 px) et `/accessibilite` (8 px). | P2 | S | garder |
| 24 | interface | Titres de vente : « 114 m² » ne se coupe plus (espace insécable au rendu). | P2 | S | garder |
| 25 | UX | « Comparer » sur la fiche visiteur ajoute vraiment la vente à la comparaison (`/sales?comparer=<id>`). | P2 | M | garder |
| 26 | UX | Définitions au survol pour « surenchère » et « avocat poursuivant » (textes déjà publiés dans le guide). | P2 | S | garder |
| 27 | UX | « Suivre ce tribunal » → « Être prévenu des ventes de ce tribunal » ; lien « Voir mes favoris » après un ajout. | P2 | S | garder |
| 28 | UX | Page tribunal : une seule carte d'alerte avec un choix « ce tribunal / tout le département ». | P2 | M | discutable |
| 29 | UX | Comparaison partagée expirée : message dédié au lieu d'une 404 générique. | P2 | S | garder |
| 30 | UX | Menu : « Ventes » actif sur les pages département, « Tribunaux » sur les audiences. | P3 | S | garder |
| 31 | UX | `/ventes-encheres-immobilieres/13` → redirection vers l'adresse par nom. | P3 | S | garder |
| 32 | UX | Accueil : le chiffre « départements » renvoie à la page par département. | P3 | S | garder |
| 33 | UX | `/sales` sans résultat : « Me prévenir des prochaines ventes ici ». | P3 | S | garder |
| 34 | UX | `/tribunaux` : champ « Trouver un tribunal ». | P3 | M | garder |
| 35 | UX | Connexion en mode professionnel : colonne de gauche propre à l'avocat. | P3 | S | garder |
| 36 | UX | `/publish` : retirer le vocabulaire interne (« panel admin »), à confier à `redacteur-contenu`. | P3 | S | garder |
| 37 | marque | Pages d'erreur sur un gabarit commun ; couleur « papier » dans `EMAIL_COLORS` pour `global-error`. | P3 | S | garder |
| 38 | marque | Image de partage en Manrope (TTF statique OFL). | P3 | M | garder |
| 39 | accessibilité | Cartes sans photo : ne plus répéter « Illustration » et une longue alternative 24 fois par page. | P3 | S | garder |
| 40 | accessibilité | Contraste forcé : états sélectionnés (pilules, Cartes / Tableau, ronds de la carte) visibles. | P3 | S | garder |
| 41 | interface | `/audiences-a-venir` : fil d'Ariane au-dessus du titre. | P3 | S | garder |
| 42 | interface | Page département sur mobile : trois chiffres clés plus compacts. | P3 | S | garder |
| 43 | interface | Barre basse de la fiche : affichée une fois la synthèse sortie de l'écran ; hauteur de l'exemple alignée. | P3 | S | garder |
| 44 | interface | `/tribunaux` sur mobile : règle de lecture dans un `<details>` (reformulée par `redacteur-contenu`). | P3 | S | garder |
| 45 | interface | « Aix-en-Provence » / « Aix-En-Provence » en tête de `/sales` : casse des villes et doublon éventuel, à confier à `qualite-donnees`. | P3 | S | garder |
| 46 | accessibilité | 404 d'une fiche : titre et `h1` alignés ; erreur React 419 à corriger (déjà présente avant la refonte). | P3 | S | garder |

## Écartés ou laissés au propriétaire

- **« 59 € TTC / mois » contre « par mois »** (marque) : le site est cohérent avec lui-même, seule une règle
  écrite diffère. Point contractuel : à trancher par le propriétaire avec `juridique-rgpd`, pas un défaut.
- **Libellés « Analyse premium » dans des tests** (marque) : écarté, n'apparaît sur aucune page.
- **Deux lexiques concurrents** (UX) : décision de contenu, à confier plus tard à `redacteur-contenu`.
- **Image de partage propre à chaque vente** : non proposé, aucune décision du propriétaire.

## Ce qui va bien (ne pas toucher)

- Aucun débordement horizontal à 390 et 1440 px. Une seule page en déborde à 320 px (n° 23).
- `/sales` : filtres et favoris à 44 px, prix en marine `tabular-nums`, `aria-pressed`, liens d'évitement.
- Pages par département : fil d'Ariane, chiffres clés, ventes par semaine, voisins, alerte.
- Fiche visiteur : sections numérotées, frise, « ce que chaque accès ouvre », signalement d'erreur.
- Fenêtres modales (galerie, menu mobile, date) : focus gardé et rendu au déclencheur.
- Nom « Immojudis », offres Découverte et Analyse, vouvoiement et Manrope seule : cohérents partout.

## Mise en œuvre (07/11/2026, pull request #435)

Le propriétaire a validé tous les constats retenus. Cinq lots `developpeur` en parallèle (D : design
system, erreurs, compte ; P : avocats, espace pro, publication, connexion ; N : navigation,
départements, tribunaux, audiences ; F : fiche vente et annonce exemple ; S : catalogue `/sales`), puis
fusion, relecture `code-reviewer` et corrections par le chef d'orchestre.

**Fait : 45 numéros sur 46.** Tous sauf le n° 10.

**Non fait :**

- **n° 10 (pages légales)** : `src/routes/legal.tsx`, `privacy.tsx` et `conditions-generales.tsx` sont
  ancrés par leur empreinte SHA-256 dans `LEGAL_DOCUMENTS` (`src/lib/legal-documents.ts`). Même un
  changement purement visuel impose une nouvelle version, une archive dans `docs/legal-archives/` et,
  pour les CGU, le préavis de 30 jours (art. 14). Décision du propriétaire attendue. Les classes
  `.liquid-*` restent donc dans `src/styles.css` (pages légales, administration, squelettes).

**Choix faits pendant la mise en œuvre, à connaître :**

- n° 8 et 43 : la barre basse de la fiche abonné se masque à partir de 1 024 px (au lieu de 960) ;
  entre 960 et 1 023 px, ni barre ni panneau collant ne gardaient les montants en vue.
- n° 28 : sur la page tribunal, un compte connecté qui choisit « tout le département » passe par
  `/alertes/creer` (un clic de plus) ; la mention de l'essai a été retirée de cette carte pour tenir le
  budget JavaScript.
- n° 25 : « Comparer » de la fiche visiteur ouvre `/sales?comparer=<id>` en gardant les critères de la
  recherche d'origine ; le catalogue ajoute la vente puis retire le paramètre de l'adresse.
- n° 45 : la casse des villes est corrigée à l'affichage seulement ; le doublon éventuel des deux
  annonces d'Aix-en-Provence n'a pas été vérifié en base (à confier à `qualite-donnees`).
- n° 4 et 5 (après relecture) : l'annuaire filtré par département lit chaque barreau à part, une seule
  requête sur plusieurs barreaux étant tronquée à 1 000 lignes par PostgREST.

**Vérifications sur la branche fusionnée :** `tsc`, lint, invariants de sécurité, Vitest complet
(969 fichiers, 13 042 tests), build de production et budgets (`/sales` 564 885 octets sur 565 000, total
client 6 678 220 sur 6 730 000 ; plusieurs allègements de `/sales` ont été nécessaires), détecteur de
textes écrasés sur `/annonce-exemple` (0 alerte de 390 à 1 440 px, contre 118 avant), parcours
Playwright de la CI.
