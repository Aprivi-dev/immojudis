# Email de demande d’informations — état éditorial et validation

Audit initial du 23 septembre 2026. Mise à jour : 28 septembre 2026. **La révision 3 est publiée en production ; la révision 2 est archivée ; aucun email n’a été envoyé à un contact réel.**

## Statut à prendre comme référence

- La PR 169 (`b5f6e948`) a livré l’habillage et la révision 2 du modèle.
- La base de production contient maintenant la révision 3 publiée, qui fait foi notamment pour la copie photo ; la révision 2 n’est plus le modèle actif.
- Le code versionné dans ce dépôt contient encore un fallback nommé « version 2 » dans `src/lib/information-agent-email-template.ts`. Ce fallback ne doit pas être présenté comme la copie active et ne doit pas être republié sans comparaison avec la révision 3 en base.
- `INFORMATION_AGENT_OUTBOUND_ENABLED` reste à `false`. Le contrôle de production n’a observé aucun message sortant ni mission envoyée pendant cette mise en service.

La base de production est la source de vérité pour le contenu actif. Avant toute modification, exporter ou lire la révision 3 depuis le back-office, puis comparer son objet, ses blocs, le rendu HTML et le texte brut au fallback et aux tests. Cette note ne reproduit pas la révision 3 faute de copie versionnée dans ce checkout.

## Ce qui était couvert par la révision 2

La révision 2, désormais archivée, corrigeait les points suivants :

| Point | Correction introduite en v2 | Statut documentaire |
| --- | --- | --- |
| Initiateur du message | Le message parlait d’une vérification menée par ImmoJudis, sans prétendre répondre à la demande d’un utilisateur. | Historique v2 ; vérifier que v3 conserve cette formulation. |
| Objet | Titre court centré sur la vente, avec la date omise lorsqu’elle est inconnue. | Historique v2 ; vérifier le comportement v3 sur les titres longs. |
| Questions | Le premier message visait au plus trois demandes prioritaires et acceptait une réponse partielle. | Historique v2 ; confirmer la limite et la priorisation en v3. |
| Transparence | Mention courte : ImmoJudis n’agit pas au nom d’un tribunal et l’équipe vérifie l’aide de l’IA avant mise à jour. | Historique v2 ; comparer au pied de page v3. |
| Réponse | Invitation à répondre au fil existant, adresse de réponse liée au dossier et pièces limitées aux éléments autorisés. | Historique v2 ; vérifier l’adresse et les droits en v3. |

La révision 2 était cohérente avec le flux initié par l’admin, mais elle ne doit plus servir de preuve du contenu envoyé aujourd’hui. Les hypothèses sur la brièveté ou le taux de réponse ne sont pas des résultats mesurés.

## Contrôle à effectuer sur la révision 3

Avant de toucher au modèle ou d’autoriser un essai supervisé, consigner dans un test ou un export daté :

1. l’identifiant de la révision publiée et la preuve que la révision 2 est archivée ;
2. l’objet rendu avec date connue, date inconnue et titre long, sans « non précisé » parasite ;
3. la formule d’appel avec destinataire nommé et destinataire générique ;
4. le nombre de questions et leur sélection par les lacunes de l’annonce ;
5. le rendu HTML et texte brut, le pré-en-tête, l’adresse de réponse et le pied de page ;
6. l’absence des anciennes mentions d’« utilisateur intéressé », de « validation explicite » et de promesses de sécurité non vérifiables ;
7. la conservation de `INFORMATION_AGENT_OUTBOUND_ENABLED=false` pendant ces tests.

Ces contrôles peuvent utiliser quatre annonces fictives : date connue/inconnue, intitulé long/court et destinataire nommé/générique. Ils ne nécessitent ni Resend réel ni destinataire externe.

## Décision et suite

La copie éditoriale v2 est **clôturée comme historique**. Le seul sujet restant est la traçabilité de la v3 active et la synchronisation future entre la base publiée, le fallback du dépôt et les tests. Aucun changement de contenu ne doit être déployé depuis le texte v2 sans validation de la v3 actuelle.

Cette note porte sur la copie et le rendu. Les risques de routage, de pièces jointes et de rattachement des réponses sont suivis dans [l’audit de sécurité](information-agent-safety-protocol-2026-09-23.md).
