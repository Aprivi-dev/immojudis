# Machines à états implicites : relevé et premières corrections (11/11/2026)

**Demande.** Trouver toutes les machines à états implicites de l'application, puis prendre la
meilleure décision pour l'expérience des utilisateurs, des développeurs et des agents, sans rien
casser.

**Ce document** est le compte-rendu de la session. Le registre durable, à tenir à jour, est
[`docs/architecture/machines-a-etats.md`](../architecture/machines-a-etats.md).

Cette session n'est pas une mission `/equipe` : la demande incluait de décider et d'appliquer. Les
corrections ont donc été faites directement, sur la branche `claude/brave-gauss-9j5dc7`.

## 1. Méthode

- Quatre explorations en lecture seule, en parallèle : interface (composants et crochets), comptes
  et paiement, demandes et dossiers, base et pipeline Python.
- Chaque défaut corrigé a d'abord été relu dans le code, puis couvert par un test qui **échoue sur
  l'ancien code** et passe sur le nouveau (vérifié en remettant l'ancien fichier).
- Les constats non corrigés sont des **relevés par lecture** : deux ont été rouverts à la main
  (prix de l'ancien paiement unique, course sur les demandes de rafraîchissement) et sont exacts ;
  un s'est révélé sans effet et a été écarté (section 4). Les autres restent à vérifier avant
  d'agir.
- Aucune écriture en base, aucune migration, aucun changement du pipeline Python.

## 2. La décision

1. **Une convention, sans dépendance** : `defineMachine` (`src/lib/state-machine.ts`), une table
   `état → événement → état suivant`. Un événement qu'un état n'accepte pas est ignoré : les états
   impossibles ne peuvent plus être écrits. Pas de XState : les parcours du site tiennent en une
   table.
2. **Corriger là où l'implicite produit aujourd'hui un écran faux**, pas réécrire ce qui marche.
   `use-auth`, `BillingActions` ou la vue aérienne sont implicites mais très testés et sans défaut
   vu : ils sont inventoriés, pas touchés.
3. **Ne rien changer à l'argent, aux données personnelles ni à la base** sans décision du
   propriétaire : ces points sont listés en section 5 du registre.
4. **Un registre gardé par un test** (`src/lib/state-machine.registry.test.ts`) : une machine non
   listée, sans test, ou un fichier cité qui disparaît fait échouer la suite. `CLAUDE.md` y renvoie.

## 3. Ce qui a changé

| #   | Parcours                                         | Avant                                                                                                                                                                                                                                                           | Après                                                                                                                                                                 | Preuve                                                                                                                          |
| --- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Recherche « autour d'une adresse » (`/sales`)    | Adresse effacée pendant la localisation, ou géocodeur qui lève une erreur : « localisation en cours » restait affiché sans fin. En changeant d'adresse, le centre de l'ancienne servait encore au tri par distance et à la zone d'une alerte créée à ce moment. | Machine `around-address-machine.ts` : le centre appartient à son adresse.                                                                                             | `around-address-machine.test.ts` (10 cas), `SearchPage.around-address.test.tsx` (4 cas, 2 échouaient avant).                    |
| 2   | Aperçu Mapbox d'une annonce                      | Une erreur Mapbox après l'affichage (une tuile en échec) recouvrait une carte qui fonctionnait, sans retour possible.                                                                                                                                           | Machine `mapbox-preview-machine.ts` : une erreur n'est acceptée que pendant le chargement.                                                                            | `mapbox-preview-machine.test.ts` (9 cas), `MapboxPreviewButton.test.tsx` (5 cas, premier test du composant ; 1 échouait avant). |
| 3   | Création d'une alerte                            | Si la lecture des droits du compte échouait, chaque essai répondait « Vérification de votre compte en cours. Réessayez dans un instant. », sans fin.                                                                                                            | La lecture est relancée à la demande ; si elle échoue encore, c'est une erreur qui est affichée, plus une invitation à attendre.                                      | `use-create-alert.test.tsx` (+2 cas).                                                                                           |
| 4   | Code de double authentification (admin)          | Un appel qui lève (réseau coupé) laissait le bouton sur « Vérification… ».                                                                                                                                                                                      | `try / finally` : le bouton revient, avec un message.                                                                                                                 | `AdminMfaGate.test.tsx` (+1 cas).                                                                                               |
| 5   | Enrôlement de la double authentification (admin) | Lecture des facteurs en échec : « Chargement… » sans fin. Boutons figés si un appel levait.                                                                                                                                                                     | État « lecture impossible » avec « Réessayer » (l'enrôlement n'est pas proposé sans savoir si un facteur existe) ; boutons toujours rendus.                           | `AdminSecurityPage.test.tsx` (5 cas, premier test de la page).                                                                  |
| 6   | Connexion / inscription                          | L'erreur du formulaire d'inscription (« Renseignez votre prénom ») restait affichée après le passage en mode connexion.                                                                                                                                         | L'erreur est effacée au changement de mode.                                                                                                                           | `login-page.test.tsx` (+1 cas, échouait avant).                                                                                 |
| 7   | « Me prévenir de l'ouverture »                   | Après déconnexion, « Votre demande est enregistrée » et « Retirer ma demande » du compte précédent restaient affichés.                                                                                                                                          | Remise à zéro quand il n'y a plus de compte.                                                                                                                          | `OfferOpeningRequest.test.tsx` (+1 cas, échouait avant).                                                                        |
| 8   | Dépôt d'un contributeur                          | Lien refusé pendant l'envoi : message sans consigne, et chaque nouvel essai retombait sur le lien mort.                                                                                                                                                         | Le message ajoute la consigne déjà utilisée à l'ouverture d'un lien expiré (« Répondez simplement à l'email… ») ; la réponse saisie reste à l'écran pour être copiée. | `InformationAgentContributionForm.test.tsx` (cas existant complété).                                                            |

Fichiers ajoutés : `src/lib/state-machine.ts`, `src/lib/search/around-address-machine.ts`,
`src/lib/mapbox-preview-machine.ts`, leurs tests, `src/lib/state-machine.registry.test.ts`, le
registre et ce compte-rendu.

**Choix à noter pour le point 8.** L'exploration proposait de remplacer le formulaire par l'écran
« lien invalide ». Cela aurait effacé la réponse que la personne vient de saisir, alors que la
consigne est justement de la renvoyer par email : le formulaire reste affiché.

## 4. Écarté après vérification

- **Carte du catalogue (`MapPanel`)** : le relevé signalait un message d'erreur remplacé au bout de
  12 secondes, et un message technique de Mapbox montré aux visiteurs. À la lecture, l'écran
  n'affiche qu'un message fixe (« La carte n'a pas pu charger… ») quel que soit le texte interne :
  aucun effet visible. Modification annulée.
- **Rapport PLU et risques** : une seule case d'erreur pour la lecture et l'export, mais l'export
  n'est proposé que lorsqu'un rapport est affiché. Effet mineur, laissé en l'état.

## 5. Ce qui reste, par ordre d'intérêt

Détail et fichiers dans le registre (sections 4 et 5). Dans l'ordre où je les prendrais :

1. **Décisions du propriétaire** (registre, section 5) : ancien paiement unique à 29 € contre 59 €,
   remboursements et litiges rattachés au compte, mission bloquée en `sending`, écritures sans
   condition du pipeline, réouverture d'une demande de droits, offre « fermée » en cas de panne.
2. **Agent d'information, dossier et mission** : un fichier d'états partagé (types, ensemble
   « ouvert », libellés), puis des écritures conditionnelles dans `send.ts` et `cancelMission`.
3. **Statut d'une vente** : une seule fonction « où en est cette vente » et un seul ensemble
   « vente en cours », côté TypeScript d'abord ; les copies en base demandent une migration.
4. **Demande de publication et mise en relation avocat** : une union partagée et une mise à jour
   conditionnelle, une fois les retours en arrière voulus décidés.
5. **Interface** : mot de passe oublié (union simple), bouton favori (un crochet pour deux copies),
   lecture des droits du compte (un seul crochet avec un état d'erreur).

## 6. Le budget JavaScript de `/sales`

La première version de ce lot faisait échouer le contrôle des budgets : `/sales` pesait 566 100
octets pour un plafond de 565 000. Mesure sur `main` avant le lot : **564 872 octets, soit 128
octets de marge**. Relever un plafond est une décision du propriétaire ; le lot a donc été allégé
jusqu'à **564 835 octets** (37 de moins que `main`) :

- `defineMachine` ne rend plus que `initial`, `table` et `transition` ; la lecture des événements
  acceptés est une fonction à part (`acceptedEvents`), que les pages n'embarquent pas ;
- la page lit l'état de la machine directement, sans fonctions intermédiaires ;
- la fonction « réservé à l'offre Analyse », écrite deux fois (page et crochet d'alerte), n'existe
  plus qu'une fois ; le message « Vérification de votre compte en cours » aussi ;
- cinq chaînes de classes répétées mot pour mot dans `SearchHeader.tsx` et `SearchResults.tsx`
  sont écrites une seule fois (aucun changement d'affichage) ;
- la garde contre un double appel de la création d'alerte, ajoutée puis retirée : les boutons des
  appelants sont déjà désactivés pendant l'enregistrement. Elle est notée dans le registre.

À retenir : toute correction sur `/sales` se paie en octets, et la marge reste d'environ 165
octets. Un vrai allègement de cette page, ou un relèvement décidé du plafond, précède le prochain
chantier qui y touche.

## 7. Vérifications

- `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run test:security-invariants`, puis
  `npm run build` et `npm run build:budgets` : résultats dans la description de la demande de
  fusion.
- Dans ce conteneur, `tsc` dépasse la mémoire par défaut de Node : il a été lancé avec
  `NODE_OPTIONS=--max-old-space-size=8192`. Le dépôt exige Node 24 (`.nvmrc`).
