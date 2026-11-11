<!-- Rapport du spécialiste `juridique-rgpd`, rendu le 11/11/2026 dans la mission « registre des pièces ». Reproduit tel quel : c'est une analyse, pas une décision. Les décisions sont dans `docs/equipe/2026-11-11-registre-des-pieces.md`. -->

# Registre des pièces, formulaire de réponse et validation en un clic : relecture conformité (11/11/2026)

Ce rapport n'est pas un avis d'avocat. Pour chaque point, je sépare trois choses : **[Texte]** ce qu'établit un texte cité, **[Prudence]** une pratique prudente, **[Avocat]** ce qu'un avocat doit trancher.

**Limite de lecture.** Je n'avais pas d'outil shell, donc pas de `git fetch` ni de `git show origin/main`. J'ai lu le répertoire de travail `/home/user/immojudis`, sans changer de branche et sans rien modifier. Il contient le journal du 11/11 à 06:30 UTC, ce qui laisse penser qu'il est à jour, mais je n'ai pas pu le comparer à `origin/main`.

**Fichiers lus :**

- `/home/user/immojudis/docs/equipe/2026-11-10-enrichissement-automatique-fiches.md`
- `/home/user/immojudis/docs/runbooks/information-agent.md`
- `/home/user/immojudis/docs/rgpd-mise-en-balance-agent-information.md`
- `/home/user/immojudis/docs/rgpd-processing-register.md` (lignes 27 à 38)
- `/home/user/immojudis/docs/data-retention-matrix.md` (lignes 87 à 94)
- `/home/user/immojudis/src/routes/privacy.tsx` (lignes 276 à 322)
- `/home/user/immojudis/src/routes/conditions-generales.tsx` (lignes 300 à 309)
- `/home/user/immojudis/src/lib/information-agent-email-template.ts` (lignes 293 et 306)
- `/home/user/immojudis/src/components/information-agent/InformationAgentContributionForm.tsx` (lignes 812 à 856)
- `/home/user/immojudis/src/lib/lawyer-fact-sources.ts` (ligne 126)

**Il n'existe aucune AIPD rédigée dans `docs/`.** On n'y trouve qu'une analyse de seuil (section 4 de la mise en balance). La ligne « Annonces de ventes et pièces publiques » du registre indique toujours « mise en balance et AIPD à documenter ».

## Constats préalables (écarts entre la nouvelle direction et les textes en vigueur)

1. **Relance.** La politique de confidentialité (`privacy.tsx:307`), le pied du message, la mise en balance (garanties : « aucune relance ») et le guide d'exploitation promettent « aucune relance » et « au plus un message par 30 jours ». Une relance contredit ces textes. Il faut les modifier **avant** la première relance.
2. **Un formulaire existe déjà** : le portail `/contribuer/<mission>`.
   - Sa case dit : « J'atteste être autorisé à transmettre… Elle ne vaut pas autorisation de diffusion publique ».
   - Sa notice dit : « vérifiées avant toute utilisation sur une fiche ».
   - Le formulaire de réponse est donc une évolution de ce portail. La nouvelle case de publication doit s'ajouter à l'attestation de transmission, pas la remplacer.
   - Point à corriger : la notice cite l'article 6.1.f, mais elle est incomplète au regard de l'article 13 (voir Q1).
3. **`auction_fact_claims` n'a aucune purge** : durée indéfinie, et une ligne survit à la vente (`data-retention-matrix.md:91`). Le registre des pièces ne doit pas hériter de ce défaut.
4. **Effacement à la demande d'un professionnel.** Le guide d'exploitation précise que « les documents déjà publiés après validation humaine ne sont pas retirés par cette action » (`information-agent.md:363`). Avec un registre et une autorisation révocable, ce trou devient bloquant.
5. **Le message aux avocats** promet « notre équipe la relit avant toute mise à jour de la fiche » (`information-agent-email-template.ts:293`). C'est compatible avec la validation en un clic, à condition que ce clic soit une vraie relecture (voir Q8, AI Act).

---

## Q1. Le formulaire change-t-il la donne ?

**Oui, sur quatre plans. Mais il ne transfère pas notre responsabilité d'éditeur.**

### Preuve de l'origine

- **[Prudence]** Le lien personnel signé (HMAC) prouve qu'on a eu accès au lien envoyé à l'adresse contactée. Il ne prouve pas qui a saisi : un collaborateur à qui l'avocat a transféré le message peut le faire.
- C'est quand même plus solide qu'un email libre, pour deux raisons :
  - les valeurs sont saisies dans des champs fermés, sans extraction ni interprétation : la cause principale des 26 publications fausses de la simulation (doutes, autre lot, valeur passée) disparaît ;
  - on peut conserver une trace probante : version du texte du formulaire, valeurs, état de chaque case, horodatage, identifiant de mission.
