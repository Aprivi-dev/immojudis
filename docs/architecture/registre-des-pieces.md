# Registre des pièces : fondations (lot R1), durcissement (lot R2a), décisions et fusion (lot R2b)

Plan : `docs/equipe/2026-11-11-registre-des-pieces.md` (section 10 pour le lot R2). Spécifications : annexes
`03-base-de-donnees-arbitrage.md` (lot R1), `08-bascule-base-de-donnees.md` et `09-bascule-pipeline.md` (lot R2).
Migrations `20261116100000` à `20261116100500` (lot R1), `20261117100000` à `20261117100700` (lot R2a),
`20261118100000` à `20261118100300` (lot R2b).

**État au lot R2b : toujours inerte.** Aucune fiche ne tient de champ et aucune décision n'est écrite : les
fonctions de décision existent sans aucun droit d'exécution, et aucun code de l'application ni du pipeline
n'appelle la projection. Le noyau de publication de l'agent d'information et son pont ne sont pas modifiés (lot
R2c). Application en production : `docs/runbooks/registre-des-pieces-r2a.md`, puis
`docs/runbooks/registre-des-pieces-r2b.md`.

## Le principe

Une fiche (`auction_sales`) est réécrite en entier par la collecte à chaque passage. Une « pièce » est une
observation (`auction_fact_claims`, immuable) qu'un administrateur a acceptée. Tant qu'elle est acceptée, elle
**tient** son champ : la valeur affichée est la sienne, et plus celle de l'annonce.

Règle à retenir : **toute écriture directe d'un champ tenu est retenue par la base.** La collecte, le repli
REST, une fusion de doublons, un rattrapage ou une requête à la main peuvent réécrire la colonne : la base remet
la valeur tenue. Une seule fonction pose ou retire une pièce : la projection.

Seconde règle, depuis le lot R2a : **le retour d'une valeur retirée, remplacée ou opposée est écarté.** La base
se souvient des anciennes valeurs tenues (mémoire d'écho) : 7 jours pour une valeur retirée ou remplacée, la vie de
la vente pour une valeur opposée ou dont l'autorisation d'affichage est retirée. Ce n'est pas une interdiction de
la valeur : passé ce délai l'annonce peut la redonner, et une autre pièce qui dit la même valeur peut être
acceptée, même après une opposition (question ouverte pour le lot R2c).

## Les objets

| Objet                                                                    | Rôle                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `auction_fact_fields`                                                    | Les cinq champs (surface, terrain, nombre de pièces, occupation, dates de visite), leurs colonnes, leurs tolérances, `hold_enabled` et `on_listing_change`. Les visites sont verrouillées par contrainte (non tenables).                                                                   |
| `auction_fact_source_precedence`                                         | Rang et droit de tenir par origine : administrateur 10, formulaire d'avocat 20, email d'avocat 30, document 50 ; l'annonce (60) ne tient jamais (contrainte).                                                                                                                              |
| `auction_fact_claim_decisions`                                           | Journal en ajout seul des décisions (acceptée, rejetée, retirée, opposition, contredite), avec le rattachement au lot. Le statut d'une observation est sa **dernière** décision, dans l'ordre de `seq`. Aucun texte libre.                                                                 |
| `auction_sale_field_hold_events`                                         | File de relecture en ajout seul : l'annonce a changé sur un champ tenu, pièce posée, retirée ou refusée par la fiche, contradiction, retour écarté d'une ancienne valeur tenue (`echo_suppressed`).                                                                                        |
| `app_private.fact_registry_seq`                                          | Séquence commune aux deux journaux : l'ordre entre une décision et un évènement se lit dans `seq`, jamais dans une date.                                                                                                                                                                   |
| `auction_sales.held_fields`                                              | Par champ : une entrée tenue (valeur, pièce, décision, origine, rang, jour de réception, tolérance, réglage, bloc `listing`, colonnes voisines, mémoire d'écho) ou une entrée libérée (mémoire d'écho, valeurs rendues, colonnes voisines, note de blocage). Nulle si rien n'est mémorisé. |
| `app_private.project_sale_fields`                                        | La projection : pose et retire les pièces.                                                                                                                                                                                                                                                 |
| `aaab_auction_sales_hold_projected_fields`                               | Le déclencheur de retenue. Il écrit aussi `held_fields` : dernière valeur connue de l'annonce, libération d'un champ, échéance de la mémoire d'écho.                                                                                                                                       |
| `public.get_sale_field_baselines`                                        | Pour la fusion de doublons de la collecte : les colonnes et la valeur d'annonce des champs tenus. Serveur seul.                                                                                                                                                                            |
| `public.check_fact_registry_consistency`                                 | Le contrôle quotidien, en lecture seule, par page ; `public.sync_fact_registry_alerts` enchaîne les pages et en fait des alertes opérationnelles.                                                                                                                                          |
| `public.accept_auction_fact_claim`, `reject_…`, `withdraw_…`, `oppose_…` | Les quatre décisions d'un administrateur (lot R2b). Aucun droit d'exécution avant le lot R2c. Elles appellent `app_private.decide_auction_fact_claim`, seule fonction qui écrit une décision.                                                                                              |
| `app_private.lock_sale_for_registry`                                     | Le verrou de ligne de la vente, pris avant toute écriture du registre, sous 3 secondes (`sale_busy` au-delà).                                                                                                                                                                              |
| `public.reproject_fact_registry_drift`                                   | La relance planifiée de la projection, appelée par la tâche quotidienne avant le contrôle, fermée par défaut (`app_private.fact_registry_switches`). Serveur seul.                                                                                                                         |

Les quatre tables sont fermées aux rôles de l'API (RLS sans politique, lecture seule pour `service_role`),
n'ont aucune clé étrangère vers `auction_sales` (le journal survit à une fusion et à la purge de la vente) et ne
sont lues par aucune vue. `held_fields` n'est accordée à aucun rôle du navigateur, n'est jamais recopiée dans
`auction_sale_history` et n'est rendue par aucune RPC (les deux RPC de dérogation de complétude rendent six
clés, plus la ligne entière).

## Les journaux

