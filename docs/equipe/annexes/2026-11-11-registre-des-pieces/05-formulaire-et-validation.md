<!-- Rapport du spécialiste `ux-designer`, rendu le 11/11/2026 dans la mission « registre des pièces ». Reproduit tel quel : c'est une analyse, pas une décision. Les décisions sont dans `docs/equipe/2026-11-11-registre-des-pieces.md`. -->

# Formulaire de réponse de l'avocat, validation en un clic, source sur la fiche

Parcours simulés : simulation qualitative, à confirmer par des tests réels.

# Formulaire de réponse de l'avocat, validation en un clic, source sur la fiche (conception, 11/11/2026)

## Méthode

- **Lecture.** Code lu sur `origin/main` à jour (`git show`). Aucun fichier modifié, aucune branche changée.
- **Captures.** Deux pages publiques en 390 px, sans connexion, aucun formulaire envoyé :
  - `/contribuer/<identifiant fictif>` (le lien sans jeton) ;
  - une fiche `/sales/25d05d49…`.
  - Images : `/tmp/claude-0/-home-user-immojudis/b7491545-da88-513a-b162-0678bf40ae93/scratchpad/shots/contribuer-sans-jeton.png` et `/tmp/claude-0/-home-user-immojudis/b7491545-da88-513a-b162-0678bf40ae93/scratchpad/shots/fiche.png`.
  - Le formulaire chargé n'a pas pu être vu : il faut un jeton réel. Ce qui suit sur lui vient du code.
- **Marquage.** [V] = vérifié dans le code ou sur capture. [S] = supposé.

## 1. Ce qui existe aujourd'hui

### Le portail `/contribuer/<mission>`

Fichiers : `src/app/contribuer/[missionId]/page.tsx`, `src/components/information-agent/InformationAgentContributionForm.tsx`, `src/lib/information-agent-contribution*.ts`.

**Pour qui.** Le destinataire d'une demande envoyée, ou toute personne à qui il transfère l'email. [V]

**Le lien**

- Il est propre à une mission (une vente, une adresse). [V]
- Il est signé (HMAC) et lié à la mission, au dossier et à l'adresse. [V]
- Il vaut 45 jours (`CONTRIBUTION_TOKEN_LIFETIME_MS`). [V]
- Le jeton passe dans le fragment de l'adresse, puis il est effacé de la barre d'adresse et gardé dans l'onglet. [V]

**Ce que fait la page** [V]

- Elle affiche :
  - un titre sur 3 lignes en mobile ;
  - la vente (« Vente concernée », référence de suivi) ;
  - les questions de l'email, en prose (« Ce que nous vous avons demandé »).
- Champs dans l'ordre :
  1. « Nom ou cabinet », obligatoire ;
  2. « Adresse e-mail », obligatoire ;
  3. « Votre réponse », **texte libre** ;
  4. « Liens utiles » ;
  5. pièces jointes : PDF, images ou TXT ; 20 Mo par fichier, 40 Mo par envoi, 12 fichiers par dossier ; Word refusé ;
  6. case « J'atteste être autorisé à transmettre… », obligatoire ;
  7. bloc de confidentialité ;
  8. bouton « Transmettre ma réponse ».

**Ce que devient la réponse** [V]

- Elle est enregistrée comme un message entrant `channel: portal`, identité non vérifiée.
- Elle passe donc par **la même extraction par règles et par l'IA que l'email**.
- Le moteur « publier ou relire » exclut le portail : « ni portail, ni import manuel », dans le guide `docs/runbooks/information-agent.md`, section moteur.

**Ce qui lui manque** [V]

- **Aucun champ structuré.** Le portail reproduit le problème du texte libre.
- **Rien de ce que nous savons déjà.** La session ne renvoie que la référence, l'objet, les questions et les limites.
- **Pas de lots**, pas de « je ne sais pas », pas de « non communicable ».
- **Pas d'autorisation de publier.** L'attestation précise même qu'« elle ne vaut pas autorisation de diffusion publique ».
- **Pas de relecture de ce qui a été envoyé.** Rouvrir le lien affiche un formulaire vide. La correction passe par « répondez simplement à l'email reçu ».
- **Pas de page multi-ventes.**

