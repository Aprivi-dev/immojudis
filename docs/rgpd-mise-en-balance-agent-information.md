# Mise en balance et analyse de seuil d’AIPD : agent d’information

**Statut : modèle à compléter et à faire valider par un avocat avant le premier envoi réel et avant
l’activation de la recherche automatisée d’adresses.** Rédigé le 14/10/2026 d’après les avis
juridiques et techniques du même jour (non-avocat, sources secondaires pour certains textes). Ce
document est référencé par la ligne « Enquête dossier supervisée » du
[registre des traitements](rgpd-processing-register.md). Aucune décision n’y est prise à la place du
responsable de traitement.

| Élément                         | Valeur                                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| Traitement                      | Recherche et usage de l’adresse professionnelle d’un professionnel d’une vente (voir registre) |
| Base juridique envisagée        | Intérêt légitime, art. 6.1.f RGPD                                                              |
| Date du test                    | 14/10/2026 (brouillon)                                                                         |
| Auteur                          | Équipe Immojudis (brouillon technique)                                                         |
| Validé par / date de validation | **À renseigner**                                                                               |
| Prochaine revue                 | Annuelle, et avant toute nouvelle source, nouveau prestataire ou nouveau transfert             |

## 1. Test de mise en balance (modèle)

1. **Intérêt poursuivi.** Fiabiliser l’information publiée sur une vente aux enchères auprès du
   professionnel qui la mène (avocat poursuivant, notaire, commissaire de justice, gestionnaire).
   C’est aussi un intérêt économique d’Immojudis : un catalogue complet et exact fait la valeur du
   service. Il est légitime mais doit être pesé comme tel, d’où l’exclusion de toute promotion.
2. **Nécessité.** Le professionnel est la source directe des informations absentes ou
   contradictoires (cahier des conditions de vente, procès-verbal descriptif, diagnostics, dates de
   visite, mise à prix, garantie exigée pour enchérir, audience). Alternatives examinées : pièces publiques, greffe,
   téléphone. **À chiffrer :** part des ventes dont la fiche reste incomplète sans réponse du professionnel,
   avec `services/data-pipeline/sql/insufficient_information_report.sql` (à exécuter par le
   propriétaire), pour établir pourquoi les alternatives ne suffisent pas.
3. **Attentes raisonnables.** L’adresse est publiée par la personne pour être contactée sur cette
   vente (annonce), sur une autre annonce de ses ventes ou sur son activité (site de son cabinet ou de son étude, cité par l’annonce). Le
   message concerne exactement la vente qu’elle mène et ne contient aucune promotion. La CNIL
   (recommandations pour les réutilisateurs de données publiées sur Internet, 12/06/2024, p. 10 et 48) retient le lien direct avec l’activité professionnelle comme facteur favorable.
4. **Impact.** Faible : données professionnelles, un message par adresse et par période de 30 jours,
   pas de profilage, pas de donnée sensible, pas de donnée de personne privée.
5. **Garanties.** Validation humaine de chaque message après aperçu ; une sollicitation par adresse
   et par 30 jours, aucune relance ; opposition en un clic, par adresse et par identité, valable
   pour tous les canaux ; information immédiate (pied art. 14 complet, source typée et datée) ;
   conservation bornée des adresses non utilisées (28 jours au plus après la dernière consultation de l’annonce, jamais rafraîchie après la vente) ; téléphone utilisé uniquement pour rapprocher deux annonces d’un même professionnel, jamais pour le contacter ni conservé par l’outil ; aucune mention commerciale (contrôle
   automatique) ; adresses de juridiction, RPVA, Ordre, CARPA, `noreply`, `dpo` et `rgpd`
   exclues.
6. **Risques résiduels.** Adresse nominative plutôt que générique ; homonymes ; secret
   professionnel du destinataire (les questions se limitent aux pièces publiques ou communicables à
   tout candidat acquéreur) ; adresse périmée ; requalification en prospection si le message
   promouvait un service (L. 34-5 CPCE).

**Conclusion du test :** favorable **si et seulement si** les conditions ci-dessus sont tenues dans
le produit. Elle se dégrade dans trois cas : adresse extraite d’une source dont l’éditeur marque
son refus du moissonnage, adresse réutilisée pour une autre finalité (démarchage de la mise en
avant payante des avocats), collecte massive ou stockage sans besoin.