- **Ordre.** La colonne `seq` ordonne les décisions et les évènements. Elle vient de la séquence commune
  `app_private.fact_registry_seq`, imposée par le déclencheur d'insertion de chaque journal : un numéro fourni
  par l'écrivain est remplacé, et sans le déclencheur l'insertion échoue. Les dates `decided_at` et `created_at`
  sont imposées par la base (`clock_timestamp()`) et ne servent jamais à ordonner. Pour une vente, l'ordre de
  `seq` est l'ordre réel, parce que toute écriture du registre se fait sous le verrou de ligne de la vente.
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
  observation ne peuvent être insérées que par le rôle propriétaire de la projection. Il en va de même de toute
  observation de l'extracteur `information_agent`, ou qui porte `information_agent_fact_id` : le classement
  range aussi en « email d'avocat » une observation `manual_review`, `email_attachment` ou `portal_upload` qui
  porte ce triplet, celui du pont existant (qui s'exécute en propriétaire, et passe).
- **Libellé du lot.** `lot_ref` suit un motif structurel, calé sur les libellés que la collecte lit (« lot 2 »,
  « lots 1 et 2 », « Lot n° 3 », « 2ème lot ») : un à quatre numéros de un à trois chiffres, sans zéro initial,
  séparés par « et », « , », « - » ou « à », jamais un mot libre. Sont refusés : un nom, une adresse, un numéro
  de plus de trois chiffres (téléphone, année, code postal), une date écrite avec « / ». N'est pas refusée : une
  suite de deux à quatre groupes de un à trois chiffres (« 612-345-678 »), qui a la forme exacte d'une liste de
  lots (« lots 685,686,687 »). Douze chiffres et quatre lettres au plus.
  **Contrat de l'écrivain (fonction de décision du lot R2b).** Avant d'écrire `lot_ref`, la fonction : remplace
  toute espace insécable (U+00A0, U+202F) par une espace ordinaire, réduit les suites d'espaces à une seule et
  retire celles du début et de la fin ; puis, si le libellé ne passe pas le motif, écrit **NULL** au lieu
  d'échouer (le rattachement au lot reste porté par `lot_attachment` et `lot_id`). Le refus de « lot unique »,
  « premier lot », « lot B » ou d'un numéro de lot à quatre chiffres est voulu : le motif n'est pas élargi pour
  eux, ils donnent NULL. La fonction ne tronque pas et ne réécrit pas un libellé pour le faire passer.

## Les décisions

Quatre fonctions publiques, une par décision : accepter, rejeter, retirer, enregistrer une opposition. Elles n'ont
**aucun droit d'exécution** au lot R2b (ni `anon`, ni `authenticated`, ni `service_role`). Chacune fixe son type de
décision et appelle `app_private.decide_auction_fact_claim`, seule fonction de la base qui insère dans le journal
des décisions, et qui fait, dans cet ordre :

1. **L'auteur.** Il est lu dans le jeton, `(select auth.uid())`, jamais dans un paramètre, et
   `public.is_admin()` doit être vrai. Sinon `admin_required`.
2. **Le second facteur du registre.** Réglage `decisions_require_second_factor` de
   `app_private.fact_registry_switches`, **exigé par défaut** (une ligne absente vaut « exigé ») : un jeton qui
   n'est pas `aal2` est refusé (`second_factor_required`), même si l'interrupteur global `admin_mfa_required` est
   éteint. Seul le propriétaire le lève, sans migration de code, par
   `select app_private.set_fact_registry_decisions_second_factor(false)`.
3. **Les déclencheurs.** `app_private.assert_fact_registry_triggers()` : sans retenue en place, rien n'est écrit
   (`registry_unavailable`).
4. **Les plafonds.** Vingt décisions par administrateur sur l'heure écoulée
   (`app_private.fact_registry_hourly_decision_limit()`), sinon `rate_limited` ; cinq décisions définitives
   (opposition, retrait pour autorisation retirée) sur 24 heures
   (`app_private.fact_registry_daily_final_decision_limit()`), sinon `final_rate_limited`. Un verrou consultatif de
   transaction par auteur est pris avant les deux comptes : ils sont exacts, même en rafale.
5. **Les verrous.** La vente d'abord (`app_private.lock_sale_for_registry`), puis l'observation. Toute la fonction
   tourne sous un délai de verrou de 3 secondes, réglage de la fonction que PostgreSQL rend à l'appelant à la
   sortie : chaque attente de verrou est bornée à 3 secondes (un verrou de ligne peut en compter deux), `sale_busy`
   au-delà. Un lot de publication de la collecte tient une vente 20 à 29 secondes : l'écran réessaie. Si
   l'observation a changé de vente entre la lecture et le verrou, `retry`.
6. **La transition**, jugée sur la dernière décision de l'observation :

   | Décision   | Dernière décision admise                                                                                       |
   | ---------- | -------------------------------------------------------------------------------------------------------------- |
   | accepter   | aucune ; ou `rejected`, `withdrawn`, `contradicted`, `accepted` (correction du lot), en nommant cette décision |
   | rejeter    | aucune, `accepted`, `contradicted`                                                                             |
   | retirer    | `accepted`                                                                                                     |
   | opposition | toute sauf `opposed`                                                                                           |

   Sinon `invalid_transition`. Deux décisions sont **définitives** : après une opposition (`opposed_final`) ou un
   retrait pour autorisation retirée (`withdrawal_final`), l'observation n'est plus jamais acceptée. C'est la
   règle de la projection, qui garde leur valeur en mémoire d'écho sans échéance.

7. **Les refus propres à l'acceptation.** L'origine doit pouvoir tenir le champ : la fonction ne nomme aucune
   origine, elle lit `auction_fact_source_precedence.can_hold` (`origin_cannot_hold` sinon). L'origine « document »
   y est fermée par le lot R2b ; le lot R3 la rouvrira par une migration. Une surface sur une vente de terrain est
   refusée (`field_not_applicable`), par la définition commune `app_private.sale_is_land_sale`. Une valeur que le
   registre ne peut pas tenir est refusée (`invalid_argument`).
8. **L'écriture.** Pour rejeter, retirer ou s'opposer, le rattachement au lot reprend celui de la dernière
   décision. Le fait de l'agent, la nature du destinataire et la date de réception de la dernière décision sont
   repris, pour qu'une correction du lot ne fasse pas tomber la provenance ; sauf quand l'autorisation d'affichage
   est retirée : ni ce retrait ni les décisions qui le suivent ne la reprennent. Les motifs, les rattachements et
   le format de `lot_ref` ne sont pas recopiés dans la fonction : les contraintes de la table jugent.
9. **La projection de toute la vente**, dans la même transaction.

**Erreurs.** Liste fermée, le message est le code, sans détail ni indice : `admin_required`,
`second_factor_required` (42501) ; `invalid_reason_code`, `invalid_lot_attachment`, `invalid_argument` (22023) ;
`claim_not_found`, `sale_not_found` (P0002) ; `invalid_transition`, `opposed_final`, `withdrawal_final`,
`claim_detached`, `origin_cannot_hold`, `field_not_applicable`, `registry_unavailable` (55000) ; `rate_limited`,
`final_rate_limited` (53400) ; `sale_busy` (55P03) ; `retry` (40001) ; `registry_write_failed` (P0001) pour toute autre erreur. La
fonction ne lit d'une erreur que son code et le nom de la contrainte, qu'elle écrit au journal du serveur : le
détail de PostgreSQL peut porter une ligne entière de `auction_sales`.

**Retour.** `claim_id`, `decision_id`, `decision`, `sale_id` (la vente projetée), `field_key`, `state` (état du
champ après la projection).

**Champ que le registre ne tient pas** (mise à prix, date de vente, type de bien). La décision est admise et
enregistrée, rien n'est affiché (`state` nul) : c'est la règle du plan (section 10, « enregistrés, non affichés »)
et de l'annexe 08 (point 1). L'origine doit alors pouvoir tenir au moins un champ.

**Observation détachée.** Après une fusion, l'observation n'a plus de vente. Elle se décide pour la vente que nomme
sa dernière décision (la vente absorbée), et c'est la vente conservée qui est verrouillée et projetée. Une
observation détachée jamais décidée ne peut plus l'être (`claim_detached`) : la collecte la réémet pour la vente
conservée.

**`public.review_auction_fact_claim`** (relecture des observations de la collecte, déjà en service) verrouille la
vente avant l'observation, par la même fonction de verrou et sous le même délai, lit la vente par colonnes nommées,
et refuse une observation d'origine réservée (professionnel, saisie d'un administrateur) ou déjà décidée au
journal. Elle ne tient jamais un champ. L'application traduit `55P03` et `40001` en « Import en cours sur cette
vente, réessayez dans une minute. »

**Règle pour le lot R2c.** Le droit d'exécution des quatre fonctions ira à `authenticated` **seul**, jamais à
`service_role` ni à `anon` : l'auteur est lu dans le jeton de l'administrateur. Les invariants de sécurité refusent
aujourd'hui tout droit sur ces fonctions, toute fonction qui les enveloppe, toute écriture du jeton de la requête
par une migration, et épinglent le corps de la fonction de décision par une empreinte.

