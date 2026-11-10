# Écran Agent IA en onglets et batterie de tests des emails (10/11/2026)

**Mission.** Deux demandes du propriétaire :

1. réorganiser l'écran Administration → Agent IA, devenu trop chargé, pour que le pilotage reste clair
   quand les réponses arriveront en volume ;
2. une fois l'écran en ligne, refaire une batterie de tests des emails pour vérifier que l'outil est
   pleinement fonctionnel.

**Déroulé.** Le chef d'orchestre a proposé un découpage en cinq onglets, validé par le propriétaire
(« 5 onglets », accueil sur « Réponses s'il y en a », budget JS « jusqu'à +10 Ko »). Le `developpeur` a
codé, la CI a couvert Chrome, Firefox et Safari. La batterie de tests a été menée par le chef d'orchestre
en production, en lecture seule côté base. Les quatre corrections qui en découlent ont été validées par le
propriétaire (« oui, corrige les trois points et ajoute remis et rebond »), codées par le `developpeur` et
relues par `code-reviewer`.

---

## 1. Écran Agent IA en cinq onglets (PR #461, en production)

Les huit panneaux empilés de `/admin/agent-ia` sont répartis en cinq onglets, sous un bandeau de synthèse.
Le comportement ne change pas : mêmes routes, mêmes garde-fous, aucune migration.

| Onglet (`?onglet=`)         | Contenu                                                                      |
| --------------------------- | ---------------------------------------------------------------------------- |
| À contacter (`a-contacter`) | File de travail ; à l'ouverture d'une fiche, éditeur, aperçu et envoi        |
| Envois (`envois`)           | Liste paginée des missions et de leur état ; « Reprendre » recharge la fiche |
| Réponses (`reponses`)       | Réponses à relire, faits à valider, messages non rattachés                   |
| Pilote (`pilote`)           | Pilote automatique, indicateurs, attestation d'aller-retour                  |
| Réglages (`reglages`)       | Gabarit de l'email, seuil de maturité du catalogue                           |

- Le bandeau affiche l'état du pilote, les envois du jour, les réponses à relire, les messages non
  rattachés et l'alerte d'arrêt. Il ne contient ni adresse ni contenu de message.
- L'écran s'ouvre sur « Réponses » s'il y a au moins une réponse à relire ou un message non rattaché,
  sinon sur « À contacter ». Un `?onglet=` dans l'adresse l'emporte.
- Un onglet est monté à sa première visite puis reste monté : un brouillon en cours survit au changement
  d'onglet.
- Le champ « Page publique où figure l'adresse » est placé sous les motifs de blocage de l'aperçu.
  L'encadré « Actualiser la source (facultatif) » précise qu'il est sans rapport avec ce champ. Cette
  confusion avait bloqué le test du matin.
- Budget JS : +7 007 octets par rapport à `main`, plafond inchangé.

**Mise en ligne.** Fusion le 10/11 à 09:32 UTC (commit `df693a70`), déploiement Vercel servi à 09:35 UTC.
Contrôles après déploiement : `/admin/agent-ia` répond 200, les API d'administration répondent 401 sans
connexion, aucune erreur d'exécution liée à l'agent. Le rendu connecté n'a pas été vu par l'équipe (pas de
session administrateur) ; il est couvert par les tests Playwright de la CI.

**Incident de CI.** Le job « Supabase migrations + pgTAP » a échoué une fois à l'étape « Detect migration
drift » (port 54320 déjà occupé sur la machine de CI). La PR ne contenait aucune migration ; le job est
passé au vert à la CI suivante, sans changement de code.

---

## 2. Batterie de tests des emails

Quatre messages de test ont été envoyés depuis `test@immojudis.com` vers des adresses internes uniquement.
Aucun message n'est parti vers un tiers. La base de production n'a reçu que des SELECT.

