# Registre des pièces : compléter chaque fiche comme un puzzle (plan arrêté le 11/11/2026)

## 1. Le besoin et la délégation

Le propriétaire a recadré le chantier de l'enrichissement automatique le 11/11/2026 : chaque annonce collectée
donne « quelques pièces du puzzle », et l'outil doit aller chercher les pièces manquantes puis les rattacher
correctement « pour arriver sur un tableau complet ». Il veut « une solution pleinement fonctionnelle » et accepte
de reconstruire ce qui doit l'être.

Il a validé la direction (« Oui, j'aime bien cette nouvelle direction ») puis délégué l'exécution (« Tu peux
avancer jusqu'à la mise en ligne. Je te fais confiance. »). Ce document est donc un plan arrêté, pas une liste à
valider. Les choix faits à sa place sont rangés en section 6 pour qu'il puisse les revoir.

Ce plan remplace la suite prévue du plan du 10/11 (`2026-11-10-enrichissement-automatique-fiches.md`, étapes
« 4 bis », « 2 bis » et 5 à 7). Les étapes 1 à 4 de ce plan restent en production ou fusionnées.

## 2. Ce que les mesures montrent (11/11/2026, lecture seule)

Sur les 1 056 ventes à venir :

| Pièce                                 | Ventes où elle manque                                   |
| ------------------------------------- | ------------------------------------------------------- |
| Nombre de pièces (maisons et appart.) | 398 sur 808 (49 %) ; 629 sur 1 056 tous types confondus |
| Occupation                            | 311 (29 %)                                              |
| Surface                               | 277 (26 %)                                              |
| Terrain, là où il a un sens           | 288 sur 594 (48 %)                                      |
| Dates de visite                       | 152 (14 %)                                              |
| Classe DPE                            | 843 (80 %)                                              |
| Charges de copropriété (appartements) | 354 sur 398 (89 %)                                      |

Quatre constats changent l'ordre des priorités.

1. **Aucune pièce n'arrive par l'agent.** Cinq dossiers ouverts, une réponse (un test interne), aucune information
   acceptée. L'envoi automatique est à l'arrêt, et l'outil pose en premier la question la plus lourde (transmettre
   le cahier des conditions de vente) en coupant presque toujours le nombre de pièces.
2. **L'email aux avocats ne peut compléter qu'une petite part du puzzle.** Sur les 674 ventes auxquelles il manque
   une pièce demandable, 62 (9 %) ont un avocat dont nous avons l'adresse email, 442 n'ont que le greffe, 170
   n'ont personne. Le contact publié est un téléphone dans 862 annonces sur 1 056.
3. **Beaucoup de pièces sont déjà chez nous.** 310 ventes ont un document officiel téléchargé et lu. 101 ventes
   sans nombre de pièces ont une valeur trouvée dans un document et jamais posée sur la fiche (56 pour les
   chambres, 31 pour l'occupation). 227 cahiers des conditions de vente sont référencés et jamais téléchargés.
   350 ventes sont décrites par deux sites ou plus.
4. **Les pièces ne sont pas rangées comme des pièces.** La fiche est une seule ligne que la collecte réécrit en
   entier à chaque passage. Une valeur acceptée d'un avocat est effacée à la collecte suivante, et par une fusion
   de doublons. La provenance est éparpillée en sept endroits. Une table d'observations existe
   (`auction_fact_claims`, 10 839 lignes pour les ventes à venir, toutes au statut « candidate ») mais elle
   recopie la fiche au lieu de la commander, et une décision n'y est jamais révocable.

Faiblesses de l'existant révélées au passage :

- 40 % des nombres de pièces affichés sont déduits et non lus, sans que rien ne les distingue.
- L'annonce et le document officiel divergent sur la surface dans 12 % des cas et sur le nombre de pièces dans
  26 %, souvent parce que l'un parle d'un lot et l'autre de l'ensemble.
- Les ventes à plusieurs lots ne sont repérées que sur un site source (43 ventes) ; ailleurs elles sont invisibles.
- Une date de visite acceptée ne s'affiche nulle part : le noyau n'écrit pas la colonne.
- Le webhook Resend de l'agent ne reçoit ni les rebonds ni les plaintes : une adresse invalide ou un destinataire
  mécontent pourrait être sollicité à nouveau. Le code qui les traite est en ligne ; c'est un réglage du compte.

## 3. Arbitrages du chef d'orchestre

| Sujet                         | Positions                                                                                                                   | Décision                                                                                                                                                                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registre neuf ou existant     | architecte et qualite-donnees : étendre `auction_fact_claims`                                                               | On garde `auction_fact_claims` pour les observations, immuables. On lui ajoute un journal des décisions en ajout seul, qui rend le retrait possible. Pas de table de pièces neuve.                                                     |
| Où appliquer la règle         | architecte : déclencheur qui projette ; data-pipeline : garde en Python ; expert-postgres : retenue passive en base         | Voie de l'expert-postgres. Un déclencheur passif retient les champs « tenus » ; une projection appelée explicitement est la seule écriture qui pose une pièce. La garde Python oublierait des chemins d'écriture (repli REST, fusion). |
| Qui peut tenir un champ       | expert-postgres : administrateur et avocat seulement ; qualite-donnees : promouvoir les valeurs trouvées dans les documents | Une pièce ne tient un champ que par une décision d'acceptation humaine. Une pièce de document acceptée en un clic tient le champ. Une pièce d'annonce ne tient jamais : l'annonce reste la valeur par défaut des colonnes.             |
| L'annonce contredit une pièce | propriétaire (10/11) : l'annonce l'emporte et le cas part en relecture ; expert-postgres : garder la pièce est plus sûr     | Réglage par champ, en données. Par défaut : la pièce tenue reste affichée et le cas part en relecture, avec les deux valeurs. Voir la section 6.                                                                                       |
| Premier fournisseur de pièces | plan du 10/11 : l'avocat par email ; qualite-donnees : les documents déjà lus                                               | Les documents et les annonces d'abord. Le formulaire et la demande aux avocats viennent ensuite, comme source complémentaire.                                                                                                          |
| Publication automatique       | plan du 10/11 : trois champs, après un jeu d'évaluation à zéro erreur                                                       | Repoussée. Elle s'ouvrira champ par champ quand la proposition de la machine et le clic humain concordent sur au moins 100 vraies valeurs par champ. Les verrous `auto_locked` restent.                                                |
| Série de parades « 4 bis »    | prompts-llm : huit groupes de corrections par listes de mots                                                                | Suspendue. Le formulaire à champs fermés supprime la lecture de texte libre pour ce canal. Le jeu d'évaluation reste comme filet pour l'email libre.                                                                                   |
| Correctif « 2 bis »           | data-pipeline : garde Python et table de conflits                                                                           | Abandonné : le registre le règle à la racine (lots R1 et R2).                                                                                                                                                                          |

## 4. Le plan, par lots livrables

Chaque lot est utile seul et réversible. « Interne » veut dire : aucun message à un tiers, aucun texte juridique
à faire valider avant la mise en ligne.

| Lot | Contenu                                                                                                                                                                                                                               | Nature  | Migration | Dépend de  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------- | ---------- |
| R1  | Fondations du registre, inertes : champs et préséance en données, journal des décisions en ajout seul, colonne `held_fields`, projection (simulation et application), déclencheur de retenue, invariants de sécurité                  | Interne | Oui       | Rien       |
| R2  | Bascule : le noyau écrit observation, décision, projection ; la mention publique lit `held_fields` ; le pont est retiré ; retrait et opposition ; report lors d'une fusion ; correctif de l'écho dans la collecte                     | Interne | Oui       | R1 observé |
| R3  | Pièces de documents : la collecte émet des observations pour le nombre de pièces, les chambres et l'occupation trouvés dans les documents ; file de validation en un clic, par vente, avec la valeur actuelle, la source et l'extrait | Interne | Oui       | R2         |
| R4  | Fiche publique : source par champ, contradiction montrée sur deux lignes, valeur déduite signalée comme telle                                                                                                                         | Interne | Non       | R2         |
| R5  | Lots : nombre de lots et rattachement pour toutes les sources ; une pièce sans lot identifié sur une vente à plusieurs lots n'est jamais posée                                                                                        | Interne | Oui       | R1         |
| R6  | Documents manquants : téléchargement des 227 cahiers en attente, lectures en échec, recherche d'une source de documents pour les sites qui n'en ont pas                                                                               | Interne | Non       | Rien       |
| R7  | Formulaire de réponse à champs fermés, par vente et par lot, avec choix d'affichage valeur par valeur ; page « vos ventes à venir » par cabinet ; demande regroupée ; nouveau message ; ordre des questions corrigé                   | Externe | Oui       | R2, R5     |
| R8  | Premier lot réel mesuré : 20 puis 40 cabinets, tableau de mesure (remise, réponses, forme, part exploitable par champ)                                                                                                                | Externe | Non       | R7         |
| R9  | Publication automatique, champ par champ                                                                                                                                                                                              | Externe | Oui       | R8         |

Précisions sur l'exécution :

- **R1 et R2 sont séparés par une période d'observation** : au moins 24 heures d'imports avec le déclencheur
  inerte, coût de l'import mesuré avant et après, aucun champ tenu, aucun évènement. La bascule n'a lieu que si
  ces mesures sont propres.
- **Les migrations qui touchent `auction_sales` s'appliquent hors import**, avec un délai de verrou de 5 secondes.
- **R3 commence par le nombre de pièces** (101 ventes), le gain le plus rapide sans déranger personne.
- **R7 est construit et mis en ligne sans être envoyé à personne.** Sa mise en service auprès de vrais avocats
  attend la section 5.

Indicateurs suivis une fois par jour : complétude prouvée par champ (valeur présente et lue, non déduite), part
des manques couverts par un document possédé, délai et taux de réponse par canal, taux de contradictions réelles.

## 5. Ce qui dépend du propriétaire ou d'un avocat

Avant tout envoi à un cabinet (lot R8), dans l'ordre :

1. **Resend, deux minutes** : abonner le webhook de l'agent aux évènements `email.bounced` et `email.complained`,
   en gardant `email.received`. Le chef d'orchestre n'a pas pu le faire : la modification d'un compte tiers a été
   refusée par le garde-fou de sa session.
2. **Qui écrit** : le responsable de traitement tant que la société n'existe pas, le signataire des messages, et
   une adresse d'expéditeur moins inquiétante que `enquete@`.
3. **Relecture par un avocat** des textes du formulaire (case d'autorisation, choix par champ, notice
   d'information), de la mention de source, de la relance et du regroupement par cabinet. Les vingt questions
   fermées et les textes proposés sont dans l'annexe 07.
4. **Analyse d'impact (AIPD)** : il n'en existe aucune rédigée, et elle est requise pour l'ensemble catalogue,
   registre et agent. Elle sera préparée par le rédacteur à partir de l'annexe 07, puis soumise.
5. **Mise à jour des textes publiés** avant toute relance : la politique de confidentialité, le pied du message et
   le guide promettent aujourd'hui « aucune relance ».
6. **Feu vert explicite du propriétaire** pour le premier lot.

Rien de cela ne bloque les lots R1 à R6.

## 6. Choix faits par délégation, à revoir si besoin

| N°  | Choix                                                                                                                      | Pourquoi                                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1   | Quand l'annonce change et contredit une pièce acceptée, la pièce reste affichée et le cas part en relecture.               | Aucune fiche ne change par accident. Le 10/11, le propriétaire avait retenu l'inverse : réglable par champ sans code. |
| 2   | Une pièce de document n'est posée qu'après un clic humain.                                                                 | 26 % de désaccords entre annonce et document sur le nombre de pièces : pas d'automatisme sur des candidats bruts.     |
| 3   | Une pièce qui ne nomme pas son lot, sur une vente à plusieurs lots, n'est jamais posée.                                    | Cause probable d'une grande part des contradictions.                                                                  |
| 4   | Le terrain trouvé dans un document n'est proposé que pour une maison, un terrain, un immeuble ou un bien mixte.            | Les candidats actuels contiennent des tantièmes et des surfaces de parcelle entière.                                  |
| 5   | Occupation affichée : « libre », « occupé », « loué » ou « non précisée ». Jamais qui occupe ni pourquoi.                  | Avis du juriste (vie privée de l'occupant).                                                                           |
| 6   | Aucun document téléchargeable par le public. À la place : « consultable au greffe ou au cabinet de l'avocat poursuivant ». | Droits d'auteur et données de tiers.                                                                                  |
| 7   | Une information demandée et non reçue s'affiche sans nommer personne : « Immojudis a demandé cette information ».          | Ne pas exposer le silence d'une personne identifiable.                                                                |
| 8   | Les 224 ventes en quarantaine ne sont pas enrichies tant que leur conflit d'identité n'est pas levé.                       | Deux sources y décrivent des biens différents.                                                                        |
| 9   | Le greffe n'est sollicité que pour savoir quel avocat poursuit, par un seul message par tribunal.                          | Il ne répond pas sur le bien ; un tribunal a jusqu'à 61 ventes.                                                       |
| 10  | L'essai réel du modèle sur le jeu d'évaluation (0,51 USD au plus) n'est pas lancé.                                         | Il mesure la lecture de texte libre, qui n'est plus le canal principal.                                               |

## 7. Ce que deviennent les étapes déjà livrées

| Élément                                              | Sort                                                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Analyse lancée à la réception, extraction durcie     | Gardé : c'est le chemin de secours de l'email libre.                                      |
| Noyau de publication et journal des publications     | Adapté en R2 : plus d'écriture en place.                                                  |
| Mention « transmise par l'avocat poursuivant »       | Même texte, autre source de lecture en R2 ; forme courte en R4, à valider par le juriste. |
| Moteur de simulation, réglage à trois modes, verrous | Gardés tels quels, à l'arrêt. Le moteur sera rebranché sur le registre en R9.             |
| Jeu d'évaluation de 215 réponses                     | Gardé comme filet de non-régression.                                                      |
| Portail `/contribuer`                                | Remplacé en R7 par le formulaire à champs fermés.                                         |

## 8. Annexes

Rapports complets des spécialistes, reproduits tels quels dans
`docs/equipe/annexes/2026-11-11-registre-des-pieces/` :

| Fichier                                | Spécialiste         | Contenu                                                                             |
| -------------------------------------- | ------------------- | ----------------------------------------------------------------------------------- |
| `01-donnees-carte-des-pieces.md`       | qualite-donnees     | Manques par source et par type, documents possédés, contradictions, contacts, rangs |
| `02-architecture-registre.md`          | architecte-logiciel | État des lieux, trois architectures, chemin par étapes                              |
| `03-base-de-donnees-arbitrage.md`      | expert-postgres     | Schéma, projection, plan de migrations, tests, invariants                           |
| `04-pipeline-reecriture-des-fiches.md` | data-pipeline       | Tous les chemins qui écrivent une fiche                                             |
| `05-formulaire-et-validation.md`       | ux-designer         | Formulaire de l'avocat, file de validation, fiche publique                          |
| `06-sollicitation-et-pilote.md`        | strategie-email     | Pourquoi rien ne part, pilote réel, messages proposés                               |
| `07-cadre-juridique.md`                | juridique-rgpd      | Ce qui peut être construit, textes proposés, vingt questions pour un avocat         |
| `08-bascule-base-de-donnees.md`        | expert-postgres     | Spécification du lot R2 côté base : treize points, plan de migrations, sous-lots    |
| `09-bascule-pipeline.md`               | data-pipeline       | Spécification du lot R2 côté collecte : écho, autres écrivains, observations, tests |
| `10-mesures-apres-r1.md`               | qualite-donnees     | Mesures en production après R1 : inertie, durée des lots, second facteur, files     |
| `11-documents-diagnostic.md`           | data-pipeline       | File de lecture des documents : premier diagnostic, en partie infirmé               |
| `12-documents-mesures.md`              | qualite-donnees     | File de lecture des documents : mesures en production                               |
| `13-documents-diagnostic-revise.md`    | data-pipeline       | File de lecture des documents : causes reproduites, correctifs A à N                |

Ces rapports sont des analyses. En cas d'écart avec ce document, c'est ce document qui fait foi.

## 9. Journal d'exécution

### Lot R1, fondations inertes (11/11/2026)

**Ce qui est livré.** Six migrations (`20261116100000` à `20261116100500`) : les quatre tables du registre, la colonne interne `auction_sales.held_fields`, la projection `app_private.project_sale_fields` et les déclencheurs de retenue. Trois fichiers de tests pgTAP (881, 882, 883), un module d'invariants de sécurité, les types et la note `docs/architecture/registre-des-pieces.md`. Rien n'appelle encore la projection : aucune fiche ne change.

**Déroulé.** Le premier développeur a été interrompu par une limite d'usage. Le second a repris ses six fichiers et y a trouvé deux défauts francs (une migration qui ne s'appliquait pas, une projection qui échouait sur toute vente sans pièce acceptée). Trois relectures indépendantes ont suivi (expert-postgres, securite-applicative, code-reviewer). Toutes concluent « fusionnable, lot inerte », avec des défauts à traiter avant le branchement. Vingt et un points ont été corrigés dans le lot avant sa mise en ligne, puisque rien n'était encore appliqué ; les autres ouvrent le lot R2. Une contre-vérification des corrections a suivi (code-reviewer, tests rejoués, 1 650 combinaisons pièces et chambres sans erreur) : deux retouches de plus, dont une contrainte réécrite pour ne pas déclencher une fausse alerte de dérive de schéma à l'application.

**Vérifications locales (base jetable PostgreSQL 16).** Rejeu de toutes les migrations sans erreur, deux applications successives du lot, 287 assertions pgTAP sur les quatre fichiers touchés, passe pgTAP complète sans changement sur l'existant, trois cas de concurrence à deux sessions sans interblocage, coût de l'import de masse inchangé (écart dans le bruit, aucun appel des déclencheurs quand rien n'est tenu).

**Choix faits par délégation pendant ce lot, à revoir si besoin.**

- Une information n'est « acceptée » que par une personne de l'équipe (administrateur existant). La réponse d'un avocat reste une proposition jusqu'à cette validation, tant que la publication automatique est verrouillée.
- Le motif d'une décision est un code pris dans une liste fermée. Aucun texte libre dans un journal qu'on ne peut pas effacer.
- L'occupation tenue par le registre se limite à libre, occupé, loué (choix 5 de la section 6).
- Les dates de visite ne peuvent pas être tenues tant que leur normalisation n'existe pas (contrainte en base) : le texte d'une annonce peut contenir un nom et un téléphone.
- Les trois nouvelles natures de pièce (email d'un professionnel, formulaire, saisie d'un administrateur) ne peuvent pas être insérées par un rôle de l'API.
- Quand l'annonce l'emporte sur une pièce (réglage `listing_wins_and_review`), la libération est durable : toute décision antérieure à la libération est écartée jusqu'à une nouvelle décision humaine.

**Reporté à l'ouverture du lot R2 (à faire avant la bascule).**

- Écho de la collecte : une valeur retirée ou contestée peut revenir, recopiée par l'import depuis la base (`services/data-pipeline/src/main.py`). Défaut le plus important.
- Ordre de verrouillage du noyau (le fait puis la vente, à inverser) et délai d'attente de la RPC d'administration pendant un import.
- Fusion de doublons : report des pièces et de la valeur d'annonce mémorisée.
- Valeur écrite dans `app_surface_kind` et `surface_source` : une constante neutre, l'origine restant dans `held_fields` ; sort de la nature de surface (Carrez, habitable, terrain).
- Tables `properties` et `judicial_sales`, qui reçoivent les mêmes colonnes sans retenue.
- Les deux RPC d'administration qui rendent la ligne entière de `auction_sales`, et `recompute_scoring.py` qui lit toutes les colonnes.
- Le rattrapage `supabase/repairs/20261029100200_recompute_past_quarantined_deadlines.sql` coupe puis rétablit tous les déclencheurs de `auction_sales` : rejoué, il sortirait ceux du registre du mode `always`. À ne pas rejouer tel quel.
- Contrôle quotidien « la simulation de projection ne change rien pour une vente tenue », et test de concordance.
- Ordre entre les deux journaux : il repose encore sur l'horloge à un endroit (libération comparée à la date de décision). Passer à une séquence commune, pour qu'une restauration de données ne fausse pas l'ordre.
- Libération durable et fusion : une pièce acceptée sur une vente absorbée peut reprendre un champ que l'annonce de la vente conservée venait de libérer (réglage `listing_wins_and_review` seulement).
- Valeur d'annonce mémorisée périmée : si l'annonce cesse de donner une valeur pendant qu'une pièce tient le champ, le retrait de la pièce restaure l'ancienne valeur d'annonce jusqu'à l'import suivant.
- Gardes par rôle : elles excluent les rôles de l'API par leur nom. À faire trancher par securite-applicative : liste d'exclusion ou liste blanche, compte tenu du chemin SQL direct du pipeline.
- Écran de relecture : lire la valeur d'annonce dans `held_fields`, pas dans le dernier évènement (la file est dédoublonnée).

**Pour le juriste (s'ajoute à la section 5).** Durée de conservation des deux journaux, qui survivent à la purge de la vente ; sort de l'identifiant de l'administrateur après suppression de son compte ; trace d'une opposition conservée sans limite.

**Mise en production.** PR #477 fusionnée le 11/11/2026. Migrations appliquées par le workflow officiel le 11/11 à 11:45 UTC, entre deux imports, en 4 secondes ; détection de dérive de schéma verte. Vérifié en lecture seule juste après : six migrations enregistrées, quatre tables sous RLS, onze déclencheurs en mode `always`, cinq champs et vingt-cinq lignes de préséance, 0 vente tenue, 0 décision, 0 évènement.

**Suite.** Au moins 24 heures d'observation, soit pas avant le 12/11 à 11:45 UTC (aucun champ tenu, aucun évènement, durée des imports inchangée), avant toute mise en production du lot R2.

### Constat hors plan : inventaires Licitor en échec (11/11/2026)

En préparant l'application, un import en échec a été relevé. Cause trouvée et reproduite par data-pipeline : depuis le 10/11 à 06:00 UTC, tous les inventaires Licitor échouent (6 sur 6). Une annonce à quatre lots a deux cartes sans mise à prix ; le lecteur (`_list_item_container`, `services/data-pipeline/src/sources/licitor.py`) déborde alors sur les cartes voisines, et la preuve de catalogue refuse à juste titre de certifier l'inventaire. Sans lien avec le registre. Conséquence : les ventes retirées de Licitor avant leur audience ne sont plus repérées depuis le 09/11 à 18:37 UTC. Les deux lots mal lus sont en quarantaine, donc invisibles. Correctif proposé : arrêter la remontée du lecteur dès qu'un parent contient une autre annonce, avec un test ; la preuve de catalogue n'est pas touchée. **En attente de l'accord du propriétaire** (correctif hors plan).

## 10. Le lot R2, découpé en trois étapes

Les deux spécifications (annexes 08 et 09) concluent que R2 est trop gros pour une seule livraison. Découpage retenu, chaque étape étant réversible :

| Étape | Base (annexe 08)                                                                                                                                                     | Collecte (annexe 09)                                                                                                                                                         | Effet sur les fiches                            | Condition pour passer à la suivante                                                                           |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| R2a   | Séquence commune aux deux journaux, gardes par rôle, retenue et projection corrigées, historique et RPC qui n'exposent plus `held_fields`, contrôle quotidien, index | PA : garde d'écho à l'écriture, listes de colonnes explicites, observations tirées du seul instantané de la source (version 3), reprise Vench hors empreinte                 | Aucun : rien n'est tenu                         | Observation de R1 propre ; contrôle quotidien à zéro sur deux passages ; durée des imports inchangée          |
| R2b   | RPC d'administration (accepter, rejeter, retirer, opposition) sans droit d'exécution ouvert ; report des pièces lors d'une fusion                                    | PB : les copies (`properties`, `judicial_sales`, `auction_surfaces`) ne reçoivent plus les colonnes du registre ; fusion sur les valeurs d'annonce ; rattrapage d'extraction | Aucun                                           | Indicateur d'écho à zéro en production ; répétition complète sur base jetable (import, pose, retrait, fusion) |
| R2c   | Bascule : le noyau écrit observation, décision, projection ; le pont est retiré ; la mention publique lit le registre ; droits des RPC ouverts aux administrateurs   | Rien à déployer ce jour-là                                                                                                                                                   | La première acceptation réelle devient possible | Première pièce posée : contrôle à zéro, mention affichée, retrait essayé sur une vente interne                |

Le code de R2a se prépare pendant l'observation de R1. Rien de R2 n'est appliqué en production avant la fin de cette observation.

### Arbitrages entre les deux spécifications

- **Écho de la collecte : les deux côtés.** La collecte ne réécrit pas un groupe qu'elle n'a fait que relire en base si la base a bougé depuis (elle seule sait qu'une valeur sortante n'est qu'une relecture). La base garde une mémoire d'écho comme filet ; son compteur doit rester à zéro et signale un chemin oublié.
- **La collecte continue de juger une vente sur la valeur affichée.** L'exigence de l'annexe 08 « remplacer partout les colonnes tenues par la valeur d'annonce » n'est retenue que pour la fusion de doublons. Essai du spécialiste du pipeline : appliquée partout, une pièce posée ne compterait plus pour la complétude (score de 71 à 60) et certaines ventes cesseraient d'être écrites.
- **Valeur d'annonce mémorisée quand l'annonce se tait** : la règle de R1 est gardée, avec une alerte, puisque l'arbitrage précédent retire le moyen de distinguer un vrai silence d'un garde-fou.
- **Copies sans lecteur** : cesser d'y écrire les colonnes du registre plutôt que les aligner, après vérification qu'aucun lecteur ne passe par l'API.
- **Aucune observation n'est émise depuis une colonne relue en base**, et cela avant le premier champ tenu : la table des observations est immuable et sans purge, une valeur d'avocat y serait attribuée à l'annonce pour toujours.
- **La collecte ne lit jamais `held_fields`** ; seule exception, une RPC dédiée pour la fusion.

### Choix faits par délégation pour R2, à revoir si besoin

- Valeur venue d'un greffe, d'un notaire ou d'un document : aucune mention nommée tant que le texte n'est pas validé par un avocat ; la valeur est « signalée », sans source.
- Mise à prix, date de vente et type de bien transmis par un avocat : enregistrés, non affichés, tant que la règle « annonce contre pièce » n'est pas choisie pour ces champs.
- Pièce jointe acceptée : le noyau la publie aujourd'hui comme document téléchargeable, ce que le choix 6 de la section 6 exclut. L'acceptation de la clé `document` est suspendue jusqu'à décision.
- Mémoire d'écho : 7 jours hors opposition, vie de la vente après une opposition.
- Opposition : fin d'affichage et blocage du retour de la valeur ; une demande d'effacement se traite à la main, hors R2.
- Second facteur des administrateurs : vérifié avant R2c ; s'il n'est pas actif en production, R2c attend.
- Valeurs déjà publiées par l'ancien noyau (aucune à ce jour) : s'il y en a le jour de la bascule, la valeur d'annonce est rendue et chaque fait est revalidé à la main, rien d'automatique.

### Ce que les mesures en production ajoutent (annexe 10, 11/11 à 12:35 UTC)

- **R1 est inerte sur tout ce qui se mesure** (0 vente tenue, 0 évènement, 0 décision, déclencheurs en mode `always`), mais sur 27 écritures seulement : aucun import de source n'avait encore tourné depuis l'application. Un relevé de référence du coût de l'insertion est pris (199 ms en moyenne par instruction).
- **Critère d'observation réécrit** : au moins un passage de chaque source qui tourne (agrasc, avoventes, cessions_etat, encheres_immobilieres, info_encheres, licitor, notaires). Vench, Petites Affiches et Enchères Publiques n'ont plus de passage depuis le 29/10, le 30/10 et plus de trente jours ; elles ne comptent pas dans le critère. Ce point est à confirmer avec le propriétaire pour les deux dernières.
- **Un lot de publication dure 20 à 29 secondes en médiane**, pas quelques secondes. Le verrou est étroit (une vente partage son code postal avec deux autres en moyenne) mais long. Conséquence pour R2b : l'écran d'administration doit réessayer seul quand la vente est occupée, et la réduction du verrou de la collecte est avancée dès qu'une mesure pendant un import la confirme.
- **Le second facteur des administrateurs n'est ni exigé ni enrôlé** (un administrateur, aucun facteur, interrupteur jamais activé). C'est un préalable de R2c qui dépend d'une action du propriétaire : enrôlement sur `/admin/securite`, puis activation.
- **Reprise de l'existant** : aucune publication de l'ancien noyau, aucun fait accepté, aucune surface marquée par l'agent. La bascule n'a rien à reprendre.
- **La file des documents ne se vide pas d'elle-même**, contrairement à ce que supposait le lot R6 : 181 tâches en attente et 71 en échec pour les ventes à venir, dont 62 pour la même cause (« PDF document checkpoint was not persisted »). Le lot R6 passe en diagnostic.
- Environ 63 % des observations existantes n'ont plus de vente (estimation) : à traiter avec la file de validation du lot R3.

### Questions qui restent au propriétaire ou à un avocat (s'ajoutent à la section 5)

- Pour un avocat : la cessation d'affichage suffit-elle après une opposition, ou faut-il pouvoir effacer la valeur des journaux ; garder la valeur opposée pour reconnaître son retour est-il fondé ; texte affiché pour une valeur venue d'un greffe, d'un notaire ou d'un document ; durée de conservation des journaux.
- Pour le propriétaire : rendre tenables la mise à prix, la date et le type de bien ; ouvrir un rôle de connexion propre à la collecte (chantier séparé, ne bloque pas R2).

## 11. Lot R6, file de lecture des documents (11/11/2026)

**Pourquoi maintenant.** Le lot R6 supposait que la file se viderait seule. Les mesures de l'annexe 10 ont montré l'inverse (181 tâches en attente, 71 en échec pour les ventes à venir). Les documents déjà possédés sont le premier gisement pour compléter les fiches.

**Ce que les mesures ont établi (annexes 11 à 13).** Un premier diagnostic par lecture du code a été en partie infirmé par les mesures de production, puis révisé. Ce qui est établi :

- **Trois ventes relues en boucle prennent 52 % des lectures** terminées en 48 heures : après chaque lecture réussie, une nouvelle tâche est créée pour la même vente, sans limite.
- **140 des 180 tâches en attente n'ont rien à lire.** La fraîcheur exigée est de 24 heures alors que la file ne peut revisiter une vente que tous les 6 jours environ.
- **Les 62 échecs « point d'étape non enregistré » sont des relectures de ventes déjà entièrement lues**, refusées à l'enregistrement, pas des téléchargements en échec.
- **Quatre échecs viennent d'une valeur brute remise sans normalisation** (« libre », « 85,5 »).
- Le budget du modèle n'est pas en cause (environ 1,6 USD par jour pour un plafond de 6). 88 % des documents des ventes à venir sont lus : le retard réel porte sur 59 ventes.

**Première série livrée (correctifs A, B, C, D, F, G, H).** Valeur de la source remise par la règle de la collecte ; pas plus de deux lectures du vidage par vente et par jour ; péremption jugée sur la vérification enregistrée ; attente au lieu d'un échec quand il n'y a rien à lire sur un manifeste complet qui porte une pièce écartée ; version des faits posée dès que le manifeste est complet ; motif du refus écrit en clair ; tâche en échec visible, et bornée, quand l'écriture de fin de passe est écartée. Deux relectures indépendantes puis une contre-vérification ; les défauts relevés (dont un type de bien brut remis tel quel, et un prix pouvant être divisé par mille, tous deux antérieurs au lot) sont corrigés dans la série.

**Effet attendu.** Environ 40 % de la capacité de lecture rendue, les 62 échecs disparaissent, le retard réel se résorbe en un à deux jours sans vidage manuel. À mesurer le lendemain de la mise en ligne avec les requêtes de `docs/audits/2026-11-11-file-de-lecture-des-pieces.md`.

**Série suivante, dans l'ordre.** E (restaurer le texte d'un manifeste qui porte des pièces écartées), I (ne pas créer de tâche pour une vente entièrement lue), K et J (statuts des pièces illisibles ; pièces d'une source retirée), N (tâches des ventes entièrement retirées, par une fonction SQL).

**Décisions qui reviennent au propriétaire.**

- **Durée de validité d'une lecture** : 7 jours au lieu de 24 heures pour une pièce lue et inchangée, en gardant 24 heures pour les ventes à moins de 7 jours de leur audience et pour les liens morts. C'est ce qui supprime les 140 tâches sans travail et réduit les requêtes vers les sites sources ; le changement d'une pièce serait vu plus tard. À ne faire qu'après le correctif E.
- **Ordre de passage** : une vente lointaine attend aujourd'hui 146 heures en moyenne derrière les ventes proches.

## 12. Autres décisions et constats du 11/11/2026

- **Licitor** : correctif du lecteur validé par le propriétaire (« tu peux faire les corrections qui te semblent nécessaires »), relu, PR #480.
- **Petites Affiches et Enchères Publiques** : leur arrêt est voulu (le propriétaire : ces sites ont bloqué les informations utiles). Elles sortent des critères de suivi, comme Vench.
- **Constat soumis au propriétaire** : 13 ventes d'Enchères Publiques sont encore « à venir » et hors quarantaine alors que leur dernière vérification date du 23 août 2026, sans autre source. Recommandation : marquer la source comme retirée du catalogue, comme Vench. En attente de sa réponse.
