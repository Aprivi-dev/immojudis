# Revue marketing : ce qui fait payer 59 € TTC par mois (06/11/2026)

Mission confiée au seul `directeur-marketing` (sur Opus), à la demande du propriétaire, juste après
la fusion de la PR qui l'a créé. Objectif : faire passer davantage de comptes gratuits (Découverte
et essai de 7 jours) à l'offre Analyse. Rien n'a été modifié : ce compte-rendu attend la validation
du propriétaire, numéro par numéro.

## Méthode et contrôles

- L'agent a lu `docs/equipe/` (en détail les sessions du 27/10 et du 31/10) et le code des écrans
  concernés. Il a pris 3 captures mobiles en 390 × 844 de l'accueil, de `/offres` et de
  `/annonce-exemple`, avec les positions en pixels des titres et des boutons.
- Chiffres relus dans le code :
  - Analyse : 5 900 centimes, soit « 59 € TTC / mois » ;
  - essai : `ANALYSIS_TRIAL_DAYS = 7` ;
  - Découverte : 3 déblocages par mois, 10 favoris, 1 alerte hebdomadaire.
- **Relecture du chef d'orchestre** (citations vérifiées dans le code) :
  - `offers-page.tsx` : descriptions des deux cartes, titre « Deux offres, un prix clair », bouton
    primaire « Voir une analyse exemple » ;
  - `HOME_TRIAL_NOTE` (ligne 30 et non 31) ;
  - `InvestorOnboarding.tsx` : « Bienvenue dans votre compte Découverte », `frequency: "weekly"`,
    récapitulatif « le lundi » ;
  - le texte de `SaleUnlockPanel.tsx` qui suit un déblocage ;
  - le PDF cité deux fois dans `launch-offer-end-lists.ts` ;
  - la case « déblocages par mois » de `HomeSections.tsx` ;
  - le `toast.error` de `use-create-alert.ts` ;
  - le mot « marchand », présent seulement dans l'administration.

## Diagnostic

- **Promesse.** La meilleure phrase du site est un sur-titre en petites capitales : « Pour acheter
  aux enchères en sachant jusqu'où monter ». Le titre principal, la devise, est abstrait, et le
  paragraphe commence par une fonction (« réunies sur une carte »).
  - **Investisseur :** il comprend à moitié.
  - **Marchand de biens :** aucune page publique ne s'adresse à lui, alors que c'est lui qu'Analyse
    sert le mieux.
  - **Avocat :** il n'est pas acheteur d'Analyse, et son parcours est cohérent.
- **Moment de vérité.** C'est voir l'enchère plafond d'une vraie vente de son secteur face à la
  mise à prix. Mais la demande n'arrive jamais juste après :
  - sur l'accueil, le bouton suivant est environ 5 500 px plus bas que le verdict de l'exemple ;
  - après un déblocage, le texte commence par ce qui reste réservé.
- **Trois principaux freins :**
  1. La différence entre les offres est présentée comme une liste de fonctions et non comme un
     bénéfice : chiffrer toutes les ventes et être prévenu chaque jour (vérifié).
  2. L'essai ne fait pas vivre l'alerte, qui est hebdomadaire et arrive souvent après J+7. La fin
     d'essai ne rappelle rien de ce que la personne a construit (vérifié).
  3. Le déficit de confiance : éditeur non identifié, aucune personne présentée, aucune preuve
     sociale. Le constat est vérifié, son effet sur la souscription est supposé.

## Propositions