| #      | Test                                                                                        | Résultat | Preuve                                                                    |
| ------ | ------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------- |
| A1     | DNS (SPF, DKIM Google et Resend, DMARC, MX) sur `immojudis.com` et `reponses.immojudis.com` | OK       | 12 enregistrements lus sur le DNS public                                  |
| A2     | Domaines Resend                                                                             | OK       | Les deux « verified », envoi et réception activés                         |
| A3     | Webhooks Resend                                                                             | OK       | `account-emails` (5 évènements) et `information-agent` (`email.received`) |
| A4     | Liste de blocage Resend                                                                     | OK       | Vide                                                                      |
| B1     | Emails réels des 7 derniers jours (alertes, confirmations d'inscription, agent)             | OK       | 54 envoyés, 54 remis                                                      |
| B2     | Expéditeur « ne pas répondre » sur les emails de compte et d'alerte                         | OK       | `ne-pas-repondre@immojudis.com`, phrase « Message automatique… »          |
| B3     | Email d'alerte : motif de réception, désactivation, désinscription globale                  | OK       | Liens présents en HTML et en texte                                        |
| T1     | Envoi Resend → `contact@`                                                                   | OK       | Remis en 2 s, boîte de réception, SPF, DKIM et DMARC « pass », TLS 1.3    |
| T1 bis | Journal des envois                                                                          | OK       | Ligne « remis » écrite 3 s après l'envoi                                  |
| T2     | Message vers `ne-pas-repondre@`                                                             | OK       | Transféré dans la boîte `contact@`                                        |
| T3a    | Message à l'agent sans jeton de dossier                                                     | OK       | « Non rattaché », motif `no_token`, en 1,5 s                              |
| T3b    | Message à l'agent avec un jeton inconnu                                                     | OK       | « Non rattaché », motif `unknown_case`, en 1,5 s                          |
| C1     | Tâches planifiées de l'agent sur 24 h                                                       | OK       | Réception 720/720, pilote 144/144                                         |
| C2     | Pilote automatique                                                                          | OK       | Mode « off », `live_allowed = false`                                      |
| D1     | Webhooks sans signature                                                                     | OK       | Refus 400                                                                 |
| D2     | Tâches planifiées et API d'administration sans connexion                                    | OK       | Refus 401                                                                 |
| D3     | Liens d'email avec jeton invalide (désinscription, clic, confirmation)                      | OK       | 400, redirection vers l'accueil, page d'erreur ; aucune erreur 500        |
| E1     | Tests automatisés liés aux emails et à l'agent                                              | OK       | 124 fichiers, 2 060 tests passés                                          |

**Non couvert en production.** La réponse d'absence, le rebond définitif et l'opposition sur un envoi de
l'agent demandent une action dans l'écran d'administration ; l'aller-retour complet a été validé le matin
même (07:14 à 07:18 UTC) et ces cas restent couverts par les tests automatisés. La réinitialisation de mot
de passe, le changement d'adresse et le lien magique n'ont pas été déclenchés.

### Points relevés

| N°  | Constat                                                                                                              | Gravité      | Décision         |
| --- | -------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------- |
| 1   | Une réponse automatique s'affiche « Rebond » rouge dans le journal (T2 : rebond passager, message arrivé)            | Affichage    | Validé, corrigé  |
| 2   | Les emails de Supabase Auth apparaissent en catégorie « unknown »                                                    | Affichage    | Validé, corrigé  |
| 3   | Lien « Copiez ce lien » des emails de compte : adresse de retour non encodée, tronquée après un « & »                | Mineur       | Validé, corrigé  |
| 4   | Deux rebonds passagers en 30 jours bloquent l'envoi de l'agent vers une adresse ; une réponse d'absence peut compter | À surveiller | Aucun changement |

Le point 1 est sans effet sur les décisions : seuls les rebonds définitifs retirent un consentement
(`account-email-delivery-events.ts`) ou excluent une adresse (`information-agent-inbound/delivery-events.ts`).

---

## 3. Corrections validées (PR #464)

Validation du propriétaire : « oui, corrige les trois points et ajoute remis et rebond ». Codé par le
`developpeur`, relu par `code-reviewer`. Aucune migration, aucune règle d'envoi modifiée.

| N°  | Changement                                                                                                  | Fichiers principaux                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1   | Journal des envois : « Rebond passager » en orange pour un rebond de type « transient », avec sa précision  | `email-delivery-status.ts`, `admin-emails/history.ts`, `EmailHistoryPanel.tsx`      |
| 2   | Journal des envois : emails de Supabase Auth affichés « Compte · … », reconnus par l'objet exact du gabarit | `admin-emails/history.ts`                                                           |
| 3   | Gabarits d'authentification : lien « Copiez ce lien » encodé avec `{{ .RedirectTo \| urlquery }}`           | `auth-email-templates.ts`, `supabase/templates/*.html`, `auth-confirmation.ts`      |
| 4   | Agent IA, onglet Envois : état de remise (Remis, Différé, Échec, Rebond, Rebond passager, Plainte)          | `information-agent/delivery-state.ts`, `delivery-log-reader.ts`, liste des missions |

**Garanties conservées.**

- Le contenu d'un email de compte n'est toujours ni lu chez Resend ni affiché, et « Actualiser » ignore
  toujours ces lignes.
- Le `href` du bouton des emails d'authentification est identique à avant. Contrôle fait avec
  `html/template` de Go 1.24 sur les six gabarits : analyse, exécution, adresse de retour entièrement
  encodée dans le lien visible.
- L'état de remise envoyé au navigateur est une valeur codée, sans adresse, objet ni identifiant.

**Exception ajoutée à un test de verrou.** `email-delivery-log.test.ts` liste les seuls fichiers autorisés à
lire `email_send_log`. `information-agent/delivery-log-reader.ts` y est ajouté, car ce journal est la seule
source de « Remis », « Différé » et « Échec ». Il ne lit que l'identifiant Resend, le statut et le type de
rebond. Le test vérifie qu'il n'est importé que par `information-agent.ts`, quel que soit le chemin
d'import, qu'il n'est appelé que dans `listAdminInformationAgentMissions`, et qu'aucun fichier de décision
ne lit l'état calculé.

**Relecture par `code-reviewer`.** Aucun point Critique. Cinq corrections intégrées dans un second commit :

- un envoi en échec n'apparaissait pas : il affiche « Échec » ;
- un rebond de type inconnu pouvait, journal purgé, s'afficher « passager, l'adresse reste utilisable » :
  le type du fournisseur est désormais conservé dans `metadata.delivery`, et une entrée ancienne sans type
  affiche « Rebond passager » sans cette précision ;
- le verrou pouvait être contourné par un import relatif : la recherche porte sur le nom du module ;
- l'aperçu des gabarits dans l'administration reproduit maintenant `urlquery` de Go ;
- la page de confirmation relit le « + » comme une espace, en un seul décodage.

**Laissé pour plus tard** (antérieur à cette PR ou hors périmètre validé) :

- un rebond passager tardif peut écraser le type d'un rebond définitif dans le journal
  (`record_email_delivery_event`, demande une migration) ;
- la réécriture de `metadata` à l'envoi (`information-agent/send.ts`) peut effacer `metadata.delivery` si un
  rebond arrive entre l'appel à Resend et cette mise à jour ;
- un journal illisible laisse les missions sans état de remise, sans le signaler à l'écran.

**Vérifications.** `tsc`, lint et invariants de sécurité au vert ; 990 fichiers et 13 286 tests passés, aucun
échec ; budget JS 6 680 742 octets (+906 par rapport à `main`) pour un plafond de 6 730 000, inchangé.

**Mise en production.** Le point 3 ne prend effet qu'après le workflow « Apply Supabase Auth Config »
(`plan` puis `apply`). Un email d'authentification réel est à contrôler juste après.

---

## 4. Constat hors périmètre : l'enrichissement des fiches n'est pas automatique

Question du propriétaire le 10/11 : une réponse reçue est-elle analysée par une IA puis intégrée
automatiquement à la fiche ? Réponse vérifiée dans le code et en production : non.

| Étape                                                    | Automatique | État                                                             |
| -------------------------------------------------------- | ----------- | ---------------------------------------------------------------- |
| Réception et rattachement au dossier                     | Oui         | Vérifié en production                                            |
| Lecture par l'IA et extraction d'informations candidates | Oui         | En place ; aucune information extraite en production à ce jour   |
| Intégration dans la fiche                                | Non         | Chaque information est acceptée ou rejetée par un administrateur |

- Aucun chemin du code ne publie une information sans validation (`reviewAdminInformationAgentFact`). La
  politique de confidentialité s'y engage.
- Le workflow « Information Agent Evidence », programmé toutes les 30 minutes, n'est lancé par GitHub que
  toutes les 4 à 11 heures (huit derniers lancements relevés). La réponse de test de 07:18 UTC a été
  analysée à 11:33.

Proposition faite au propriétaire, en attente de sa décision : concevoir un enrichissement automatique sous
conditions (expéditeur authentifié, lot identifié, citation exacte, pas de contradiction avec la fiche),
avec relecture maintenue pour les contradictions, les réponses ambiguës et les pièces jointes.
