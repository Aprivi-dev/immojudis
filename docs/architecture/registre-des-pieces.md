# Registre des pièces : fondations (lot R1) et durcissement (lot R2a)

Plan : `docs/equipe/2026-11-11-registre-des-pieces.md` (section 10 pour le lot R2). Spécifications : annexes
`03-base-de-donnees-arbitrage.md` (lot R1), `08-bascule-base-de-donnees.md` et `09-bascule-pipeline.md` (lot R2).
Migrations `20261116100000` à `20261116100500` (lot R1), `20261117100000` à `20261117100700` (lot R2a).

**État au lot R2a : toujours inerte.** Aucune fiche ne tient de champ, aucune décision n'est écrite, aucun code de
l'application ni du pipeline n'appelle la projection. Le noyau de publication de l'agent d'information, son pont et
`review_auction_fact_claim` ne sont pas modifiés (lots R2b et R2c). Application en production :
`docs/runbooks/registre-des-pieces-r2a.md`.

## Le principe

Une fiche (`auction_sales`) est réécrite en entier par la collecte à chaque passage. Une « pièce » est une
observation (`auction_fact_claims`, immuable) qu'un administrateur a acceptée. Tant qu'elle est acceptée, elle
**tient** son champ : la valeur affichée est la sienne, et plus celle de l'annonce.

Règle à retenir : **toute écriture directe d'un champ tenu est retenue par la base.** La collecte, le repli
REST, une fusion de doublons, un rattrapage ou une requête à la main peuvent réécrire la colonne : la base remet
la valeur tenue. Une seule fonction pose ou retire une pièce : la projection.

Seconde règle, depuis le lot R2a : **une valeur retirée, remplacée ou opposée ne revient pas.** La base se
souvient des anciennes valeurs tenues (mémoire d'écho) et écarte leur retour.

## Les objets

| Objet                                      | Rôle                                                                                                                                                                                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `auction_fact_fields`                      | Les cinq champs (surface, terrain, nombre de pièces, occupation, dates de visite), leurs colonnes, leurs tolérances, `hold_enabled` et `on_listing_change`. Les visites sont verrouillées par contrainte (non tenables).                                                                   |
| `auction_fact_source_precedence`           | Rang et droit de tenir par origine : administrateur 10, formulaire d'avocat 20, email d'avocat 30, document 50 ; l'annonce (60) ne tient jamais (contrainte).                                                                                                                              |
| `auction_fact_claim_decisions`             | Journal en ajout seul des décisions (acceptée, rejetée, retirée, opposition, contredite), avec le rattachement au lot. Le statut d'une observation est sa **dernière** décision, dans l'ordre de `seq`. Aucun texte libre.                                                                 |
| `auction_sale_field_hold_events`           | File de relecture en ajout seul : l'annonce a changé sur un champ tenu, pièce posée, retirée ou refusée par la fiche, contradiction, retour écarté d'une ancienne valeur tenue (`echo_suppressed`).                                                                                        |
| `app_private.fact_registry_seq`            | Séquence commune aux deux journaux : l'ordre entre une décision et un évènement se lit dans `seq`, jamais dans une date.                                                                                                                                                                   |
| `auction_sales.held_fields`                | Par champ : une entrée tenue (valeur, pièce, décision, origine, rang, jour de réception, tolérance, réglage, bloc `listing`, colonnes voisines, mémoire d'écho) ou une entrée libérée (mémoire d'écho, valeurs rendues, colonnes voisines, note de blocage). Nulle si rien n'est mémorisé. |
| `app_private.project_sale_fields`          | La projection : pose et retire les pièces.                                                                                                                                                                                                                                                 |
| `aaab_auction_sales_hold_projected_fields` | Le déclencheur de retenue. Il écrit aussi `held_fields` : dernière valeur connue de l'annonce, libération d'un champ, échéance de la mémoire d'écho.                                                                                                                                       |
| `public.get_sale_field_baselines`          | Pour la fusion de doublons de la collecte : les colonnes et la valeur d'annonce des champs tenus. Serveur seul.                                                                                                                                                                            |
| `public.check_fact_registry_consistency`   | Le contrôle quotidien, en lecture seule ; `public.sync_fact_registry_alerts` en fait des alertes opérationnelles.                                                                                                                                                                          |

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
  « lots 1 et 2 », « Lot n° 3 », « 2ème lot ») : des numéros de lot, jamais un mot libre. Un nom, une adresse ou
  un numéro de téléphone sont refusés.

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

