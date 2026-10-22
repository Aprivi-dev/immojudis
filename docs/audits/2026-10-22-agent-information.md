# Audit de l’agent d’information et de son email — 22 octobre 2026

Périmètre : la chaîne complète de l’agent qui écrit aux professionnels d’une vente (avocats,
notaires, commissaires de justice, gestionnaires) pour compléter une fiche. Cela couvre le
brouillon, l’aperçu, l’envoi, la lecture des réponses, la page de dépôt `/contribuer` et la revue.
L’audit porte aussi sur le gabarit de l’email et sur une demande du propriétaire : inciter les
professionnels contactés à s’inscrire pour déposer eux-mêmes leurs prochaines ventes.

Méthode : lecture du code, rendu réel de l’email (texte et capture mobile à 390 px) et quatre
relectures indépendantes : envoi, réponses, conformité juridique, parcours d’une avocate et d’un
clerc de notaire. État de la production le 22/10 : envoi coupé
(`INFORMATION_AGENT_OUTBOUND_ENABLED=false`), une seule mission en brouillon, aucun message
envoyé. Le modèle publié en base (révision 4) est ignoré.

## Synthèse

1. **L’email ne disait pas qui écrit.** Depuis la révision 7, le message ne présentait plus
   Immojudis. Pour une avocate qui ne connaît pas le site, un email qui demande des pièces sans
   dire qui l’envoie ressemble à de l’hameçonnage. Le lien de dépôt arrivait après la signature,
   et le caractère facultatif de la réponse était noyé au milieu d’un paragraphe de 100 mots.
2. **Inviter à créer un compte dans l’email : déconseillé, pour deux raisons.** C’est de la
   prospection au sens de l’article L. 34-5 CPCE, ce qui oblige à refaire le test de mise en
   balance. Surtout, cela contredit l’engagement prévu envers Licitor (« aucune publicité, aucune
   offre… ne sert pas à la prospection »). L’invitation est donc placée **sur l’écran qui suit une
   réponse volontaire** sur `/contribuer`. C’est le moment où le professionnel a déjà fait un pas
   vers nous, et ce n’est pas un message électronique.
3. **Un défaut de conformité réel : les oppositions courantes n’étaient pas reconnues.**
   « Veuillez ne plus me contacter », « Ne m’écrivez plus », « Je me désabonne » ou « Stop, merci »
   partaient en revue comme des réponses ordinaires. C’est corrigé.
4. **Un défaut d’envoi grave avant l’ouverture.** Si l’enregistrement échouait après l’acceptation
   par Resend, la mission passait en « échec ». La règle des 30 jours ne la comptait plus, et une
   reprise manuelle aurait pu envoyer un second email. C’est corrigé.

## L’email : avant et après (gabarit révision 8, `information_request_v8`)

| Point                      | Avant (révision 7)                                                   | Après (révision 8)                                                                                                                                                             |
| -------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Objet                      | « Appartement T3 — précisions pour Immojudis »                       | « Appartement T3 à Bordeaux, audience du 14/11/2026 : vérification de l’annonce » : le professionnel reconnaît son dossier avant d’ouvrir                                      |
| Aperçu (sous l’objet)      | Répétait l’objet                                                     | « 4 points à vérifier sur cette vente. Réponse facultative, par simple retour d’email. »                                                                                       |
| Qui écrit                  | Rien                                                                 | Une phrase factuelle : site indépendant d’information sur les ventes aux enchères, destiné aux candidats acquéreurs, qui ne vend aucun bien et n’agit pas au nom d’un tribunal |
| Pourquoi moi               | Phrase d’origine en gris 12 px                                       | « Pourquoi vous ? » en tête, 13 px, plus contrasté                                                                                                                             |
| Bloc de la vente           | Jamais mis en forme (bogue du motif « Référence de l’annonce »)      | Étiquettes et valeurs ; mise à prix ajoutée (absente du message jusqu’ici)                                                                                                     |
| Caractère facultatif       | Au milieu d’un paragraphe                                            | Ouvre les consignes : « Répondre est facultatif. »                                                                                                                             |
| Dépôt des pièces           | Après la signature, vocabulaire « dépôt sécurisé » sans domaine      | Juste après les consignes, domaine nommé, « aucun compte ni mot de passe »                                                                                                     |
| Transmission à un collègue | « son contact nous serait utile »                                    | « vous pouvez lui transférer ce message » (le lien de dépôt suit)                                                                                                              |
| Salutation                 | « Bonjour Maître Jeanne Exemple, Avocat, » pour les adresses Licitor | « Bonjour Maître Jeanne Exemple, »                                                                                                                                             |
| Question sur les pièces    | « transmettre le cahier » (déposé au greffe)                         | « … ou nous indiquer où les consulter »                                                                                                                                        |
| Questions en doublon       | Les modalités (consignation, frais, délais) demandées avec le cahier | Plus demandées quand le cahier l’est : la quatrième question sert à autre chose                                                                                                |