- **[Prudence]** Ne pas conserver l'adresse IP, ou alors tronquée et sur une durée courte : elle n'apporte presque rien face au lien signé.

### Preuve de l'accord

- **[Texte]** La case n'est pas un « consentement » RGPD. Les valeurs affichées (surface, occupation) ne sont pas des données personnelles de l'avocat, et son nom n'est pas affiché. La base du traitement de ses données reste l'intérêt légitime (art. 6.1.f RGPD).
- **[Prudence]** La case est une autorisation d'utilisation, révocable pour l'avenir. Ne pas l'appeler « consentement », pour ne pas importer le régime de l'art. 7 et laisser croire que le retrait rend le traitement passé illicite.
- **[Prudence]** Case non cochée par défaut, et choix champ par champ. Les lignes directrices 05/2020 du CEPD sur le consentement imposent un acte positif ; elles ne s'appliquent pas directement, mais la règle est un bon étalon de preuve.

### Secret professionnel

- **[Texte]** Art. 66-5 de la loi n° 71-1130 : le secret couvre « en toutes matières » les consultations et les correspondances entre l'avocat et son client ou entre avocats. Sa violation est punie par l'art. 226-13 du Code pénal.
- **[Texte]** Art. R. 322-31 du CPCE, contenu de l'avis de vente :
  - identité du créancier poursuivant et de son avocat ;
  - nature du bien, **occupation**, **superficie connue** et, le cas échéant, **dates et heures de visite** ;
  - mise à prix ; jour, heure et lieu de la vente ;
  - mention que le cahier des conditions de vente est consultable au greffe du juge de l'exécution ou au cabinet de l'avocat.
