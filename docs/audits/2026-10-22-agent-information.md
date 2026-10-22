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
2. **Inviter à créer un compte dans l’email : déconseillé.** C’est de la prospection au sens de
   l’article L. 34-5 CPCE, ce qui oblige à refaire le test de mise en balance, et l’analyse
   actuelle exclut ce cas. L’invitation est donc placée **sur l’écran qui suit une
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
- le test actuel (`docs/rgpd-mise-en-balance-agent-information.md`, § 1 et § 3) exclut
  expressément ce cas.

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

Troisième passe (points 7 à 15, traités le 22/10) :

| Point | Correctif                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Fichiers                                                                                       |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 7     | Extraction plus stricte. Les surfaces d’annexes (jardin, cave, balcon, garage…) sont écartées. Une surface sans étiquette n’est retenue que si le bien est nommé juste avant, mais elle sert toujours à détecter une contradiction. « Le locataire a quitté les lieux » donne « libre », et « locataire » seul ne vaut plus « loué ». L’adresse du bien doit être explicite : « Adresse : » en début de ligne avant la formule de politesse ; jamais une signature ni une adresse email.                                                      | `information-agent-inbound/fact-extraction.ts`                                                 |
| 8     | Panneau de revue. Un dépôt via le lien privé est présenté comme « identité non vérifiée ». L’échec ou l’absence de vérification de l’authentification de l’expéditeur est signalé (rien n’a été extrait). L’état du traitement automatique est affiché : en file, en échec avec l’erreur, opposition enregistrée. Une extraction par règles n’affiche plus de pourcentage ; la confiance de l’IA est présentée comme déclarée par le modèle.                                                                                                  | `AdminInformationAgentReviewPanel.tsx`                                                         |
| 9     | Actions « Enregistrer une opposition » (contact sollicité et expéditeur, avec confirmation) et « Marquer comme traitée ». Une réponse traitée sort de la file. Plus besoin de SQL `service_role` pour une opposition reçue en réponse.                                                                                                                                                                                                                                                                                                        | `admin-information-agent.ts`, route `/api/admin/information-agent` (POST), panneau             |
| 10    | Corriger sa réponse après une erreur ne renvoie plus les pièces déjà déposées. Les réservations expirées sans validation sont libérées avant toute nouvelle réservation, une fois leur objet orphelin supprimé (marge de 15 minutes). Si la suppression échoue, la réservation reste comptée.                                                                                                                                                                                                                                                 | `information-agent-contribution.ts`, formulaire, migration `20261031100900` (commentaire seul) |
| 11    | Les petites images citées par le corps du message (logos, signatures) sont ignorées ; une photo collée dans le message, plus lourde, reste proposée. Un format refusé dit de demander une version PDF. Le contrôle du contenu réel d’une pièce reste fait par l’analyse des pièces : ce constat de l’audit était inexact.                                                                                                                                                                                                                     | `information-agent-inbound/attachments.ts`                                                     |
| 12    | Page de dépôt. Les questions de l’email sont rappelées, et le lien peut être transmis au collaborateur. L’adresse sert à « pouvoir vous répondre ». Le quota n’est plus détaillé : un avis n’apparaît qu’à trois fichiers restants. Un rechargement après envoi affiche « contribution déjà transmise ».                                                                                                                                                                                                                                      | formulaire, route de session                                                                   |
| 13    | La garde anti-prospection écarte les textes repris de l’annonce (titre, titre court, ville, tribunal), avant comme après le rendu.                                                                                                                                                                                                                                                                                                                                                                                                            | `information-agent.ts`                                                                         |
| 14    | L’aperçu affiche la version texte. « Régénérer » annule l’ancien brouillon de la même vente et de la même adresse. Les informations manquantes, y compris celles écartées par la limite de quatre questions, sont affichées et l’administrateur peut régénérer avec son choix. **Non fait :** l’empreinte d’aperçu ne couvre toujours pas le pied, qui est recalculé à l’envoi depuis la même configuration serveur, avec l’origine de l’adresse revérifiée. Le risque résiduel est un changement de configuration entre l’aperçu et l’envoi. | `information-agent.ts`, panneau                                                                |
| 15    | Signature nominative optionnelle (`INFORMATION_AGENT_SIGNATURE_NAME`) : « Prénom Nom / Pour l’équipe Immojudis », modifiable dans le brouillon. À faire valider avec le gabarit.                                                                                                                                                                                                                                                                                                                                                              | `information-agent.ts`                                                                         |

## Avant le premier envoi réel (ajouts au runbook)

- Faire valider par le juriste le gabarit révision 8, dont la phrase d’identité, et l’invitation
  de l’écran de fin de dépôt.
- Les 15 points de l’audit sont traités, sauf l’empreinte du pied (point 14, risque résiduel décrit).
- Choisir la signature (`INFORMATION_AGENT_SIGNATURE_NAME`) et la faire valider avec le gabarit.
