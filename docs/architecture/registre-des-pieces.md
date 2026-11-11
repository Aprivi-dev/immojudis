# Registre des pièces : fondations (lot R1)

Plan : `docs/equipe/2026-11-11-registre-des-pieces.md`. Spécification : annexe
`03-base-de-donnees-arbitrage.md`. Migrations `20261116100000` à `20261116100500`.

**État au lot R1 : inerte.** Aucune fiche ne tient de champ, aucun code de l'application ni du pipeline
n'appelle la projection, le noyau de publication de l'agent d'information n'est pas modifié (lot R2).

## Le principe

Une fiche (`auction_sales`) est réécrite en entier par la collecte à chaque passage. Une « pièce » est une
observation (`auction_fact_claims`, immuable) qu'une personne a acceptée. Tant qu'elle est acceptée, elle
**tient** son champ : la valeur affichée est la sienne, et plus celle de l'annonce.

Règle à retenir : **toute écriture directe d'un champ tenu est retenue par la base.** La collecte, le repli
REST, une fusion de doublons, un rattrapage ou une requête à la main peuvent réécrire la colonne : la base remet
la valeur tenue. Une seule fonction pose ou retire une pièce : la projection.

## Les objets

| Objet                                      | Rôle                                                                                                                                                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auction_fact_fields`                      | Les cinq champs tenables (surface, terrain, nombre de pièces, occupation, dates de visite), leurs colonnes, leurs tolérances, l'interrupteur `hold_enabled` et le réglage `on_listing_change`.        |
| `auction_fact_source_precedence`           | Rang et droit de tenir par origine : administrateur 10, formulaire d'avocat 20, email d'avocat 30, document 50 ; l'annonce (60) ne tient jamais (contrainte).                                         |
| `auction_fact_claim_decisions`             | Journal en ajout seul des décisions sur les observations (acceptée, rejetée, retirée, opposition, contredite), avec le rattachement au lot. Le statut d'une observation est sa **dernière** décision. |
| `auction_sale_field_hold_events`           | File de relecture en ajout seul : l'annonce a changé sur un champ tenu, pièce posée ou retirée, contradiction.                                                                                        |
| `auction_sales.held_fields`                | Par champ tenu : valeur, pièce, décision, origine, rang, jour de réception, tolérance, réglage, et le bloc `listing` (dernière valeur connue de l'annonce). Nulle si rien n'est tenu.                 |
| `app_private.project_sale_fields`          | La projection.                                                                                                                                                                                        |
| `aaab_auction_sales_hold_projected_fields` | Le déclencheur de retenue.                                                                                                                                                                            |

Les quatre tables sont fermées aux rôles de l'API (RLS sans politique, lecture seule pour `service_role`) et
n'ont aucune clé étrangère vers `auction_sales` : le journal survit à une fusion et à la purge de la vente.

## La projection

`app_private.project_sale_fields(vente, champs, appliquer)` n'est exécutable par aucun rôle de l'API. Avec
`appliquer = false` (défaut) elle simule sans rien écrire. Pour chaque champ :

1. elle prend la dernière décision de chaque observation de la vente (et des ventes qu'elle a absorbées par
   fusion) et ne garde que les acceptations d'un lot identifié (`single_lot`, `matched`) dont l'origine peut
   tenir le champ. Une observation sans décision au journal, un document resté candidat, une pièce d'annonce
   ou un lot inconnu ne tiennent rien ;
2. elle ordonne par rang, puis date de réception, puis date de décision. Au même rang, une pièce plus récente
   de la même origine (même dossier) remplace la précédente ; deux origines différentes qui disent autre chose
   (hors tolérance) sont une contradiction : rien ne bascule, un évènement `conflicted` part en relecture ;
3. elle écrit en un seul `UPDATE` les colonnes, `held_fields` et `updated_at`. Sans changement elle n'écrit
   rien. Quand plus aucune pièce ne tient un champ (retrait, opposition, rejet), elle restaure la valeur de
   l'annonce gardée dans le bloc `listing`.

Ordre des verrous pour tout appelant : la vente (`for no key update`), puis les observations, puis les
décisions.

## La retenue

Le déclencheur est passif : il ne lit ni les observations, ni la préséance, ni `raw_payload`, et n'appelle
jamais la projection. Il ne s'exécute que pour une vente qui tient un champ (clause `WHEN`). Avec I la valeur
entrante, H la valeur tenue et L la dernière valeur connue de l'annonce :

| Écriture entrante                 | Effet                                                                                                                               |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| I nulle (ou occupation inconnue)  | H reste, sans évènement.                                                                                                            |
| I égale à H, à la tolérance près  | H reste : écho ou confirmation.                                                                                                     |
| I égale à L, à la tolérance près  | H reste : l'annonce n'a pas changé.                                                                                                 |
| Autre valeur : l'annonce a changé | Évènement en relecture. `keep_and_review` (défaut) : H reste, L est mise à jour. `listing_wins_and_review` : I passe, champ libéré. |

Le groupe de surface (cinq colonnes) est retenu en bloc. Une écriture de `held_fields` hors projection est
refusée (`42501`), à la modification comme à l'insertion. Le déclencheur porte le préfixe `aaab_` pour passer
avant les autres déclencheurs `BEFORE UPDATE` : une réécriture annulée ne date pas `content_changed_at`.

## Régler le comportement

Tout se règle en données, par migration : `hold_enabled` (un champ est-il tenable), `can_hold` et `rank`
(quelle origine tient, et laquelle l'emporte), `on_listing_change`. Ce dernier réglage est recopié dans
l'entrée de `held_fields` au moment de la projection : un changement vaut pour un champ déjà tenu à sa
projection suivante.

## Limites connues, à traiter au lot R2

- Le nombre de pièces tenu ne peut pas rester sous le nombre de chambres de l'annonce (contrainte de la
  table) : le champ est alors libéré avec un évènement. À l'inverse, projeter un nombre de pièces inférieur au
  nombre de chambres de la fiche échoue.
- Retirer la pièce la plus récente d'un dossier rend le champ à la pièce précédente du même dossier si elle
  est encore acceptée.
- Les copies normalisées de la fiche (`properties`, `judicial_sales`) ne sont pas retenues.
- Le marqueur de transaction de la projection est une défense en profondeur : aucun code ne doit le nommer
  (invariant `held-fields-projection-only`).

## Garde-fous

Tests pgTAP `881` (tables, droits, ajout seul), `882` (retenue), `883` (projection). Invariants de
`scripts/check-security-invariants-fact-registry.mjs` : `fact-registry-tables-closed`,
`fact-registry-append-only`, `held-fields-projection-only`, `hold-trigger-present-early`,
`field-projection-not-callable-by-api`, `fact-claims-never-repointed`, `registry-no-fk-to-auction-sales`. La
publication automatique reste verrouillée (`auction_fact_claim_decisions_auto_locked`).
