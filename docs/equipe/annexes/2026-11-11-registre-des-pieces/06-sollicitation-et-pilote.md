<!-- Rapport du spécialiste `strategie-email`, rendu le 11/11/2026 dans la mission « registre des pièces ». Reproduit tel quel : c'est une analyse, pas une décision. Les décisions sont dans `docs/equipe/2026-11-11-registre-des-pieces.md`. -->

# Agent d'information : pourquoi aucune pièce n'arrive, et comment mener un pilote réel mesuré

**Réserve de méthode.** Je n'ai pas d'outil shell. Je n'ai donc pas pu faire `git fetch` ni `git show origin/main:…`. J'ai lu l'arbre de travail local de `/home/user/immojudis`, sans changer de branche. Il faudra revérifier sur `origin/main` les points marqués « vérifié ».

Je n'ai rien modifié, rien envoyé, et je n'ai lu ni la base ni Vercel. « Vérifié » veut dire lu dans le code ou dans un compte-rendu daté. « Supposé » veut dire non contrôlé.

---

## 1. Pourquoi rien ne part

### A. Le pilote automatique ne peut pas partir. C'est voulu, et c'est juste à ce stade.

Tout ceci est vérifié dans `src/lib/information-agent/autopilot-readiness.ts` et `autopilot-rules.ts` :

- `AUTOPILOT_LEGAL_MIN_PRIVACY_VERSION = "2099-01-01.0"` (ligne 16) ;
- la colonne `live_allowed` vaut faux et seule une migration du lot 3 peut la lever ;
- il faut une AIPD attestée ;
- il faut au moins 30 envois manuels réels avec des taux propres (`AUTOPILOT_MIN_MANUAL_SENDS`) ;
- il faut au moins 7 jours de simulation sans anomalie ;
- il faut un aller-retour attesté depuis moins de 30 jours.

Le préalable « 30 envois manuels » est le pilote lui-même. Tant que personne n'envoie à la main, tout le reste attend.

### B. L'envoi manuel est possible en code, mais personne ne s'en sert

Ce que l'envoi manuel exige (vérifié dans `config.ts` et dans le guide, section « Avant le premier envoi réel ») :

- `INFORMATION_AGENT_OUTBOUND_ENABLED=true` et `INFORMATION_AGENT_OUTBOUND_CANARY_ONLY=false` ;
- l'expéditeur, le secret du portail et l'identité du responsable de traitement (`NEXT_PUBLIC_LEGAL_ENTITY_NAME`, `…_ADDRESS`, `…_CONTACT_EMAIL`). Sans eux, l'envoi est refusé ;
- un aperçu obligatoire, puis « Valider et envoyer », **une vente à la fois**.

État en production, supposé : l'aller-retour interne du 10/11 entre 07:14 et 07:18 laisse penser que l'envoi est ouvert et le canari coupé. À confirmer dans Vercel.

Préalables écrits dans le guide et qui ne sont pas remplis (vérifié, faute de toute trace de leur réalisation) :

1. La validation du gabarit, de la mise en balance et des durées de conservation par un juriste. Les contrats de sous-traitance des prestataires ne sont pas vérifiés non plus.
2. L'abonnement du webhook `information-agent` aux évènements `email.bounced` et `email.complained`. Le compte-rendu du 10/11 (test A3) montre qu'il ne reçoit que `email.received`. Or le webhook des comptes ignore les emails de l'agent (`account-email-delivery-events.ts:26`). **Conséquence : un rebond définitif ou une plainte sur un envoi de l'agent ne marquerait pas l'adresse.** Le registre ne saurait pas qu'une adresse ne doit plus être sollicitée, et les seuils d'arrêt seraient aveugles. **C'est le seul vrai bloquant technique avant le premier envoi à un tiers.**
3. L'identité du responsable de traitement. La société n'est pas créée : qui signe le pied RGPD ? À trancher avec `juridique-rgpd`.

### C. Ce qui freine sans protéger (vérifié dans le code)