**Dans l'email** [V]

- Le lien est présenté comme une issue de secours pour les fichiers lourds.
- Texte du bloc : « Des pièces trop lourdes pour un email ? Déposez-les… ». Bouton : « Déposer des pièces pour ce dossier » (`emails/information-request.tsx:200`).
- Rien n'invite à répondre par le portail.

**Sur la capture du lien sans jeton** [V]

- L'en-tête du site affiche la pilule « S'inscrire » : une sollicitation commerciale sur une page destinée à l'avocat.
- La ligne « Pour vous opposer ou exercer vos droits » se coupe mal en 390 px.

**Écart au design system** [V]

- Le portail utilise `glass-shell`, `liquid-page` et des couleurs brutes (`red-50`, `emerald-50`).
- L'onglet Réponses utilise `amber-50`, `slate-50` et `red-700`.
- Or `docs/design/fondations.md` demande des cartes blanches sur filet, sans ombre, et des jetons par rôle (`warning`, `success`, `danger`).

### Le gabarit de la demande

Fichiers : `src/lib/information-agent-email-template.ts`, version 10 ; table `information_agent_email_templates`. [V]

- Ordre du message :
  1. formule d'appel ;
  2. identité ;
  3. bloc de la vente ;
  4. « notre équipe la relit avant toute mise à jour de la fiche » ;
  5. au plus 4 questions longues et à plusieurs volets, par exemple « Pouvez-vous confirmer séparément la surface habitable, la surface Carrez et, le cas échéant, la surface du terrain ? » (`src/lib/information-agent-questions.ts`) ;
  6. consignes et secret professionnel ;
  7. encadré de dépôt ;
  8. pied RGPD (art. 14).
- **Contrainte forte** : une seule sollicitation par professionnel et par période de 30 jours, toutes ventes confondues (guide, « Limites connues »). Un cabinet qui a 10 ventes n'est interrogé que sur une seule par mois.
- **Garde anti-commerciale** : tout lien hors confidentialité, dépôt privé et opposition bloque l'envoi (`information-agent-commercial-guard.ts`).
- **La page `/agent-information` n'existe pas** dans `src/app` : elle reste un brouillon (`docs/agent-information-brouillon.md`). Il n'y a donc pas de page « qui sommes-nous » vers laquelle renvoyer.

### L'onglet Réponses

Fichiers : `/admin/agent-ia`, `AdminInformationAgentWorkspace.tsx`, `AdminInformationAgentReviewPanel.tsx`. [V]

- Trois panneaux empilés : réponses de l'agent, revue des faits (`AdminAuctionFactClaimReviewPanel`), messages non rattachés.
- Le panneau de l'agent affiche **deux listes séparées** : les messages, puis les informations extraites. Elles ne sont pas regroupées par vente. La vente apparaît comme « Voir l'annonce 25d05d49 ».
- Ce que montre une information :
  - le libellé et la valeur ;
  - « confiance déclarée par le modèle : 87 % » ;
  - un extrait **non surligné et hors de sa phrase** ;
  - les motifs de doute et l'alerte de lot.
- Ce qu'elle ne montre pas :
  - **la valeur actuelle de la fiche et sa source** (le panneau des faits a, lui, « Valeur extraite / Valeur canonique actuelle ») ;
  - l'état « identique à la fiche ».