- **[Texte]** L'art. R. 322-32 (avis simplifié) **exclut l'identité du débiteur** et le caractère forcé de la vente. Ces éléments viennent d'une traduction secondaire ; le texte français est à revérifier sur Légifrance.
- Conséquence : la surface, le nombre de pièces, l'occupation au sens « libre / occupé / loué », les visites et la consultabilité du cahier relèvent de la publicité légale.
- Ce qui n'en relève pas, et ne doit pas être demandé :
  - la situation du débiteur ou de l'occupant ;
  - les échanges avec le client, la stratégie, les accords de paiement, un surendettement ;
  - la probabilité d'un renvoi ou d'une suspension ;
  - le montant de la créance (il figure au cahier, mais n'a aucune utilité pour une fiche).
- **[Prudence]** Un formulaire limité à ces champs fermés réduit fortement le risque. Un champ de commentaire libre le réintroduit : il faut le marquer « jamais publié, usage interne » et rappeler ce qu'il ne faut pas y écrire.
- **[Avocat]** Les éléments du cahier déposé au greffe sont-ils hors du secret ? Et le notaire (ventes notariales) est-il dans la même situation ?

### Responsabilité si l'information est fausse

- **[Texte]** Immojudis publie elle-même. Le régime d'hébergeur de la LCEN ne s'applique pas. Restent la responsabilité civile (art. 1240 du Code civil) et, pour un site marchand, le risque de pratique commerciale trompeuse (art. L. 121-2 du Code de la consommation).
- **[Prudence]** Le formulaire réduit le risque d'erreur, pas notre statut d'éditeur. La protection passe par :
  - la source et la date attribuées ;
  - « non vérifiée par Immojudis » ;
  - le renvoi au cahier qui fait foi ;
  - un signalement et un retrait rapides.
- Ne pas demander de garantie ni de clause de responsabilité à l'avocat : cela découragerait les réponses et serait mal reçu par la profession.

### Non-diffusion

- La demande de non-diffusion devient un choix explicite par champ. Le détecteur de « ne pas publier » ne sert plus que pour le canal email.

### Textes proposés

Choix par champ, sous chaque valeur saisie :

> ( ) Afficher sur la fiche ( ) Pour information d'Immojudis seulement, ne pas afficher
>
> (aucun des deux choix n'est présélectionné ; le formulaire exige un choix pour chaque valeur saisie)

Case d'autorisation (non cochée) :

> ☐ J'autorise Immojudis à afficher sur la fiche de cette vente les seules informations marquées « Afficher sur la fiche », avec la mention : « Information transmise par l'avocat poursuivant le [date], non vérifiée par Immojudis. Vérifiez-la dans le cahier des conditions de vente. » Ni mon nom, ni celui du cabinet, ni mon commentaire, ni les documents joints ne seront affichés. Je peux retirer cette autorisation à tout moment par le lien reçu ou à [contact] : l'information est alors retirée de la fiche dans un délai de [2 jours ouvrés].

Déclaration, à faire valider par un avocat (elle peut décourager les réponses) :

> Ces informations figurent dans l'avis de vente, le cahier des conditions de vente ou le procès-verbal descriptif, ou peuvent être communiquées à tout candidat acquéreur.

Avertissement au-dessus du commentaire libre :

> Ce commentaire n'est jamais publié. N'y indiquez aucune information sur le débiteur, les occupants ou d'autres personnes (nom, situation familiale ou financière, motif de la vente).

Notice d'information du formulaire. **[Texte]** Les données sont collectées directement auprès de l'avocat : c'est donc l'art. 13 RGPD qui s'applique, et non l'art. 14.

> Responsable : [entité, adresse]. Finalités : vérifier et compléter la fiche de cette vente ; afficher les informations que vous autorisez, sans votre nom. Base : intérêt légitime d'Immojudis et des candidats acquéreurs à une information exacte (art. 6.1.f RGPD). Données : votre adresse de contact, les nom et fonction que vous saisissez, vos réponses, vos choix d'affichage, la date et la version de ce formulaire. Destinataires : l'équipe Immojudis ; hébergeurs (Vercel, Supabase) ; [prestataire d'IA, États-Unis, seulement pour les documents et le commentaire libre]. Conservation : [durée de la vente puis X] pour les informations ; [5 ans ?] pour la preuve de votre autorisation et de son retrait ; 12 à 24 mois pour l'échange. Vos droits : accès, rectification, effacement, opposition (lien « Ne plus être contacté »), retrait de l'autorisation d'affichage (lien distinct), réclamation auprès de la CNIL. Répondre est facultatif.

**[Avocat]** Durée de conservation de la preuve d'autorisation ; libellé de la déclaration ; délai de retrait annoncé.

---

## Q2. Le registre des pièces

### Nouveau traitement ou non

- **[Texte]** Mêmes finalités générales (informer le public, fiabiliser la fiche), donc compatibles au sens de l'art. 6.4 RGPD.
- Mais il y a un nouvel objet de stockage, une nouvelle finalité secondaire (prouver la provenance de chaque valeur affichée) et une durée propre.
- **[Prudence]** Ajouter une ligne au registre (art. 30), « Registre des pièces et provenance des informations », avec durée fixée, ou une sous-ligne explicite de « Enquête dossier supervisée » et de « Annonces de ventes et pièces publiques ».

### Données personnelles qui peuvent s'y glisser

- Extraits d'annonce ou de PV contenant le nom du débiteur ou de l'occupant. **[Texte]** Art. R. 322-2 du CPCE : le PV descriptif comporte « l'identité des occupants » et les droits qu'ils invoquent.
- Cahier : identité du débiteur, créance.
- Email : nom, téléphone et signature de l'assistante ou de l'avocat.
- Réponse du greffe : nom du greffier.
- **[Prudence]** Les difficultés financières d'un saisi sont des données « hautement personnelles » au sens du critère 4 des lignes directrices WP 248 du CEPD (à apprécier).

### Minimisation dès la conception (art. 25 et 5.1.c RGPD)

Chaque pièce porte :

- une **valeur normalisée** ;
- un **type de source** fermé : annonce (site nommé), document (cahier, PV, avis, diagnostic), avocat poursuivant, notaire, greffe, administrateur ;
- une **référence** : URL ou identifiant de document et page, identifiant de mission, jamais l'adresse email ;
- la **date** et le **lot** ;
- un **état** : proposée, validée, affichée, contredite, retirée.

Règles sur l'extrait :

- **Pas d'extrait pour le formulaire** : la valeur saisie est la pièce.
- **Annonce ou document** : extrait borné à 280 caractères. Noms de particuliers remplacés par leur rôle (même règle que les annonces), téléphones et emails masqués. Rejet de l'extrait (valeur gardée, extrait vide) si un nom subsiste après nettoyage.
- **Email** : extrait nettoyé de la même façon, **supprimé 90 jours après la décision** (même logique que les messages non rattachés). Le message complet reste dans le dossier sous sa propre durée (12 ou 24 mois).
- **Qui a répondu** : n'enregistrer que la nature (« avocat poursuivant », « cabinet », « greffe »), jamais le nom de la personne.
- **[Texte]** Un nom remplacé par un rôle est une pseudonymisation, pas une anonymisation (considérant 26 RGPD) : la pièce reste une donnée personnelle tant que l'adresse du bien permet d'identifier l'occupant.

### Durées

- **[Prudence]** Les pièces suivent la vente (cascade, comme les autres tables de l'agent), sans exception de type `auction_fact_claims`.
- Seul subsiste un **journal minimal de preuve** : vente, champ, type de source, dates d'autorisation, d'affichage et de retrait, version du formulaire. Pas de valeur, pas d'extrait, pas d'identité.
- **[Avocat]** Durée de ce journal : 1 an après la vente, ou 5 ans (art. 2224 du Code civil, action d'un adjudicataire qui aurait cru une surface fausse) ?

### Retrait ou opposition de l'avocat

- **Retrait de l'autorisation** :
  - retrait de la fiche sous le délai annoncé (cache, données structurées, plan du site) ;
  - suppression de la valeur et de l'extrait de la pièce ;
  - conservation d'une « pièce retirée » sans valeur, pour empêcher toute republication depuis cette source.
  - **[Avocat]** La même valeur issue d'une autre source publique (annonce, cahier) peut-elle rester affichée sous sa propre source ?
- **Opposition (art. 21 RGPD)**, qui porte sur les données de l'avocat :
  - plus de contact ;
  - effacement de ses données d'identité dans les dossiers.
  - **[Prudence]** La traiter aussi comme un retrait de l'autorisation d'affichage, sauf indication contraire. Proposer deux liens distincts : « Ne plus être contacté » et « Retirer les informations affichées ».
- **Corriger la limite de `information-agent.md:363`** : l'effacement doit aussi retirer ce qui est publié.

---

## Q3. Occupation et visites

### Base

- **[Texte]** L'avis de vente comporte l'occupation et les dates et heures de visite (R. 322-31 du CPCE). L'avis simplifié exclut l'identité du débiteur (R. 322-32).
- **[Texte]** Art. 9 du Code civil (vie privée).

### Affichable, liste fermée

- Occupation : « Libre », « Occupé », « Loué (bail en cours) », « Occupation non précisée ».
- Visite : « Visite : [date] à [heure], sur place, organisée par un commissaire de justice. »
- Si l'avis publié le donne : « Renseignements : cabinet de l'avocat poursuivant » (pas de numéro de commissaire de justice s'il ne figure pas dans l'avis).

### Jamais affiché

- identité ou initiales de l'occupant ou du débiteur ;
- « occupé par le propriétaire, le saisi, un indivisaire, un ex-conjoint, la famille » ;
- composition du foyer, enfants, âge, santé, handicap ;
- motif (dette, divorce, décès, succession) ;
- procédure d'expulsion, trêve hivernale appliquée à cette personne ;
- contentieux locatif.

### À décider

- **[Avocat]** Montant du loyer et date de fin du bail : utiles aux investisseurs, mais avec l'adresse ils renseignent sur un locataire identifiable. Ne pas les afficher en première version.

### Formulation proposée

> Occupation : occupé. Information transmise par l'avocat poursuivant le 12/11/2026, non vérifiée par Immojudis. Les conditions d'occupation figurent dans le cahier des conditions de vente et le procès-verbal descriptif.

**[Prudence]** Une date de visite passée doit disparaître de l'affichage, ou passer en « Visite du 14/11/2026 (passée) ».

---

## Q4. Documents transmis (cahier, PV descriptif)

### Lecture interne

- **[Prudence]** Possible sous l'intérêt légitime pour en tirer des valeurs, dans le bucket privé existant, en cascade avec la vente.
- Mais ces documents contiennent l'identité des occupants (R. 322-2), celle du débiteur et la créance.
- **[Texte]** Leur envoi entier au prestataire d'IA (Replicate, États-Unis) est un transfert soumis au chapitre V du RGPD. Le contrat de sous-traitance (DPA) et le mécanisme de transfert sont « à vérifier » dans le registre.
- **[Prudence]** Masquer les noms avant l'envoi, ou n'envoyer que les pages utiles (désignation, PV hors identité).

### Conservation

Privée, liée à la vente. Aucune copie hors du bucket.

### Diffusion (téléchargement public)

Trois conditions cumulatives :

1. autorisation de diffusion de la source. **[Avocat]** Droits d'auteur du rédacteur du cahier et du commissaire de justice ; une simple autorisation de « transmission » ne suffit pas, comme le dit déjà le portail ;
2. masquage complet : débiteur, occupants, créancier personne physique, montants de créance, photos montrant des personnes ou des effets personnels ;
3. contrôle humain du masquage (règle existante du « caviardage vérifié »).

**[Prudence] Première version : aucun téléchargement public.** Afficher plutôt :

> Le cahier des conditions de vente peut être consulté au greffe du juge de l'exécution du tribunal judiciaire de [ville] ou au cabinet de l'avocat poursuivant.

Ajouter un lien vers la publication de l'avocat lui-même (son site, son espace de ventes) quand elle existe.

---

## Q5. Le greffe

- **[Texte]** Le cahier est consultable au greffe du juge de l'exécution (R. 322-31 et R. 322-32 du CPCE).
- **[Prudence]** Le greffe n'a aucune obligation de répondre à un site privé par email. Il peut légitimement donner :
  - l'identité de l'avocat poursuivant (publique dans l'avis) ;
  - la date et l'état de l'audience (renvoi, radiation) ;
  - les modalités de consultation du cahier.
- On ne lui demande ni l'occupation, ni les visites, ni copie du cahier, ni rien sur les parties. Ses agents sont tenus au secret professionnel (art. 226-13 du Code pénal).
- La question unique actuelle (`court-registry-template.ts:59`) est bien calibrée : à garder.
- Registre des pièces : source « greffe du tribunal judiciaire de X », jamais le nom du greffier.
- **[Avocat]** Une réponse du greffe sur la date d'audience peut-elle être affichée comme telle ?

---

## Q6. Mention de source sur la fiche

**Annonce :**

> Surface : 54 m². Source : annonce publiée sur Licitor, consultée le 12/11/2026. Vérifiez-la dans le cahier des conditions de vente.

**Document :**

> Surface : 54 m². Source : cahier des conditions de vente (page 12), lu par Immojudis le 12/11/2026. Seule la version déposée au greffe fait foi.

Si la valeur a été lue par la machine : « relevée automatiquement dans le cahier des conditions de vente (page 12) le 12/11/2026 ».

**Avocat** (reprend la mention actuelle, déjà dans `lawyer-fact-sources.ts:126`) :

> Surface : 54 m². Information transmise par l'avocat poursuivant le 12/11/2026, non vérifiée par Immojudis. Vérifiez-la dans le cahier des conditions de vente.

- Pour une vente notariale : « transmise par le notaire chargé de la vente ».
- Pour le greffe : « communiquée par le greffe du tribunal judiciaire de [ville] le … ».
- **Ne pas écrire « vérifiée »** après la validation en un clic : l'administrateur contrôle la cohérence, pas la pièce.

**Contradiction** : afficher les deux, ne pas choisir en silence.

> Surface : les sources diffèrent. 54 m² selon l'avocat poursuivant (12/11/2026) ; 61 m² selon l'annonce publiée sur Licitor (consultée le 10/11/2026). Vérifiez dans le cahier des conditions de vente.

**Demandée, pas encore reçue** :

> Surface : non communiquée à ce jour. Immojudis a demandé cette information ; elle s'affichera ici si elle est transmise.

**[Prudence]** Ne jamais écrire « demandée à l'avocat poursuivant, sans réponse ». Cela exposerait un silence attribuable à une personne identifiable par l'annonce. Le guide d'exploitation interdit déjà tout usage des silences.

---

## Q7. Sollicitation à l'échelle

### Base et nature du message

- **[Texte]** Base : intérêt légitime (art. 6.1.f), mise en balance documentée.
- **[Texte]** Le message n'est pas de la prospection au sens de l'art. L. 34-5 du CPCE (Code des postes et des communications électroniques) tant qu'il ne promeut aucun service. Garder la garde anti-commerciale.
- **[Avocat]** Immojudis vend de la mise en avant aux avocats : ce lien suffit-il à requalifier les messages ? La règle « jamais de réutilisation pour la mise en avant » doit rester absolue.

### Information à fournir

- **[Texte]** Art. 14.3.b : au plus tard lors de la première communication. Contenu de l'art. 14.1 et 14.2 :
  - identité du responsable ;
  - finalités et base légale, intérêt poursuivi ;
  - catégories de données et source de l'adresse ;
  - destinataires ;
  - transferts ;
  - durées ;
  - droits, opposition, réclamation auprès de la CNIL.
- Le pied actuel est complet sur ces points. **À ajouter** : l'affichage possible des informations autorisées et l'existence d'une relance unique.

### Opposition

- **[Texte]** Art. 21 RGPD.
- **[Texte]** La CNIL admet, entre professionnels, l'absence de consentement préalable si trois conditions sont réunies : lien avec l'activité, information sur l'origine et la finalité, opposition simple. La liste d'opposition est recommandée.
- Le lien d'opposition en un clic et l'opposition par identité existants sont adaptés.

### Limites proposées

- **[Prudence]** Une demande par avocat, et non par domaine, regroupant ses ventes, au plus une par 30 jours.
- Une seule relance, à 10 jours ouvrés au moins, seulement s'il n'y a eu aucune réponse, et jamais après :
  - une opposition ;
  - un « mauvais destinataire » ;
  - un rebond ;
  - un message d'absence.
- La relance renvoie au même lien, sans nouvelle question.
- Chaque semaine : seuils d'arrêt du pilote (plaintes, oppositions) inchangés.
- Volume : quelques centaines par semaine, à reprendre au critère 5 (grande échelle) de l'analyse de seuil.
- **Avant la première relance** : modifier la politique de confidentialité, le pied, la mise en balance et le guide d'exploitation, qui promettent aujourd'hui « aucune relance ».

### Adresse nominative ou générique

- Une adresse nominative (prénom.nom@) est une donnée personnelle : régime complet, opposition par identité.
- Selon des sources secondaires qui reprennent la CNIL, une adresse générique de personne morale (contact@) ne relèverait pas des règles de consentement et d'opposition. Je n'ai pas retrouvé ce passage sur le site de la CNIL.
- **[Prudence]** Traiter toutes les adresses comme personnelles : un contact@ de cabinet individuel identifie l'avocat.
- **[Prudence]** Préférer l'adresse générique quand l'annonce donne les deux. Le regroupement par domaine risque d'adresser à un avocat des ventes menées par un confrère : grouper par identité.

---

## Q8. Les huit points pour l'avocat et l'AIPD

| Point (section 6 du compte-rendu)                 | Sort                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Art. 22 RGPD et arrêt SCHUFA (CJUE, C-634/21)  | **Tombe pour l'essentiel** : afficher une surface n'est pas une décision produisant des effets juridiques sur une personne. Reste une vérification marginale pour l'occupation.                                                                                                                                                             |
| 2. Intérêt légitime d'une publication attribuée   | **Reste**, allégé pour le formulaire (aucun nom affiché). Entier pour la voie email.                                                                                                                                                                                                                                                        |
| 3. Responsabilité d'éditeur et pratique trompeuse | **Reste**, recentré sur les mentions (contradiction, « non vérifiée », pièce demandée).                                                                                                                                                                                                                                                     |
| 4. Déontologie de l'avocat                        | **Reste** : un avocat peut-il autoriser l'affichage sur un site privé qui vend de la mise en avant à des avocats ?                                                                                                                                                                                                                          |
| 5. Secret professionnel et des correspondances    | **Reste, réduit** au périmètre des champs fermés et au commentaire libre.                                                                                                                                                                                                                                                                   |
| 6. Art. 50 du règlement IA                        | **Tombe pour le formulaire** : aucune valeur générée par IA. **[Texte]** L'art. 50(4) (applicable depuis le 2 août 2026) vise le texte généré par IA publié pour informer le public, sauf contrôle humain ou éditorial réel. Reste pour la voie email automatique ; la validation en un clic doit être un vrai contrôle, pas une formalité. |
| 7. AIPD et consultation de la CNIL                | **Reste et s'aggrave** : il n'existe aucune AIPD rédigée.                                                                                                                                                                                                                                                                                   |
| 8. Informations sur l'occupant                    | **Reste et devient central** (Q3).                                                                                                                                                                                                                                                                                                          |

**S'ajoutent :**

- 9 : nature et preuve de l'autorisation, et qui peut la donner (collaborateur, assistante) ;
- 10 : durée du journal de preuve après la vente ;
- 11 : relance et regroupement, qui changent les engagements publiés ;
- 12 : téléchargement de documents (droits d'auteur, masquage) ;
- 13 : affichage des réponses du greffe ;
- 14 : traitement d'une autre source publique après un retrait ;
- 15 : critères de la future publication automatique (« la machine et les humains concordent ») ;
- 16 : loyer et bail.

**AIPD, à rédiger (et non à réécrire).**

- **[Prudence]** Compter les critères WP 248 sur l'ensemble « catalogue, registre et agent » :
  - critère 4 : difficultés financières des saisis, occupants ;
  - critère 5 : échelle nationale, des centaines de contacts par semaine ;
  - critère 6 : croisement annonce, documents, avocat, greffe ;
  - critère 8 : IA.
  - Le seuil de deux critères est atteint, donc l'AIPD est requise. **[Texte]** Art. 35 RGPD ; liste des traitements de la CNIL.
- Sections nécessaires :
  - description du registre des pièces et des flux ;
  - nécessité et minimisation (Q2) ;
  - risques : affichage d'une donnée d'occupant ; extrait non nettoyé ; information fausse attribuée ; retrait non suivi d'effet ; transfert de documents vers les États-Unis ; publication automatique ;
  - mesures et risque résiduel ;
  - avis du DPO s'il y en a un.

---

## Q9. Ce qui bloque et ce qui ne bloque pas

**Peut être construit et utilisé maintenant, avec validation humaine :**

- registre des pièces interne avec minimisation (extraits nettoyés, pas de nom, cascade avec la vente, purge des extraits d'email à 90 jours) ;
- mention de source pour les annonces et les documents publics ;
- affichage des contradictions ;
- mention « demandée, pas encore reçue » sans nommer personne ;
- validation en un clic par l'administrateur pour les valeurs venant des annonces et des documents ;
- construction du formulaire (sans l'envoyer à de vrais avocats) ;
- affichage « libre / occupé / loué » et des visites quand ils viennent de l'annonce publique.

**Exige une validation d'avocat avant la mise en service :**

- tout envoi réel (déjà prévu dans « Avant le premier envoi réel ») ;
- les textes du formulaire (case, choix par champ, déclaration, notice art. 13) ;
- l'affichage de valeurs venant de l'avocat ou du greffe, et le circuit de retrait ;
- la relance et le regroupement, avec la mise à jour préalable des textes publiés ;
- tout téléchargement public de document ;
- la ligne du registre et l'AIPD.

**Exige une validation d'avocat avant la publication automatique seulement :**

- les critères de concordance ;
- l'art. 50 du règlement IA pour la voie email ;
- l'occupation et les visites en automatique ;
- le contenu final de l'AIPD sur ce risque.

---

## Tableau des propositions

| N°  | Proposition                                                                                                                                                                              | Priorité | Effort |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| 1   | Rédiger l'AIPD (registre, agent, catalogue) ; il n'en existe aucune                                                                                                                      | Critique | L      |
| 2   | Registre des pièces minimisé : valeur, type de source fermé, référence, date, lot ; extrait nettoyé de 280 caractères au plus ; aucun nom de la personne qui répond                      | Critique | M      |
| 3   | Pièces en cascade avec la vente ; journal de preuve sans valeur ni identité ; corriger l'absence de purge de `auction_fact_claims`                                                       | Critique | M      |
| 4   | Retrait : la fiche est corrigée sous le délai annoncé, la valeur supprimée, une pièce retirée bloque la republication ; l'effacement retire aussi le publié (`information-agent.md:363`) | Critique | M      |
| 5   | Liste fermée pour l'occupation et les visites ; détecteur de noms qui bloque l'affichage de tout texte libre                                                                             | Critique | S      |
| 6   | Case d'autorisation et choix par champ, non présélectionnés ; journal de preuve (version du texte, horodatage)                                                                           | Haute    | M      |
| 7   | Notice art. 13 dans le formulaire ; distinguer « Ne plus être contacté » et « Retirer les informations affichées »                                                                       | Haute    | S      |
| 8   | Commentaire libre « jamais publié », avec avertissement sur les tiers                                                                                                                    | Haute    | S      |
| 9   | Mentions de source de la Q6, dont la contradiction et la pièce demandée sans nom                                                                                                         | Haute    | M      |
| 10  | Mettre à jour la politique de confidentialité, le pied, la mise en balance et le guide d'exploitation avant toute relance                                                                | Haute    | S      |
| 11  | Relance unique (10 jours ouvrés, aucune réponse, exclusions de la Q7) ; regroupement par identité et non par domaine                                                                     | Moyenne  | M      |
| 12  | Aucun téléchargement public de document en première version ; mention « consultable au greffe ou au cabinet »                                                                            | Haute    | S      |
| 13  | Masquer les noms ou restreindre les pages avant d'envoyer un document au prestataire d'IA ; vérifier le DPA et le transfert                                                              | Haute    | M      |
| 14  | Greffe : garder la question unique ; source « greffe du tribunal de X » sans nom                                                                                                         | Moyenne  | S      |
| 15  | Ligne au registre art. 30 : « Registre des pièces et provenance »                                                                                                                        | Haute    | S      |
| 16  | Ajout à l'art. 8 des CGU : informations transmises par l'avocat poursuivant ou le greffe, signalées, non vérifiées, le cahier fait foi                                                   | Haute    | S      |

**Texte pour la proposition 16 (CGU, fin de l'article 8) :**

> Certaines informations d'une fiche proviennent de l'avocat poursuivant, du notaire chargé de la vente ou du greffe. Elles sont signalées comme telles, avec leur date, et relues par Immojudis, qui ne les vérifie pas sur pièces. Seuls le cahier des conditions de vente et les pièces de la procédure font foi : vérifiez-les avant d'enchérir. Signalez toute erreur à [contact] ; nous la corrigeons ou la retirons dans les meilleurs délais.

## Points à soumettre à un avocat (questions fermées)

1. La case du formulaire est-elle une autorisation d'utilisation révocable pour l'avenir, et non un consentement au sens de l'art. 7 RGPD ?
2. Un collaborateur ou une assistante du cabinet peut-il valablement donner cette autorisation par le lien personnel ?
3. Les informations de l'avis de vente (R. 322-31 du CPCE) et du cahier déposé au greffe sont-elles hors du secret de l'art. 66-5 de la loi de 1971 ?
4. Même question pour un notaire, dans une vente notariale ?
5. Faut-il garder la déclaration « ces informations figurent dans les pièces communicables à tout candidat acquéreur » ?
6. Un avocat peut-il, sans manquer à sa déontologie (RIN), autoriser l'affichage sur un site qui vend de la mise en avant à des avocats ?
7. La relance unique et le regroupement par avocat restent-ils dans l'intérêt légitime, une fois les textes publiés modifiés ?
8. Les messages restent-ils hors de l'art. L. 34-5 du CPCE malgré l'offre payante vendue aux avocats ?
9. Peut-on afficher « libre / occupé / loué » et les dates de visite sans base autre que l'art. 6.1.f ?
10. Faut-il exclure le loyer et la date de fin de bail ?
11. La mention « non vérifiée par Immojudis » suffit-elle à écarter la pratique trompeuse après une validation humaine en un clic ?
12. Une contradiction doit-elle toujours afficher les deux sources ?
13. Le journal de preuve peut-il être conservé 5 ans après la vente (art. 2224 du Code civil) ?
14. Après un retrait, la même valeur issue d'une autre source publique peut-elle rester affichée sous cette source ?
15. Le téléchargement public d'un cahier ou d'un PV masqué est-il exclu tant qu'on n'a pas l'accord écrit de son auteur ?
16. Peut-on afficher une date d'audience communiquée par le greffe ?
17. Une AIPD est-elle obligatoire pour l'ensemble « catalogue, registre et agent » (critères 4, 5, 6 et 8 de WP 248) ?
18. La CNIL doit-elle être consultée avant la publication automatique (art. 36 RGPD) ?
19. La validation en un clic constitue-t-elle le contrôle éditorial humain qui écarte l'art. 50(4) du règlement IA pour la voie email ?
20. Le transfert de documents non masqués au prestataire d'IA aux États-Unis est-il admissible avec le DPA et le mécanisme actuels ?

## Sources

- RGPD, règlement (UE) 2016/679 (art. 5, 6, 7, 13, 14, 21, 22, 25, 30, 35, 36) : https://eur-lex.europa.eu/legal-content/FR/TXT/?uri=CELEX:32016R0679
- Règlement IA (UE) 2024/1689, art. 50 : https://eur-lex.europa.eu/legal-content/FR/TXT/?uri=CELEX:32024R1689 ; https://ai-act-service-desk.ec.europa.eu/fr/ai-act/article-50 ; FAQ de la Commission : https://digital-strategy.ec.europa.eu/fr/faqs/transparency-obligations-under-article-50-ai-act
- CPCE, partie réglementaire (R. 322-2, R. 322-31, R. 322-32), Légifrance : https://www.legifrance.gouv.fr/codes/texte_lc/LEGITEXT000025024948/ ; traductions consultées, à revérifier en français : https://french-business-law.com/rench-legislation-art/article-r322-31-of-the-french-code-of-civil-enforcement-procedures et https://french-business-law.com/rench-legislation-art/article-r322-32-of-the-french-code-of-civil-enforcement-procedures ; commentaire sur R. 322-2 : https://solent-avocats.com/le-proces-verbal-descriptif-de-limmeuble-en-saisie-immobiliere/
- Loi n° 71-1130, art. 66-5 : https://www.legifrance.gouv.fr/loda/id/JORFTEXT000000508793 ; vade-mecum sur le secret : https://www.lagbd.org/Secret_professionnel_de_l_avocate_et_de_l_avocat_et_confidentialite_des_echanges_vade_mecum
- RIN, CNB : https://www.cnb.avocat.fr/fr/reglement-interieur-national-de-la-profession-davocat-rin
- CNIL, communications électroniques entre professionnels : https://www.cnil.fr/fr/communication-electronique-quelles-regles ; adresses professionnelles reconstituées : https://cnil.fr/fr/node/169044 ; liste des traitements soumis à AIPD : https://www.cnil.fr/fr/liste-des-traitements-pour-lesquels-une-aipd-est-requise ; recommandations aux réutilisateurs de données publiées sur Internet (12/06/2024) : https://www.cnil.fr/sites/cnil/files/2024-06/recommandations_reutilisateurs_donnees_publiees_sur_internet.pdf
- CEPD, lignes directrices WP 248 rév. 01 (AIPD) : https://ec.europa.eu/newsroom/article29/items/611236 ; lignes directrices 05/2020 sur le consentement : https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-052020-consent-under-regulation-2016679_fr
- Source secondaire sur les adresses génériques, non confirmée sur le site de la CNIL : https://www.legiscope.com/blog/rgpd-marketing-direct-prospection.html
- Cités sans lien profond, à ouvrir sur Légifrance : Code pénal art. 226-13 ; Code civil art. 9, 1240 et 2224 ; Code de la consommation art. L. 121-2 ; Code des postes et des communications électroniques art. L. 34-5 ; CJUE, 7 décembre 2023, SCHUFA, C-634/21.
