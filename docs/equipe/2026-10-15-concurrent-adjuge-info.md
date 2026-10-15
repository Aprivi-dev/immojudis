# Analyse du concurrent adjuge.info — 15/10/2026

Mission : analyser https://adjuge.info/ (design, fonctionnalités, positionnement) et dire ce
qu'Immojudis gagnerait à reprendre ou à adapter. Agents : `veille-concurrentielle`,
`ux-designer`. Aucun fichier de code modifié.

Règle commune : on reprend des idées et des principes d'interface, jamais les textes, les
visuels, les chiffres ou les données d'adjuge.info (droit d'auteur, droit sui generis des
bases de données, CPI L. 341-1 et L. 342-1). Ne pas citer Adjugé nommément dans un contenu
public.

## Le concurrent en bref

- « Adjugé » est une **application mobile** (iPhone, Android) éditée par Avenia Consulting.
  Le site web est une vitrine et une machine à pages pour Google : pas de moteur de
  recherche, pas de filtres, pas de carte, pas de compte web.
- Promesse : « le prix réel sous le marteau ». Argument vedette : une archive d'environ
  20 000 adjudications avec prix final, en accès libre, et le rapport médian prix final /
  mise à prix.
- Couverture étroite : environ 200 à 245 ventes à venir, judiciaire seul, 38 départements.
  Immojudis : environ 1 890 lignes (environ 880 ventes distinctes), judiciaire, notarial et
  domanial.
- Modèle : gratuit limité (5 fiches par jour, 5 favoris, 1 alerte), Pro à 4,99 €/mois ou
  29,99 €/an ; publicité sur Android.
- Stratégie SEO : 38 pages par département, pages « prix réels », environ 26 pages de
  notions, lexique, calculateurs publics, milliers de pages d'archive de ventes passées,
  `llms.txt` et robots IA explicitement accueillis.
- Faiblesses : fiches pauvres (ni tribunal, ni photo, ni documents, ni source), décote
  affichée sans méthode sur la fiche, chiffres qui se contredisent d'une page à l'autre,
  pas de mentions légales ni de CGU complètes.

Immojudis est nettement plus complet sur le produit (recherche, carte, fiche, pièces,
plafond par vente, avocats, alertes e-mail, comparateur). adjuge.info est en avance sur
l'**acquisition** : contenus publics, chiffres en accès libre, pages par territoire.

## Comparatif

