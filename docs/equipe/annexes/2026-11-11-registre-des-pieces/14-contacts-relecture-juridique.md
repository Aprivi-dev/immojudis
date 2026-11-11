# Contacts professionnels de l'agent d'information : relecture juridique et RGPD

Rapport de `juridique-rgpd` du 11/11/2026, condensé par le chef d'orchestre. Il porte sur deux lots : la lecture des contacts déjà en base pour tous les rôles (PR #487) et la réactivation du décodage des adresses Licitor avec conservation du contact des études notariales (PR #483).

Le relecteur n'est pas avocat. Rien de ce qui suit ne vaut décision : tout est à faire valider par un professionnel. Les sources citées (CNIL, Légifrance, mentions légales des sites) ont été lues par un outil de résumé et sont à recontrôler sur la page.

## Cadre retenu

Position du propriétaire : il s'agit de demander un complément d'information sur une annonce publiée, à des professionnels qui ont publié leur adresse pour être contactés au sujet de cette vente. Ce n'est pas de la prospection. Les envois sont validés un par un par un administrateur et le pilote automatique est éteint.

## 1. Intérêt légitime, rôle par rôle

| Rôle                        | Défendable ?                                                                                | Conditions                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Avocat poursuivant          | Oui, cas le plus solide                                                                     | Pièce de l'accord Licitor versée, mise en balance validée, garanties de transfert nommées   |
| Notaire (vente notariale)   | Oui, sous conditions                                                                        | Message adapté, position écrite sur les conditions d'immobilier.notaires.fr                 |
| Service de l'État (cession) | Oui ; une boîte de service est en principe hors champ, mais l'agent qui répond ne l'est pas | Message adapté, pied « service », adresse nominative seulement à défaut de boîte de service |
| Greffe                      | Oui, inchangé                                                                               | Validation avant le premier envoi, déjà inscrite au registre                                |
| Rôle non établi             | Fragile                                                                                     | Liste courte de questions par défaut                                                        |

Deux points discutés :

- **Prospection ou non.** L'article L. 34-5 du code des postes vise tout message qui promeut directement ou indirectement un service. Immojudis vend par ailleurs de la visibilité aux avocats. Le cadre reste défendable tant que le message ne présente aucun service ; une requalification reste possible.
- **Article 14 du RGPD.** Une adresse gardée plus d'un mois sans prise de contact pose question.

## 2. Ce qui manquait dans le code, et ce qui a été fait