Inchangés, car protégés : pied art. 14 complet, opposition en un clic, « aucune offre commerciale »,
mention de l’IA, garde anti-prospection. Le seuil de conformité des modèles publiés reste la
révision 7 (`MIN_COMPLIANT_TEMPLATE_REVISION`).

**À faire valider par le juriste avec le reste du gabarit :** la phrase d’identité. La décision du
13/10 a retiré la « présentation d’Immojudis ». La nouvelle phrase ne vante rien : elle dit qui
écrit, ce qu’exige de toute façon l’article L. 34-5. Elle passe la garde anti-prospection
(« site », pas « plateforme » ; aucun « gratuit »).

## Inciter les professionnels à déposer leurs ventes

**Ce qui est fait.** Après un dépôt sur `/contribuer`, l’écran de confirmation dit ce qui va se
passer (relecture humaine, rien n’est publié sans vérification, comment corriger). Il propose
ensuite, sobrement : « Vous menez régulièrement des ventes aux enchères ? Vous pouvez déposer
vous-même vos prochaines ventes sur Immojudis, avec leurs pièces. Vous gardez la main sur ce qui
est affiché, et les candidats trouvent le cahier des conditions de vente sans avoir à solliciter
votre cabinet ou votre étude… », avec un lien vers `/login?mode=professional&redirect=/publish`.

- L’invitation n’apparaît jamais après une opposition (l’API renvoie `opposed`).
- Elle se coupe avec `NEXT_PUBLIC_INFORMATION_AGENT_PRO_INVITATION=false`.
- Elle ne dit ni « gratuit » (aucune condition professionnelle ne le garantit aujourd’hui), ni
  « visibilité », ni « mise en avant ».

**Ce qui n’est pas fait, et pourquoi.** Aucune invitation dans l’email :

- elle ferait du message entier une prospection (L. 34-5 CPCE, régime B2B défendable mais avec un
  test de mise en balance dédié, une finalité nouvelle dans le pied et la politique de
  confidentialité) ;
- elle contredirait la lettre prête pour Licitor et l’accord oral du 14/10 sur le décodage des
  adresses, ainsi que la lettre aux barreaux : les adresses Licitor (52 % des fiches Licitor) et
  celles des annuaires deviendraient inutilisables ;
- le test actuel (`docs/rgpd-mise-en-balance-agent-information.md`, § 1 et § 3) exclut
  expressément ce cas.

**Décision du propriétaire, avant d’envoyer la lettre à Licitor :**

1. tenir « aucune prospection » dans les messages : rien à changer ; ou
2. mentionner dans la lettre que la page de dépôt, après réponse, présente le dépôt direct des
   ventes. C’est ce que fait cette branche. Cette option reste prudente, car ce n’est pas un message.

**Prérequis à toute mention « gratuit ».** Publier des conditions professionnelles (publication,
options payantes, résiliation) et dire sur `/publish` ce qui est gratuit et ce qui est payant.
Aujourd’hui, `/publish` propose « mise en avant », « SEO » et « relais partenaire » dans le même
formulaire, ce qui brouille le discours. Il vaudrait mieux replier ces options.

## Correctifs livrés dans cette branche