- **Une demande par vente, et une seule sollicitation par professionnel tous les 30 jours** (`recipient-cooldown.ts`). Un cabinet qui a 6 ventes ne peut être interrogé que sur une seule par mois. Avec 212 contacts, on plafonne à environ 212 ventes par mois au mieux, et en pratique beaucoup moins. La règle des 30 jours protège ; c'est l'unité « une vente » qui freine.
- **L'ordre des questions ne suit pas les besoins.** Dans `information-agent-questions.ts:86-111`, les priorités sont : pièces du dossier 100, date 96, modalités 94, mise à prix 92, visites 88, occupation 82, surface 72, composition 64. Le plafond est de 4 questions. Le nombre de pièces (629 ventes sans) et la surface (277 sans) sont donc presque toujours coupés.
- **La première question demande de « transmettre le cahier des conditions de vente ».** C'est la demande la plus lourde, et le cahier est déjà consultable au greffe : c'est la plus facile à décliner.
- **Le lecteur automatique ne comprend pas une réponse au format « Nombre de pièces : 3 ».** L'expression régulière n'attend que « 3 pièces » (`fact-extraction.ts:138-141`), et le compte-rendu du 10/11 le confirme. Une réponse bien structurée ne serait donc pas lue.
- **Le pilote se met en pause 90 jours après une réponse** (`AUTOPILOT_REPLY_PAUSE_DAYS`). Il pénalise les avocats qui répondent, alors que ce sont eux qu'il faut solliciter à chaque nouvelle vente.
- **Le lien de dépôt n'est qu'une note libre avec liens et fichiers** (`information-agent-contribution.ts:94`). Ce n'est pas un formulaire par champ.
- **Le pipeline réécrit toute la ligne d'une vente à chaque collecte** (« étape 2 bis », en attente de décision). Une valeur donnée par l'avocat et acceptée serait effacée sans le signaler. Pour « une solution pleinement fonctionnelle », c'est Critique.

### D. Ce que le propriétaire doit faire pour qu'un premier lot parte

| Action                                                                                                                                                                                                 | Temps                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| Vérifier dans Vercel les variables d'envoi, l'expéditeur, le secret du portail, l'identité légale et `LLM_PROVIDER`                                                                                    | 15 min                                        |
| Dans Resend, abonner le webhook `information-agent` à `email.bounced` et `email.complained`                                                                                                            | 10 min                                        |
| Trancher l'identité du responsable de traitement (avec `juridique-rgpd`)                                                                                                                               | décision                                      |
| Faire relire par un avocat le gabarit, la mise en balance et le texte du pilote (section 3). Sinon, décider en connaissance de cause de partir sur le seul avis de `juridique-rgpd`                    | 1 à 3 h de relecture, 1 à 2 semaines de délai |
| Choisir le signataire (nom, et téléphone si accepté) : `INFORMATION_AGENT_SIGNATURE_NAME`                                                                                                              | 5 min                                         |
| Envoyer la vague 0 : 20 messages à 3 à 5 min chacun avec l'aperçu                                                                                                                                      | environ 1 h 30                                |
| Relire les réponses                                                                                                                                                                                    | environ 10 min par réponse                    |
| Passer le pilote automatique en « simulation » pendant ce temps : il n'envoie rien et accumule les 7 jours requis. Ne pas confondre avec la simulation de publication, qui doit attendre l'étape 4 bis | 2 min                                         |

Point à confirmer : le compte-rendu du 08/11 (ligne 600) range « agent d'information en envoi réel » sous « gel levé ». Si un gel est en vigueur, seul le propriétaire peut le lever.

---

## 2. Pilote réel, sous contrôle humain