| Point                                                             | Suite donnée                                                               |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Un seul modèle de message pour avocat, notaire et service         | Fait (PR #487) : un texte par rôle, sans invitation à joindre des pièces   |
| Pas de variante de pied pour une adresse générique                | Fait (PR #487) : « votre cabinet », « votre étude », « votre service »     |
| Portée de l'opposition non annoncée                               | Fait (PR #487) : pied du message et page de confirmation                   |
| Rôle non établi recevant la liste complète de questions           | Fait (PR #487) : audience déduite de l'organisateur, à défaut de la source |
| Garanties de transfert hors de l'Union non nommées                | À faire, après vérification des contrats de sous-traitance                 |
| Intérêt économique d'Immojudis absent du pied                     | À trancher avec l'avocat                                                   |
| Adresse Licitor masquée, relevée automatiquement, non dit au pied | À trancher avec l'avocat                                                   |
| Purge de `information_agent_cases`                                | À coder avant le premier envoi                                             |

## 3. Points propres aux notaires et aux services de l'État

- **Conditions d'immobilier.notaires.fr : point le plus sérieux.** Les mentions de l'éditeur interdisent la reproduction sans autorisation écrite, et celles de notaires.fr la réutilisation dans un but commercial. L'adresse de l'étude reste lisible par les comptes connectés (colonne de contact), ce qui est une communication à des tiers. Le registre des traitements classe notaires.fr « désactivé sans autorisation écrite », sans distinguer l'annuaire de l'annonce d'une vente. Proposition : demander une autorisation écrite à l'éditeur, ou obtenir l'avis de l'avocat. Décision prudente prise en attendant : envois aux notaires fermés par un réglage éteint par défaut.
- **Adresse générique ne veut pas dire non personnelle.** La boîte d'un notaire exerçant seul se rapporte à une personne. Écrire « en principe hors champ, traitée par prudence avec les mêmes garanties », jamais « pas de donnée personnelle ».
- **Secret professionnel du notaire.** L'obligation pèse sur lui. La liste fermée de questions est une bonne garantie ; la question sur l'occupation est la plus sensible et a été reformulée (« Selon l'annonce ou le cahier des charges… »).
- **Services de l'État.** `gouv.fr` étant un domaine partagé, l'opposition de la boîte d'un service ne couvre pas l'agent nommé du même service. Ne pas présenter le message comme une demande d'accès à un document administratif.

## 4. Opposition étendue à la structure

Adaptée, sous trois conditions : le dire (fait), prévoir et tracer la levée (à faire : aucun bouton aujourd'hui), inscrire les clés de structure au registre des traitements (à faire).

## 5. Textes à mettre à jour

À rédiger puis à faire relire par un avocat avant toute publication. Le rapport complet propose une rédaction pour chaque passage.

- `src/routes/privacy.tsx` : ligne du tableau et section « Professionnels contactés » (rôles, adresse de contact de la structure, questions par rôle, portée de l'opposition), ligne « Annonces de ventes » (coordonnées de l'organisateur lisibles par les comptes connectés), version du document.
- `docs/rgpd-processing-register.md` : lignes 28, 31 et 39 (personnes, données, clés de structure, coordonnées en colonne), sources admises (accord Licitor déclaré le 11/11/2026, pièce à verser), niveaux 1 et 3 (annonce contre annuaire pour notaires.fr), garde-fous.
- `docs/rgpd-mise-en-balance-agent-information.md` : périmètre étendu aux notaires et aux services de l'État, nouveaux risques (erreur de rôle, adresse générique en fait personnelle, conditions de la source, adresse d'étude visible), seuil d'analyse d'impact à réexaminer.
- `docs/data-retention-matrix.md` : liste d'opposition.

## 6. Questions pour l'avocat, par importance

1. L'accord de Licitor couvre-t-il le décodage en lot, la conservation et l'usage pour écrire ? Suffit-il sans information des avocats concernés ?
2. Les mentions d'immobilier.notaires.fr permettent-elles de réutiliser l'adresse de l'étude, de l'afficher aux comptes connectés et de lui écrire ? Faut-il une autorisation de l'éditeur ou du Conseil supérieur du notariat ?
3. Le message reste-t-il hors de l'article L. 34-5, alors qu'Immojudis vend de la visibilité aux avocats ?
4. L'intérêt légitime tient-il pour le notaire et pour le service de l'État, avec la liste fermée de questions ?
5. Article 14 : que faire des adresses gardées plus d'un mois sans contact ?
6. La question sur l'occupation peut-elle être posée à un notaire ? La mention de l'outil d'IA suffit-elle ?
7. L'opposition par structure et sa durée sont-elles correctement décrites ? Comment tracer sa levée ?
8. Les durées de 12 et 24 mois sont-elles proportionnées ?
9. Quelle garantie de transfert nommer pour chaque prestataire américain ?
10. Une analyse d'impact est-elle requise maintenant que le périmètre s'élargit ?

## 7. Avant le premier envoi réel à un notaire ou à un service de l'État

1. Verser la pièce de l'accord de Licitor.
2. Obtenir une position écrite sur immobilier.notaires.fr, ou l'avis de l'avocat.
3. Vérifier les contrats de sous-traitance et nommer les garanties de transfert.
4. Mettre à jour puis faire valider la mise en balance, le registre et la politique de confidentialité ; publier la politique avant l'envoi.
5. Ajouter la purge de `information_agent_cases`.
6. Garder le pilote automatique éteint pour ces rôles.
