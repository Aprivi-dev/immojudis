# Préparation du pilote de statistiques par tribunal

_Audit et réconciliation Supabase — situation au 24 août 2026_

## Conclusion

La couche France peut être préparée comme contexte historique, sous réserve de la validation
juridique de la réutilisation StatJur. Le référentiel courant est désormais complet pour les 123
tribunaux judiciaires actifs suivis : chacun possède son identité Justice et son ressort de cour
d’appel. Deux profils catalogue franchissent le seuil minimal de cinq ventes admissibles :
**TJ Paris** et **TJ Toulouse**, avec six observations chacun. Leur publication doit conserver la
mention d’un échantillon limité.

## Couverture observée

| Indicateur                                                     | Valeur |
| -------------------------------------------------------------- | -----: |
| Juridictions du tableau StatJur 2019                           |    164 |
| Rattachements au référentiel Justice actuel                    |    164 |
| Tribunaux actifs pourvus d’un ressort officiel                 |    123 |
| Rattachements ambigus                                          |      0 |
| Ventes brutes du catalogue sur 36 mois                         |     39 |
| Ventes judiciaires vérifiées ou recoupées admissibles          |     29 |
| Ventes admissibles rattachées à un tribunal actif              |     29 |
| Taux de rattachement sur le corpus admissible                  |  100 % |
| Tribunaux actifs ayant au moins une vente admissible           |     14 |
| Profils atteignant le seuil minimal de cinq ventes admissibles |      2 |

La réconciliation a ajouté 18 rattachements audités : 12 égalités de libellé normalisé, quatre
préfixes uniques lorsque le libellé source ajoutait du texte descriptif, puis deux preuves relevées
sur les affiches PDF publiques des ventes. Les 29 ventes judiciaires admissibles sont désormais
rattachées. Les dix autres lignes du catalogue brut sont des ventes notariales, des dossiers non
validés ou d’autres lignes hors du corpus Premium judiciaire ; elles ne doivent pas diluer le taux
de couverture.

Ces preuves de libellé servent uniquement à l’activité catalogue. Elles ne sont pas promues en
preuve de compétence territoriale dans le graphe Outcome ; ce dernier continue d’exiger le code
INSEE BAN accepté et le référentiel officiel des compétences.

## Ressorts pilotes proposés

| Priorité | Ressort                        | Bande   | Tribunaux | Ventes admissibles | Profils publiables |
| -------: | ------------------------------ | ------- | ---------: | -----------------: | -----------------: |
|        1 | Cour d’appel de Toulouse       | élevée  |          4 |                  8 |                  1 |
|        2 | Cour d’appel de Nancy          | moyenne |          5 |                  3 |                  0 |
|        3 | Cour d’appel d’Aix-en-Provence | faible  |          8 |                  1 |                  0 |
|        4 | Cour d’appel de Paris          | élevée  |          8 |                 10 |                  1 |
|        5 | Cour d’appel de Bordeaux       | faible  |          5 |                  1 |                  0 |

## Décision de mise en production

- conserver la statistique nationale et le millésime Justice séparés du catalogue courant ;
- ne publier aucun taux d’exhaustivité entre StatJur 2019 et les 36 derniers mois ;
- ouvrir d’abord les profils catalogue de Paris et Toulouse avec la mention « échantillon limité » ;
- relancer le rapport après chaque lot de réconciliation ;
- conserver les seuils plus stricts propres aux statistiques d’issue judiciaire.

Les migrations de stockage historique et de référentiel judiciaire sont appliquées. La source
StatJur reste `pending`, `disabled` et inactive jusqu’à la validation des conditions de
réutilisation ; aucune ligne historique n’a été persistée à ce stade. L’ancien « TJ Marmande », sans
vente, dossier Outcome ni snapshot, a été conservé mais désactivé car le registre 2026 ne contient
plus qu’un tribunal de proximité à Marmande.