| Gravité   | Correctif                                                                                                                                                                    | Fichiers                                                                                        |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Bloquant  | Opposition reconnue dans les formulations courantes (« Veuillez ne plus me contacter », « Ne m’écrivez plus », « Je me désabonne », « Stop, merci », « Cessez vos envois »…) | `information-agent-inbound/reply-intent.ts`                                                     |
| Bloquant  | Après acceptation par Resend, la mission n’est plus jamais rétrogradée en échec : elle reste « envoyée » avec l’identifiant et le motif de l’enregistrement incomplet        | `information-agent.ts`                                                                          |
| Important | Délai de 15 s sur l’appel à Resend (une mission ne reste plus bloquée en « sending ») ; la clé d’idempotence protège la reprise                                              | `email-alerts.ts`                                                                               |
| Important | « 3 pièces jointes » n’est plus lu comme 3 pièces du logement                                                                                                                | `information-agent-inbound/fact-extraction.ts`                                                  |
| Important | La garde anti-prospection ne bloque plus l’origine « annuaire des avocats du Conseil national des barreaux », pourtant admise                                                | `information-agent-commercial-guard.ts`                                                         |
| Important | Gabarit révision 8, objet, aperçu, bloc de la vente, mise à prix, salutation, dépôt avant la signature                                                                       | `information-agent-email-template.ts`, `emails/information-request.tsx`, `information-agent.ts` |
| Moyen     | Question « modalités » retirée quand le cahier est demandé ; question sur les pièces élargie à « où les consulter »                                                          | `information-agent-questions.ts`                                                                |
| Moyen     | Écran de fin de dépôt utile ; opposition confirmée ; invitation au dépôt direct                                                                                              | `InformationAgentContributionForm.tsx`, route `submit`                                          |

Seconde passe (points 1 à 6 de l’audit, traités le 22/10) :

| Point        | Correctif                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Fichiers                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1 (bloquant) | Un email reçu sans dossier ouvert (jeton absent ou inconnu, dossier supprimé avec la vente, dossier clos, jetons multiples) n’est plus ignoré en silence. Le motif est journalisé sans adresse ni contenu (`ignoredReason`). Une demande d’opposition d’un expéditeur authentifié (DMARC) est enregistrée sur son adresse, même sans dossier, et aussi quand le dossier est clos. Si Resend ne répond pas, l’erreur fait rejouer la livraison au lieu de perdre l’opposition. | `information-agent-inbound.ts`, `information-agent-inbound/case-updates.ts` |
| 2            | Un brouillon est refusé quand la vente a déjà été sollicitée à cette adresse : « déjà sollicité pour cette vente le JJ/MM/AAAA ». À l’envoi, un dossier déjà envoyé donne « Aucun email n’est parti… » au lieu de « mise à jour ».                                                                                                                                                                                                                                            | `information-agent.ts`                                                      |
| 3            | Motif de l’échec affiché sur la mission ouverte et, en court, dans la liste.                                                                                                                                                                                                                                                                                                                                                                                                  | `AdminInformationAgentMissionsPanel.tsx`                                    |
| 4            | La vente est relue à l’aperçu et à l’envoi. L’envoi est bloqué si la vente est retirée, vendue ou supprimée, si sa date est passée, ou si la date ou la mise à prix ont changé depuis le brouillon. Le panneau affiche la date de préparation et prévient au-delà de 3 jours. Les lacunes ne sont pas recomparées, car l’administrateur peut choisir ses questions.                                                                                                           | `information-agent.ts`, `admin-information-agent-sale.ts`, panneau          |
| 5            | Délai de 30 jours contrôlé dès le brouillon. Il couvre aussi le même professionnel sous une autre adresse (clés d’identité) et donne la date du dernier envoi et celle de la levée.                                                                                                                                                                                                                                                                                           | `information-agent/recipient-cooldown.ts`, `information-agent.ts`           |
| 6            | Message sans aucune question (aucune ligne « - ») : motif bloquant à l’aperçu et refus à l’envoi.                                                                                                                                                                                                                                                                                                                                                                             | `information-agent.ts`                                                      |

## Reste à faire, par priorité