## 2. Risque propre à l’automatisation

La recherche automatisée collecte une adresse avant la validation humaine du message et peut
confondre deux personnes.

| Risque                                                                        | Garantie prévue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Collecte en masse ou parcours d’un annuaire                                   | Déclenchement par un brouillon, un professionnel à la fois ; pages ciblées (trois au plus), ni pagination ni formulaire ; arrêt sur 403 ou 429 (hors relevé Licitor en lot : voir la ligne « Décodage » et la section 2 bis)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Copie ou index d’un annuaire                                                  | Aucune copie de page ; aucune liste conservée ; pas de rafraîchissement périodique (hors relevé Licitor en lot, qui conserve les adresses décodées dans le registre interne, et hors captures HTML du collecteur d’historique Licitor, `licitor_ingestion.captures`, sans purge codée à ce jour)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Erreur d’identité (homonyme, associé, cabinet)                                | Nom et téléphone pour une autre annonce ; site cité par l’annonce et adresse du domaine du cabinet pour le site ; « ambigu » si deux candidats sont proches ; le lien de la page source est affiché et l’administrateur peut l’ouvrir avant de valider                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Collecte d’une personne qui s’est opposée                                     | Contrôle d’opposition par identité **avant** toute requête réseau, par adresse dès qu’elle est connue (hors relevé Licitor en lot : contrôle par adresse à la collecte, par identité avant tout envoi ; les lignes du lot ne portent pas de clés d’identité)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Site qui refuse la collecte                                                   | `robots.txt` respecté ; illisible ou erreur 5xx : aucune collecte ; revue trimestrielle de chaque source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Provenance fausse dans le message                                             | Libellé d’origine tiré du type de source du registre (annonce, autre annonce, annuaire nommé, site du cabinet), avec lien et date                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Décodage des adresses masquées (Cloudflare)                                   | Licitor : le parseur décode, à la collecte, les adresses email masquées (protection Cloudflare) des blocs avocat des annonces. L’accord oral de Licitor du 14/10/2026 est invoqué à titre provisoire ; sa portée est à confirmer par écrit ; le décodage est suspendu si Licitor ne confirme pas. Vench : pas de décodage. Le décodage se fait à la collecte, sur le HTML déjà récupéré : il n’ajoute aucune requête vers Licitor et il est impossible après coup, la page n’étant plus relue. Mêmes filtres que pour une adresse en clair (juridictions, messagerie RPVA, Ordre, barreau et CARPA, adresses `noreply`, `dpo` et `rgpd` exclus) ; uniquement l’adresse publiée par le professionnel dans le bloc de l’annonce qui le présente comme interlocuteur de la vente (aucune adresse d’une partie à la procédure) ; origine : l’annonce. **Email Licitor décodé conservé, sous forme décodée, uniquement dans le registre interne de l’agent d’information (service_role), jamais publié** : ni fiche, ni panneau organisateur, ni vue ou RPC lisible par un visiteur ou un utilisateur connecté, ni données structurées, ni historique. Contrôle d’opposition par adresse à la collecte, par identité avant tout envoi. Captures HTML : le collecteur d’historique de Licitor (`licitor_ingestion.captures`, colonne `html_gzip`) conserve des pages d’annonces telles que reçues, avec les adresses masquées sous leur forme encodée (`data-cfemail`, réversible). Aucune purge n’est codée à ce jour (ni migration, ni collecteur) : durée indéfinie, **à trancher**. C’est pourquoi l’email « conservé uniquement dans le registre » s’entend sous forme décodée. |
| Données de tiers dans les réponses (parties, occupants, pièces)               | Pas de collecte recherchée ; réponses lues par l’outil d’IA puis relues par un administrateur avant toute publication ; caviardage vérifié avant publication d’une pièce ou d’une photo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Transfert du contenu des réponses au prestataire d’IA (Replicate, États-Unis) | Mécanisme de transfert et DPA à vérifier avant le premier envoi réel ; information dans le pied du message ; le destinataire peut demander la garantie applicable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Contrôle humain de pure forme                                                 | Le lien de la page source et la date sont affichés, l’administrateur peut l’ouvrir avant de valider ; l’envoi reste déclenché à la main après aperçu                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## 2 bis. Information des personnes dont l’adresse est relevée en lot (Licitor)