**Unité : le cabinet, pas la vente.** Une demande par cabinet (clé d'identité ou domaine) regroupe toutes ses ventes éligibles, cinq au plus.

**Deux vagues :**

- **Vague 0, outil actuel, sans développement.** 20 cabinets, une vente chacun. L'administrateur choisit lui-même les questions dans l'ordre surface, pièces, occupation, visite (le brouillon accepte une liste de questions explicite). Texte révisé publié par l'éditeur de gabarit après relecture juridique.
- **Vague 1, après développement.** 40 cabinets avec le message groupé et le formulaire.

**Sélection :**

- classe A uniquement, adresse lue dans l'annonce de la vente ;
- aucune messagerie grand public ;
- adresses Licitor décodées : seulement si le propriétaire assume l'accord oral (décision à prendre) ;
- un tiers des cabinets avec 2 ventes ou plus, pour mesurer l'effet du regroupement ;
- répartir sur au moins 8 tribunaux ;
- greffes exclus de la vague 0.

**Moment :**

- audience entre J-45 et J-15. Jamais en dessous de J-10, comme la règle du pilote automatique ;
- la publicité légale court entre un et deux mois avant l'audience (art. R. 322-31 CPCE, selon [Cass. civ. 2e, 26 juin 2014](https://www.dalloz-actualite.fr/document/civ-2e-26-juin-2014-f-pb-n-13-20193) ; texte en vigueur à vérifier sur Légifrance). Le cabinet a alors le dossier sous la main, et la notice légale doit décrire la nature et l'occupation du bien ;
- pour les visites : avant la première visite connue, quand l'avocat a intérêt à faire venir des visiteurs.

**Créneau :** mardi au jeudi, 9 h 30 à 11 h 30. Ni le 11/11, ni les vacances de Noël (du 19/12 au 04/01). Vague 0 les semaines du 16 et du 23/11, vague 1 du 1er au 11/12.

**Relance :** aucune dans la vague 0. Le pied promet « aucune relance ». Une relance unique à J+7 dans la vague 1 ne se fera que si le juriste l'accepte et que le pied est réécrit.

**Fenêtre d'observation :** 10 jours ouvrés par message.

**Mesures :**

- **Remise :** 97 % ou plus attendu ; arrêt sous 95 %.
- **Rebonds définitifs :** moins de 3 % ; arrêt à 2 sur 20.
- **Plaintes :** 0 ; arrêt à 1.
- **Oppositions :** moins de 5 % ; on réexamine à 3 sur 40.
- **« Mauvais destinataire » :** moins de 5 %.
- **Ouverture : non mesurée.** Pas de pixel. Le clic sur le lien n'est pas fiable non plus, car les passerelles de sécurité des cabinets l'ouvrent d'elles-mêmes. On compte les **soumissions** du formulaire, pas les clics.
- **Réponse humaine :** réponses automatiques et défis anti-spam exclus. On mesure le taux et le délai médian.
- **Forme de la réponse :** texte dans le corps, pièce jointe, renvoi vers un site ou vers le greffe, formulaire, refus, opposition.
- **Part exploitable par champ :** valeurs acceptées par l'administrateur, rapportées au nombre de fois où le champ a été demandé.

**Seuils de décision, avec 40 cabinets :** la marge d'erreur est d'environ plus ou moins 12 à 15 points. On ne conclut donc qu'à grands traits.

- 10 réponses ou plus sur 40 (25 %) : on étend.
- 5 à 9 : on retravaille le message et le moment.
- 4 ou moins (10 % ou moins) : l'email n'est plus le canal principal. Il faut alors exploiter d'abord les PDF déjà collectés (`pdf_rooms_candidates`…) et les sites des cabinets.

**Repère de marché, à prendre comme un plancher :** la prospection commerciale B2B à froid obtient entre 0,5 % et 5 % de réponses selon les études ([Belkins](https://belkins.io/blog/cold-email-response-rates.md), [Hunter](https://hunter.io/the-state-of-cold-email-2025), [Instantly](https://instantly.ai/blog/cold-email-reply-rate-benchmarks)). Notre cas diffère : on écrit sur un dossier précis, à quelqu'un dont l'intérêt rejoint le nôtre. J'espère mieux, mais rien ne le prouve.

---

## 3. Le message

### Critique du gabarit actuel, vu par un avocat ou son secrétariat (vérifié dans le gabarit)

- **Objet** : « …, audience du … : vérification de l'annonce ». « Vérification » sonne comme un contrôle. Rien ne dit ce qu'on demande ni combien de temps cela prend.
- **Expéditeur** : `enquete@` évoque une enquête, ce qui inquiète un avocat. Signature anonyme, « L'équipe Immojudis ».
- **Ouverture** : le message commence par ce qu'est Immojudis, puis explique d'où vient l'adresse (« figure dans l'annonce … sur Licitor (lien) »), avant de dire ce qu'on attend. Ce qui sert au secrétariat (la vente, les 3 points) arrive après deux paragraphes.
- **Questions** : quatre questions longues de 25 à 45 mots chacune. Certaines font « confirmer » ce que l'avocat a lui-même publié. La plus lourde (transmettre le cahier) est posée en premier.
- **Longueur** : pied RGPD complet de 7 rubriques. Il est obligatoire, et il est bien placé après la signature. En revanche, le corps devrait tenir en 120 mots environ.
- **Ce qui inspire confiance et doit rester** : le bloc de la vente précis, « répondre est facultatif », « votre secret professionnel prime », l'absence de toute sollicitation commerciale, la possibilité de transférer à un collaborateur.
- **Intérêt de l'avocat, à peine évoqué** : « évite aux candidats de vous interroger ».

### Version A : formulaire en un clic (une vente)

**Objet :** `Vente du 14/11/2026, appartement à Bordeaux : 3 informations manquent à l'annonce`

**Aperçu :** `Surface, nombre de pièces, occupation. Une minute, sans compte. Répondre est facultatif.`

> Bonjour Maître Dupont,
>
> Pour la vente ci-dessous, dont vous êtes l'avocat poursuivant, notre fiche publique ne donne pas encore trois informations que les candidats acquéreurs demandent le plus souvent.
>
> [Bloc vente : Appartement, 33000 Bordeaux · Tribunal judiciaire de Bordeaux · Audience annoncée : 14/11/2026 · Mise à prix annoncée : 85 000 €]
>
> 1. Surface habitable ou Carrez
> 2. Nombre de pièces principales
> 3. Occupation : libre, occupé ou loué
>
> [Bouton : Compléter ces 3 informations]
>
> Vous pouvez aussi répondre directement à cet email, ou nous indiquer où ces éléments sont consultables. Ne communiquez que ce qui l'est à tout candidat acquéreur : votre secret professionnel prime sur notre demande. Une fiche complète évite aux candidats de vous appeler pour ces points.
>
> Répondre est facultatif.
>
> Bien cordialement,
> [Prénom Nom], pour Immojudis
> Site privé d'information sur les ventes immobilières aux enchères. Nous ne vendons aucun bien et n'agissons pas au nom d'un tribunal.
>
> Ne plus être contacté
> [pied RGPD inchangé, mention IA comprise ; la phrase d'origine de l'adresse passe dans le pied si le juriste l'accepte]

**Variante groupée :**

- Objet : `Vos 3 ventes à venir au TJ de Bordeaux : informations manquantes sur les annonces`
- Une ligne par vente avec ses champs manquants, puis un seul bouton « Compléter les fiches ».

**Formulaire :**

- pré-rempli avec ce que la fiche affiche déjà, pour que l'avocat confirme ou corrige ;
- champs : surface habitable, surface Carrez, nombre de pièces, occupation (libre / occupé / loué / je ne peux pas le communiquer), dates de visite (date et heure), dépôt de pièces ;
- case « Ne pas publier, pour information seulement » ;
- boutons « Ce n'est pas mon dossier » et « Ne plus être contacté » ;
- case non cochée : « Vous pouvez m'écrire pour mes prochaines ventes ». C'est un accord exprès, à faire valider par le juriste ;
- une simple ouverture du lien n'enregistre rien, puisque les passerelles de sécurité ouvrent les liens d'elles-mêmes.

### Version B : réponse par email, lisible par une machine

Même ouverture que la version A, puis :

> Pour répondre par email, complétez les lignes ci-dessous et renvoyez ce message. Laissez vide ce que vous ne pouvez pas communiquer.
>
> [IJ-AB12CD34] Vente du 14/11/2026, Bordeaux
>
> 1. Surface habitable (m²) :
> 2. Surface Carrez (m²) :
> 3. Nombre de pièces principales :
> 4. Occupation (libre / occupé / loué) :
> 5. Prochaine visite (date et heure) :
> 6. Où consulter le cahier des conditions de vente :

Pour plusieurs ventes, on numérote A1 à A6, B1 à B6, avec la référence de chaque vente.

Condition technique : il faut un lecteur ancré sur ces libellés exacts. Il doit aussi accepter les lignes remplies **à l'intérieur du message cité**, car les avocats répondent souvent dans le texte, et aujourd'hui le texte cité est retiré avant lecture. Une ligne restée vide ou identique au modèle ne vaut rien.

Un point s'ajoute : notre texte cité contient « secret professionnel », ce qui envoie aujourd'hui la réponse en relecture (compte-rendu du 10/11). Le lecteur doit l'ignorer.

---

## 4. Rythme et segments

**Ordre de priorité :**

1. Audience entre J-45 et J-15.
2. Ventes sans surface, sans nombre de pièces ou sans occupation (champs à afficher en priorité). Les visites seulement si aucune n'est passée.
3. Cabinets qui ont plusieurs ventes.
4. Cabinets jamais contactés.

**Fréquence :** un message par cabinet et par 30 jours, toutes ventes regroupées. La règle actuelle est gardée, mais l'unité change.

Les avocats qui ont répondu et coché « prochaines ventes » : un message par nouvelle vente, sans dépasser un par semaine (juriste). Il faut alors lever pour eux la pause de 90 jours.

**Selon la réaction :**

- **Silence :** aucune relance dans la vague 0. Le cabinet redevient éligible après 30 jours pour une autre vente. Après 2 silences, pause de 6 mois (règle existante, à garder).
- **Refus poli :** on le note, pas de nouvelle demande avant 6 mois.
- **Opposition :** définitive (existant).
- **« Ce n'est pas mon dossier » :** exclusion de l'identité et arrêt du pilote (existant).
- **Réponse partielle :** on accepte ce qui est donné et on ne redemande pas le reste pour cette vente.
- **Renvoi vers un site ou un document :** la lecture du site est à faire par l'administrateur.

**Greffe :** seulement pour savoir quel avocat poursuit, sur les ventes de classe D. C'est déjà le seul usage codé. On ne lui pose pas de questions sur le bien, et il n'entre pas dans la vague 0. Ensuite, un bras distinct de 10 envois, mesuré à part, avec le plafond de 3 par tribunal et par jour.

---

## 5. Délivrabilité et réputation

**Ce qui est en place** (vérifié dans le guide et le code) :

- SPF, DKIM et DMARC « pass » sur `reponses.immojudis.com` (compte-rendu du 10/11, test T1) ;
- expéditeur séparé de celui des comptes ;
- en-têtes `List-Unsubscribe` et `List-Unsubscribe-Post` ;
- page d'opposition avec un GET qui n'écrit rien ;
- hygiène des adresses (vérification MX, deux rebonds passagers bloquent) ;
- alertes : rebonds définitifs à 3 % sur 14 jours (au moins 10 envois), plaintes ;
- seuils d'arrêt et plafonds par domaine et par tribunal du pilote automatique ;
- reconnaissance des réponses automatiques (`reply-signals.ts`).

**Ce qui manque :**

1. **Critique** : le webhook de l'agent ne reçoit ni les rebonds ni les plaintes (section 1.B).
2. Les défis anti-spam par réponse, fréquents dans les cabinets français (supposé ; Mailinblack par exemple), ne sont pas reconnus. Il faut une catégorie « défi » : jamais comptée comme réponse, validée à la main ou ignorée.
3. Pas de test de placement avant la vague. Le propriétaire peut envoyer vers des boîtes internes hébergées chez Microsoft 365 et chez un fournisseur français, et vérifier l'arrivée en boîte de réception.
4. Seuils d'arrêt pour les envois manuels : aujourd'hui seulement des alertes, ce qui suffit sous contrôle humain. À reprendre pour l'automatique.
5. Politique DMARC du sous-domaine (`p=none` ou plus strict) : non vérifiée.

**À l'échelle visée :** quelques dizaines puis quelques centaines d'envois par semaine. Les seuils des messageries grand public, comme le taux de plaintes sous 0,3 % chez Google ([aide Google](https://support.google.com/a/answer/14229414)), ne seront jamais atteints en volume. Le vrai risque est le filtrage par cabinet, au cas par cas. On monte donc par paliers : 20, 40, puis 80 par semaine. On ne passe au palier suivant qu'après une semaine propre. Garder les créneaux et l'espacement aléatoire déjà codés.

---

## 6. Cadre (rappel, sans trancher)

**Déjà posé :**

- intérêt légitime, avec une mise en balance à valider ;
- information au titre de l'article 14 dans le pied ;
- opposition en un clic, par adresse et par identité ;
- une sollicitation par professionnel et par 30 jours ;
- aucune relance ;
- exclusions : juridictions, RPVA, Ordre, CARPA, adresses techniques, messageries grand public pour le pilote automatique ;
- aucune mention commerciale (`information-agent-commercial-guard.ts`) ;
- les adresses, réponses et silences ne servent jamais à classer des avocats ni à les mettre en relation.

**À soumettre à `juridique-rgpd` :**

1. Un message qui regroupe plusieurs ventes d'un même cabinet.
2. Une relance unique, contraire à la promesse actuelle.
3. Le formulaire pré-rempli et la case « prochaines ventes » comme accord exprès.
4. L'argument « évite aux candidats de vous appeler » ou « attire des enchérisseurs » : est-ce encore informatif ?
5. Une signature nominative, avec téléphone.
6. Un changement d'adresse d'expéditeur (`enquete@`).
7. Déplacer la phrase d'origine de l'adresse dans le pied.
8. Le responsable de traitement tant que la société n'existe pas.
9. Les adresses Licitor décodées dans le pilote manuel.
10. La conservation des formulaires reçus.
11. Le texte de publication attribuée, déjà proposé le 10/11.

---

## 7. Rendre la main à la machine

1. **Préparer.** Chaque jour, la machine construit la file groupée par cabinet, les brouillons et les aperçus. L'administrateur valide message par message. C'est possible dès la vague 1.
2. **Proposer en lot.** Validation d'un lot de 10 par l'administrateur, avec l'aperçu de chaque message. Condition : la vague 1 est terminée sans plainte ni rebond définitif.
3. **Envoyer seul**, seulement pour le segment avocat, adresse de l'annonce, domaine de cabinet. Le contrôle de préparation existant reste en place, et on y ajoute des chiffres :
   - 40 cabinets ou plus contactés ;
   - remise de 97 % ou plus ;
   - rebonds définitifs sous 2 % ;
   - aucune plainte ;
   - oppositions sous 5 % ;
   - « mauvais destinataire » sous 3 % ;
   - réponse humaine de 15 % ou plus.
4. **Publier les informations, champ par champ.** Pour chaque champ (nombre de pièces, surface, puis surface du terrain ; l'occupation plus tard), il faut au moins 30 valeurs reçues et acceptées sans aucune correction par l'administrateur. Même avec 0 erreur sur 30, le taux d'erreur réel peut encore atteindre 10 % (au seuil de confiance de 95 %). Pour descendre à 3 %, il faut environ 100 valeurs sans erreur. Il faut aussi les verrous de l'étape 6 et l'étape 2 bis corrigée.

---

## Propositions

| N°  | Proposition                                                                                                              | Priorité | Effort | Qui                       |
| --- | ------------------------------------------------------------------------------------------------------------------------ | -------- | ------ | ------------------------- |
| 1   | Abonner le webhook `information-agent` à `email.bounced` et `email.complained`, puis vérifier                            | Critique | S      | propriétaire              |
| 2   | Vérifier les variables d'envoi, l'identité légale et `LLM_PROVIDER` en production                                        | Critique | S      | propriétaire              |
| 3   | Trancher le responsable de traitement et la relecture juridique du gabarit                                               | Critique | M      | propriétaire, juriste     |
| 4   | Étape 2 bis : le pipeline n'écrase plus une valeur de l'avocat                                                           | Critique | M      | développeur               |
| 5   | Vague 0 : 20 cabinets, outil actuel, questions choisies à la main, texte révisé publié par l'éditeur                     | Haute    | M      | propriétaire, rédacteur   |
| 6   | Réordonner les priorités des questions (surface, pièces, occupation, visites d'abord) et raccourcir les questions        | Haute    | S      | développeur, rédacteur    |
| 7   | Demande groupée par cabinet (plusieurs ventes, une mission, une sollicitation)                                           | Haute    | L      | développeur               |
| 8   | Formulaire structuré pré-rempli, avec « ne pas publier », « pas mon dossier » et opposition                              | Haute    | L      | développeur, rédacteur    |
| 9   | Lecteur des réponses numérotées, y compris dans le texte cité, et règle « secret professionnel » corrigée                | Haute    | M      | développeur               |
| 10  | Tableau de mesure du pilote : forme de réponse, part exploitable par champ, réponses humaines hors réponses automatiques | Haute    | M      | développeur               |
| 11  | Reconnaître les défis anti-spam par réponse                                                                              | Moyenne  | S      | développeur               |
| 12  | Pilote automatique en simulation dès maintenant (sans envoi)                                                             | Moyenne  | S      | propriétaire              |
| 13  | Remplacer la pause de 90 jours après réponse par l'accord « prochaines ventes »                                          | Moyenne  | M      | développeur, juriste      |
| 14  | Expéditeur moins inquiétant que `enquete@` et signature nominative                                                       | Moyenne  | S      | propriétaire, développeur |
| 15  | Mesurer la part des 629 ventes sans nombre de pièces qu'on peut compléter avec les PDF déjà collectés                    | Moyenne  | M      | développeur               |
| 16  | Test de placement en boîte de réception vers des boîtes internes avant chaque vague                                      | Moyenne  | S      | propriétaire              |
| 17  | Bras « greffe » distinct, 10 envois, après la vague 0                                                                    | Moyenne  | S      | propriétaire              |

---

## Décisions du propriétaire

1. Un gel de l'envoi réel est-il en vigueur (compte-rendu du 08/11) ? Si oui, le levez-vous ?
2. Au nom de qui partent les messages tant que la société n'existe pas ?
3. Faites-vous relire le message par un avocat avant la vague 0, ou partez-vous sur le seul avis de `juridique-rgpd` ?
4. Qui signe les messages ? Donne-t-on un numéro de téléphone ?
5. Accepte-t-on les adresses Licitor décodées dans le pilote manuel ?
6. Lancez-vous la vague 0 avec l'outil actuel, sans attendre le formulaire ?
7. Relance unique ou non, à partir de la vague 1 ?
8. Validez-vous les seuils de décision : on étend à 25 % de réponses ou plus, on change de canal à 10 % ou moins ?
9. Validez-vous la correction de l'étape 2 bis ?

---

## Fichiers cités (lus dans l'arbre local)

- /home/user/immojudis/docs/runbooks/information-agent.md
- /home/user/immojudis/docs/equipe/2026-11-10-enrichissement-automatique-fiches.md
- /home/user/immojudis/docs/equipe/2026-11-10-agent-ia-onglets-et-tests-emails.md
- /home/user/immojudis/docs/equipe/2026-11-08-etat-des-lieux.md
- /home/user/immojudis/src/lib/information-agent/autopilot-readiness.ts
- /home/user/immojudis/src/lib/information-agent/autopilot-rules.ts
- /home/user/immojudis/src/lib/information-agent/recipient-cooldown.ts
- /home/user/immojudis/src/lib/information-agent/config.ts
- /home/user/immojudis/src/lib/information-agent-questions.ts
- /home/user/immojudis/src/lib/information-agent-email-template.ts
- /home/user/immojudis/emails/information-request.tsx
- /home/user/immojudis/src/lib/information-agent-inbound/fact-extraction.ts
- /home/user/immojudis/src/lib/information-agent-contribution.ts
- /home/user/immojudis/src/lib/account-email-delivery-events.ts

Sources externes :

- [Belkins](https://belkins.io/blog/cold-email-response-rates.md)
- [Hunter](https://hunter.io/the-state-of-cold-email-2025)
- [Instantly](https://instantly.ai/blog/cold-email-reply-rate-benchmarks)
- [Aide Google, expéditeurs](https://support.google.com/a/answer/14229414)
- [Cass. civ. 2e, 26 juin 2014](https://www.dalloz-actualite.fr/document/civ-2e-26-juin-2014-f-pb-n-13-20193)