Les points 1 à 6 sont traités (voir ci-dessus). Les suivants gardent leur numéro. À traiter **avant le premier envoi réel**, sauf ceux marqués « confort ».

| #   | Gravité   | Constat                                                                                                                                                                                                                                                          | Où                                                                                              | Correction proposée                                                                                                             |
| --- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 7   | Important | Extraction : « Surface du jardin : 300 m² » devient la surface du bien ; une surface sans étiquette est retenue ; « le locataire a quitté les lieux » donne « loué » ; « mon adresse mail est… » peut être lu comme adresse du bien.                             | `information-agent-inbound/fact-extraction.ts`                                                  | Exiger une étiquette de surface ; écarter jardin, cave, balcon ; retirer les motifs sans contexte.                              |
| 8   | Important | Le panneau de revue affiche des constantes codées en dur comme « Confiance 86 % ». Il présente un dépôt portail comme une réponse vérifiée, et ne signale ni un échec d’authentification de l’expéditeur, ni un traitement en échec.                             | `AdminInformationAgentReviewPanel.tsx`                                                          | « Extraction automatique » au lieu d’un pourcentage ; « Dépôt portail, identité non vérifiée » ; afficher l’état de traitement. |
| 9   | Important | Aucune action « Enregistrer une opposition » ni « Traité » dans le panneau : le runbook renvoie à du SQL `service_role`.                                                                                                                                         | panneau de revue                                                                                | Ajouter les deux actions.                                                                                                       |
| 10  | Important | Quota du dépôt : chaque modification d’un champ oublie les fichiers déjà envoyés, qui sont réservés de nouveau. Le dossier atteint vite 12 fichiers « à vie ».                                                                                                   | `InformationAgentContributionForm.tsx:273`, migration `reserve_information_agent_portal_upload` | Ne réinitialiser que si les fichiers changent ; faire expirer les réservations inutilisées.                                     |
| 11  | Moyen     | Pièces jointes : les images de signature (logos) deviennent des candidats « photo ». `.docx` et `.zip` sont refusés sans que l’expéditeur le sache.                                                                                                              | `information-agent-inbound/attachments.ts`                                                      | Ignorer les pièces `inline` ; prévenir l’administrateur pour qu’il le dise à l’expéditeur.                                      |
| 12  | Moyen     | Page de dépôt : « Nous la comparons à celle à laquelle nous avons écrit » sonne comme de la surveillance ; « 40 Mo par préparation » est incompréhensible ; les questions posées ne sont pas rappelées ; un rechargement après envoi affiche « lien incomplet ». | `InformationAgentContributionForm.tsx`                                                          | Reformuler ; masquer le quota tant qu’il n’est pas atteint ; rappeler les questions ; écran « contribution déjà reçue ».        |
| 13  | Moyen     | La garde anti-prospection lit la référence de la vente dans l’objet et le corps avant le rendu : un titre d’annonce contenant « Partenaire » bloque l’envoi.                                                                                                     | `information-agent.ts` (aperçu et envoi, avant le rendu)                                        | Passer `ignore: [référence]` comme pour le rendu.                                                                               |
| 14  | Confort   | L’empreinte d’aperçu ne couvre pas le pied ; l’aperçu n’affiche pas la version texte ; « Régénérer » laisse la mission précédente ouverte ; le panneau n’expose pas le choix des questions.                                                                      | `information-agent.ts`, panneau                                                                 | À regrouper dans une passe sur le panneau.                                                                                      |
| 15  | Confort   | Signature anonyme « L’équipe Immojudis ». Un prénom, un nom et une fonction (l’administrateur qui envoie) rassureraient davantage.                                                                                                                               | gabarit                                                                                         | Variable de signature tirée du compte administrateur, à faire valider avec le gabarit.                                          |

## Avant le premier envoi réel (ajouts au runbook)

- Faire valider par le juriste le gabarit révision 8, dont la phrase d’identité, et l’invitation
  de l’écran de fin de dépôt.
- Trancher la formulation de la lettre à Licitor (voir la décision ci-dessus) avant de l’envoyer.
- Points 1 à 6 du reste à faire : traités le 22/10. Traiter ensuite les points 7 à 13.