Le relevé en lot décode l’adresse de l’avocat d’une annonce avant toute demande d’information, donc
avant que la personne ait été contactée. Mesures prévues, à faire valider :

- **Information individuelle** : au premier message envoyé à la personne (art. 14.3.b RGPD, au plus
  tard lors de la première communication), par le pied du message (source typée, lien de l’annonce,
  date de relevé, durées, droits, opposition en un clic).
- **Information publique** : politique de confidentialité (version 2026-10-20.1, qui mentionne le
  relevé des adresses des annonces Licitor et la durée, comme la 2026-10-14.2) ; future page `/agent-information` nommant
  Licitor (brouillon `docs/agent-information-brouillon.md`, non publiée).
- **Conservation bornée** : Adresse relevée à la collecte de l’annonce et non utilisée pour un envoi : conservée tant que le détail de l’annonce est relu, jamais rafraîchie après la date de la vente, et supprimée au plus tard 28 jours après la dernière consultation de l’annonce (purge hebdomadaire, seuil de 21 jours).
- **Opposition** : par adresse à la collecte (une adresse opposée n’est ni écrite ni rafraîchie), par
  identité avant tout envoi (les lignes du lot ne portent pas de clés d’identité).
- **Aucun usage hors envoi validé à la main** : pas de prospection, pas de liste exportée, pas de
  publication ; l’agent ne lit ces adresses que lors du brouillon d’une demande pour cette vente.
- **Nécessité** : Le décodage se fait à la collecte, sur le HTML déjà récupéré : il n’ajoute aucune requête vers Licitor et il est impossible après coup, la page n’étant plus relue.
- **Question ouverte** : l’obligation d’information de l’art. 14 pour les adresses relevées mais
  jamais utilisées pour un envoi n’est pas tranchée : **à faire valider par un avocat**.

## 3. Compatibilité de finalité du réemploi d’une adresse (art. 6.4 RGPD)

Cas principal : l’adresse d’un professionnel, relevée dans l’annonce ou un annuaire pour publier la
fiche de la vente, est ensuite utilisée pour lui écrire au sujet de cette vente. Cas voisin : une
adresse publiée dans une autre annonce est réutilisée pour lui écrire à propos d’une autre vente.

- **Lien entre les finalités :** même professionnel, même activité (la conduite de ventes aux
  enchères), même objet (demande d’information sur une vente).
- **Contexte de la collecte :** publication par la personne pour être contactée sur ses ventes ;
  attente raisonnable de l’être sur une autre vente.
- **Nature des données :** adresse professionnelle, aucune donnée sensible.
- **Conséquences :** un message de plus, informatif, sans promotion.
- **Garanties :** identité vérifiée par le nom et le téléphone, ancienneté de l’adresse limitée à 6
  mois (sinon relecture de la source), sources limitées à la liste admise, origine exacte dans le
  pied du message, opposition contrôlée par identité, aucune réutilisation pour la prospection.

**À faire valider :** la compatibilité de finalité et les licences des sources concernées. Une
adresse collectée pour l’agent ne doit jamais alimenter la prospection des avocats pour la mise en
avant payante (art. 6.4 RGPD et L. 34-5 CPCE).

## 4. Analyse de seuil d’AIPD

**Statut : à faire valider. Cette analyse ne tient pas lieu d’AIPD.**

La CNIL considère qu’une AIPD est requise lorsque le traitement remplit au moins deux des neuf
critères du CEPD (lignes directrices WP 248 rév. 01), sauf justification contraire documentée.

| #   | Critère du CEPD                                           | Appréciation (14/10/2026)                                                                                                   |
| --- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | Évaluation ou notation                                    | Non. Un score d’appariement d’identité n’évalue pas la personne.                                                            |
| 2   | Décision automatisée à effet juridique                    | Non. Chaque message est validé par un administrateur (réduit aussi le risque de l’art. 22).                                 |
| 3   | Surveillance systématique                                 | Non.                                                                                                                        |
| 4   | Données sensibles ou hautement personnelles               | Non. Données professionnelles.                                                                                              |
| 5   | Traitement à grande échelle                               | Peu probable : environ 900 professionnels distincts, une recherche par brouillon. **À reconfirmer** avec les volumes réels. |
| 6   | **Croisement ou combinaison d’ensembles de données**      | **Potentiellement réuni.** Annonce, annuaires officiels et site du cabinet sont rapprochés pour retrouver une personne.     |
| 7   | Personnes vulnérables                                     | Non. Professionnels dans l’exercice de leur activité.                                                                       |
| 8   | **Usage innovant ou nouvelles solutions technologiques**  | **Potentiellement réuni.** Agent d’IA qui retrouve des adresses, et outil d’IA qui classe les réponses.                     |
| 9   | Exclusion du bénéfice d’un droit, d’un service ou contrat | Non.                                                                                                                        |