**Indices de fusion.** Le quatrième paramètre reçoit les entrées `held_fields` d'une vente absorbée. Une fusion
écrit la vente conservée avant de supprimer l'absorbée : ses colonnes peuvent déjà porter la valeur que tenait
l'absorbée. À la première prise d'un champ, si une colonne de valeur égale la valeur ou une valeur d'écho de
l'indice, le bloc `listing` est celui de l'indice (la vraie valeur d'annonce) ; sinon c'est l'instantané des
colonnes. La mémoire d'écho de l'indice est reprise. Aucun appelant au lot R2a.

Elle n'échoue jamais sur la contrainte « pièces >= chambres ». Une pièce qui compte moins de pièces que la fiche
ne compte de chambres n'est pas posée : état `blocked`, évènement `projection_blocked`, et les autres champs
sont projetés. Une valeur d'annonce à restaurer qui serait devenue incompatible est remplacée par NULL.

**Vente de terrain.** Sur une vente de terrain (`property_type` ou `surface_scope` à `land`), la projection ne
pose ni ne garde `property.surface_m2` : l'application afficherait la surface bâtie d'une pièce comme celle du
terrain. État `blocked` (raison `land_sale`). Si une pièce toujours acceptée tenait la surface avant le
reclassement de la vente, le champ est libéré (`released_by: blocked`) et la valeur d'annonce revient. Tant que
personne n'a reprojeté la vente, le contrôle quotidien la signale (dérive et `stale_listing`).

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
`public.sync_fact_registry_alerts()`, sans paramètre. Dix contrôles, une alerte opérationnelle
`fact_registry.<contrôle>` chacun (détail dans `docs/operations/planification.md`) : dérive de la projection,
mode et fonction des déclencheurs, colonnes tenues, libellé réservé sans surface tenue (ces quatre-là sont
critiques), valeur d'une pièce dans une colonne voisine, une copie ou un champ libéré, colonne interne recopiée
dans `raw_payload`, rafale d'évènements d'écriture directe, écho écarté, valeur d'annonce retenue comme un écho,
annonce qui se tait. Le rapport ne porte que des comptes et des identifiants de vente.

Le contrôle n'écrit rien : il n'appelle la projection qu'en simulation (`false` écrit en dur ; une fonction
stable peut appeler une fonction volatile, la garantie vient donc de ce littéral, vérifié par un invariant et par
le test 889). Une vente en dérive est rejouée une fois avant d'être rendue : la simulation lit sans verrou, une
décision validée pendant la passe ne doit pas lever une alerte critique. Les champs libérés sont regardés comme
les champs tenus : la valeur d'une pièce retirée ou opposée ne doit rester ni dans une colonne, ni dans une
copie.

