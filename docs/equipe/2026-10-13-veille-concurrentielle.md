# Veille concurrentielle : première édition (13/10/2026)

Mission du propriétaire : explorer ce que propose la concurrence et proposer les fonctionnalités
vues ailleurs qui seraient pertinentes pour Immojudis. Agent : `veille-concurrentielle`. Pages
publiques consultées le 13/10/2026. « Vu » = lu sur le site du concurrent ; « rapporté » = lu chez
un tiers ; « supposé » = non vérifié.

## En bref

- **Deux concurrents directs** existent déjà sur l'analyse d'enchères judiciaires pour
  investisseurs : [Mon Petit MDB](https://www.monpetitmdb.fr/) (gratuit avec 3 analyses par mois,
  Pro à 19 €/mois ou 190 €/an) et [MdB Scanner](https://mdbscanner.fr/) (enchère max, travaux,
  résumé hebdomadaire gratuit). Ils affichent déjà une enchère maximale, une estimation DVF, une
  note de travaux, un baromètre des adjudications et des alertes par tribunal.
- **Prix** : Analyse à 29 €/mois est plus cher que tous les concurrents vus, et il n'existe pas de
  formule annuelle.
- **Ce qu'Immojudis fait mieux** : plus de types de ventes (judiciaires, notariales, domaniales),
  lecture des pièces PDF avec la page citée, enchère plafond plus détaillée (occupation, trêve
  hivernale, portage, trois projets), scénarios par tribunal, avocats, simulateur de frais.
- **Ce qui manque** : pas d'essai de l'analyse sans payer, pas d'agenda ni d'export calendrier,
  pas d'alerte quand une vente suivie change (le calcul existe côté serveur mais rien ne
  l'affiche), plafond sauvegardé dans le navigateur seulement, pas de formule annuelle.

## Panorama des acteurs

