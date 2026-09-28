# Agent d’enrichissement par email — audit de sécurité et protocole de validation

Audit initial du 23 septembre 2026. Mise à jour : 28 septembre 2026. **État de référence : la production est au commit de la PR 175 (`3206125c`) ; aucun envoi externe n’est autorisé.**

## Comment lire ce document

Les états sont séparés pour éviter de confondre un comportement déjà livré avec le durcissement encore présent dans le checkout de travail :

| État | Référence | Signification |
| --- | --- | --- |
| Production | PR 175, commit `3206125c` | Base actuellement publiée. Elle inclut les PR 168 à 171, puis les évolutions des PR 174 et 175. |
| Pièces jointes | PR 170, commit `e7a979f5` | Pagination, limites de téléchargement, routage et dérivé photo sont déjà livrés. |
| Durcissement local | modifications non fusionnées du 28 septembre | Contrôles d’association, revue des messages entrants et verrouillage de l’acceptation avant extraction terminée. À valider puis publier avec sa migration. |
| Envoi sortant | `INFORMATION_AGENT_OUTBOUND_ENABLED=false` | Aucun essai avec un contact réel. Une publication de code ou de modèle ne vaut pas autorisation d’envoi. |

Le modèle d’email actif en production est la **révision 3** ; la révision 2 est archivée. Le détail éditorial et la vérification de synchronisation du fallback sont documentés dans [l’audit de copie](information-agent-email-copy-2026-09-23.md).

## Périmètre et règle d’exploitation

L’agent est accessible depuis le back-office administrateur. La route destinée aux utilisateurs répond `410`. L’envoi sortant exige explicitement `INFORMATION_AGENT_OUTBOUND_ENABLED=true` ; cette variable reste à `false` pendant toute la validation. Les scénarios utilisent des adresses `example.test`, des messages simulés et des transports HTTP locaux substitués. Aucun test ne doit appeler Resend, Supabase de production ou un contact réel.

Flux audité : approbation admin → email avec adresse de réponse propre au dossier → webhook Resend signé → routage par token → message et pièces en stockage privé → extraction des PDF/images/textes → candidats avec provenance → revue admin → mise à jour de l’annonce ou publication d’une pièce après contrôle des droits.

## Protections déjà livrées en production

La PR 170 a livré les contrôles suivants :

| Contrôle | Comportement livré |
| --- | --- |
| Signature et routage | Le webhook vérifie la signature Resend. Un token absent, inconnu, multiple ou incohérent avec les destinataires du message est ignoré. |
| Expéditeur | Une adresse différente du contact attendu est conservée pour revue, sans extraction de faits ni téléchargement de pièces. Le champ `From` reste un signal de routage, pas une preuve d’identité SMTP ; la vérification SPF/DKIM/DMARC ou équivalente du fournisseur n’est pas encore intégrée. |
| Pièces nombreuses | Les pages Resend sont parcourues jusqu’à 500 pièces ; une troncature est signalée pour revue manuelle. |
| Limites de volume | Chaque fichier est limité à 20 Mo, le cumul d’une réponse à 40 Mo et le flux réellement téléchargé est borné, même si la taille annoncée par le fournisseur est erronée. |
| Formats refusés | Les formats, vidéos, fichiers vides et tailles refusés sont conservés dans les métadonnées avec leur nom et un motif lisible. |
| Rejeu | Le message et la pièce sont recherchés par identifiant fournisseur et par message avant insertion ; les chemins de stockage incluent le dossier, le message et le hash du contenu. |
| Stockage et publication | Les originaux restent privés. Une photo acceptée est convertie en WebP, tournée selon ses métadonnées, limitée à 1 920 px et 2 Mo, sans EXIF ; une conversion impossible suspend sa publication. Les droits doivent être autorisés et la publication doit être préparée par le serveur. |

La base de production vérifie déjà les droits de diffusion et la préparation de la publication. Ces contrôles ne prouvent pas encore que l’association dossier/message/vente est cohérente dans tous les chemins d’écriture, ni que l’extraction est terminée avant une acceptation directe.

## Durcissement local à terminer et publier

Le patch local correspondant doit rester groupé avec la migration SQL et ses tests :

| Contrôle | Fichiers concernés | État |
| --- | --- | --- |
| Association immuable dossier/message/vente/pièce | `services/data-pipeline/src/information_agent_evidence.py`, ses tests, et la migration `supabase/migrations/20260923131500_guard_information_agent_fact_associations.sql` | Code et test local ajoutés ; vérification sur schéma Supabase complet encore nécessaire. |
| Verrouillage de l’acceptation | `src/lib/admin-information-agent.ts`, `src/components/admin/AdminInformationAgentReviewPanel.tsx` et la même migration SQL | Le serveur, l’interface et le trigger local exigent une extraction `completed` pour une photo ou un document ; non publié tant que la migration n’est pas appliquée et testée sur le schéma complet. |
| Revue des réponses sans fait, longues ou anciennes | `src/app/api/admin/information-agent/route.ts`, `src/lib/client-api.ts` et le panneau admin | Pagination par offset, lecture du texte complet et visibilité de l’expéditeur/motif de rejet ajoutées localement ; vérifier la stabilité sous arrivées concurrentes. |
| Scénarios de rejeu et de rattachement | tests inbound, webhook et worker du checkout | Fixtures locales ajoutées dans le chantier ; exécuter la suite intégrée avant publication. |