| Fonctionnalité                                          | Immojudis                                       | adjuge.info                                      | Meilleur chez                           |
| ------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------ | --------------------------------------- |
| Couverture des ventes à venir                           | ~880 distinctes, judiciaire, notarial, domanial | ~200-245, judiciaire seul                        | Immojudis                               |
| Recherche, filtres, carte                               | Complets                                        | Absents du web (dans l'app)                      | Immojudis                               |
| Fiche de vente                                          | Photos, pièces, risques, plafond, historique    | Titre, mise à prix, date, surface, €/m²          | Immojudis                               |
| Décote par rapport au marché (DVF)                      | Présente (`src/lib/value-preview.ts`)           | Présente, méthode publiée à part                 | Égal ; adjuge explique mieux            |
| Prix d'adjudication passés                              | Par tribunal, réservé à Analyse (~1 500)        | Publics, ~20 000                                 | adjuge.info                             |
| Calculateurs publics                                    | Simulateur de frais (prix vers coût)            | Enchère max, fourchette du prix final, rendement | adjuge.info (accès libre)               |
| Pages par département                                   | Aucune                                          | 38                                               | adjuge.info                             |
| Pages par tribunal                                      | `/tribunaux`                                    | Aucune                                           | Immojudis                               |
| Contenus                                                | 10 articles longs + guide pilier                | Guide + ~26 pages courtes + lexique              | adjuge (nombre), Immojudis (profondeur) |
| Pages d'archive (ventes passées)                        | Supprimées après l'audience (404)               | Conservées                                       | adjuge.info                             |
| Annuaire d'avocats, alertes e-mail, comparateur, agenda | Oui                                             | Non                                              | Immojudis                               |
| Application mobile                                      | Non (écartée le 13/10)                          | Oui                                              | adjuge.info                             |
| Mentions légales, CGU, sources                          | Complètes                                       | Incomplètes                                      | Immojudis                               |

## Propositions

Priorité : Critique / Important / Suggestion. Effort : S < 1 h, M < 1 jour, L > 1 jour.

| N°  | Agent       | Proposition                                                                                                                                                          | Priorité   | Effort | Avis du chef                                                                                       |
| --- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------------------------------- |
| 1   | ux          | Accueil : une ligne de chiffres réels sous « Explorer les ventes » (« N ventes à venir · mises à jour le … »), calculée sur nos données                              | Important  | S      | garder                                                                                             |
| 2   | ux          | Accueil et cartes : dire clairement ce qui est gratuit (« Gratuit, sans carte bancaire · 3 fiches détaillées par mois ») avec lien vers `/offres`                    | Suggestion | S      | garder                                                                                             |
| 3   | ux + veille | Bulle de définition « ? » accessible sur 5 termes (mise à prix, adjudication, surenchère, consignation, enchère plafond) + lexique du guide avec une ancre par terme | Important  | M      | garder                                                                                             |
| 4   | ux          | Plafond : remplacer « Travaux inclus : à chiffrer » par « Plafond hors travaux : ajoutez votre budget travaux »                                                      | Important  | S      | garder                                                                                             |
| 5   | ux          | Cartes de résultats : type de bien devant la ville dans le titre ; « Mise à prix » lisible (13-14 px), collé au montant                                              | Suggestion | S      | garder                                                                                             |
| 6   | veille      | Simulateur de frais : mode inverse « j'ai X € : jusqu'à combien enchérir ? », avec les barèmes existants et un lien vers les ventes                                  | Important  | M      | garder                                                                                             |
| 7   | veille      | Page « comment est calculé l'écart avec le marché » + garde-fou d'affichage des écarts aberrants                                                                     | Suggestion | S-M    | garder                                                                                             |
| 8   | ux          | Guide : date de mise à jour tirée du contenu (aujourd'hui en dur) ; format des nombres homogène                                                                      | Suggestion | S      | garder                                                                                             |
| 9   | ux          | Guide : frise de la procédure (visiter, consigner, enchérir, surenchère, payer), temps de lecture, encadrés « À retenir »                                            | Suggestion | M      | garder                                                                                             |
| 10  | veille      | Pages courtes de notions (licitation, saisie immobilière, avocat obligatoire) + petit calcul de surenchère du dixième                                                | Suggestion | M      | garder (rédaction `redacteur-contenu`, relecture `juridique-rgpd`)                                 |
| 11  | veille      | Pages « ventes aux enchères par département », seuil d'au moins 3 ventes sinon `noindex`, ajout au sitemap                                                           | Important  | L      | garder, à lancer après le dédoublonnage (sinon comptes faux)                                       |
| 12  | ux          | Fiche, visiteur non connecté : afficher mise à prix au m² comparée à la médiane DVF de la commune, avec source et date, à la place du cadenas                        | Important  | M      | discutable : déplace la frontière gratuit / compte, décision commerciale                           |
| 13  | ux          | Fiche : bandeau unique en haut (mise à prix, date et heure, tribunal, visite) + regrouper les « informations manquantes » dans un bloc replié                        | Important  | M      | discutable : touche des écrans validés ; constat fait sur le texte, pas sur un rendu               |
| 14  | veille      | `llms.txt` qui décrit Immojudis et ne liste que les pages éditoriales                                                                                                | Suggestion | S      | discutable : choix de politique vis-à-vis des robots IA                                            |
| 15  | veille      | Page publique « prix réels des adjudications » (médianes nationales, méthode, date de calcul)                                                                        | Important  | M      | discutable : bloquée par l'accord écrit de Licitor et la relecture juridique ; archive plus petite |
| 16  | ux          | Vue « tableau » optionnelle dans `/sales` (bureau seulement)                                                                                                         | Suggestion | L      | discutable : gain réservé aux professionnels, effort élevé                                         |
| 17  | veille      | Garder une page « résultat » allégée après l'audience au lieu d'un 404                                                                                               | Suggestion | L      | discutable : RGPD, droit des bases, matrice de conservation                                        |

### Vérifications du chef

- N° 1 : l'accueil n'affiche qu'un exemple fictif au-dessus de la ligne de flottaison
  (`src/components/CinematicHome.tsx`).
- N° 3 : aucun composant de définition dans `src/components` ; « Mise à prix » est un
  libellé `text-xs` sans explication (`src/components/search/SearchResults.tsx:381`).
- N° 4 : « Travaux inclus : à chiffrer » confirmé
  (`src/components/sale-detail/SaleDetailDecisionPanels.tsx:95-97`).
- N° 5 : titre de carte `ville · département`, type de bien en dessous
  (`SearchResults.tsx:312-325`).
- N° 6 : `/simulateur-frais-encheres` va uniquement du prix vers le coût
  (`src/app/simulateur-frais-encheres/page.tsx`). Le barème des émoluments reste à faire
  confirmer par un juriste (noté le 15/10).
- N° 8 : `Mis à jour le 13/10/2026` écrit en dur
  (`src/app/ventes-immobilieres-judiciaires/resources-guide.tsx:284`).
- N° 11 : aucune page département dans `src/app`, rien dans `src/app/sitemap.ts`. Reporté
  le 13/10 « à rouvrir en premier » après le lancement ; l'indexation est ouverte depuis le
  15/10, il reste le dédoublonnage (`DEDUPE_RECONCILE_ENABLED`, côté propriétaire).
- N° 12 : le visiteur voit « Créez un compte gratuit pour voir la fourchette de valeur »
  (`SaleDetailDecisionPanels.tsx:206`).
- N° 14 : `src/app/robots.ts` sans règle pour les robots IA ; pas de `llms.txt`.

### Écartés

- Application mobile et notifications : décision du 13/10, tout le modèle d'adjuge en dépend.
- Favoris et alertes sans compte : les alertes d'Immojudis reposent sur un e-mail consenti,
  et le compte Découverte est gratuit.
- Tarif à 4,99 € et quotas par jour : positionnement différent ; seule la formule annuelle
  reste ouverte (point 58 du 15/10).
- Publicités : incompatibles avec la promesse de confiance.
- Comptes TikTok et Instagram : communication, hors développement.
- Fiches sans tribunal ni source : point faible du concurrent.
- Reprise de l'archive ou des chiffres d'adjuge : interdit.

## Point juridique à noter

Les identifiants d'archive d'adjuge.info (`/v/081284`, suffixes `-2`, `-3` pour les lots)
ressemblent aux numéros d'annonces de Licitor (supposé, non démontré). Si c'est exact, le
concurrent s'appuie sur la même source que le module Licitor d'Immojudis : cela renforce le
besoin de l'accord écrit de Licitor avant toute publication d'agrégats ouverts (n° 15, 17).

## Ce que les agents n'ont pas pu voir

- Le rendu visuel (couleurs, typographie, densité) et le HTML source (JSON-LD, meta) :
  l'outil de consultation renvoie un texte converti. L'axe « identité visuelle » reste à
  faire sur captures d'écran.
- L'application elle-même (filtres, alertes, avis des stores).
- La liste des résultats d'adjudication, chargée en JavaScript.
- Côté Immojudis, les pages derrière un compte : analyse faite sur le code et la fiche
  d'exemple publique.