## Écran de décision

Côté application du lot R2c. Il ne sert à rien tant que la partie base n'a pas ouvert le droit d'exécution des
quatre fonctions à `authenticated` : d'ici là toute décision répond « Action non autorisée. ».

**Où.** Admin › Agent IA, onglet « Réponses » (`/admin/agent-ia?onglet=reponses`), panneau « Observations à
décider » (`src/components/admin/AdminFactClaimDecisionPanel.tsx`), sous « Faits à vérifier ». Sans vente choisie,
la file montre les observations d'origine réservée (réponse d'un professionnel, saisie d'un administrateur). Avec
l'identifiant ou l'adresse d'une fiche, elle montre toutes les observations de cette vente.

**Ce qui est montré**, par observation : le champ, la valeur proposée, la valeur que la fiche affiche aujourd'hui
(la colonne de la vente), la nature de la pièce, le lien vers la source s'il est en http(s), la dernière décision
et les actions permises. Ni citation de la pièce, ni auteur de la décision, ni `held_fields`. L'état affiché est
la **dernière décision** (« Dernière décision : acceptée »), pas l'état du champ : une pièce acceptée peut ne pas
tenir le champ (champ hors registre, pièce de rang inférieur, annonce qui l'a délogée). Seul le message qui suit
une acceptation lit l'état réel rendu par la base. Pour un champ sans colonne connue de l'écran, la valeur
affichée est dite « Non comparée ici ».

**Actions**, proposées selon la dernière décision (`src/lib/fact-claim-decisions.ts`, seule copie de la table des
transitions et des motifs côté application ; la base reste juge) :

| Dernière décision                 | Actions proposées          | Saisie demandée                                  |
| --------------------------------- | -------------------------- | ------------------------------------------------ |
| aucune, contredite                | accepter, rejeter, opposer | accepter : rattachement au lot ; rejeter : motif |
| acceptée                          | rejeter, retirer, opposer  | motif                                            |
| rejetée, retirée                  | accepter, opposer          | rattachement au lot                              |
| retirée pour autorisation retirée | opposer                    |                                                  |
| opposition                        | aucune                     |                                                  |

Une opposition et un retrait pour autorisation retirée demandent de cocher « J'ai compris que cette décision est
définitive. » : aucune annulation n'existe. Une acceptation nomme la décision vue à l'écran
(`p_supersedes_decision_id`) : si une autre l'a suivie, la base refuse. La correction du lot d'une observation déjà
acceptée n'est pas proposée par l'écran. L'opposition part avec le motif par défaut de la base.

**Route.** `GET` et `POST /api/admin/fact-claims/decisions` (`src/lib/admin-fact-claim-decisions.ts`). Jeton porteur
dans l'en-tête `Authorization` (pas de cookie, donc pas de requête intersite possible), rôle administrateur vérifié
avant la lecture du corps, corps strict. La lecture passe par le rôle de service. **La décision est écrite avec le
client Supabase de la session** (`auth.supabase`, clé publique et jeton de l'administrateur), jamais avec le client
de service : la base lit l'auteur dans le jeton. Après chaque décision, réussie ou refusée, l'écran relit la liste.
Il ne réessaie pas seul.

**Messages.** Une seule traduction des erreurs de la base, `src/lib/fact-claim-database-errors.ts`, partagée avec la
route de relecture. Le code de la base et son SQLSTATE ne partent jamais vers le navigateur ; une erreur hors liste
donne le message générique de la route (500), y compris un `55000` au code inconnu : seule la route de relecture
le lit comme « déjà traité ». Le journal du serveur n'en garde que le SQLSTATE et, s'il a la forme d'un code, le
message. Le test `src/lib/fact-claim-database-concordance.test.ts` lit les migrations du registre et compare les
codes levés, les motifs, les rattachements et les natures réservées à leurs copies côté application.
`decision_in_progress` y est déclaré « annoncé » tant que sa migration n'est pas sur `main`.

| Code de la base                                                     | HTTP | Message                                                                                            |
| ------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------- |
| `sale_busy`, `retry`                                                | 409  | Import en cours sur cette vente, réessayez dans une minute.                                        |
| `invalid_transition`                                                | 409  | Cette observation a déjà été traitée.                                                              |
| `opposed_final`, `withdrawal_final`                                 | 409  | Décision définitive, elle ne peut plus être modifiée.                                              |
| `decision_in_progress`                                              | 409  | Une autre décision est en cours avec votre compte. Attendez quelques secondes, puis réessayez.     |
| `origin_cannot_hold`                                                | 409  | L'origine de cette observation ne permet pas d'afficher sa valeur sur la fiche. […]                |
| `field_not_applicable`                                              | 409  | Une surface bâtie ne peut pas être acceptée sur une vente de terrain.                              |
| `claim_detached`                                                    | 409  | Cette observation n'est plus rattachée à une vente (doublons fusionnés). […]                       |
| `admin_required`                                                    | 403  | Action réservée aux administrateurs.                                                               |
| `second_factor_required`                                            | 403  | Cette décision demande la double authentification. […]                                             |
| `rate_limited`                                                      | 429  | Plafond de décisions atteint pour cette heure. Réessayez plus tard.                                |
| `final_rate_limited`                                                | 429  | Plafond de décisions définitives atteint pour aujourd'hui. Réessayez demain.                       |
| `claim_not_found`, `sale_not_found`                                 | 404  | Observation introuvable. / Vente introuvable.                                                      |
| `invalid_reason_code`, `invalid_lot_attachment`, `invalid_argument` | 400  | Motif non reconnu. / Rattachement au lot non reconnu. / Cette valeur ne peut pas être affichée […] |
| `registry_unavailable`                                              | 503  | Le registre des pièces est indisponible. Aucune décision n'a été enregistrée. […]                  |
| `registry_write_failed`                                             | 500  | La décision n'a pas pu être enregistrée et rien n'a été modifié. […]                               |

## La projection

`app_private.project_sale_fields(vente, champs, appliquer, indices)` n'est exécutable par aucun rôle de l'API.
Avec `appliquer = false` (défaut) elle simule sans rien écrire. Pour chaque champ :

1. elle prend la dernière décision de chaque observation de la vente (et des ventes qu'elle a absorbées par
   fusion) et ne garde que les acceptations d'un lot identifié (`single_lot`, `matched`) dont l'origine peut
   tenir le champ. Une observation sans décision au journal, un document resté candidat, une pièce d'annonce
   ou un lot inconnu ne tiennent rien ;
2. elle écarte toute pièce que l'annonce a délogée (évènement `listing_changed_released`) : il faut une
   nouvelle décision humaine, de `seq` plus grand que l'évènement, pour qu'elle reprenne le champ. Un évènement
   de la vente de la décision l'écarte s'il la nomme ou la suit. Un évènement de la vente projetée (la vente
   conservée après une fusion) écarte toute décision plus ancienne, y compris celles d'une vente absorbée. La
   libération d'une vente absorbée ne déloge pas les pièces de la vente conservée ;
3. elle ordonne par rang, puis par date (réception, à défaut décision). Au même rang, une pièce plus récente
   de la même origine (même dossier) remplace la précédente ; deux origines différentes qui disent autre chose
   (hors tolérance) sont une contradiction : rien ne bascule, un évènement `conflicted` part en relecture ;
4. elle écrit en un seul `UPDATE` les colonnes, `held_fields` et `updated_at` (toujours plus grand que le
   précédent, même si l'horloge recule). Sans changement elle n'écrit rien. Quand plus aucune pièce ne tient un
   champ (retrait, opposition, rejet), elle restaure la valeur de l'annonce gardée dans le bloc `listing`, et
   l'entrée passe à l'état `released` avec sa mémoire d'écho.

**Libellés de surface.** Une pièce de surface écrit `surface_source = 'fact_registry'` et `app_surface_kind =
'built'` (« surface bâtie de nature non précisée », valeur que la collecte emploie déjà). L'origine de la pièce
reste dans `held_fields` : ces deux colonnes sont lues par les vues publiques. Greffe, notaire, document : aucune
origine nommée ne devient publique.

**Fusion de doublons.** Rien n'est déplacé dans le registre : les décisions gardent l'identifiant de la vente
absorbée, les observations sont détachées, et la projection de la vente conservée lit les ventes qu'elle a
absorbées. Depuis le lot R2b, `app_private.carry_sale_user_data_to_merged_sale` (déclencheur avant suppression de la
vente absorbée) appelle elle-même la projection de la vente conservée, avec les entrées `held_fields` de la vente
absorbée en **indice** (quatrième paramètre). L'appel n'a lieu que si la vente absorbée tient ou mémorise un champ,
ou si une décision la nomme, elle ou une vente qu'elle avait elle-même absorbée (fusion en chaîne). Le journal
`information_agent_fact_publications` suit la vente conservée. Quand la projection, appelée par une fusion, pose
ainsi une pièce dont la décision nomme une autre vente, elle journalise un évènement `merge_carried` (valeur,
décision, vente d'origine) ; le contrôle quotidien les compte sur 24 heures. Une prise ultérieure de la même pièce,
par une décision ou par la relance, n'est pas une fusion : elle n'émet pas cet évènement.

Une fusion écrit la vente conservée avant de supprimer l'absorbée : ses colonnes peuvent déjà porter la valeur que
tenait l'absorbée (colonne « contaminée »). La contamination se juge à l'égalité exacte, sur chacune des colonnes
de valeur du champ : une annonce à 53,5 m² n'est pas la pièce à 54 m². L'indice sert à ne pas prendre la valeur de
la pièce pour une valeur d'annonce :

| Situation                                                                        | Effet sur la vente conservée                                                                                                                                |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Une pièce prend le champ, une colonne porte la valeur ou un écho de l'indice     | Champ tenu ; le bloc `listing` est celui de l'indice (la vraie valeur d'annonce), pas l'instantané des colonnes                                             |
| Une pièce prend le champ, aucune colonne contaminée                              | Champ tenu ; le bloc `listing` est l'instantané des colonnes                                                                                                |
| Aucune pièce ne prend le champ, l'absorbée le tenait, une colonne est contaminée | Les colonnes du champ reprennent le bloc `listing` de l'indice ; entrée `released`, `released_by: merge`, avec `restored` ; évènement `projection_released` |
| Aucune pièce ne prend le champ, aucune colonne contaminée                        | Colonnes inchangées ; entrée `released`, `released_by: merge`, sans `restored` : seule la mémoire est reprise                                               |
| La vente conservée tient déjà le champ, les deux pièces se contredisent          | Rien ne bascule (`conflicted`), relecture                                                                                                                   |
| L'indice est à l'état `released`                                                 | Seule sa mémoire d'écho est reprise, avec ses échéances ; rien n'est affirmé des colonnes                                                                   |

« Aucune pièce ne prend le champ » : la pièce de l'absorbée est délogée par l'annonce de la vente conservée,
contredite, refusée par le nombre de chambres, ou la vente conservée est un terrain. Dans tous les cas, la valeur
que tenait l'absorbée entre en mémoire d'écho (7 jours ; sans échéance si sa pièce a reçu une opposition), sauf si
c'est elle qui tient le champ. Une valeur déjà en mémoire n'est pas rajoutée : rappeler la projection avec le même
indice ne change rien.

Elle n'échoue jamais sur la contrainte « pièces >= chambres ». Une pièce qui compte moins de pièces que la fiche
ne compte de chambres n'est pas posée : état `blocked`, évènement `projection_blocked`, et les autres champs
sont projetés. Une valeur d'annonce à restaurer qui serait devenue incompatible est remplacée par NULL.

**Vente de terrain.** Une seule définition, `app_private.sale_is_land_sale`, lue par la décision, la projection
et le contrôle quotidien, et qui est celle de l'application : `property_type`, `surface_scope` ou
`app_surface_kind` vaut `land`. Quand la surface est tenue, la colonne `app_surface_kind` porte `built` (écrit par
la projection) : la nature lue est alors celle de l'annonce, gardée dans le bloc `listing` de l'entrée. Sur une
vente de terrain, la projection ne pose ni ne garde `property.surface_m2` : l'application afficherait la surface
bâtie d'une pièce comme celle du terrain. État `blocked` (raison `land_sale`). Si une pièce toujours acceptée
tenait la surface avant le reclassement de la vente, le champ est libéré (`released_by: blocked`) et la valeur
d'annonce revient. Tant que personne n'a reprojeté la vente, le contrôle quotidien la signale (dérive et
`stale_listing`).

**Qui relance la projection.** La projection lit des colonnes que la retenue ne tient pas : un reclassement en
terrain, ou une écriture de `bedrooms_count` par la collecte (une pièce « 3 pièces » bloquée par 6 chambres tient
le champ dès que les chambres passent à 2), change ce qu'elle déciderait. Aucun déclencheur ne la rappelle (le
déclencheur de retenue reste passif). Deux relances, depuis le lot R2b :

- toute décision d'administrateur reprojette la vente entière ;
- la tâche quotidienne `fact-registry-check` appelle `public.reproject_fact_registry_drift()` avant le contrôle,
  par un appel à part (sa propre transaction : ses verrous sont rendus avant que le contrôle ne commence). Pour
  chaque vente du registre dont la simulation rend `changed`, elle applique la projection.

**La seconde est une écriture de fiche lancée par une tâche planifiée.** Elle ne fait que réappliquer des décisions
humaines déjà acceptées : elle n'écrit aucune décision, le mode de publication reste `manual`, les verrous de la
publication automatique ne bougent pas. Elle est **fermée par défaut** : réglage
`app_private.fact_registry_switches`, ligne `scheduled_reprojection` (une ligne absente vaut « fermé »), que le
propriétaire ouvre ou referme sans migration de code par
`select app_private.set_fact_registry_scheduled_reprojection(true ou false)`. Tant qu'elle est ouverte, l'alerte
`fact_registry.reprojection_enabled` le rappelle. Elle ne fait rien tant que le journal des décisions est vide ni
quand un déclencheur du registre manque. Elle travaille en deux temps : elle simule d'abord toutes les ventes du
registre sans aucun verrou, puis applique la projection aux ventes en dérive, seul moment où des verrous de ligne
sont tenus. Elle est bornée : 30 ventes écrites ou occupées par passe, puis la passe s'arrête ; la tâche enchaîne
les passes tant qu'il reste du temps pour le contrôle, et le passage suivant reprend le reste ; après trois ventes
occupées par la collecte, la passe s'arrête aussi. Une vente dont la simulation ou la projection échoue ne compte
pas dans la borne et n'arrête pas la passe, pour ne pas priver les suivantes de leur tour : elle est rendue avec
son code SQLSTATE et le nom de la contrainte, sans message. Elle est journalisée (évènement
`drift_reprojected`, un par champ dont l'entrée a changé, à défaut par champ tenu). Fermée, la dérive reste
signalée par l'alerte critique `fact_registry.projection_drift`.

Une entrée marquée `conflicted` garde la valeur affichée tant que la pièce qui la porte est encore acceptée ;
quand la contradiction cesse, l'entrée repasse à `held` avec un évènement `projection_held`. Un simple
changement de réglage (`on_listing_change`, tolérance) met l'entrée à jour sans évènement.

Ordre des verrous pour tout appelant : la vente (`for no key update`), puis les observations, puis les
décisions.

## La retenue

Le déclencheur est passif : il ne lit ni les observations, ni les décisions, ni la préséance, ni
`raw_payload`, et n'appelle jamais la projection. Il ne s'exécute que pour une vente dont `held_fields` n'est pas
nulle, ou pour une écriture qui apporte le libellé réservé `surface_source = 'fact_registry'` (clause `WHEN`).
Avec I la valeur entrante, H la valeur tenue, L la dernière valeur connue de l'annonce et E la mémoire d'écho :

| Écriture entrante sur un champ tenu                                  | Effet                                                                                                                               |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| I ne dit rien (nulle, nombre nul ou négatif, occupation « unknown ») | H reste, L n'est **pas** vidée, sans évènement. L'entrée note seulement que l'annonce se tait (`listing_silent_since`).             |
| I égale à H, à la tolérance près                                     | H reste : recopie par la collecte, ou confirmation.                                                                                 |
| I égale à L, à la tolérance près                                     | H reste : l'annonce n'a pas changé (la note de silence est retirée).                                                                |
| I égale à une valeur de E                                            | H reste, L inchangée, évènement `echo_suppressed` (un par valeur et par décision).                                                  |
| Autre valeur : l'annonce a changé                                    | Évènement en relecture. `keep_and_review` (défaut) : H reste, L est mise à jour. `listing_wins_and_review` : I passe, champ libéré. |

Sur un champ libéré (`released`), une valeur entrante différente de la colonne actuelle (inégalité exacte) et
égale, à la tolérance près, à une valeur de E ne passe pas (le groupe entier pour la surface), avec un évènement
`echo_suppressed` ; toute autre valeur passe comme pour un champ libre. La colonne actuelle n'est pas prise pour
une valeur d'annonce à laquelle comparer I : une pièce qui confirme l'annonce à la tolérance près (annonce
50 m², pièce 50,4 m²) reviendrait sinon après son retrait ou son opposition.

- **Libellé réservé.** `surface_source = 'fact_registry'` n'est écrit que par la projection. Hors projection,
  une écriture qui l'apporte sur une surface que rien ne tient (champ libéré, ou vente sans aucune entrée)
  recopie une ligne lue quand une pièce tenait le champ : le groupe de la surface garde ses valeurs actuelles,
  quelle que soit la valeur apportée, avec un évènement `echo_suppressed`.
- **Note de blocage.** À chaque retenue sur un champ libéré, l'entrée note `echo_blocked_since` (première
  retenue) et `echo_blocked_at` (dernière). Si l'annonce dit vraiment la valeur retenue (elle avait rejoint la
  pièce avant le retrait ou l'opposition, et la fiche est revenue à une valeur d'annonce périmée), chaque
  passage de la collecte est retenu : la note reste et l'alerte `fact_registry.echo_blocked` reste ouverte.
  Après un écho isolé, la note sort d'elle-même 7 jours après la dernière retenue.

- **Surface.** Les cinq colonnes sont retenues en bloc. L'annonce a changé dès qu'une des deux colonnes de
  valeur (`app_surface_m2`, `surface_m2`) dit autre chose que H, que sa propre dernière valeur connue et que E.
  Une colonne n'entre dans L que si **sa propre** classe est « l'annonce a changé » : dans une écriture mixte,
  l'autre colonne peut porter H ou un écho, qui reviendrait au retrait comme valeur d'annonce. À la libération
  par l'annonce, une colonne que l'écriture n'a pas touchée, ou qui porte H ou un écho, reprend sa valeur du
  bloc `listing`.
- **Colonnes voisines.** `habitable_surface_m2` et `carrez_surface_m2` (pour la surface), `surface_m2` et
  `app_surface_m2` (pour le terrain, quand la surface n'est pas tenue) ne sont jamais tenues, mais la valeur
  d'une pièce n'y entre pas : une valeur entrante égale à H ou à une valeur de E y est remplacée par la colonne
  actuelle, champ tenu ou libéré. L'écriture écartée est journalisée par un évènement `echo_suppressed` qui
  nomme la colonne (`{"carrez_surface_m2": 54}`), un par valeur et par décision. Exception : la valeur que la
  colonne portait déjà à la première prise (clé `neighbors` de l'entrée, par exemple une surface Carrez lue dans
  un document et égale à la pièce) est celle de l'annonce et passe.
- **Chambres.** Quand une écriture apporte plus de chambres que le nombre de pièces tenu : en
  `keep_and_review`, la pièce reste, le nombre de chambres entrant n'est pas pris et un évènement
  `listing_changed_kept` porte les deux nombres ; en `listing_wins_and_review`, le champ est libéré (valeur de
  l'écriture ou du bloc `listing` si elle est compatible, sinon NULL). L'écrivain n'échoue jamais, même s'il
  n'écrit que `bedrooms_count`. Si le nombre de pièces entrant est un écho, le champ reste tenu dans les deux
  réglages et le nombre de chambres venu avec lui n'est pas pris.
- **Évènements bornés.** Un évènement par valeur entrante et par décision : une annonce qui oscille entre
  deux valeurs, ou un écho répété, n'ajoutent rien à la file.
- **Écriture de `held_fields`.** Hors projection, elle est refusée (`42501`), à la modification comme à
  l'insertion. Le marqueur de transaction que pose la projection n'est pas un contrôle d'accès : une seconde
  garde refuse tout changement de `held_fields` par un rôle qui n'est pas le propriétaire de la projection,
  marqueur posé ou non.
- **Garde du marqueur.** Le marqueur ouvrait aussi la retenue des colonnes tenues à tout rôle capable de le
  poser. Le déclencheur `aaab_auction_sales_held_fields_marker_guard` refuse (`42501`) l'écriture d'une colonne
  surveillée d'une vente du registre quand le marqueur désigne cette vente et que le rôle n'est pas le
  propriétaire de la projection. Aucun appel quand rien n'est tenu.

Le déclencheur porte le préfixe `aaab_` pour passer avant les déclencheurs `BEFORE UPDATE` qui jugent la
ligne : une réécriture annulée ne date pas `content_changed_at`.

## La mémoire d'écho

La collecte recopie de la base vers la base (annexe 09, section 2.2) : un import commencé avant une décision
peut réécrire la valeur que cette décision vient de retirer ou de remplacer. La collecte a sa propre garde
d'écho, exacte, à l'écriture. La base garde un **filet** : la mémoire d'écho.

- **Forme.** Clé `echo` de l'entrée du champ : les anciennes valeurs tenues, la plus récente d'abord, chacune
  avec son échéance `until`. Une entrée libérée (`state: released`) garde cette mémoire, `released_by`, la
  décision qui tenait le champ, la tolérance, les valeurs rendues aux colonnes (`restored` : celles de
  l'annonce, pour que le contrôle quotidien distingue l'annonce d'un écho revenu), le relevé des colonnes
  voisines (`neighbors`) et, s'il y a lieu, la note de blocage. Tout lecteur de « ce que la vente tient » filtre
  `state in ('held', 'conflicted')`.
- **Durée.** 7 jours (`app_private.sale_field_echo_memory()`), pour un retrait, un rejet, une contradiction,
  un remplacement, un blocage ou une libération par l'annonce. **Sans échéance**, donc autant que la vente, pour
  une valeur dont la pièce a reçu une opposition ou un retrait pour autorisation retirée.
- **Places.** Cinq valeurs à échéance au plus : au-delà, la plus ancienne sort, jamais celle qui vient d'entrer.
  Une valeur sans échéance n'est jamais chassée et ne compte pas dans ces cinq places : il y en a autant que
  d'oppositions prononcées par des personnes sur ce champ de cette vente. Une limite commune ferait osciller la
  liste d'une projection à l'autre, ou oublier une opposition.
- **Opposition tardive.** Une opposition bloque le retour de la valeur pour la vie de la vente, même prononcée
  après l'expiration de l'entrée : si la pièce a tenu le champ, la projection recrée une entrée libérée
  (`released_by: opposed`). La valeur d'une pièce qui n'a jamais été affichée n'est mémorisée que si le champ a
  déjà une entrée.
- **Échéance.** Ce qui est échu sort à la prochaine écriture d'une des colonnes surveillées de la vente
  (retenue) ou à la projection suivante qui écrit. Une entrée libérée sans mémoire disparaît ; `held_fields`
  redevient nulle quand il ne reste rien. Aucune tâche planifiée n'écrit. L'échéance seule n'est pas un
  changement : la simulation rend `changed = false` et la projection ne réécrit pas la vente pour cela. Une
  vente qui n'est plus importée garde donc une entrée échue, que le contrôle quotidien ignore.
- **Indicateur.** L'évènement `echo_suppressed` signale un chemin que la garde de la collecte a oublié. Il doit
  rester à zéro ; le contrôle quotidien en fait une alerte.

## Le contrôle quotidien

`/api/cron/fact-registry-check` (Vercel Cron, 05:28 UTC, attendue par `cron.stale` toutes les 27 heures) appelle
`public.reproject_fact_registry_drift()` (la relance, fermée par défaut) puis
`public.sync_fact_registry_alerts()`, toutes deux sans paramètre. Le contrôle tourne même quand la relance a
échoué. Treize contrôles (les dix du lot R2a, la relance ouverte, les décisions définitives sur 24 heures et le
dépassement de leur plafond par un auteur), une alerte opérationnelle
`fact_registry.<contrôle>` chacun (détail dans `docs/operations/planification.md`) : dérive de la projection,
mode et fonction des déclencheurs, colonnes tenues, libellé réservé sans surface tenue (ces quatre-là sont
critiques), valeur d'une pièce dans une colonne voisine, une copie ou un champ libéré, colonne interne recopiée
dans `raw_payload`, rafale d'évènements d'écriture directe, écho écarté, valeur d'annonce retenue comme un écho,
annonce qui se tait, relance planifiée ouverte. Le rapport ne porte que des comptes et des identifiants de vente ;
le résumé gardé dans `operational_job_runs` ne porte que des comptes et des codes, et une erreur de la base n'y
laisse que son étape et son code.

Le contrôle n'écrit rien : il n'appelle la projection qu'en simulation (`false` écrit en dur ; une fonction
stable peut appeler une fonction volatile, la garantie vient donc de ce littéral, vérifié par un invariant et par
le test 889). Une vente en dérive est rejouée une fois avant d'être rendue : la simulation lit sans verrou, une
décision validée pendant la passe ne doit pas lever une alerte critique. En cas de dérive de masse, seules les
vingt premières ventes en dérive de chaque page sont rejouées : les suivantes sont comptées sans rejeu, pour tenir
le délai d'instruction (82 s mesurées pour 2 940 ventes en dérive quand toutes étaient rejouées). Une vente dont la
simulation lève est comptée en dérive, avec son code SQLSTATE, sans arrêter le contrôle. Les champs libérés sont
regardés comme
les champs tenus : la valeur d'une pièce retirée ou opposée ne doit rester ni dans une colonne, ni dans une
copie.

**Pages.** `public.sync_fact_registry_alerts()` lit une fois les ventes du registre, puis enchaîne les pages de
500 ventes : `app_private.fact_registry_page_checks` rend les cinq contrôles par vente (c'est la seule fonction du
contrôle qui appelle la projection, en simulation), et `app_private.fact_registry_report_add_page` les additionne
(compte, vingt premiers identifiants). La liste des contrôles par vente n'est écrite nulle part : ce sont ceux que
rend une page. Ce qui ne dépend pas d'une page est calculé une fois par
`app_private.fact_registry_global_checks` : déclencheurs, libellé réservé, file d'évènements, relance ouverte,
pièces reportées par une fusion sur 24 heures, et colonne interne recopiée dans `raw_payload` (lecture d'une
grande colonne, bornée aux 500 premières ventes du registre). `public.check_fact_registry_consistency(p_limit)`
garde sa signature du lot R2a : une page et les contrôles généraux, pour une lecture à la main. Les deux fonctions
appelées par la tâche portent un délai d'instruction de 120 secondes, que PostgREST applique à l'appel.

**Rapport tronqué.** Au-delà de 40 pages (20 000 ventes du registre) le rapport est partiel. La base ne synchronise
alors que les contrôles actifs (aucune alerte n'est refermée), et la tâche échoue au lieu de tenir un rapport
partiel pour complet.

**Mode des déclencheurs.** `app_private.assert_fact_registry_triggers()` lève `registry_unavailable` si l'un
des douze déclencheurs du registre manque, n'est plus en mode `always`, ou n'a plus la définition de sa
migration : fonction (nom, schéma `app_private`, mode de sécurité, réglages), évènements, colonnes, clause `WHEN`
(les constantes entre apostrophes sont comparées telles quelles). Elle lève aussi quand l'une des six tables du
registre, `auction_sales` comprise, n'a pas le propriétaire de la projection (signalée `<table>.owner`). Un
`alter table … disable trigger user` suivi d'un `enable trigger user` les remettrait tous en mode ordinaire sans
aucune erreur. Remise en état du mode seulement :
`supabase/maintenance/20261117100600_restore_fact_registry_trigger_modes.sql` ; une définition ou un propriétaire
différents se corrigent par migration. Règle pour un rattrapage : `supabase/repairs/README.md`.

## Régler le comportement

Tout se règle en données, par migration : `hold_enabled` (un champ est-il tenable), `can_hold` et `rank`
(quelle origine tient, et laquelle l'emporte), `on_listing_change`. Ce dernier réglage est recopié dans
l'entrée de `held_fields` : un changement vaut pour un champ déjà tenu à sa projection suivante. La durée de la
mémoire d'écho est dans `app_private.sale_field_echo_memory()`.

## Limites connues

- Retirer la pièce la plus récente d'un dossier rend le champ à la pièce précédente du même dossier si elle
  est encore acceptée.
- La table des fusions est tenue à plat par `carry_sale_user_data_to_merged_sale` : la projection lit un seul
  niveau.
- **Écho et vraie annonce.** Une annonce qui publie réellement une valeur de la mémoire d'écho est retenue
  jusqu'à l'échéance (7 jours), et pour toujours après une opposition. Pour l'occupation, qui n'a que trois
  valeurs, cela veut dire qu'après une opposition sur « libre », l'annonce ne peut plus afficher « libre » sur
  cette vente. Le cas se voit en relecture par `echo_suppressed`, et dure dans l'alerte
  `fact_registry.echo_blocked` tant que la collecte renvoie cette valeur. Pas de levée manuelle à ce lot.
- **Annonce qui rejoint la pièce.** Si l'annonce prend la valeur de la pièce pendant que le champ est tenu, la
  valeur d'annonce mémorisée ne change pas (la base ne distingue pas cette écriture d'une recopie). Au retrait
  ou à l'opposition, la fiche revient à l'ancienne valeur d'annonce et la vraie valeur est retenue comme un
  écho : la note de blocage et son alerte le signalent, rien ne le corrige à ce lot.
- **Tolérance après une libération.** Une nouvelle valeur d'annonce qui tombe dans la tolérance d'une valeur de
  la mémoire (annonce 50 m², pièce opposée 50,4 m², puis annonce à 50,5 m²) est retenue elle aussi.
- **Gardes par rôle.** Le chemin SQL direct de la collecte se connecte aujourd'hui avec le rôle propriétaire
  des fonctions : aucune garde par rôle ne le distingue de la projection. Pour ce chemin, la protection est la
  retenue (marqueur) et l'invariant de code. Un rôle de connexion propre à la collecte est un chantier séparé.
- **Terrain et surface principale.** Sur une vente de terrain, la collecte recopie le terrain dans
  `app_surface_m2`. La valeur d'une pièce de terrain n'entre pas dans cette colonne (colonne voisine) : la
  surface principale affichée reste celle de l'annonce pendant que le champ est tenu. À trancher avant le lot
  R2c : la projection du terrain gouverne aussi `app_surface_m2`, ou l'affichage lit le terrain.
- **Annonce qui se tait.** La valeur d'annonce mémorisée n'est pas vidée quand l'annonce cesse de donner une
  valeur : un retrait pendant le silence restaure l'ancienne valeur d'annonce, jusqu'à l'import suivant.
  L'alerte `fact_registry.stale_listing` le signale.
- **Restauration de données seules.** Les déclencheurs du registre sont en mode `always` : la garde
  d'insertion refuse une vente restaurée avec `held_fields`, et les déclencheurs de validation et d'horodatage
  renuméroteraient et redateraient les deux journaux. Procédure dans le runbook.
- **Borne du contrôle.** Au-delà de 20 000 ventes du registre (40 pages), la tâche échoue chaque jour.
- **Indice de fusion à l'état libéré.** Si la vente absorbée avait déjà libéré le champ (retrait, opposition) et que
  la fusion a écrit l'ancienne valeur de la pièce dans la vente conservée, la colonne n'est pas corrigée : seule la
  mémoire est reprise. Le contrôle quotidien le signale (`echo_suspected`).
- **Fusion par le repli REST.** La suppression de la vente absorbée verrouille la vente conservée après l'absorbée,
  hors de l'ordre par identifiant des lots SQL de la collecte : face à un lot qui tient la vente conservée et
  demande l'absorbée, PostgreSQL annule l'une des deux transactions. Le repli REST n'est pas le chemin de
  production.
- **Reclassement en terrain par la nature seule, surface tenue.** Quand la surface est tenue, la nature lue est
  celle que l'annonce avait à la dernière mise à jour du bloc `listing`. Si l'annonce change ensuite sa nature en
  « terrain » sans changer sa valeur, la retenue ne met pas ce bloc à jour : la vente n'est pas vue comme un terrain
  tant que la valeur d'annonce ne bouge pas. Un reclassement par le type de bien ou par la portée de la surface est
  vu tout de suite.
- **Plafonds et sessions simultanées.** Les deux plafonds sont exacts (verrou consultatif par auteur). En rafale,
  une session qui attend ce verrou plus de 3 secondes reçoit `sale_busy` : un refus de trop, jamais une décision
  de trop.
- **Simulation qui lève.** Une vente dont l'entrée est abîmée fait lever la projection. Ni le contrôle ni la
  relance ne s'arrêtent : la vente est comptée en dérive et rendue avec son code ; les contrôles par entrée ne la
  lisent pas. La corriger demande une migration.
- **Fusion et interblocage.** La suppression d'une vente fusionnée verrouille cette vente, puis la vente conservée,
  hors de l'ordre par identifiant des lots de la collecte : face à un lot qui tient la vente conservée et demande
  la vente fusionnée, PostgreSQL annule l'une des deux transactions, sans écriture partielle. Fiche d'incident
  dans le runbook R2b ; la suppression vente par vente côté collecte est une condition du lot R2c.

## Fait au lot R2a (points reportés par le lot R1)

- Écho de la collecte, côté base : mémoire d'écho, colonnes voisines, évènement `echo_suppressed`.
- Valeur neutre dans `app_surface_kind` et `surface_source`.
- Ordre entre les deux journaux par une séquence commune.
- Libération durable et vente absorbée (une pièce d'une vente absorbée ne reprend pas un champ que l'annonce de
  la vente conservée vient de libérer).
- Valeur d'annonce mémorisée périmée : règle du lot R1 gardée, avec la note `listing_silent_since` et l'alerte.
- Gardes par rôle en liste blanche.
- Les deux RPC d'administration ne rendent plus la ligne entière ; `auction_sale_history` ignore `held_fields`.
- Rattrapage `20261029100200` réécrit ; contrôle du mode des déclencheurs.
- `updated_at` monotone.
- Contrôle quotidien « la simulation ne change rien », et ses alertes.
- Lecture des valeurs d'annonce pour la fusion (`get_sale_field_baselines`), indices de fusion de la projection.
- Deux index (ventes du registre, unicité de l'observation d'un fait de l'agent).

Après les trois relectures du lot (base de données, code, sécurité) :

- une valeur retirée ou opposée ne revient plus quand elle est dans la tolérance de l'annonce ; libellé
  `fact_registry` réservé à la projection ;
- la valeur d'annonce mémorisée ne prend plus la valeur tenue ou un écho dans une écriture mixte ;
- note de blocage et alerte `fact_registry.echo_blocked` ; colonnes voisines relevées à la première prise, et
  journalisées quand une écriture y est écartée ;
- la projection ne tient pas la surface d'une vente de terrain ;
- mémoire d'écho : ordre, places, opposition tardive ;
- garde d'origine étendue au triplet du pont, garde du marqueur, contrôle de la fonction des déclencheurs,
  format de `lot_ref` ;
- contrôle quotidien : champs libérés, libellé réservé, rapport tronqué qui ne referme rien, fonction d'alerte
  sans paramètre, moins de faux positifs ;
- la vue `v_auction_fact_claims_read_model` ne montre que la dernière génération des observations de la collecte
  (migration `20261117100700`, à appliquer avant le passage de la collecte à la version 3). La génération se lit
  sans expression rationnelle, sous un plafond (`app_private.fact_claims_generation_ceiling()`, 3) : une
  observation isolée d'une génération plus haute ne masque rien et est elle-même masquée.

Après la contre-vérification :

- la projection est stable en une application (une opposition à une pièce jamais affichée, suivie d'une
  acceptation sur le même champ, laissait une dérive) ; test générique et essai aléatoire à graine fixe (`891`) ;
- le contrôle des déclencheurs compare aussi leur définition (évènements, colonnes, clause `WHEN`) et le mode de
  sécurité de leur fonction ;
- un seul évènement par vente quand le libellé réservé est écarté sur une vente sans entrée ;
- délai de verrou de 2 secondes avant les déclencheurs.

Après la dernière contre-vérification (exécution, PostgreSQL, sécurité) :

- ordre des verrous de `20261117100100` : la table des observations d'abord, puis les deux journaux ; délai de
  2 secondes posé avant le commentaire de colonne de `20261117100200` ;
- `lot_ref` : trois chiffres au plus par numéro, « / » retiré des séparateurs, contrat de l'écrivain ci-dessus ;
- contrôle des déclencheurs : constantes de la clause `WHEN` comparées telles quelles, réglages et schéma de la
  fonction, propriétaire des six tables ;
- vue des observations : la génération est calculée une fois par version présente, la version en est dérivée ;
- invariants : aucun `owner to` ni `reassign owned` sur un objet du registre, aucun `alter function` sur les deux
  fonctions de génération, `set_config` avec un nom littéral seulement (`set-config-literal-name`, doublé par
  une assertion du test 884 sur le corps des fonctions en base).

## Fait au lot R2b

- Quatre fonctions de décision (accepter, rejeter, retirer, opposition), sans droit d'exécution ; auteur tiré de
  `auth.uid()` ; second facteur du registre exigé par défaut ; plafond horaire ; opposition et retrait de
  l'autorisation définitifs ; origine jugée par la table de préséance (« document » fermé jusqu'au lot R3) ;
  contrat de `lot_ref` (normalisé, NULL hors motif) tenu par la contrainte de la table.
- Ordre de verrouillage (la vente d'abord) et délai de 3 secondes par attente, pour les décisions et pour
  `review_auction_fact_claim`.
- Une seule définition de la vente de terrain.
- Report des pièces lors d'une fusion, y compris en chaîne ; `information_agent_fact_publications` suit la vente
  conservée ; indice de fusion sans gagnant, contamination exacte, mémoire de l'indice, stabilité au rappel ;
  évènement `merge_carried`.
- Relance de la projection : par toute décision, et par la tâche quotidienne (appel à part, fermée par défaut).
- Contrôle quotidien par pages, contrôles généraux calculés une fois, treize contrôles (relance ouverte, décisions
  définitives sur 24 heures, plafond dépassé), état du second facteur dans le rapport, rejeu borné aux vingt
  premières ventes en dérive d'une page.
- Plafonds exacts (verrou consultatif par auteur), plafond des décisions définitives, index du journal.
- Une définition par règle : terrain, lot qui tient un champ, vente conservée, décision définitive, lecture de
  chacun des deux réglages.
- Tâche `fact-registry-check` : résumé avec les pages, la relance et l'état de son réglage ; une erreur de la base
  n'y laisse que son étape et son code.

## Reporté après le lot R2b

- Côté collecte (étape PB) : copies `properties`, `judicial_sales` et `auction_surfaces` sans les colonnes du
  registre ; fusion sur les valeurs d'annonce. **Ensuite seulement** : retirer ces copies du contrôle quotidien
  (des copies figées y donneraient un faux positif permanent ; les retirer avant ôterait une détection réelle).
- Tâche `fact-registry-check` : retirer la tolérance `skipped: migration_pending`, une fois le lot R2b appliqué
  (le code est déployé avant la migration).
- Index partiel pour la liste de relecture d'administration, si l'écart mesuré en production avant et après la
  migration `20261117100700` dépasse 100 ms (contrôle A4 du runbook R2a).
- Levée ou restitution après une opposition bloquante : une valeur d'annonce légitime, égale ou proche (à la
  tolérance du champ) de la valeur opposée, est retenue pour la vie de la vente (voir le lot R2c).
- Faux positif de `echo_suspected` quand une colonne voisine est écrite APRÈS la première prise avec une valeur
  que la retenue n'écarte pas (par exemple la valeur d'annonce d'un autre champ égale à la pièce, ou une valeur
  déjà en place qu'une pièce de remplacement vient égaler) : le relevé `neighbors` date de la première prise.
- Invariant `pipeline-no-wildcard-sale-read` : la collecte ne lit jamais la ligne entière d'une vente
  (`select=*`, `return=representation` sans liste de colonnes).

## Reste pour le lot R2c

- Le noyau de l'agent d'information écrit observation, décision et projection ; le pont est retiré.
- La mention publique lit le registre ; fonction séparée pour les origines autres que l'avocat poursuivant.
- Refus d'un bloc d'annonce marqué `information_agent_verified` à la première prise (reprise de l'existant).
- Écran de décision : fait côté application (voir « Écran de décision »). Restent la valeur d'annonce et l'état du
  champ lus dans le registre (fonction de lecture `get_admin_sale_field_registry`, qui n'existe pas encore), et la
  nouvelle tentative seule sur `sale_busy` et `retry`.
- Droits des quatre fonctions de décision ouverts à `authenticated` seul, après le choix du propriétaire sur le
  second facteur. Liste complète des conditions : `docs/runbooks/registre-des-pieces-r2b.md`, « Conditions du lot
  R2c ».
- Le noyau refuse une observation préexistante dont la vente, le champ ou la valeur diffèrent du fait de l'agent
  (l'index unique sur l'identifiant de fait ne garantit que l'unicité, pas le contenu).
- Relance planifiée : ouverte ou fermée le jour de la bascule, décision du propriétaire.
- Une autre pièce de même valeur peut-elle être acceptée après une opposition : à trancher avec le juriste.
- Surface principale d'une vente de terrain tenue (voir « Limites connues ») : les tris, les filtres et les
  ratios au mètre carré lisent `app_surface_m2`, donc l'annonce, alors que la fiche affiche le terrain de la
  pièce.
- Opposition sur un champ à peu de valeurs (occupation, nombre de pièces) : après une opposition, l'annonce ne
  peut plus afficher cette valeur sur cette vente. Levée manuelle, ou échéance pour les champs énumérés : décision
  du propriétaire du produit et d'un juriste, avant qu'une pièce d'occupation ou de pièces puisse être opposée.
- Restitution de la valeur d'annonce à la libération : si la dernière observation de la source dit la valeur que
  tenait la pièce (l'annonce avait rejoint la pièce), la rendre comme valeur d'annonce au lieu de l'ancienne.
- Normalisation des visites (jour et heure structurés), préalable à la levée de leur verrou : hors R2.

## Garde-fous

Tests pgTAP `881` (tables, droits, journaux, format du lot), `882` (retenue), `883` (projection), `884`
(séquence commune, gardes, garde du marqueur, origine forgée, mode et fonction des déclencheurs, historique, RPC,
index construits dans le test, inertie prouvée), `885` (mémoire d'écho, colonnes voisines, annonce qui se tait,
indices de fusion, libellé réservé, écriture mixte, note de blocage, vente de terrain, opposition tardive), `887`
(fonctions de décision : droits, auteur, second facteur, plafond, transitions, refus, provenance, erreurs sans
détail, reprojection de la vente, observation détachée, verrous), `888` (fusion : report, chaîne, indice sans
gagnant, contamination exacte, stabilité, opposition, publications, pièce reportée), `889` (valeurs d'annonce,
contrôle quotidien sur les champs tenus et libérés, alertes, rapport tronqué, pages, relance planifiée), `890` (vue
des observations par génération), `891` (stabilité de la projection, essai aléatoire à graine fixe) et `442`
(vues). Invariants de
`scripts/check-security-invariants-fact-registry.mjs` : `fact-registry-tables-closed`,
`fact-registry-append-only`, `held-fields-projection-only`, `hold-trigger-present-early`,
`field-projection-not-callable-by-api`, `fact-claims-never-repointed`, `registry-no-fk-to-auction-sales`,
`held-fields-never-returned`, `fact-registry-check-read-only`, `registry-neutral-surface-labels`,
`fact-claims-generation-pattern`, `set-config-literal-name`, `registry-rpc-actor-from-jwt`,
`registry-rpc-no-error-detail`. La publication automatique reste verrouillée
(`auction_fact_claim_decisions_auto_locked`, `auction_fact_claim_decisions_accepted_by_admin`), les dates de
visite aussi (`auction_fact_fields_visit_dates_locked`).