Le trigger local ne remplace pas les contrôles applicatifs : il protège aussi les écritures privilégiées, les reprises de webhook et les appels directs à la base. Il ne doit être appliqué qu’après vérification des colonnes, fonctions et privilèges présents dans le schéma Supabase réel.

## Vérifications hors réseau

Depuis la racine du dépôt, après intégration de tous les fichiers du patch :

```sh
npx vitest run \
  src/lib/information-agent.test.ts \
  src/lib/information-agent-inbound.test.ts \
  src/lib/information-agent-inbound.scenarios.test.ts \
  src/app/api/webhooks/resend/information-agent/route.test.ts \
  src/components/admin/AdminInformationAgentReviewPanel.test.tsx \
  src/app/api/information-agent/route.test.ts \
  src/lib/information-agent-attachments.test.ts \
  src/lib/admin-information-agent-photo.test.ts

cd services/data-pipeline
.venv/bin/python -m pytest tests/test_information_agent_evidence.py -q
cd ../..

bash scripts/test-information-agent-fact-guard.sh
```

Les tests TypeScript remplacent Resend, Supabase et `fetch`. Le worker Python utilise `httpx.MockTransport` et des documents générés en mémoire. Le script SQL crée puis supprime une instance PostgreSQL temporaire sur socket locale ; il ne touche à aucune base existante. Ce script ne valide qu’un schéma minimal : il ne remplace pas une migration sur une base Supabase de test complète.

## Scénarios de sortie

| Scénario | Résultat exigé | État à la mise à jour |
| --- | --- | --- |
| Deux annonces, même expéditeur ou double token | Un seul dossier reçoit le message, les pièces et les candidats. | Routage et tests locaux livrés ; trigger d’association local à publier. |
| Rejeu du webhook | Un seul message et une seule pièce, sans candidat en double. | Déduplication livrée ; concurrence et panne à chaque étape restent à éprouver. |
| Pièce liée à une autre vente | L’extraction est refusée et aucune donnée ne traverse vers l’autre annonce. | Contrôle worker + SQL dans le patch local ; test sur schéma complet à faire. |
| Expéditeur différent | Message visible en revue, aucun fait ni pièce publiable. | Livré par PR 170 ; l’authenticité au-delà de `From` reste hors périmètre. |
| Citation du message initial ou HTML atypique | Aucun fait tiré d’une citation ; le corps utile est conservé. | Texte brut et `blockquote` couverts ; transferts et variantes mobiles à compléter. |
| PDF texte, scanné, chiffré ou MIME trompeur | Pages sourcées si lisibles ; état explicite sinon ; aucune acceptation prématurée. | Extraction locale couverte ; OCR de production à qualifier. |
| Pièce hors format, trop grande ou vidéo | Motif visible, aucun téléchargement non borné, aucune publication. | Limites PR 170 livrées ; cas 500+ et flux interrompu à compléter en intégration. |
| Revue admin d’une pièce en cours d’analyse | Bouton inactif, refus serveur et refus en base. | Patch local ; migration et tests complets à publier. |
| Signature invalide ou panne | HTTP 400 pour signature invalide ; HTTP 500 pour permettre la reprise. | Tests de route à exécuter dans la suite intégrée. |

## Travail restant avant tout essai réel

1. Exécuter la migration et le test SQL sur une base Supabase de test complète, avec deux ventes, deux dossiers, deux messages, deux pièces, les fonctions existantes et les privilèges réels.
2. Tester les doubles livraisons concurrentes et les pannes après téléchargement, après stockage et après insertion d’un candidat ; vérifier les objets privés orphelins et la reprise.
3. Constituer un corpus synthétique de réponses Gmail/Outlook, texte et HTML, transferts, alias, négations, corrections de valeurs, documents multipages, photos, HEIC/HEIF, DOCX/ZIP et tailles limites.
4. Vérifier l’OCR dans l’environnement de déploiement. `PDF_OCR_ENABLED` est désactivé par défaut ; un PDF scanné doit rester explicitement non exploitable tant que l’OCR n’est pas configuré et observé.
5. Vérifier que le panneau admin permet d’écarter les logos/signatures, d’autoriser les droits et de contrôler le dérivé avant acceptation. L’aperçu intégré n’est pas encore présent.
6. Vérifier les réponses arrivant après un envoi marqué `failed`, les réponses sans fait et la conservation des messages anciens dans la pagination admin.
7. Obtenir et conserver le signal d’authenticité fourni par Resend (SPF/DKIM/DMARC ou équivalent) avant de traiter une adresse `From` comme un contact de confiance. Tant que ce signal n’est pas exploité, une usurpation du champ `From` reste une limite connue.

## Critères de sortie

La phase locale est acceptée seulement si : **zéro email externe**, **zéro association inter-annonces**, **zéro publication sans revue admin et extraction terminée**, **aucune pièce silencieusement perdue**, et **reprise idempotente** après doublon ou panne. Les pièces non exploitables ont un état et un motif visibles. Chaque scénario produit un relevé d’erreur exploitable.

**Décision actuelle : ne pas autoriser l’envoi réel.** Le patch local doit être intégré, testé sur le schéma complet et publié avec sa migration avant toute adresse réelle. L’interrupteur d’envoi reste fermé jusqu’à autorisation explicite.
