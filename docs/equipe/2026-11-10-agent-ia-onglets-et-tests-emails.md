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
