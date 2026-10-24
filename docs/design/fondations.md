# Fondations du design

Règles communes à toutes les pages d'Immojudis, validées par le propriétaire le 24/10/2026
(planche de proposition : fond, couleurs par rôle, échelle de texte, arrondis, pastilles).
Elles ne changent ni la marque (marine, or, Cormorant Garamond, IBM Plex Sans) ni le contenu :
elles retirent le bruit visuel. Les jetons vivent dans `src/styles.css`, les composants de base
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
| Or texte      | `gold-text`                 | Surtitres, liens, italiques, enchère plafond            |
| Or sur marine | `gold-light`                | Accents sur fond sombre                                 |
| Urgent        | `danger` / `danger-tint`    | Vente aujourd'hui, erreur                               |
| Attention     | `warning` / `warning-tint`  | Échéance proche, point à vérifier                       |
| Confirmé      | `success` / `success-tint`  | Donnée recoupée, action réussie                         |
| Information   | `info` / `info-tint`        | Aide, précision de méthode                              |

Les couleurs Tailwind brutes (`red-700`, `amber-50`, `slate-600`…) ne sont plus utilisées dans
le nouveau code. Un cliquet (`src/design-system.test.ts`) compte celles qui restent : le plafond
ne peut que baisser, et chaque page migrée l'abaisse.

## Échelle de texte

Rien sous **12 px**. Cormorant pour les titres, Plex pour tout ce qui se lit ou se compare.

| Rôle                  | Police                                     | Taille                   |
| --------------------- | ------------------------------------------ | ------------------------ |
| Titre de l'accueil    | Cormorant 500                              | 56 (mobile 44)           |
| Titre de page         | Cormorant 500                              | 40                       |
| Section               | Cormorant 500                              | 30                       |
| Titre de carte        | Cormorant 500                              | 22                       |
| Montant clé           | Plex 600, chiffres alignés, **marine**     | 28 (carte 22)            |
| Chapô                 | Plex 400                                   | 18                       |
| Texte                 | Plex 400                                   | 16                       |
| Petit texte / légende | Plex 400                                   | 14 / 13 (`text-caption`) |
| Surtitre              | Plex 600, capitales, interlettrage 0,14 em | 12                       |

Les **prix** sont en marine, Plex demi-gras, `tabular-nums` : ce qu'on compare d'une vente à
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

Composant `Badge` (`tone` : `neutral`, `gold`, `success`, `warning`, `danger`, `info`).

- **Deux pastilles au plus** par carte.
- La couleur seulement pour ce qui demande l'attention ; toujours un libellé, souvent une icône.

| Information                                  | Ton                       | Où                                                 |
| -------------------------------------------- | ------------------------- | -------------------------------------------------- |
| Type de vente (tribunal, notaire, domaniale) | `neutral` avec icône      | Carte et fiche                                     |
| Vente aujourd'hui                            | `danger`                  | Carte et fiche                                     |
| Vente dans 7 jours ou moins                  | `warning`                 | Carte et fiche                                     |
| Points à vérifier                            | `warning`                 | Fiche seulement                                    |
| Donnée recoupée                              | `success`                 | Fiche seulement                                    |
| Heure à confirmer                            | texte simple sous la date | Carte et fiche                                     |
| Qualité de l'annonce                         | —                         | **Fiche seulement** (retirée des cartes de /sales) |

## Migration

Page par page, dans cet ordre : fiche vente, /sales, accueil ; le reste du site suit au fil des
changements. Chaque migration n'ajoute que du CSS et des composants serveur : le budget de
JavaScript client (`scripts/check-build-budgets.mjs`) reste tenu.
