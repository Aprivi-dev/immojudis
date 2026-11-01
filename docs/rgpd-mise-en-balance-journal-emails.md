# Mise en balance : journal des emails envoyés par Immojudis et son historique d’administration

**Statut : modèle à confirmer par un avocat.** Rédigé le 01/11/2026 d’après l’avis juridique du même jour
sur les lots 3 et 4 du module « Emails » de l’administration (journal des envois, onglet Historique), qui
valide une conservation de 90 jours et l’intérêt légitime comme base. Ce document est référencé par les
lignes « Journal des emails envoyés » et « Journal des consultations de l’historique des emails » du
[registre des traitements](rgpd-processing-register.md) et par la
[matrice de conservation](data-retention-matrix.md). Aucune décision n’y est prise à la place du
responsable de traitement.

| Élément                         | Valeur                                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| Traitement                      | Journal central des emails envoyés (`public.email_send_log`) et son historique d’administration |
| Base juridique                  | Intérêt légitime, art. 6.1.f RGPD                                                               |
| Date du test                    | 01/11/2026                                                                                      |
| Auteur                          | Équipe Immojudis (brouillon technique), d’après l’avis juridique du 01/11/2026                  |
| Validé par / date de validation | **À renseigner** (à confirmer par un avocat)                                                    |
| Prochaine revue                 | Annuelle, et avant toute nouvelle donnée au journal, nouveau prestataire d’envoi ou transfert   |

## 1. Test de mise en balance

1. **Intérêt poursuivi.** Contrôler que les messages d’Immojudis partent et sont remis (alertes, rappels,
   messages liés au compte, au paiement, à une demande de droits ou à une mise en relation, échanges avec des
   professionnels), répondre à une personne qui demande si un email a été envoyé ou reçu, détecter les abus
   (rebonds répétés, plaintes) et prouver l’envoi d’un message. Intérêt légitime, aussi économique : la
   réputation de l’expéditeur conditionne la remise de tous les emails, factures comprises.
2. **Nécessité.** Avant ce journal, chaque émetteur gardait son propre suivi, sans état de remise ni adresse
   (identifiant de message seulement) : impossible de répondre à « je n’ai rien reçu » ni de vérifier un
   rebond. Le prestataire d’envoi ne conserve le contenu et ses journaux que 30 jours, et pour les seuls
   messages encore présents. Alternative écartée : ne rien garder au-delà de ces 30 jours, qui ne couvre ni
   une réclamation tardive ni la preuve d’un envoi. Le journal ne garde **ni corps ni pièce jointe**.
3. **Attentes raisonnables.** Toute personne qui reçoit un email d’un service s’attend à ce qu’il garde la
   trace de cet envoi et de sa remise. Les professionnels contactés par l’agent d’information sont informés
   par le pied de chaque message et par la politique de confidentialité (version `2026-11-01.3`).
4. **Impact.** Faible : adresse du destinataire, objet, type de message, lien éventuel avec le compte, état
   de remise ; pas de contenu, pas de donnée sensible, pas de profilage, aucune décision tirée du journal
   (le retrait des consentements, `bounce_status` et la liste d’opposition se lisent dans l’évènement
   reçu, jamais dans le journal : test `email-delivery-log.test.ts`).
5. **Garanties.**
   - Conservation de **90 jours** après l’envoi, dans UNE fonction (`app_private.email_send_log_retention`) ;
     suppression à la purge hebdomadaire (97 jours au plus) ; suppression avec le compte (clé étrangère en
     cascade) et à la demande par adresse (`privacy-requests.ts`, `information-agent-professional-rights.ts`).
   - Table réservée à `service_role` (RLS activée, aucun droit ni politique pour `anon` ni `authenticated`).
   - **Objet générique** pour les gabarits personnalisés avec des données de tiers : mise en relation avec un
     avocat (`lawyer_referral`), demandes de l’agent d’information (`agent_request`,
     `agent_court_registry`). L’objet réel n’est pas copié au journal (`GENERIC_LOG_SUBJECTS`).
   - Consultation réservée aux administrateurs, **tracée 6 mois** sans l’adresse ni le contenu
     (`admin_email_access_log` : administrateur, date, portée, identifiant technique ou nombre de lignes).
     Si la trace ne peut pas être écrite, rien n’est affiché.
   - Contenu d’un message lu à la demande chez le prestataire (30 jours), **sans lien d’action** : les URL à
     jeton (confirmation d’adresse, lien magique, réinitialisation, désinscription signée, opposition et dépôt
     de l’agent, partage de rapport) sont remplacées par « [lien d’action masqué] » côté serveur ; les liens
     restants sont inertes, le cadre est isolé (`sandbox=""`, aucune requête). Un email reçu s’affiche en
     texte seul, jamais en HTML.
   - Ni ouvertures ni clics : les évènements `email.opened` et `email.clicked` ne sont ni abonnés ni lus.
6. **Risques résiduels.** Adresse conservée alors que la personne a retiré son consentement à un
   traitement (le journal est distinct des consentements ; il garde la preuve de l’envoi) ; adresses
   d’emails envoyés par un autre outil du même compte Resend, enregistrées par les évènements de livraison
   sous la clé de gabarit `unknown` (même durée) ; objet d’un email de compte, conservé tel quel (il ne
   contient pas de donnée de tiers) ; liens d’action non reconnus par le masquage (le masquage est
   volontairement large, et le cadre reste isolé).

**Conclusion du test :** favorable tant que le journal reste sans corps, limité à 90 jours, hors de toute
décision (consentement, opposition, rebond) et que sa consultation reste tracée.

## 2. Droits des personnes

- **Accès / portabilité.** Pour un professionnel sans compte, l’export `collectProfessionalData` inclut les
  lignes du journal envoyées à son adresse (`emailLog`). Pour un compte, la demande est traitée par un
  administrateur depuis `/admin` : le journal des envois liés au compte (colonne `user_id`) et à l’adresse
  (colonne `to_address`) fait partie des tables à extraire.
- **Effacement.** Compte : suppression des lignes `user_id`, puis des lignes de l’adresse confirmée, avant la
  suppression du compte (`executePrivacyErasure`). Professionnel : `eraseProfessionalData` supprime les
  lignes de son adresse.
- **Opposition.** Par l’adresse de contact de la politique de confidentialité. L’opposition à ce journal
  n’arrête pas l’envoi des messages : elle fait effacer les lignes de l’adresse.

## 3. Prestataire d’envoi : Resend

Voir la fiche « Sous-traitant : Resend » du [registre](rgpd-processing-register.md). Contenu des messages et
journaux de remise conservés **30 jours** (sauvegardes : 7 jours), aux États-Unis, sous les clauses
contractuelles types et le cadre de protection des données UE–États-Unis. **À compléter par le propriétaire :
le plan Resend souscrit et la date de signature de l’accord de sous-traitance (DPA).**

## 4. Points à faire confirmer par un avocat

1. Durée de 90 jours pour toutes les catégories, y compris les emails contractuels et de facturation (la
   colonne `category` et le paramètre de `email_send_log_retention` permettent d’en changer par une migration
   d’une seule fonction).
2. Durée de 6 mois de la trace des consultations.
3. Enregistrement de l’adresse du destinataire d’un email envoyé par un autre outil du même compte Resend.
4. Qualification du sous-traitant et garanties de transfert (plan, DPA).
