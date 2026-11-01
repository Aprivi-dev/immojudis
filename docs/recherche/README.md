# Recherche utilisateurs : guides d'entretien et protocole de test

Créé le 2026-10-31 (lot 8, n° 96). Ces documents préparent trois études menées **par le propriétaire** (aucun
agent ne contacte de participant). Aucun texte n'a été relu par `juridique-rgpd` : le consentement et
l'enregistrement des entretiens sont à valider avant le premier contact ([modèle](consentement-et-enregistrement.md)).

| Étude                                                | Qui                                     | Combien | Durée  | Guide                                                                          |
| ---------------------------------------------------- | --------------------------------------- | ------- | ------ | ------------------------------------------------------------------------------ |
| Test d'utilisabilité de l'enchère plafond            | Investisseurs qui étudient des ventes   | 5 à 6   | 45 min | [test-utilisabilite-enchere-plafond.md](test-utilisabilite-enchere-plafond.md) |
| Entretiens de découverte avec des marchands de biens | Marchands de biens, achats aux enchères | 6 à 8   | 40 min | [entretiens-marchands-de-biens.md](entretiens-marchands-de-biens.md)           |
| Entretiens de découverte avec des avocats            | Avocats qui portent des enchères        | 5       | 40 min | [entretiens-avocats.md](entretiens-avocats.md)                                 |

## Pourquoi ces trois études

Le seul signal de demande aujourd'hui est la demande « Me prévenir de l'ouverture de l'offre Analyse »
(`OfferOpeningSurvey`), assortie de trois questions facultatives et d'une case d'accord à un entretien de
45 minutes. Aucun événement ne dit si le plafond est lu, compris, cru ou suivi, ni si un avocat contacté
répond. Ces études donnent les réponses qualitatives avant de chiffrer le produit.

## Règles communes

1. **Parler du passé, pas du futur.** Demandez ce que la personne a fait la dernière fois, pas ce qu'elle ferait.
   Les compliments, les promesses (« je m'abonnerais ») et les avis généraux (« c'est une bonne idée ») ne sont
   pas des données ; un engagement concret (un rendez-vous, une introduction, un paiement) en est une.
2. **Ne pas présenter le produit avant la fin** des entretiens de découverte. Le test d'utilisabilité, lui,
   montre l'écran mais ne vend rien.
3. **Aucune promesse de gain, aucun conseil d'enchérir.** Ne commentez jamais la valeur d'un bien réel ni une
   enchère à porter. Si la personne le demande, répondez : « Je ne peux pas vous conseiller, je cherche à
   comprendre comment vous décidez. »
4. **Consentement avant tout enregistrement** : lire la notice, obtenir l'accord oral enregistré (ou la case
   cochée), proposer de ne pas enregistrer. Voir [consentement-et-enregistrement.md](consentement-et-enregistrement.md).
5. **Un seul enquêteur parle, un second prend les notes** si possible. Si vous êtes seul, enregistrez (avec accord)
   et notez les citations exactes juste après.
6. **Une personne = une fiche de synthèse** dans les 24 heures, à partir du [gabarit](#gabarit-de-fiche-de-synthese).
7. **Arrêtez de recruter** quand les trois derniers entretiens ne vous apprennent plus rien de nouveau.

## Recrutement

- Source principale : les personnes qui ont coché « J'accepte un entretien de 45 minutes » dans le questionnaire de
  la demande « Me prévenir ». Le consentement est donné pour cet usage : n'utilisez pas ces adresses pour autre chose.
- Marchands de biens et avocats : réseaux personnels du propriétaire, annuaire public (profil professionnel
  uniquement), introductions. Un premier message est un **message d'invitation à un entretien**, jamais une offre
  commerciale (voir les points à faire valider pour les avocats dans [entretiens-avocats.md](entretiens-avocats.md)).
- Aucun entretien avec une personne que vous ne pouvez pas identifier clairement comme participant volontaire.
- Une contrepartie éventuelle (bon d'achat, accès à l'offre Analyse) se décide avant le premier entretien, est
  annoncée dans l'invitation et ne dépend pas des réponses données.

## Calendrier proposé (5 semaines)

| Semaine | Travail                                                                                                         |
| ------- | --------------------------------------------------------------------------------------------------------------- |
| 1       | Valider le consentement (`juridique-rgpd`), identifier le responsable du traitement, recruter, préparer l'écran |
| 2       | Test d'utilisabilité du plafond : 5 à 6 sessions                                                                |
| 3       | Synthèse du test ; premiers entretiens de marchands de biens (3 à 4)                                            |
| 4       | Fin des marchands de biens (6 à 8 au total) ; entretiens d'avocats (2 à 3)                                      |
| 5       | Fin des avocats (5 au total) ; synthèse croisée ; décisions produit et tarif                                    |

## Gabarit de fiche de synthèse

À copier pour chaque entretien, dans un dossier non versionné et à accès restreint (voir la durée de conservation
dans le modèle de consentement). Aucune donnée d'identité dans le dépôt Git.

```
Participant : P1 (code, pas de nom)       Date :       Durée :       Enregistré : oui / non
Profil : (particulier / marchand de biens / avocat), nombre d'achats ou de dossiers par an
Ce qu'il fait aujourd'hui (faits, derniers cas) :
Ses outils et ses coûts actuels :
Ses frustrations (avec la dernière fois où elles sont arrivées) :
Citations exactes (3 maximum) :
Engagements obtenus (rendez-vous, introduction, essai, paiement) : oui / non, lesquels
Ce qui m'a surpris :
Hypothèse confirmée / infirmée :
Suite à donner :
```

## Ce que l'on décide à la fin

- **Plafond** : le garder tel quel, le reformuler (termes, ordre, verdict), ou le retirer d'un écran.
- **Offre** : à qui s'adresse Analyse (marchands de biens ? particuliers investisseurs ?), à quel prix, avec quelle
  limite du compte gratuit.
- **Avocats** : si une mise en avant payante est souhaitée, sous quelle forme (forfait, annuaire, mise en
  relation), avec quel garde-fou déontologique.