- Actions : « Accepter » ; « Rejeter » avec un champ de motif libre toujours visible.
- « Mauvais destinataire » passe par `window.prompt`.
- Il manque : corriger puis accepter (le schéma n'accepte que `accepted` ou `rejected`, `src/lib/admin-information-agent.ts:107`), demander une précision, raccourcis clavier, annulation.

### La fiche publique

**La mention de l'avocat** [V]

- Texte validé le 10/11 : « Information transmise par l'avocat poursuivant le JJ/MM/AAAA, non vérifiée par Immojudis. Vérifiez-la dans le cahier des conditions de vente. »
- Elle s'affiche en entier sous chaque bloc concerné (`lawyer-fact-sources.ts:124`, `SaleListing.tsx`, `ListingDataCoverage.tsx`).

**Ce qui existe et se réutilise** [V]

- `ListingDataCoverage` a déjà les états « Information manquante », « Sources à départager » et « Estimation ».
- Il a une fenêtre de source par information (`SourceDialog` ; types « Annonce d'origine », « Document joint », « Source consultée »).
- Il a un accordéon « N informations non communiquées dans le dossier ».
- `ListingCharacteristics` indique la source une fois par bloc (« Informations publiées sur l'annonce de la source »).
- Sur la capture : « Source de l'annonce : Immobilier.notaires. Signaler une erreur sur cette fiche ».

## 2. Parcours de l'avocat aujourd'hui (Maître Dubois et son assistante)

**État d'esprit.** Il lit sur téléphone, entre deux audiences. Il se méfie d'un site privé qui publie « ses » ventes. Il ne veut ni créer de compte, ni écrire un mail. Il doit voir en 3 secondes : qui écrit, pour quelle vente, ce qu'on attend de lui, et que c'est court.

1. **Email, premier écran.** [V] contenu, [S] rendu
   - « Immojudis… n'agit pas au nom d'un tribunal. Appartement T3 à Bordeaux, audience du 14/11. » Rassurant.
   - Puis quatre questions longues : « Il faut que j'ouvre le dossier pour répondre à ça. Plus tard. » **Premier abandon** : la réponse est remise à plus tard.
2. **Email, fin.** [V]
   - L'encadré doré parle de « pièces trop lourdes ». Il ne voit pas de formulaire : il répond en deux lignes libres, ou transfère à son assistante.
   - C'est l'origine des 215 réponses piégées.
3. **Portail, si l'assistante l'ouvre.** [V] contenu, [S] hauteurs
   - Titre sur 3 lignes, introduction, vente, questions répétées.
   - Le premier champ arrive probablement autour de 900 à 1 100 px : 1 à 2 écrans à défiler. À mesurer par `optimisation-interface`.
   - Elle doit saisir nom et email (déjà connus de nous), puis réécrire en texte libre ce qu'elle a trouvé.
   - La case d'attestation, avec « ne vaut pas autorisation de diffusion publique », inquiète : « Alors qu'allez-vous publier ? »
   - « S'inscrire » en haut : « C'est commercial. » **Deuxième abandon possible.**
4. **Après l'envoi.** [V]
   - « Réponse reçue… Pour corriger ou retirer un envoi, répondez simplement à l'email reçu. »
   - Il ne voit pas ce qu'il a envoyé, ni ce qui sera affiché, ni sous quelle mention.

## 3. Le formulaire proposé (mobile d'abord, 390 px puis 320 px)

**Principes**

- Une page par vente.
- Au plus 4 questions : celles de l'inventaire, qui demande seulement ce qui est absent, contradictoire ou estimé.
- Une réponse = un tap ou un nombre.
- Aucun champ d'identité obligatoire.
- Pas d'en-tête commercial (masquer « S'inscrire » et la navigation sur `/contribuer`).
- Style : cartes blanches sur `line`, bouton or plein (`bg-gold text-brand-navy`, celui du site), états `warning-tint` / `success-tint`.

### Écran 1 : le premier écran, sans défiler

- Surtitre : « RÉPONSE À IMMOJUDIS »
- Titre (22 px) : « Appartement 3 pièces, Bordeaux »
- Ligne : « Audience du 14/11/2026 · Tribunal judiciaire de Bordeaux · mise à prix 80 000 € »
- Phrase : « 3 informations manquent à notre fiche. Une réponse partielle nous aide déjà. Sans compte. »
- Lien discret : « Qui sommes-nous et que devient votre réponse ? » Il ouvre un panneau en place, sans quitter la page (voir la section Confiance).
- Le premier champ doit apparaître ici.

### Écran 2 : les questions, une carte par champ manquant

Chaque carte suit le même ordre : libellé court, choix, puis la ligne d'issues.

**Ligne d'issues (sur chaque carte)**

- « Je ne sais pas »
- « Voir le document joint »
- « Non communicable »
- Elles sont distinctes : « non communicable » respecte le secret professionnel et ne sera jamais relancé.

**Occupation**

- Titre : « Le bien est-il occupé ? »
- Choix : « Libre » · « Loué » · « Occupé par le propriétaire saisi » · « Occupé, sans précision ».
- Le cas `squatted` n'est pas proposé, à trancher (décision D7).

**Surface**

- Titre : « Surface »
- Champ numérique (`inputmode="decimal"`), suffixe « m² ».
- Sélecteur : « Carrez » · « Habitable » · « Je ne sais pas laquelle ».
- « Terrain » seulement pour une maison ou un terrain.

**Pièces**

- Titre : « Nombre de pièces principales »
- Pastilles 1 · 2 · 3 · 4 · 5 · 6 et plus.

**Visites**

- Titre : « Visites »
- Choix : « Une visite est fixée » (ouvre date et heure, plusieurs dates possibles) · « Pas encore fixées » · « Aucune visite prévue ».
- Puis : « Modalité : sans inscription / sur inscription auprès du cabinet / voir le cahier des conditions de vente ».
- Pas de champ libre de coordonnées : risque de données de tiers.

**Documents** : « Cahier des conditions de vente » et « Procès-verbal descriptif »

- Bouton « Joindre le fichier », ou « Il est consultable ici : [lien] », ou « Au greffe seulement ».

### Écran 3 : ce que la fiche indique déjà (replié par défaut)

- En-tête : « Nous avons déjà : 3 pièces, mise à prix 80 000 €, audience le 14/11. Une erreur ? »
- Chaque ligne a sa source (« selon l'annonce Licitor ») et un lien « Corriger » qui ouvre le champ.
- La date de vente est préremplie : « Vente maintenue le 14/11 ? Oui (par défaut) · Renvoyée · Retirée ». Si « Retirée », les autres questions disparaissent.

### Vente à plusieurs lots

[S] : le modèle des lots est à confirmer. Le pipeline connaît `multi_lot_sale` et `lot_count`. Une fiche peut couvrir plusieurs lots, ou chaque lot avoir sa fiche.

- Une carte repliable par lot : « Lot 1 : appartement, 2e étage », « Lot 2 : cave ».
- Les questions par lot, avec un compteur « Lot 1 sur 3 ».
- Une question commune au-dessus (« Les lots sont-ils vendus ensemble ? »), seulement si elle est utile.
- Jamais de « même valeur pour tous les lots » pour la surface ou les pièces.
- Le lot est toujours explicite, ce qui supprime le motif « lot non nommé ».

### Écran 4 : l'autorisation de publier, juste avant le bouton

- Titre : « Affichage sur la fiche publique »
- Trois choix exclusifs, **aucun présélectionné** (choix obligatoire, un tap) :
  1. « J'accepte que ces informations soient affichées sur la fiche, avec la mention ci-dessous. »
  2. « J'accepte, sauf pour les informations que je décoche. » Une case par valeur apparaît, toutes cochées.
  3. « Ne rien afficher : ces informations servent seulement à vérifier la fiche. »
- Aperçu réel, sous les choix : « Sur la fiche, cela apparaîtra ainsi : Surface 54 m², Information transmise par l'avocat poursuivant le 12/11/2026, non vérifiée par Immojudis. Vérifiez-la dans le cahier des conditions de vente. »
- Puis : « Votre nom n'apparaît pas. Les documents joints ne sont jamais publiés sans contrôle de notre équipe. »
- L'attestation actuelle est fondue ici, en une phrase : « En envoyant, vous confirmez être autorisé à transmettre ces informations. » À valider par `juridique-rgpd`.
- Une ligne facultative : « Vous répondez en tant que : Avocat poursuivant · Collaborateur du cabinet ». Nom facultatif. L'email n'est pas redemandé : « Si une précision est nécessaire, nous écrirons à l'adresse qui a reçu la demande. »
- Bouton : « Envoyer ma réponse »

### Écran 5 : la confirmation

- Titre : « Merci, réponse enregistrée le 12/11/2026 à 10 h 42 »
- Récapitulatif de ce qui a été envoyé, valeur par valeur, avec le choix d'affichage.
- Phrase : « Notre équipe vérifie chaque information avant de l'afficher. »
- Bouton secondaire : « Modifier ma réponse ». Il fonctionne avec le même lien jusqu'à la vente.
- Lien : « Retirer une information affichée ».
- Cabinet à plusieurs ventes : bouton principal « Vente suivante (2 sur 5) ».

### Correction après envoi

- Rouvrir le lien affiche la réponse précédente, préremplie, et non un formulaire vide.
- Une modification crée une nouvelle version. L'administrateur la voit comme une « correction de l'avocat ».
- Une valeur déjà affichée et retirée par l'avocat est masquée tout de suite, en attente de vérification, comme le texte juridique proposé le promet.

### Confiance : le panneau « Qui sommes-nous… », 5 lignes

1. « Immojudis est un site privé d'information sur les ventes aux enchères, destiné aux candidats acquéreurs. Il n'agit pas au nom d'un tribunal. »
2. « Votre réponse complète la fiche publique de cette vente. Elle évite aux candidats de vous interroger sur des points déjà connus. »
3. « Rien n'est affiché sans vérification par notre équipe, et toujours avec la mention de l'avocat poursuivant, sans votre nom. »
4. « Vous pouvez corriger ou retirer une information à tout moment avec ce même lien. »
5. Liens : « Politique de confidentialité » · « Ne plus être contacté ».

La validation en un clic garde vraie la promesse actuelle d'une relecture humaine. Les textes juridiques changent donc moins qu'avec le mode automatique.

## 4. Un avocat, plusieurs ventes : page « Vos ventes à venir »

**Pourquoi.** Avec la règle des 30 jours, 9 ventes sur 10 d'un cabinet ne sont jamais interrogées dans le mois [V règle, S volume]. Une seule demande, une seule page, multiplie la couverture sans écrire davantage.

**Accès** [S, à concevoir]

- Lien signé lié à l'adresse sollicitée (et à son identité), 45 jours.
- Il liste les ventes à venir dont cette adresse est le contact relevé sur l'annonce.

**Structure**

- Titre : « Vos ventes à venir sur Immojudis (5) »
- Sous-titre : « Classées par date d'audience. Complétez celles que vous voulez, dans l'ordre que vous voulez. »
- Une carte par vente :
  - « 14/11 · Appartement, Bordeaux · 3 informations manquantes » ;
  - état : « À compléter » / « Envoyée le 12/11 » / « Complète » ;
  - un lien « Ce n'est pas mon dossier », qui alimente « mauvais destinataire ».
- Après chaque envoi : « Vente suivante ».
- Pas de tri, pas de filtre au-delà de 10 ventes. Au-delà, une pagination simple.

## 5. L'email qui amène au formulaire

**Objet** : inchangé. « Appartement T3 à Bordeaux, audience du 14/11/2026 : vérification de l'annonce »

**Corps**, sous la formule d'appel et l'identité actuelles :

- « Pour cette vente, il manque à notre fiche : la surface, l'occupation et les dates de visite. »
- « Répondre est facultatif et prend moins d'une minute, sans compte. »
- Bouton : « Répondre en 3 questions ». Le nombre doit être exact.
- Cabinet à plusieurs ventes, une ligne de plus : « Vous suivez aussi 4 autres ventes à venir : [Voir vos 5 ventes] ».
- Juste sous le bouton : « Vous préférez écrire ? Répondez simplement à cet email, ou transférez-le au collaborateur qui suit le dossier. »

**Ce qu'on retire**

- La liste des questions en prose : on garde seulement les noms des informations manquantes.
- L'encadré « pièces trop lourdes » : le dépôt de fichiers vit dans le formulaire.

**Ce qu'on garde** : le paragraphe sur le secret professionnel et le pied RGPD complet.

**Réponse par email** : elle suit le circuit actuel (règles, IA, relecture) et arrive dans la même file d'administration, marquée « Email ». Aucun accusé de réception automatique sans décision (D5).

## 6. L'écran de validation de l'administrateur

Il remplace le panneau des réponses de l'agent dans l'onglet Réponses.

**En-tête**

- « À valider : 47 informations, 12 ventes ».
- Filtres en pastilles : « Formulaire (32) » · « Email (15) » · « Contradictions (4) » · « Pièces (6) ».

**Ordre de la file**

1. Date d'audience la plus proche : une échéance réelle.
2. Puis les réponses par formulaire avant les emails.
3. Dans une vente : occupation, surface, pièces, visites, documents.

**Un groupe par vente**

En-tête du groupe : « Appartement T3, Bordeaux · audience 14/11 (dans 3 jours) · réponse par formulaire le 12/11 à 10 h 42, par le lien envoyé à l'adresse relevée · affichage : tout autorisé ».

Une ligne par information, en 5 colonnes, qui se replient en 2 lignes sous 1 024 px :

| Colonne        | Contenu                                                                                                                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Champ          | « Surface (Carrez), lot 1 »                                                                                                                                                                        |
| Proposé        | « 54 m² »                                                                                                                                                                                          |
| Fiche actuelle | « vide » ou « 61 m², annonce Licitor »                                                                                                                                                             |
| Origine        | Formulaire : « case : Libre » ou « saisi : 54 ». Email : la phrase complète, la valeur surlignée (`mark`), la phrase précédente et la suivante en gris. Pièce : nom et page.                       |
| État           | Pastille « Nouveau » (`neutral`) · « Identique » (`success`) · « Contradiction » (`warning`, les deux valeurs côte à côte) · « Doute » (`warning`, motifs en clair) · « Ne pas afficher » (`info`) |

**Actions**

| Action                         | Touche          | Effet                                                                                                                         |
| ------------------------------ | --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Accepter                       | `A` ou `Entrée` | Valide l'information.                                                                                                         |
| Corriger                       | `C`             | Édite en place, puis `Entrée` accepte la valeur corrigée. La valeur proposée reste au journal.                                |
| Refuser                        | `R`             | Ouvre des motifs en un tap : « Déjà connu », « Autre lot », « Doute dans la phrase », « Valeur invraisemblable », « Autre… ». |
| Demander une précision         | `P`             | Prépare une question dans le même dossier. Rien n'est envoyé sans l'aperçu actuel.                                            |
| Tout accepter pour cette vente | `Maj+A`         | Actif seulement si toutes les lignes viennent du formulaire, champ vide, sans contradiction ni doute.                         |

**Navigation et annulation**

- `J` / `K` : information suivante ou précédente. `?` : aide des raccourcis.
- Les raccourcis sont inactifs quand le focus est dans un champ.
- Chaque raccourci double un bouton visible.
- Une notification de 10 s : « Surface 54 m² acceptée. Annuler (Z) ».
- Un journal « Décisions du jour » avec « Retirer de la fiche » (proposition 10 du chantier).

**Les pièces jointes restent hors du un-clic** : droits, caviardage et nom du contrôleur sont conservés tels quels, dans un couloir « Pièces à contrôler ».

**Ce qu'on supprime de l'écran actuel**

- Les deux listes séparées, messages puis informations.
- « Voir l'annonce 25d05d49 » et « Dossier xxxx », remplacés par le titre de la vente.
- « confiance déclarée par le modèle : X % », trompeur.
- Le champ de motif toujours affiché.
- `window.prompt` pour « Mauvais destinataire ».
- Les fonds ambre comme seul signal : on passe à des pastilles avec libellé.
- « Marquer comme traitée » pour un message dont toutes les informations sont décidées : ce doit être automatique.

**Ce qu'on garde**

- Les avertissements d'authentification et d'expéditeur, en une ligne dans l'en-tête du groupe.
- « Enregistrer une opposition ».
- Les messages non rattachés, en panneau à part.
- La revue des faits des sources : même modèle de ligne, à fusionner plus tard.

## 7. La fiche publique (320 px)

**Règle.** La source par défaut est dite une fois par bloc ; c'est déjà le cas (« Informations publiées sur l'annonce de la source »). Seules les valeurs d'une autre source portent une étiquette courte. Le texte complet est dans la fenêtre de source existante (`SourceDialog`).

**Valeur de l'avocat**

- « Surface 54 m² », puis dessous, en `text-caption` `ink-soft` : « Avocat poursuivant, 12/11/2026 · détail ».
- « détail » ouvre la mention validée en entier.
- On remplace la phrase de 150 caractères répétée, qui fait 4 à 5 lignes à 320 px [S d'après la longueur]. Le texte reste identique dans la fenêtre : à faire confirmer par `juridique-rgpd`.

**Valeur d'un document** : « Cahier des conditions de vente, p. 12 ».

**Contradiction**

- Pastille `warning` « Sources à départager » (libellé existant), puis deux lignes :
  - « 61 m² selon l'annonce Licitor » ;
  - « 54 m² selon l'avocat poursuivant (12/11/2026) ».
- Puis : « Vérifiez dans le cahier des conditions de vente. »
- Jamais un choix silencieux.

**Information demandée**

- Dans l'accordéon existant « N informations non communiquées » : « Occupation : demandée à l'avocat poursuivant le 12/11/2026 ».
- Sans « sans réponse ».
- La ligne disparaît après 30 jours ou à la date de la vente.

**Donnée confirmée par l'avocat, identique à l'annonce** : pastille `success` « Recoupé », réutilisée.

## 8. Accessibilité et erreurs

**Accessibilité**

- Chaque question est un `fieldset` avec sa `legend`. Les pastilles sont de vrais boutons radio, cibles d'au moins 44 px.
- Le résumé d'erreurs reçoit le focus et liste des liens vers les champs. Le mécanisme existe déjà (`errorRef`).
- La progression de l'envoi est annoncée (`aria-live`, existant).
- Dans la file d'administration : `role="grid"` ou une liste de `article` focalisables, focus visible en or, raccourcis documentés.

**Lien expiré (45 jours)**

- « Ce lien a expiré. Vos ventes à venir restent consultables : demandez un nouveau lien. »
- Le bouton renvoie le lien seulement à l'adresse d'origine, sans révéler aucune vente. [S, à valider : est-ce une nouvelle sollicitation ?]
- Rappeler aussi : « ou répondez à l'email reçu ».
- Aujourd'hui « invalide » et « expiré » sont confondus [V].

**Formulaire déjà rempli** : afficher le récapitulatif avec « Modifier ma réponse ». Aujourd'hui, le formulaire revient vide [V].

**Vente passée, retirée ou dossier clos**

- « Cette vente a eu lieu le 14/11/2026 : il n'est plus possible de compléter la fiche. Merci. »
- Aujourd'hui : « Ce dossier n'accepte plus de dépôt. » [V]. Le contrôle de la date de vente au chargement n'est pas vérifié [S].

**Fichier trop lourd**

- « Ce fichier pèse 32 Mo ; la limite est de 20 Mo par fichier. Indiquez plutôt où le consulter (lien du greffe ou de votre site), ou envoyez-le par email. »
- **Les réponses aux questions sont enregistrées d'abord, les fichiers ensuite** : un fichier refusé ne fait jamais perdre les réponses.

## 9. Propositions

| N°  | Proposition                                                                                                                                                                        | Priorité | Effort |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| 1   | Formulaire structuré par vente : au plus 4 questions, choix en un tap, « Je ne sais pas » / « Voir le document joint » / « Non communicable »                                      | Critique | L      |
| 2   | Bouton principal de l'email « Répondre en N questions », questions en prose remplacées par la liste des manques, email libre en secours                                            | Critique | S      |
| 3   | Autorisation d'affichage à trois choix, sans présélection, avec aperçu exact de la mention                                                                                         | Critique | M      |
| 4   | File de validation par vente : valeur actuelle et sa source, origine surlignée, Accepter / Corriger / Refuser / Précision, raccourcis, annulation 10 s                             | Critique | L      |
| 5   | Corriger puis accepter (évolution du schéma de revue, valeur proposée conservée au journal)                                                                                        | Haute    | M      |
| 6   | Réouverture du lien avec la réponse précédente et « Modifier ma réponse » ; retrait d'une valeur affichée                                                                          | Haute    | M      |
| 7   | Page « Vos ventes à venir » sur un lien lié à l'adresse                                                                                                                            | Haute    | L      |
| 8   | Lots explicites dans le formulaire                                                                                                                                                 | Haute    | M      |
| 9   | Retirer l'en-tête « S'inscrire » et la navigation du site sur `/contribuer`                                                                                                        | Haute    | S      |
| 10  | Supprimer nom et email obligatoires ; rôle en un tap, nom facultatif                                                                                                               | Haute    | S      |
| 11  | Fiche : étiquette courte de source par valeur et mention complète dans la fenêtre de source ; contradiction sur deux lignes                                                        | Haute    | M      |
| 12  | Fiche : « demandée à l'avocat poursuivant le … » dans les informations non communiquées                                                                                            | Moyenne  | S      |
| 13  | Messages d'erreur distincts : expiré, vente passée, déjà rempli, fichier trop lourd ; réponses enregistrées avant les fichiers                                                     | Haute    | M      |
| 14  | Aligner le portail et l'onglet Réponses sur `fondations.md` (fin de `glass-shell` et des couleurs brutes)                                                                          | Moyenne  | M      |
| 15  | Bloc replié « Nous avons déjà… » avec « Corriger » et date de vente préremplie                                                                                                     | Moyenne  | M      |
| 16  | Publier `/agent-information` et l'autoriser comme lien dans l'email (garde anti-commerciale)                                                                                       | Moyenne  | M      |
| 17  | Fusionner plus tard la revue des faits des sources dans le même modèle de ligne                                                                                                    | Moyenne  | M      |
| 18  | Test d'utilisabilité : 5 à 8 avocats ou assistantes, tâche « répondre à la demande depuis un téléphone en moins d'une minute » ; mesures sur captures par `optimisation-interface` | Haute    | M      |

## 10. Décisions qui relèvent du propriétaire

- **D1.** Une réponse par formulaire peut-elle un jour être publiée sans clic d'administrateur ? Je recommande : non au départ, validation en un clic.
- **D2.** Le lien suffit-il comme preuve d'identité ? Il est transférable à l'assistante, donc à n'importe qui. Ou faut-il un code reçu par email avant d'envoyer ?
- **D3.** Une seule demande pour toutes les ventes d'un cabinet (page « Vos ventes à venir ») : est-ce compatible avec la règle des 30 jours et le pied RGPD ? À faire trancher par `juridique-rgpd`.
- **D4.** Choix d'affichage sans présélection : il coûte un tap, mais évite un consentement forcé. À valider par le juridique.
- **D5.** Accusé de réception automatique pour une réponse par email : oui ou non ?
- **D6.** Afficher publiquement « demandée à l'avocat poursuivant le … » : oui ou non, et combien de temps ?
- **D7.** Proposer « Occupé sans droit ni titre » dans les choix d'occupation, ou s'en tenir à « Occupé, sans précision » ?
- **D8.** « Demander une précision » depuis la file : est-ce un nouveau message soumis à la règle des 30 jours, ou une suite du même dossier ?
- **D9.** Raccourcir la mention publique en étiquette, le texte complet restant dans la fenêtre de source : le texte validé le 10/11 doit-il être revu ?
- **D10.** Lots : une fiche par lot, ou une fiche à plusieurs lots ? Cela change le formulaire et la file. Le modèle de données n'a pas été vérifié.

## Coordination

- `optimisation-interface` : mesurer la position du premier champ, le nombre de taps et les cibles sur le formulaire et la file, une fois une maquette rendue.
- `juridique-rgpd` : formulation de l'autorisation, attestation fondue, D3 à D6 et D9.

## Fichiers clés

- `/home/user/immojudis/src/components/information-agent/InformationAgentContributionForm.tsx`
- `/home/user/immojudis/src/lib/information-agent-contribution.ts`
- `/home/user/immojudis/src/lib/information-agent-contribution-token.ts`
- `/home/user/immojudis/emails/information-request.tsx`
- `/home/user/immojudis/src/lib/information-agent-email-template.ts`
- `/home/user/immojudis/src/lib/information-agent-questions.ts`
- `/home/user/immojudis/src/components/admin/AdminInformationAgentReviewPanel.tsx`
- `/home/user/immojudis/src/components/admin/AdminInformationAgentWorkspace.tsx`
- `/home/user/immojudis/src/lib/admin-information-agent.ts`
- `/home/user/immojudis/src/lib/lawyer-fact-sources.ts`
- `/home/user/immojudis/src/components/sale-detail/ListingDataCoverage.tsx`
- `/home/user/immojudis/src/components/sale-detail/ListingCharacteristics.tsx`
- `/home/user/immojudis/docs/design/fondations.md`

Ces chemins sont dans le répertoire de travail ; je les ai lus sur `origin/main`.
