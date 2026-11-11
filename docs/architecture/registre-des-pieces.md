# Registre des pièces : fondations (lot R1)

Plan : `docs/equipe/2026-11-11-registre-des-pieces.md`. Spécification : annexe
`03-base-de-donnees-arbitrage.md`. Migrations `20261116100000` à `20261116100500`.

**État au lot R1 : inerte.** Aucune fiche ne tient de champ, aucun code de l'application ni du pipeline
n'appelle la projection, le noyau de publication de l'agent d'information n'est pas modifié (lot R2).

## Le principe

Une fiche (`auction_sales`) est réécrite en entier par la collecte à chaque passage. Une « pièce » est une
observation (`auction_fact_claims`, immuable) qu'un administrateur a acceptée. Tant qu'elle est acceptée, elle
**tient** son champ : la valeur affichée est la sienne, et plus celle de l'annonce.

Règle à retenir : **toute écriture directe d'un champ tenu est retenue par la base.** La collecte, le repli
REST, une fusion de doublons, un rattrapage ou une requête à la main peuvent réécrire la colonne : la base remet
la valeur tenue. Une seule fonction pose ou retire une pièce : la projection.

## Les objets

| Objet                                      | Rôle                                                                                                                                                                                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auction_fact_fields`                      | Les cinq champs (surface, terrain, nombre de pièces, occupation, dates de visite), leurs colonnes, leurs tolérances, `hold_enabled` et `on_listing_change`. Les visites sont verrouillées par contrainte (non tenables).   |
| `auction_fact_source_precedence`           | Rang et droit de tenir par origine : administrateur 10, formulaire d'avocat 20, email d'avocat 30, document 50 ; l'annonce (60) ne tient jamais (contrainte).                                                              |
| `auction_fact_claim_decisions`             | Journal en ajout seul des décisions (acceptée, rejetée, retirée, opposition, contredite), avec le rattachement au lot. Le statut d'une observation est sa **dernière** décision, dans l'ordre de `seq`. Aucun texte libre. |
| `auction_sale_field_hold_events`           | File de relecture en ajout seul : l'annonce a changé sur un champ tenu, pièce posée, retirée ou refusée par la fiche, contradiction.                                                                                       |
| `auction_sales.held_fields`                | Par champ tenu : valeur, pièce, décision, origine, rang, jour de réception, tolérance, réglage, et le bloc `listing` (dernière valeur connue de l'annonce). Nulle si rien n'est tenu.                                      |
| `app_private.project_sale_fields`          | La projection : pose et retire les pièces.                                                                                                                                                                                 |
| `aaab_auction_sales_hold_projected_fields` | Le déclencheur de retenue. Il écrit aussi `held_fields` : il y met à jour la dernière valeur connue de l'annonce, ou en retire un champ libéré.                                                                            |

Les quatre tables sont fermées aux rôles de l'API (RLS sans politique, lecture seule pour `service_role`),
n'ont aucune clé étrangère vers `auction_sales` (le journal survit à une fusion et à la purge de la vente) et ne
sont lues par aucune vue.

## Les journaux

- **Ordre.** La colonne `seq` (identité) ordonne les décisions et les évènements. Les dates `decided_at` et
  `created_at` sont imposées par la base (`clock_timestamp()`), jamais fournies par l'écrivain.
- **Qui accepte.** Une acceptation exige un administrateur existant (`user_profiles.user_role = 'admin'`) au
  moment de la décision. Un avocat n'accepte pas seul : sa réponse est une observation, acceptée ensuite par une
  personne de l'équipe. La publication automatique reste verrouillée.
- **Motifs.** `reason_code` est une liste fermée par type de décision (refus : `already_known`, `other_lot`,
  `doubtful_statement`, `implausible_value` ; retrait : `entry_error`, `other_lot`,
  `authorization_withdrawn`, `replaced_by_source` ; opposition : `professional_opposition` ; contredite :
  `by_listing`, `by_document`, `by_professional` ; partout `other`). Une note libre, si elle devient
  nécessaire, ira dans une table à part, purgeable, jamais dans ce journal non effaçable.
- **Valeurs.** Une acceptation est refusée si la valeur n'est pas recevable. Occupation : `vacant` (libre),
  `occupied` (occupé) ou `rented` (loué), et rien d'autre (plan, section 6, choix 5 : jamais qui occupe ni
  pourquoi). La file d'évènements ne garde l'occupation que sous cette forme.
- **Idempotence.** Un même fait de l'agent n'est accepté qu'une fois ; une nouvelle acceptation (après un
  retrait par erreur, ou pour corriger le lot) nomme la décision qu'elle remplace (`supersedes_decision_id`).
- **Ajout seul.** UPDATE, DELETE et TRUNCATE sont refusés (`55000`), même en `session_replication_role =
replica` : les déclencheurs du registre sont en `enable always`.
- **Origines réservées.** Les natures `professional_email`, `professional_form` et `admin_entry` d'une
  observation ne peuvent pas être insérées par un rôle de l'API.

## La projection

`app_private.project_sale_fields(vente, champs, appliquer)` n'est exécutable par aucun rôle de l'API. Avec
`appliquer = false` (défaut) elle simule sans rien écrire. Pour chaque champ :

1. elle prend la dernière décision de chaque observation de la vente (et des ventes qu'elle a absorbées par
   fusion) et ne garde que les acceptations d'un lot identifié (`single_lot`, `matched`) dont l'origine peut
   tenir le champ. Une observation sans décision au journal, un document resté candidat, une pièce d'annonce
   ou un lot inconnu ne tiennent rien ;
2. elle écarte toute pièce que l'annonce a délogée (évènement `listing_changed_released` de la vente de la
   décision, qui nomme cette décision ou qui la suit) : il faut une nouvelle décision humaine, postérieure,
   pour qu'elle reprenne le champ ;
3. elle ordonne par rang, puis par date (réception, à défaut décision). Au même rang, une pièce plus récente
   de la même origine (même dossier) remplace la précédente ; deux origines différentes qui disent autre chose
   (hors tolérance) sont une contradiction : rien ne bascule, un évènement `conflicted` part en relecture ;
4. elle écrit en un seul `UPDATE` les colonnes, `held_fields` et `updated_at`. Sans changement elle n'écrit
   rien. Quand plus aucune pièce ne tient un champ (retrait, opposition, rejet), elle restaure la valeur de
   l'annonce gardée dans le bloc `listing`.

Elle n'échoue jamais sur la contrainte « pièces >= chambres ». Une pièce qui compte moins de pièces que la fiche
ne compte de chambres n'est pas posée : état `blocked`, évènement `projection_blocked`, et les autres champs
sont projetés. Une valeur d'annonce à restaurer qui serait devenue incompatible est remplacée par NULL.

Une entrée marquée `conflicted` garde la valeur affichée tant que la pièce qui la porte est encore acceptée ;
quand la contradiction cesse, l'entrée repasse à `held` avec un évènement `projection_held`. Un simple
changement de réglage (`on_listing_change`, tolérance) met l'entrée à jour sans évènement.

Ordre des verrous pour tout appelant : la vente (`for no key update`), puis les observations, puis les
décisions.

## La retenue

Le déclencheur est passif : il ne lit ni les observations, ni les décisions, ni la préséance, ni
`raw_payload`, et n'appelle jamais la projection. Il ne s'exécute que pour une vente qui tient un champ (clause
`WHEN`). Avec I la valeur entrante, H la valeur tenue et L la dernière valeur connue de l'annonce :

| Écriture entrante                                                    | Effet                                                                                                                               |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| I ne dit rien (nulle, nombre nul ou négatif, occupation « unknown ») | H reste, sans évènement.                                                                                                            |
| I égale à H, à la tolérance près                                     | H reste : écho ou confirmation.                                                                                                     |
| I égale à L, à la tolérance près                                     | H reste : l'annonce n'a pas changé.                                                                                                 |
| Autre valeur : l'annonce a changé                                    | Évènement en relecture. `keep_and_review` (défaut) : H reste, L est mise à jour. `listing_wins_and_review` : I passe, champ libéré. |

- **Surface.** Les cinq colonnes sont retenues en bloc. L'annonce a changé dès qu'une des deux colonnes de
  valeur (`app_surface_m2`, `surface_m2`) dit autre chose que H et que sa propre dernière valeur connue. À la
  libération, les colonnes que l'écriture n'a pas touchées reprennent leur valeur du bloc `listing`.
- **Chambres.** Quand une écriture apporte plus de chambres que le nombre de pièces tenu : en
  `keep_and_review`, la pièce reste, le nombre de chambres entrant n'est pas pris et un évènement
  `listing_changed_kept` porte les deux nombres ; en `listing_wins_and_review`, le champ est libéré (valeur de
  l'écriture ou du bloc `listing` si elle est compatible, sinon NULL). L'écrivain n'échoue jamais, même s'il
  n'écrit que `bedrooms_count`.
- **Évènements bornés.** Un évènement par valeur entrante et par décision : une annonce qui oscille entre
  deux valeurs n'ajoute rien à la file.
- **Écriture de `held_fields`.** Hors projection, elle est refusée (`42501`), à la modification comme à
  l'insertion. Le marqueur de transaction que pose la projection n'est pas un contrôle d'accès : une seconde
  garde refuse tout changement de `held_fields` par un rôle de l'API, marqueur posé ou non.

Le déclencheur porte le préfixe `aaab_` pour passer avant les déclencheurs `BEFORE UPDATE` qui jugent la
ligne : une réécriture annulée ne date pas `content_changed_at`.

## Régler le comportement

Tout se règle en données, par migration : `hold_enabled` (un champ est-il tenable), `can_hold` et `rank`
(quelle origine tient, et laquelle l'emporte), `on_listing_change`. Ce dernier réglage est recopié dans
l'entrée de `held_fields` : un changement vaut pour un champ déjà tenu à sa projection suivante.

## Limites connues

- Retirer la pièce la plus récente d'un dossier rend le champ à la pièce précédente du même dossier si elle
  est encore acceptée.
- La table des fusions est tenue à plat par `carry_sale_user_data_to_merged_sale` : la projection lit un seul
  niveau.
- Le rattrapage `supabase/repairs/20261029100200_recompute_past_quarantined_deadlines.sql` coupe puis rétablit
  les déclencheurs de `auction_sales` : rejoué tel quel, il laisserait ceux du registre hors du mode
  `always`. Il ne doit plus être rejoué sans être adapté.

## Reporté au lot R2

- Écho de la collecte après un retrait (`main.py` et mémoire des anciennes valeurs tenues).
- Ordre de verrouillage du noyau et `lock_timeout` de la RPC.
- Fusion de doublons (report des dossiers et reprojection). Dont ce cas : une libération par l'annonce n'écarte
  que les décisions de sa propre vente, donc quand l'annonce de la vente conservée déloge sa pièce, une pièce
  acceptée plus tôt sur une vente absorbée peut reprendre le champ à la projection suivante.
- Valeur écrite dans `app_surface_kind` et `surface_source` (constante neutre, nature Carrez, habitable ou
  terrain).
- Copies normalisées `properties` et `judicial_sales`, qui ne sont pas retenues.
- Normalisation des visites (jour et heure structurés), préalable à la levée de leur verrou.
- Les deux RPC d'administration qui rendent la ligne entière de `auction_sales`.
- `recompute_scoring.py`, qui lit `select=*`.
- `updated_at` monotone.
- Contrôle quotidien « la simulation rend `changed = false` ».
- Test de concordance entre la simulation et les faits acceptés de l'agent.

## Garde-fous

Tests pgTAP `881` (tables, droits, journaux), `882` (retenue), `883` (projection) et `442` (vues). Invariants
de `scripts/check-security-invariants-fact-registry.mjs` : `fact-registry-tables-closed`,
`fact-registry-append-only`, `held-fields-projection-only`, `hold-trigger-present-early`,
`field-projection-not-callable-by-api`, `fact-claims-never-repointed`, `registry-no-fk-to-auction-sales`. La
publication automatique reste verrouillée (`auction_fact_claim_decisions_auto_locked`,
`auction_fact_claim_decisions_accepted_by_admin`).