| Acteur                                                                                            | Type                       | Modèle économique                                | Points forts                                                                                       | Ce qu'Immojudis fait mieux                                 |
| ------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [Licitor](https://www.licitor.com/)                                                               | Annonces judiciaires       | Gratuit (journal papier payant)                  | Agenda des enchères, calendrier des visites, rubrique « Surenchérir dans les 10 jours », résultats | Aucune analyse (estimation, frais, plafond)                |
| [Vench](https://www.vench.fr/)                                                                    | Annonces judiciaires       | Annuel, 40 à 250 €/an (rapporté)                 | Calendrier par tribunal, pages par département, alertes détaillées (rapporté), application         | Pas d'analyse de prix ni de coût total ; judiciaire seul   |
| [Avoventes](https://www.avoventes.fr/)                                                            | Annonces des avocats (CNB) | Gratuit                                          | Pièces, simulation de frais, ventes passées                                                        | Pas d'alerte, d'estimation, de plafond ni de lecture       |
| [Info-Enchères](https://www.info-encheres.com/)                                                   | Annonces                   | Non affiché                                      | Alerte à la publication, recherche par numéro, résultats                                           | Pas d'analyse                                              |
| [36 heures immo](https://www.36heures.immo/), immo-interactif                                     | Ventes notariales en ligne | Gratuit pour l'acquéreur                         | Enchères en ligne, visites, alertes                                                                | Catalogue unique et enchère plafond                        |
| [Mon Petit MDB](https://www.monpetitmdb.fr/tarifs)                                                | Analyse d'enchères         | Free (3 analyses/mois) ; Pro 19 €/mois, 190 €/an | Enchère max, scénarios de revente, score travaux IA, baromètre public, assistant IA, exports       | Pas de notarial ni domanial, pas de lecture des pièces vue |
| [MdB Scanner](https://mdbscanner.fr/)                                                             | Analyse d'enchères         | Tarifs non trouvés                               | Enchère max, synthèse des risques, email hebdomadaire gratuit, étude publiée                       | Judiciaire seul, pas de carte ni de comparateur vus        |
| [Horiz.io](https://www.horiz.io/)                                                                 | Rendement locatif          | Gratuit, puis 9 à 29 €/mois (rapporté)           | Fiscalité, carte de rentabilité, extension navigateur                                              | Pas d'enchères                                             |
| [Biddit](https://www.notaire.be/) (Belgique), [Auction House UK](https://www.auctionhouse.co.uk/) | Enchères étrangères        | Gratuit pour l'acheteur                          | Enchère en ligne, lots invendus remis en vente, alertes quotidiennes                               | Pas d'aide à la décision chiffrée                          |

Limites : `encheres-publiques.com` (403), `vench.fr/tarifs` et `mdbscanner.fr/tarifs` (404) ; Enchères
Publiques et Petites Affiches non observées. L'absence d'alerte de changement chez les concurrents
français est supposée, pas démontrée.

## Propositions numérotées

Vérifié dans le code par le chef d'orchestre : plafond enregistré dans le navigateur
(`src/components/ceiling/use-ceiling-choices.ts`), cron `sale-change-monitor` et droit
`alerts.realtimeChanges` présents sans écran ni email, aucun export `.ics`, aucun badge « déjà
passé » dans la recherche.

| N°  | Proposition                                                               | Vue chez                     | Valeur          | Effort | Avis du chef                                           |
| --- | ------------------------------------------------------------------------- | ---------------------------- | --------------- | ------ | ------------------------------------------------------ |
| 1   | Bouton « Ajouter à mon agenda » (.ics) sur la fiche (visite, audience)    | Licitor, Vench               | Moyenne         | S      | garder                                                 |
| 2   | Formule annuelle et tarif de lancement                                    | Mon Petit MDB, Vench         | Moyenne         | S      | garder, à faire avec Stripe                            |
| 3   | Badge et filtre « déjà passé aux enchères / mise à prix en baisse »       | Lots invendus (UK)           | Moyenne à Forte | S à M  | garder                                                 |
| 4   | Alertes de changement sur les favoris (report, retrait, baisse, résultat) | Aucun concurrent français vu | Forte           | M      | garder, mesurer d'abord les fausses alertes            |
| 5   | 3 analyses complètes gratuites par mois                                   | Mon Petit MDB                | Forte           | M      | garder                                                 |
| 6   | Baromètre public des adjudications                                        | Mon Petit MDB, MdB Scanner   | Forte           | M      | discutable : gel Outcome Graph et validation juridique |
| 7   | Agenda complet et rappels par email (J-7, J-1)                            | Licitor                      | Forte           | M      | garder, après le n° 1                                  |
| 8   | « Adjugées récemment : surenchère possible » (délai de 10 jours)          | Licitor, Vench               | Moyenne         | S à M  | discutable : calcul du délai à faire valider           |
| 9   | Plafond, état et notes de chaque favori enregistrés sur le compte         | Mon Petit MDB                | Moyenne         | M      | garder                                                 |
| 10  | Questions-réponses sur les pièces d'une vente (IA)                        | Mon Petit MDB                | Moyenne à Forte | L      | discutable : risque juridique et coût, après le reste  |

### Détail

1. **Agenda .ics sur la fiche.** Un fichier calendrier pour la visite et l'audience, sans compte ni
   table. N'exporter que les dates sourcées, jamais les « dates à confirmer ».
2. **Formule annuelle.** Un second prix Stripe, un sélecteur sur `/offres`, le comparatif et les CGV
   (rétractation et remboursement sur un abonnement annuel) ; règles sur les prix barrés. Attend la
   société et Stripe.
3. **Badge « déjà passé ».** La fiche affiche déjà « Ce bien est déjà passé 2 fois » et la baisse de
   mise à prix (`SalePassagesSection`). Exposer un indicateur dans la recherche, un badge et un
   filtre gratuits ; le détail reste dans Analyse. Dépend de la fiabilité de la fusion des doublons.
4. **Alertes de changement.** `user_sale_change_events` et le cron existent ; il manque la
   notification (cloche existante), l'email et l'affichage dans `/favoris`. Découverte : un type de
   changement sur ses 3 favoris ; Analyse : tous. La feuille de route du 09/10 recommandait de retirer
   ce cron faute d'écran : ce qui change, c'est qu'aucun concurrent vu ne couvre ce besoin.
5. **3 analyses gratuites par mois.** Déblocage par vente (table de déblocages, quota dans
   `PLAN_LIMITS`, compteur), exception de droits au niveau de la fiche, test e2e anti-fuite.
   Coût de lecture IA à mesurer ; offre et CGV à réécrire.
6. **Baromètre public.** Page `/barometre-encheres` reprenant les agrégats déjà publiés (médiane
   nationale, par type, par tribunal au-dessus du seuil) et un bloc sur la fiche. À confronter au
   gel du chantier statistiques jusqu'au lancement et à faire relire par `juridique-rgpd` (chiffres
   dérivés de Licitor rendus publics ; accord oral déclaré par le propriétaire).
7. **Agenda complet.** Page `/agenda`, flux .ics privé par compte (jeton révocable), rappels J-7 et
   J-1 ; consentement et registre RGPD.
8. **Surenchère possible.** Liste des ventes adjugées depuis moins de 10 jours, prix adjugé quand il
   est connu. Délai (jours calendaires, jours fériés) à faire valider ; prix souvent absents.
9. **Plafond et notes sur le compte.** État (à étudier, à visiter, abandonné), note libre et plafond
   rattachés au favori ; tableau `/favoris` trié par date d'audience. Notes libres = données
   personnelles à effacer avec le compte.
10. **Questions sur les pièces.** Réponses limitées au texte extrait, page toujours citée, refus
    sinon, quota. Risque de consultation juridique (loi du 31/12/1971, art. 54) et d'erreur.

**Gains rapides** : 1, 2 et 3. **Pour convertir les visiteurs gratuits** : 5, puis 4 et 6.

## Écarté

- Pages par département et par tribunal : déjà reportées après le lancement (13/10), à rouvrir en
  premier ensuite (deux concurrents les ont).
- Résumé hebdomadaire gratuit : déjà couvert par l'alerte hebdomadaire de Découverte.
- Jeu « Le bon prix » : sans effet direct sur la conversion, à revoir après le baromètre.
- Carte DVF avec propriétaires : hors périmètre et problème RGPD.
- Extension navigateur, rentabilité par commune, simulation fiscale : hors enchères ou conseil
  fiscal à risque.
- Enchère en ligne, vente de gré à gré après carence : Immojudis n'est pas une salle de vente ;
  non transposable aux saisies françaises.
- Application mobile et notifications push : déjà écartées le 13/10.
- Journal papier, tarification sur devis : hors sujet.

## Contraintes à faire vérifier par `juridique-rgpd` avant exécution

Chiffres dérivés de Licitor rendus publics (6, 8) ; consentement des rappels et flux privé (7) ;
consultation juridique par IA (10) ; réductions de prix et rétractation sur abonnement annuel (2) ;
aucune citation nominative d'un concurrent dans les contenus publics.

## Décisions du propriétaire

13/10/2026 : **validés n° 5** (3 analyses complètes gratuites par mois) **et n° 10**
(questions-réponses par IA sur les pièces d'une vente). Les autres numéros ne sont pas retenus
pour l'instant.

Avant de construire : cadrage juridique (`juridique-rgpd`) des deux fonctionnalités et
cartographie du code existant (droits par offre, lecture des pièces, budget IA).