**Rapport tronqué.** Au-delà de 500 ventes candidates le rapport est partiel. La base ne synchronise alors que
les contrôles actifs (aucune alerte n'est refermée), et la tâche échoue au lieu de tenir un rapport partiel pour
complet.

**Mode des déclencheurs.** `app_private.assert_fact_registry_triggers()` lève `registry_unavailable` si l'un
des douze déclencheurs du registre manque, n'est plus en mode `always`, ou n'appelle plus sa fonction. Un
`alter table … disable trigger user`
suivi d'un `enable trigger user` les remettrait tous en mode ordinaire sans aucune erreur. Remise en état :
`supabase/maintenance/20261117100600_restore_fact_registry_trigger_modes.sql`. Règle pour un rattrapage :
`supabase/repairs/README.md`.

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
- **Borne du contrôle.** Au-delà de 500 ventes candidates, la tâche échoue chaque jour, sans pagination.

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

## Reste pour le lot R2b

- RPC d'administration (accepter, rejeter, retirer, opposition), sans droit d'exécution ouvert.
- Report des pièces lors d'une fusion : `carry_sale_user_data_to_merged_sale` appelle la projection avec les
  indices ; `information_agent_fact_publications` suit la vente conservée.
- Ordre de verrouillage (la vente d'abord) et délai d'attente de la RPC pendant un import.
- Côté collecte : copies `properties`, `judicial_sales` et `auction_surfaces` sans les colonnes du registre ;
  fusion sur les valeurs d'annonce.
- Indices de fusion, avec leur appelant : un indice sans gagnant (pièce de l'absorbée délogée ou contredite) ou à
  l'état `released` ne rend pas la valeur d'annonce de l'indice et ne mémorise pas la valeur que tenait
  l'absorbée ; rappeler la projection avec le même indice prolonge une échéance (`changed = true` à chaque
  appel).
- Retirer les copies (`properties`, `judicial_sales`, `auction_surfaces`) du contrôle quotidien une fois l'étape
  PB de la collecte livrée : des copies figées y donneraient un faux positif permanent.
- Retirer la tolérance `skipped: migration_pending` de la tâche `fact-registry-check` : une fonction absente
  (cache de schéma périmé, signature changée, retour arrière partiel) doit devenir un échec, pas un succès.
- Paginer le contrôle quotidien dès le lot R2b, et non au lot R3 : dès que des pièces seront acceptées en
  nombre, la borne de 500 ventes candidates fera échouer la tâche chaque jour.
- Levée ou restitution après une opposition bloquante : une valeur d'annonce légitime, égale ou proche (à la
  tolérance du champ) de la valeur opposée, est retenue pour la vie de la vente. Il faut un geste d'administration
  qui lève le blocage, ou la restitution de la valeur d'annonce (voir le lot R2c).
- Qui relance la projection après un reclassement en terrain : la surface tenue n'est libérée qu'à la projection
  suivante, et aucune écriture de la collecte ne l'appelle. D'ici là le contrôle quotidien lève une alerte
  critique de dérive.
- Faux positif de `echo_suspected` quand une colonne voisine est écrite APRÈS la première prise avec une valeur
  que la retenue n'écarte pas (par exemple la valeur d'annonce d'un autre champ égale à la pièce, ou une valeur
  déjà en place qu'une pièce de remplacement vient égaler) : le relevé `neighbors` date de la première prise.
- `actor_id` d'une décision tiré de `auth.uid()`, jamais d'un paramètre de la RPC.
- Le noyau refuse une observation préexistante dont la vente, le champ ou la valeur diffèrent du fait de
  l'agent (l'index unique sur l'identifiant de fait ne garantit que l'unicité, pas le contenu).
- Invariant `pipeline-no-wildcard-sale-read` : la collecte ne lit jamais la ligne entière d'une vente
  (`select=*`, `return=representation` sans liste de colonnes).

## Reste pour le lot R2c

- Le noyau de l'agent d'information écrit observation, décision et projection ; le pont est retiré.
- La mention publique lit le registre ; fonction séparée pour les origines autres que l'avocat poursuivant.
- Refus d'un bloc d'annonce marqué `information_agent_verified` à la première prise (reprise de l'existant).
- Écran de relecture : valeur d'annonce lue dans le registre, messages d'erreur.
- Droits des RPC ouverts aux administrateurs, après vérification du second facteur.
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
indices de fusion, libellé réservé, écriture mixte, note de blocage, vente de terrain, opposition tardive), `889`
(valeurs d'annonce, contrôle quotidien sur les champs tenus et libérés, alertes, rapport tronqué), `890` (vue
des observations par génération), `891` (stabilité de la projection, essai aléatoire à graine fixe) et `442`
(vues). Invariants de
`scripts/check-security-invariants-fact-registry.mjs` : `fact-registry-tables-closed`,
`fact-registry-append-only`, `held-fields-projection-only`, `hold-trigger-present-early`,
`field-projection-not-callable-by-api`, `fact-claims-never-repointed`, `registry-no-fk-to-auction-sales`,
`held-fields-never-returned`, `fact-registry-check-read-only`, `registry-neutral-surface-labels`,
`fact-claims-generation-pattern`. La publication automatique reste verrouillée
(`auction_fact_claim_decisions_auto_locked`, `auction_fact_claim_decisions_accepted_by_admin`), les dates de
visite aussi (`auction_fact_fields_visit_dates_locked`).