**Lecture, par voie :**

- **Voie manuelle** (l’administrateur saisit ou choisit l’adresse ; l’IA ne fait que classer les
  réponses) : un seul critère potentiellement réuni (8, usage d’un outil d’IA). Le seuil des deux
  critères n’est pas atteint : AIPD non obligatoire, sous réserve de validation.
- **Voie automatique** (recherche d’adresse par l’agent) : les critères 6 et 8 sont potentiellement
  réunis, donc le seuil des deux critères est potentiellement atteint : AIPD recommandée avant
  l’activation. À rapprocher de la liste des types d’opérations pour lesquelles la CNIL exige une
  AIPD ([liste CNIL](https://www.cnil.fr/fr/liste-des-traitements-pour-lesquels-une-aipd-est-requise))
  pour vérifier qu’aucune ne vise ce traitement.

Facteurs qui jouent en sens inverse : petit nombre de personnes, données professionnelles, aucune
donnée sensible, validation humaine, aucune copie, opposition simple.

**Recommandation :** avant d’activer la recherche automatisée,

1. faire valider par un avocat cette analyse de seuil, ou la justification écrite de l’absence
   d’AIPD ;
2. à défaut, mener une AIPD allégée (description du traitement, nécessité et proportionnalité,
   risques pour les personnes, mesures) à partir du présent document ;
3. consulter le DPO s’il en existe un ; l’inscrire à la prochaine revue du registre.

La lecture des réponses par le prestataire d’IA relève de la voie manuelle, déjà en place : elle est
couverte par le registre et le pied du message.

## 5. Points à faire valider par un avocat

1. Intérêt légitime et mise en balance ci-dessus, avant le premier envoi réel.
2. Sources admises : droit des producteurs de bases de données (CPI L. 342-1 à L. 342-3), mentions
   légales de la CNCJ, des barreaux de Lyon et de Bordeaux ; maintien de Paris, Marseille et
   notaires.fr désactivés.
3. Décodage des adresses masquées par Cloudflare : Licitor, en lot à la collecte, avec un accord oral
   non écrit. L’accord oral de Licitor du 14/10/2026 est invoqué à titre provisoire ; sa portée est à confirmer par écrit ; le décodage est suspendu si Licitor ne confirme pas. Vench : pas de décodage. À faire confirmer par écrit et par un avocat
   (voir `docs/equipe/2026-10-14-demandes-autorisation.md`).
4. Compatibilité de finalité du réemploi (section 3).
5. Seuil d’AIPD (section 4).
6. Pied du message : suffisance, mention de la recherche automatique, durées (28 jours au plus après la dernière
   consultation de l’annonce, 12 mois, 24 mois, au moins 3 ans pour la liste d’opposition), transferts liés au prestataire d’IA
   (Replicate, États-Unis) et à l’hébergement du worker.
7. Secret professionnel du destinataire et libellé des questions autorisées.
8. Obligation d’information de l’art. 14 pour les adresses relevées en lot et jamais utilisées (section 2 bis).
9. Durée de conservation des captures HTML du collecteur d’historique Licitor (aucune purge codée).

## 6. Sources

- Cadrage juridique « recherche d’adresses professionnelles pour l’agent d’information »
  (14/10/2026) et avis juridique « recherche automatique » (14/10/2026).
- CNIL, [Recommandations pour les réutilisateurs de données publiées sur Internet](https://www.cnil.fr/sites/cnil/files/2024-06/recommandations_reutilisateurs_donnees_publiees_sur_internet.pdf)
  (12/06/2024).
- CNIL, [Ce qu’il faut savoir sur l’analyse d’impact (AIPD)](https://www.cnil.fr/fr/ce-quil-faut-savoir-sur-lanalyse-dimpact-relative-la-protection-des-donnees-aipd).
- CNIL, [Chapitre III du RGPD (art. 12 à 22)](https://www.cnil.fr/fr/reglement-europeen-protection-donnees/chapitre3).
