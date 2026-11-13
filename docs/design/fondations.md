# Fondations du design

Règles communes à toutes les pages d'Immojudis, validées par le propriétaire le 24/10/2026
(planche de proposition : fond, couleurs par rôle, échelle de texte, arrondis, pastilles).
Elles ne changent ni la marque (marine, or, Manrope) ni le contenu : elles retirent le bruit
visuel. Depuis le 25/10/2026, Manrope est la seule police du site, sans italique (à la place de
Cormorant Garamond et d'IBM Plex Sans), la navigation est une pilule flottante et l'accueil suit
sa maquette (`src/components/home/HomePage.module.css`, qui a sa propre échelle). Les jetons vivent dans `src/styles.css`, les composants de base
dans `src/components/ui/primitives.tsx`.

## Fond et surfaces

- Un seul fond de page : le **papier chaud** `--background` (#fbf9f5). Le ciel #eef7ff n'est plus
  utilisé.
- Les cartes, fiches et blocs sont **blancs**, posés par un filet `border-line`, **sans ombre**.
- Le **marine** `--brand-navy` sert aux bandeaux forts (hero de l'accueil, fin de page).
- Teintes de fond secondaires, toutes chaudes : `surface-tint` (#f3eee5), `surface-muted`
  (#f8f5ef), `muted` (#f4efe6). Filets : `line` (#d8cfc1), `line-soft` (#e8e1d6), `line-warm`.
- Une seule ombre, réservée à ce qui flotte au-dessus de la page : menus, fenêtres, barres
  collantes.

## Couleurs par rôle

| Rôle          | Jeton                       | Usage                                                   |
| ------------- | --------------------------- | ------------------------------------------------------- |
| Encre         | `brand-navy` / `foreground` | Titres, texte, montants                                 |
| Encre douce   | `ink-soft`                  | Texte secondaire, légendes                              |
| Or d'accent   | `gold`                      | Décor, filets forts, focus. **Jamais du texte** (2,8:1) |
| Or texte      | `gold-text`                 | Surtitres, liens, accents de titre, enchère plafond     |
| Or sur marine | `gold-light`                | Accents sur fond sombre                                 |
| Urgent        | `danger` / `danger-tint`    | Vente aujourd'hui, erreur                               |
| Attention     | `warning` / `warning-tint`  | Échéance proche, point à vérifier                       |
| Confirmé      | `success` / `success-tint`  | Donnée recoupée, action réussie                         |
| Information   | `info` / `info-tint`        | Aide, précision de méthode                              |

Les couleurs Tailwind brutes (`red-700`, `amber-50`, `slate-600`…) ne sont plus utilisées dans
le nouveau code. Un cliquet (`src/design-system.test.ts`) compte celles qui restent : le plafond
ne peut que baisser, et chaque page migrée l'abaisse.

## Échelle de texte

Rien sous **12 px**. Manrope partout, sans italique : l'accent d'un titre se marque par la
couleur. Les titres des pages autres que l'accueil gardent les tailles ci-dessous, réglées pour
Cormorant : `--font-display-adjust` (`src/styles.css`) ramène la hauteur des capitales de Manrope
à celle de Cormorant, pour que leurs mises en page ne bougent pas. Titre de l'accueil : 60 px
(48 sous 1 100 px, 36 sur mobile), Manrope 800.

| Rôle                  | Police                                        | Taille                   |
| --------------------- | --------------------------------------------- | ------------------------ |
| Titre de page         | Manrope 500 (ajustée)                         | 40                       |
| Section               | Manrope 500 (ajustée)                         | 30                       |
| Titre de carte        | Manrope 500 (ajustée)                         | 22                       |
| Montant clé           | Manrope 600, chiffres alignés, **marine**     | 28 (carte 22)            |
| Chapô                 | Manrope 400                                   | 18                       |
| Texte                 | Manrope 400                                   | 16                       |
| Petit texte / légende | Manrope 400                                   | 14 / 13 (`text-caption`) |
| Surtitre              | Manrope 600, capitales, interlettrage 0,14 em | 12                       |

Les **prix** sont en marine, Manrope demi-gras, `tabular-nums` : ce qu'on compare d'une vente à
l'autre doit être lisible avant d'être décoratif. L'or reste pour les surtitres et l'enchère
plafond.

## Arrondis

| Valeur | Classe                        | Usage                     |
| ------ | ----------------------------- | ------------------------- |
| 4 px   | `rounded-sm`                  | Vignettes, petits repères |
| 6 px   | `rounded-md`                  | Boutons, champs           |
| 10 px  | `rounded-lg` (= `rounded-xl`) | Cartes, fiches, blocs     |
| Pilule | `rounded-full`                | Pastilles, filtres        |

## Pastilles

Composant `Badge` (`tone` : `neutral`, `gold`, `success`, `warning`, `danger`, `info`, `pepite`).

- **Pastilles d'une carte** (décision du propriétaire du 13/11/2026, qui remplace « deux pastilles au plus par carte ») : deux au plus sur la photo ; en tête du texte, le type de vente et l'échéance ; sous les faits, le repère « Annonce bien renseignée », pour les seules annonces du palier haut du classement par complétude. Si « Débloquée », « Pépite » et « Vu » s'appliquent à la même vente, « Vu » disparaît de la photo. La pastille « Pépite » est opaque blanche, bordure et logo or, texte `gold-text`, sans animation : elle se distingue du fond or plein de « Débloquée » et de l'encart « Sponsorisé ».
- La couleur seulement pour ce qui demande l'attention ; toujours un libellé, souvent une icône.

| Information                                  | Ton                                            | Où                                                                                                  |
| -------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Type de vente (tribunal, notaire, domaniale) | `neutral` avec icône                           | Carte et fiche                                                                                      |
| Vente aujourd'hui                            | `danger`                                       | Carte et fiche                                                                                      |
| Vente dans 7 jours ou moins                  | `warning`                                      | Carte et fiche                                                                                      |
| Points à vérifier                            | `warning`                                      | Fiche seulement                                                                                     |
| Donnée recoupée                              | `success`                                      | Fiche seulement                                                                                     |
| Heure à confirmer                            | texte simple sous la date                      | Carte et fiche                                                                                      |
| Pépite                                       | `pepite` avec le logo de pépite (`PepiteIcon`) | Photo des cartes (haut gauche), tableau (icône), fiche                                              |
| Qualité de l'annonce                         | —                                              | Fiche ; cartes de /sales : repère « Annonce bien renseignée » (palier haut, décision du 13/11/2026) |

## Annonce sans photo

Décision du propriétaire du 31/10/2026, qui remplace la « case neutre » du 24/10/2026 (zone grise
de format 4/3, icône et mention « Aucun visuel fiable ») : 14 cartes sur 24 de `/sales` n'ont pas
de photo, et chacune occupait 273 px de gris.

- Une carte de `/sales` sans photo ni vue aérienne fiable montre une **illustration générique** du
  type de bien (`src/components/PropertyIllustration.tsx`) : maison, appartement, immeuble ou terrain.
  Tout autre type (garage, local commercial, bien mixte, type inconnu) prend le dessin de la
  maison, qui est le repli, mais avec un nom accessible neutre (« d'un bien immobilier »). Dessin
  sobre : traits marine `brand-navy`, sol or `gold`, fond beige `surface-tint` ; jamais une couleur
  brute.
- Elle est **toujours signalée** : pastille visible « Illustration » en haut à gauche (même style que
  l'étiquette d'une photo), et nom accessible « Illustration générique d'une maison : aucune photo
  du bien n'est disponible » (selon le type : d'un appartement, d'un immeuble, d'un terrain, ou d'un
  bien immobilier). Elle ne doit jamais passer pour une photo du bien : le même dessin sert
  à tous les biens d'un même type.
- La ville s'écrit sous le dessin quand elle est connue.
- **Hauteur réduite** : cadre 5/2 au lieu de 4/3 (146 px au lieu de 273 px sur un écran de 364 px).
  Le cadre est choisi sur les seules données de la vente (`listingMediaFrameClass`) : 4/3 dès qu'une
  photo ou une vue aérienne du bâtiment (position d'adresse ou de parcelle) est possible, pour que la
  hauteur ne change pas quand l'image arrive ou échoue.
- Un visuel **réservé** garde le fond beige et le cadenas « Visuel réservé » (visiteur sans droit).

## Migration

Page par page, dans cet ordre : fiche vente, /sales, accueil ; le reste du site suit au fil des
changements. Chaque migration n'ajoute que du CSS et des composants serveur : le budget de
JavaScript client (`scripts/check-build-budgets.mjs`) reste tenu.