| N°  | Proposition                                                                                                                                                                                                                         | Priorité | Effort | Avis du chef                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Vendre Analyse par le tri : « Le plafond de chaque vente, avant de choisir celles qui méritent une visite. » ; Découverte : « chiffrer les 3 qui vous intéressent le plus » ; titre « Trois ventes chiffrées par mois, ou toutes. » | Critique | S      | Garder. Écrire « chaque vente au tribunal » ou suivre `ceilingTermText`, car le plafond ne couvre pas les ventes de l'État.           |
| 2   | Comparatif de `/offres` : les 5 différences en tête, ce qui est commun aux deux offres replié                                                                                                                                       | Haute    | S      | Garder                                                                                                                                |
| 3   | Bouton « Voir le plafond d'une vraie vente de mon secteur » juste après le verdict de l'exemple, sur l'accueil                                                                                                                      | Haute    | S      | Garder                                                                                                                                |
| 4   | Ligne d'essai : « 7 jours d'offre Analyse : toutes les ventes ouvertes, sans carte bancaire. »                                                                                                                                      | Haute    | S      | Garder. Texte d'essai à faire relire par `juridique-rgpd`.                                                                            |
| 5   | Premier écran : réécrire le paragraphe pour mettre le bénéfice en premier ; le titre « Sachez jusqu'où enchérir, avant l'audience. » est à tester                                                                                   | Haute    | S      | Garder le paragraphe. Le titre est verrouillé par `tagline.test.ts` : à vous de décider.                                              |
| 6   | `/offres` : « Commencer l'essai gratuit de 7 jours » en bouton primaire, et motif `offre` sur les liens d'inscription                                                                                                               | Haute    | S      | Garder                                                                                                                                |
| 7   | Après un déblocage : « Votre enchère plafond est prête », puis le bouton ; ce qui reste réservé passe sous le calcul                                                                                                                | Haute    | S      | Garder. La réserve « aide à la décision » reste entière.                                                                              |
| 8   | Déblocages épuisés : « Vos 3 ventes de novembre sont chiffrées », liens vers ces ventes et deux choix honnêtes                                                                                                                      | Haute    | M      | Garder                                                                                                                                |
| 9   | Alerte quotidienne pendant l'essai, puis retour à l'hebdomadaire                                                                                                                                                                    | Critique | M      | Garder. Déjà signalé le 27/10 (n° 93) et toujours pas fait. Consentement et emails à voir avec `strategie-email` et `juridique-rgpd`. |
| 10  | Accueil du compte en essai : « Votre essai de l'offre Analyse a commencé », étape « Votre premier plafond »                                                                                                                         | Haute    | S      | Garder (le texte actuel est faux pendant l'essai)                                                                                     |
| 11  | Fin d'essai : listes corrigées (PDF en double, plafond et alertes absents) et bilan personnel                                                                                                                                       | Haute    | M      | Garder                                                                                                                                |
| 12  | Repères de prix sourcés près de 59 €, et « sans engagement de durée » juste avant le bouton                                                                                                                                         | Haute    | S      | Discutable : seulement à l'ouverture de la souscription, après `juridique-rgpd`                                                       |
| 13  | Bandeau de l'accueil : remplacer « 3 déblocages par mois » par « ≈ 13 % de frais pour un bien adjugé 150 000 € »                                                                                                                    | Moyenne  | S      | Garder, sous réserve de `statisticien`                                                                                                |
| 14  | Textes qui suivent l'annonce exemple et le simulateur : rappeler le plafond que le visiteur vient de voir, pas « l'adresse et les photos »                                                                                          | Moyenne  | S      | Garder                                                                                                                                |
| 15  | Critère d'alerte réservé : un message d'information qui nomme l'offre, au lieu d'une erreur                                                                                                                                         | Moyenne  | S      | Garder                                                                                                                                |
| 16  | Une phrase pour les marchands de biens sous les cartes de `/offres`                                                                                                                                                                 | Moyenne  | S      | Garder                                                                                                                                |

### Idées de rupture (à explorer)

- **A. « Abonnez-vous le mois de votre audience. »** L'abonnement mensuel présenté comme un outil de
  projet, que l'on résilie après la vente. Avec `analyste-prix` et `juridique-rgpd`.
- **B. Le coût de 1 000 € de trop.** À côté du plafond, ce que coûte réellement chaque palier
  d'enchère supplémentaire, frais compris. Avec `statisticien` et `qa-modeles`.
- **C. Le jour de l'ouverture comme seconde chance.** Un seul message aux anciens comptes en essai,
  avec leur secteur et leurs favoris conservés. Avec `strategie-email` et `juridique-rgpd` : est-ce
  un email de service ou de prospection ?

## À garder

- Le sur-titre « Pour acheter aux enchères en sachant jusqu'où monter ».
- La phrase « Le bon prix d'une vente aux enchères se décide chez vous, avant l'audience. ».
- L'exemple interactif marqué « Exemple fictif », avec son verdict chiffré.
- La relance après l'écart au marché.
- « Rien n'est prélevé à la fin de l'essai » et « sans carte bancaire ».
- La FAQ qui commence par « Comment résilier ? ».
- Le badge « Recommandée » affiché seulement quand l'offre est achetable.
- « Quand les données manquent, la fiche le dit. ».
- L'étape « confiez votre limite à votre avocat ».

## Points à transmettre

- **`juridique-rgpd` :**
  - les textes d'essai (n° 4 et 14) ;
  - l'alerte quotidienne pendant l'essai et son consentement (n° 9) ;
  - les repères de prix et « sans engagement de durée » (n° 12 et 13) ;
  - le bilan de fin d'essai et l'email du jour de l'ouverture (n° 11 et idée C) ;
  - « tous les frais » dans la carte Analyse (`offers-page.tsx:95`) ;
  - le verdict « On enchérit » (P10) ;
  - la dépendance des statistiques d'adjudication à Licitor (P5).
- **`analyste-indicateurs` :**
  - la cible `example` pour `home_cta_clicked` ;
  - `reason: "offre"` sur les liens de `/offres` ;
  - la propriété `surface` pour `opening_notification_requested` ;
  - le nouvel événement `upgrade_prompt_viewed`.
