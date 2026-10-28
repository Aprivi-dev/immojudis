# Étude utilisateurs : accueil, pépite, essai

Source : compte-rendu du 27/10/2026 (n° 90), rapport `recherche-utilisateurs`. Document de
préparation : **aucune prise de contact ne démarre** tant que les verrous ci-dessous ne sont pas
levés.

## Décisions que l'étude éclaire

- **Q1** : garde-t-on le texte et l'affichage de la pépite ? Est-elle comprise comme un repère
  calculé (et non un conseil), crue et utile ?
- **Q2** : garde-t-on l'accueil actuel ? Le visiteur comprend-il ce qu'offre le site, ce qui est
  gratuit, ce que fait « Essayez sur un exemple » ?
- **Q3** : 7 jours suffisent-ils pour voir la valeur de l'offre Analyse ?

## Volets

- **Volet A** : 5 primo-visiteurs recrutés **hors produit**, test mobile de l'accueil, 20 minutes,
  pensée à voix haute. Tâches : dire à quoi sert le site, ce qui est gratuit et payant ; manipuler
  « Essayez sur un exemple » sans consigne ; trouver une vente de son département et ouvrir la
  fiche ; repérer prix, date et points à vérifier ; créer une alerte.
- **Volet B** : 6 à 8 entretiens de 45 minutes avec des personnes de la liste d'attente ou de
  l'essai **qui ont coché la case** (particuliers novices et aguerris, marchands de biens, un avocat ; au moins 3 sur
  mobile). Aucune relance écrite : le texte de la case promet « une seule fois ». Il donne des
  signaux qualitatifs : **aucun pourcentage**.

Séances sur les fiches publiques et `/annonce-exemple` (pas d'écriture dans la production) ; deux
comptes de séance prolongés via la vue Inscriptions si une fiche complète est nécessaire.
Notes sous pseudonyme (P1 à P8), enregistrement supprimé à 30 jours, notes à 12 mois au plus
(durées annoncées dans le texte de la case « entretien »).

## Verrous avant tout contact

1. **Finalité du consentement.** Le texte de la case « entretien » couvre désormais le choix des
   ventes étudiées, **l'accueil du site, le repère « Pépite » et l'essai gratuit**
   (`offerOpeningInterviewNotice`, version du texte `OFFER_OPENING_SURVEY_VERSION` =
   `2026-10-28.3`). Ce texte [JR] est à relire par `juridique-rgpd`. La version `2026-10-28.3`
   **ne sert pas aux anciens accords** : une personne qui a coché la case avec une version
   antérieure n'est pas invitée, son accord ne couvrant pas ces séances. Seules sont contactées les
   personnes dont l'accord porte cette version (ou une version ultérieure qui garde la finalité).
2. **La case est masquée** tant que l'identité de l'éditeur (nom et email de contact) n'est pas
   renseignée (`offerOpeningInterviewAvailable`). Le propriétaire la renseigne et complète la
   politique de confidentialité (qui ne cite aujourd'hui que la demande « Me prévenir ») avant
   tout envoi.
3. **Règles retenues après la relecture `juridique-rgpd`** :
   - **Aucun email** aux inscrits de l'essai qui n'ont pas coché la case : ils ne sont pas
     contactés par email. Seule voie ouverte, une invitation dans le produit, à faire valider avant
     usage ;
   - **un seul email** par personne ayant coché la case, **aucune relance** (le texte promet « une
     seule fois ») ;
   - **gratification** : si elle existe, elle est annoncée **avant** le consentement, dans le texte
     de la case et dans l'invitation, jamais après coup ;
   - **outil de visioconférence** : il est cité (nom de l'outil) dans l'information donnée avec la
     case et dans la politique de confidentialité avant tout entretien ; le nom est à renseigner par
     le propriétaire ;
   - reste à trancher par `juridique-rgpd` : formulaire de consentement distinct pour les
     participants recrutés hors produit (volet A).
4. **Indicateur** : nombre de personnes qui ont coché la case, lu en base par le propriétaire.
   Il décide du plan A (6 volontaires ou plus), du plan B (mélange avec des gens hors produit) ou de
   l'attente.

## Deux questions à poser à la prise de rendez-vous

Elles servent à équilibrer l'échantillon. **Aucun champ n'est ajouté** au formulaire public ni à la
base : elles se posent dans la réponse de planification, après le consentement, et les réponses sont
**supprimées à la fin de l'étude** (comme les notes de planification).

1. « Avez-vous déjà enchéri dans une vente aux enchères immobilière ? **Jamais**, **1 à 2 fois**
   ou **régulièrement** ? »
2. « Quels **départements** suivez-vous ? »

Le profil de la liste d'attente n'a que quatre valeurs (particulier, marchand de biens, avocat,
autre) : ces deux questions donnent la différence entre novice et aguerri, et la zone géographique.

## Calendrier visé

| Période        | Étape                                          |
| -------------- | ---------------------------------------------- |
| 28/10 au 03/11 | Avis juridique, matériel, comptes de séance    |
| 04 au 13/11    | Prise de contact (un seul email, sans relance) |
| 10 au 21/11    | Séances, 2 par semaine au plus                 |
| 24 au 28/11    | Synthèse                                       |
| 29/11          | Décisions (le préavis des CGU tombe le 01/12)  |

## Critères de décision (des signaux, jamais des statistiques)

| Résultat observé                                                                        | Décision                                  |
| --------------------------------------------------------------------------------------- | ----------------------------------------- |
| Pépite : 5 participants sur 6 la paraphrasent comme un repère automatique               | On garde le texte                         |
| Pépite : 2 sur 6 ou plus la lisent comme un conseil ou une garantie                     | On réécrit, avis de `juridique-rgpd`      |
| Pépite : 3 sur 6 ou plus ne comprennent pas « à confirmer »                             | On reformule                              |
| Accueil : 4 sur 5 citent les 3 éléments (usage, gratuit, payant) et touchent un réglage | On garde l'accueil                        |
| Accueil : 2 sur 5 ou moins                                                              | On revoit le premier écran                |
| Essai : 3 des 4 comptes prolongés citent une vente suivie après J+7                     | On étudie un essai plus long ou un rappel |
| Essai : aucun ne dépasse J+7                                                            | L'essai court ne bloque pas               |

Une seule question de prix, à la toute fin des séances, jamais mêlée à la valeur perçue ; aucun
chiffre de prix ne remonte dans la synthèse.
