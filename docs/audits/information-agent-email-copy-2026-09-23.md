# Email de demande d’informations — état éditorial et validation

Audit initial du 23 septembre 2026. Mise à jour : 28 septembre 2026. **La révision 3 est publiée en production ; la révision 2 est archivée ; aucun email n’a été envoyé à un contact réel.**

## Statut à prendre comme référence

- La PR 169 (`b5f6e948`) a livré l’habillage et la révision 2 du modèle.
- La base de production contient maintenant la révision 3 publiée, qui fait foi notamment pour la copie photo ; la révision 2 n’est plus le modèle actif.
- Le fallback versionné dans `src/lib/information-agent-email-template.ts` est lui aussi nommé « version 3 ». Sa dénomination, son objet et ses sept blocs correspondent à la révision 3 publiée en base ; la copie du dépôt et la copie active sont donc synchronisées.
- `INFORMATION_AGENT_OUTBOUND_ENABLED` reste à `false`. Le contrôle de production n’a observé aucun message sortant ni mission envoyée pendant cette mise en service.

La base de production reste la source de vérité pour le contenu actif. La vérification en lecture seule du 28 septembre a confirmé l’alignement du nom, de l’objet et des sept blocs entre la révision 3 en base et le fallback versionné. Conserver cette comparaison dans les tests ou dans un relevé daté lors de toute future modification.

## Ce qui était couvert par la révision 2

La révision 2, désormais archivée, corrigeait les points suivants :

| Point                 | Correction introduite en v2                                                                                          | Statut documentaire                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Initiateur du message | Le message parlait d’une vérification menée par ImmoJudis, sans prétendre répondre à la demande d’un utilisateur.    | Historique v2 ; vérifier que v3 conserve cette formulation.       |
| Objet                 | Titre court centré sur la vente, avec la date omise lorsqu’elle est inconnue.                                        | Historique v2 ; vérifier le comportement v3 sur les titres longs. |
| Questions             | Le premier message visait au plus trois demandes prioritaires et acceptait une réponse partielle.                    | Historique v2 ; confirmer la limite et la priorisation en v3.     |
| Transparence          | Mention courte : ImmoJudis n’agit pas au nom d’un tribunal et l’équipe vérifie l’aide de l’IA avant mise à jour.     | Historique v2 ; comparer au pied de page v3.                      |
| Réponse               | Invitation à répondre au fil existant, adresse de réponse liée au dossier et pièces limitées aux éléments autorisés. | Historique v2 ; vérifier l’adresse et les droits en v3.           |

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

La copie éditoriale v2 est **clôturée comme historique**. La v3 active est synchronisée entre la base publiée et le fallback du dépôt. Le sujet restant est la non-régression du rendu HTML/texte brut et la validation opérationnelle hors réseau ; aucun changement de contenu ne doit être déployé depuis le texte v2.

Cette note porte sur la copie et le rendu. Les risques de routage, de pièces jointes et de rattachement des réponses sont suivis dans [l’audit de sécurité](information-agent-safety-protocol-2026-09-23.md).