- **`analyste-prix` :** Découverte (3 plafonds par mois) suffit-elle à un particulier ? À voir avec
  l'idée A.
- **`recherche-utilisateurs` :** un test des 5 secondes sur l'accueil et la question « Quelle
  différence entre les offres ? », en 5 entretiens plutôt qu'un test A/B.

## Décision du propriétaire

Le 06/11/2026, le propriétaire valide les numéros classés « garder » : 1 à 11 et 13 à 16. Le n° 12
attend l'ouverture de la souscription ; les idées A, B et C restent à explorer.

## Ce qui a été fait

Trois lots `developpeur` en parallèle, puis un quatrième pour le n° 9. Le tout est relu par
`juridique-rgpd` (deux passages) et `code-reviewer`. Les quatre vérifications (`tsc`, lint, 12 813
tests, invariants de sécurité) passent.

- **`/offres`**
  - n° 1 : descriptions des offres par le bénéfice, « Le plafond des ventes au tribunal ou chez le
    notaire, avant de choisir celles qui méritent une visite. » ; titre « 3 ventes chiffrées par mois,
    ou sans limite. » ;
  - n° 2 : comparatif avec les différences en tête et un groupe replié « Inclus dans les deux
    offres », calculé sur les données ;
  - n° 6 : « Commencer l’essai gratuit de 7 jours » en bouton principal pendant l'essai,
    « Explorer gratuitement » en simple lien, motif `offre` sur les liens d'inscription ;
  - n° 16 : phrase pour les marchands de biens.
- **Accueil**
  - n° 3 : bouton « Voir le plafond d’une vraie vente de mon secteur » juste après le verdict de
    l'exemple, mesuré par `home_cta_clicked` avec la cible `example` ;
  - n° 5 : paragraphe du premier écran réécrit, avec le titre et la devise inchangés ;
  - n° 13 : bandeau « ≈ 13 % de frais en plus du prix, pour un bien adjugé 150 000 € au tribunal
    (hypothèses du simulateur) ». Le chiffre est calculé par `computeAcquisitionCosts`, et la FAQ
    lit la même source.
- **Essai et passerelles**
  - n° 4 : ligne d'essai « 7 jours d’offre Analyse, sans carte bancaire : toutes les ventes
    ouvertes, puis retour au compte gratuit. » ;
  - n° 14 : nouveaux textes à la fin de l'annonce exemple et du simulateur.
- **Déblocage**
  - n° 7 : « Votre enchère plafond est débloquée », puis le bouton. Ce qui reste réservé et la
    réserve « aide à la décision » restent visibles dessous ;
  - n° 8 : mois épuisé, « Vos 3 ventes de … sont débloquées », un lien vers ces ventes et « Vous
    pourrez la débloquer le 1er … avec le compte gratuit ».
- **Compte et fin d'essai**
  - n° 10 : « Votre essai de l’offre Analyse a commencé ». La 3ᵉ étape garde son libellé, car elle
    mène au catalogue et non à un plafond ;
  - n° 11 : liste de fin d'essai corrigée (PDF cité une seule fois, plafond et alertes en tête),
    dans la page compte et dans l'email ;
  - n° 15 : les critères d'alerte réservés font l'objet d'un message d'information et non plus
    d'une erreur.
- **n° 9, alerte quotidienne pendant l'essai**
  - L'accueil crée la première alerte en quotidien pendant l'essai, avec un consentement qui
    annonce les deux rythmes.
  - Correction d'un bug existant : une alerte quotidienne d'un compte Découverte n'était plus
    évaluée du tout après l'essai. Elle est maintenant évaluée en hebdomadaire et réécrite en
    `weekly` au premier passage.
  - Une vente déjà notifiée n'est pas renotifiée, et le premier passage est borné à 7 jours.
  - Le registre RGPD décrit ce fonctionnement.

**Non fait :**

- le bilan personnel de fin d'essai (n° 11) : les nombres ne sont disponibles ni sur la page
  compte ni dans l'email ;
- le n° 12, qui attend l'ouverture de la souscription.

**Points ouverts :**

- Une version du texte de consentement enregistrée avec le consentement aux alertes demande une
  migration. En attendant, la preuve repose sur la date du consentement, la fin de l'essai et
  l'historique du dépôt.
- À faire valider par un avocat avant d'ouvrir la souscription :
  - la qualification de l'abonnement dans les CGV (durée indéterminée ou reconduction) ;
  - les conditions pour les professionnels ;
  - l'identification de l'éditeur ;
  - la nature des emails d'alerte (service ou prospection).
- Le n° 13 reste à confirmer par `statisticien`.
- Une alerte réécrite en hebdomadaire le reste si la personne s'abonne ensuite à Analyse.
