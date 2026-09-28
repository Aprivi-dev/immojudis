# Agent d’enrichissement par email — audit de sécurité et protocole de validation

Audit initial du 23 septembre 2026. Mise à jour : 28 septembre 2026. **La PR 176 passe la CI complète ; sa migration est appliquée en production avant le déploiement web/worker. Aucun envoi externe n’est autorisé.**

## Comment lire ce document

Les états sont séparés pour distinguer la base historique, la migration déjà appliquée et le code livré par la PR 176 :

| État                | Référence                                      | Signification                                                                                                                                                                |
| ------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base avant PR 176   | PR 175, commit `3206125c`                      | Inclut les PR 168 à 171, puis les évolutions des PR 174 et 175.                                                                                                              |
| Pièces jointes      | PR 170, commit `e7a979f5`                      | Pagination, limites de téléchargement, routage et dérivé photo sont déjà livrés.                                                                                             |
| Durcissement PR 176 | migration `20260923131500` et branche vérifiée | Contrôles d’association, revue des messages entrants, publication fail-closed et verrouillage de l’acceptation avant extraction terminée. Migration appliquée avant le code. |
| Envoi sortant       | `INFORMATION_AGENT_OUTBOUND_ENABLED=false`     | Aucun essai avec un contact réel. Une publication de code ou de modèle ne vaut pas autorisation d’envoi.                                                                     |

Le modèle d’email actif en production est la **révision 3** ; la révision 2 est archivée. Le détail éditorial et la vérification de synchronisation du fallback sont documentés dans [l’audit de copie](information-agent-email-copy-2026-09-23.md).

## Périmètre et règle d’exploitation

L’agent est accessible depuis le back-office administrateur. La route destinée aux utilisateurs répond `410`. L’envoi sortant exige explicitement `INFORMATION_AGENT_OUTBOUND_ENABLED=true` ; cette variable reste à `false` pendant toute la validation. Les scénarios utilisent des adresses `example.test`, des messages simulés et des transports HTTP locaux substitués. Aucun test ne doit appeler Resend, Supabase de production ou un contact réel.

Flux audité : approbation admin → email avec adresse de réponse propre au dossier → webhook Resend signé → routage par token → message et pièces en stockage privé → extraction des PDF/images/textes → candidats avec provenance → revue admin → mise à jour de l’annonce ou publication d’une pièce après contrôle des droits.

## Protections déjà livrées en production

La PR 170 a livré les contrôles suivants :

| Contrôle                | Comportement livré                                                                                                                                                                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signature et routage    | Le webhook vérifie la signature Resend. Un token absent, inconnu, multiple ou incohérent avec les destinataires du message est ignoré.                                                                                                                                                  |
| Expéditeur              | Une adresse différente du contact attendu est conservée pour revue, sans extraction de faits ni téléchargement de pièces. `From` reste un signal de correspondance ; le signal Resend normalisé et la règle d’admission sont détaillés au point 8.                                      |
| Pièces nombreuses       | Les pages Resend sont parcourues jusqu’à 500 pièces ; une troncature est signalée pour revue manuelle.                                                                                                                                                                                  |
| Limites de volume       | Chaque fichier est limité à 20 Mo, le cumul d’une réponse à 40 Mo et le flux réellement téléchargé est borné, même si la taille annoncée par le fournisseur est erronée.                                                                                                                |
| Formats refusés         | Les formats, vidéos, fichiers vides et tailles refusés sont conservés dans les métadonnées avec leur nom et un motif lisible.                                                                                                                                                           |
| Rejeu                   | Le message et la pièce sont recherchés par identifiant fournisseur et par message avant insertion ; les chemins de stockage incluent le dossier, le message et le hash du contenu.                                                                                                      |
| Stockage et publication | Les originaux restent privés. Une photo acceptée est convertie en WebP, tournée selon ses métadonnées, limitée à 1 920 px et 2 Mo, sans EXIF ; une conversion impossible suspend sa publication. Les droits doivent être autorisés et la publication doit être préparée par le serveur. |

Avant la PR 176, la base vérifiait les droits de diffusion et la préparation de la publication, mais pas tous les rattachements dossier/message/vente ni l’extraction terminée avant une acceptation directe. La migration `20260923131500` ajoute ces garanties en base.

## Durcissement de la PR 176

Le code, la migration SQL et ses tests forment une livraison coordonnée :

| Contrôle                                           | Fichiers concernés                                                                                                                                                        | État                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Association immuable dossier/message/vente/pièce   | `services/data-pipeline/src/information_agent_evidence.py`, ses tests, et la migration `supabase/migrations/20260923131500_guard_information_agent_fact_associations.sql` | Migration rejouée sur le schéma Supabase complet par la CI, puis appliquée en production ; vérification distante des objets SQL effectuée.                                                                                                                                                                             |
| Verrouillage de l’acceptation                      | `src/lib/admin-information-agent.ts`, `src/components/admin/AdminInformationAgentReviewPanel.tsx` et la même migration SQL                                                | Le serveur, l’interface et le trigger exigent une extraction `completed` pour une photo ou un document. La CI et le test SQL jetable couvrent les refus.                                                                                                                                                               |
| Revue des réponses sans fait, longues ou anciennes | `src/app/api/admin/information-agent/route.ts`, `src/lib/client-api.ts` et le panneau admin                                                                               | Pagination par deux curseurs stables `(created_at,id)` pour les faits et les messages, lecture du texte complet et visibilité de l’expéditeur/motif de rejet ajoutées localement ; vérifier le comportement à la frontière sous arrivées concurrentes.                                                                 |
| Scénarios de rejeu et de rattachement              | `src/lib/information-agent-inbound.scenarios.test.ts`, test de route webhook et tests du worker                                                                           | Les doubles livraisons et reprises sont maintenant testées en mémoire ; exécuter encore les essais d’intégration et vérifier les objets privés orphelins avant publication.                                                                                                                                            |
| Publication d’une pièce et révocation des droits   | `src/lib/admin-information-agent.ts`, `src/app/api/admin/information-agent/evidence/[id]/route.ts` et la migration SQL                                                    | Chaque tentative utilise un chemin public UUID unique, est inscrite en staging avant upload, puis revue par chemin avec CAS. Un échec ne supprime l’objet que si le CAS confirme qu’il n’a pas été accepté. Une révocation après acceptation ou staging répond `409` et attend la procédure manuelle de dépublication. |

Le trigger local ne remplace pas les contrôles applicatifs : il protège aussi les écritures privilégiées, les reprises de webhook et les appels directs à la base. Il ne doit être appliqué qu’après vérification des colonnes, fonctions et privilèges présents dans le schéma Supabase réel.

### Publication fail-closed et ordre de déploiement

Pour une photo ou un document, le chemin public est de la forme `sale_id/asset_id/<tentative-uuid>`. Le serveur enregistre ce chemin et son URL dans la base avant de créer l’objet, puis appelle une fonction de revue qui verrouille le candidat et exige exactement le chemin attendu. Si l’upload ou la revue échoue, `abort_information_agent_evidence_publication` retire les références uniquement si aucune acceptation concurrente ne les a reprises ; le serveur ne supprime alors que ce chemin unique. Si le CAS refuse l’abandon ou si la suppression de stockage échoue, l’objet reste identifié pour une opération de nettoyage ciblée.

La fermeture d’un dossier (`completed` ou `failed`) rejette automatiquement ses candidats encore `pending` ou `conflict`. Le serveur refuse aussi de commencer une publication sur un dossier fermé. La restriction des droits d’une pièce déjà acceptée ou dont la publication est encore préparée est volontairement refusée en `409` : une procédure manuelle doit d’abord supprimer l’objet public et toutes ses références dans les ventes, puis marquer la pièce comme restreinte.

La migration `20260923131500_guard_information_agent_fact_associations.sql` a été rejouée sur le schéma Supabase complet en CI, puis appliquée en production **avant** le déploiement du nouveau code web ou du worker. Le workflow de production a également validé l’absence de dérive du schéma. L’envoi sortant reste désactivé pendant toute la migration et le déploiement.

Relevés : [CI de la PR 176, tentative 2](https://github.com/Aprivi-dev/immojudis/actions/runs/36404687780/attempts/2) ; [application et contrôle de dérive en production](https://github.com/Aprivi-dev/immojudis/actions/runs/36405464026).

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

| Scénario                                        | Résultat exigé                                                                                           | État à la mise à jour                                                                                                                                                                                                  |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deux annonces, même expéditeur ou double token  | Un seul dossier reçoit le message, les pièces et les candidats.                                          | Routage et tests locaux livrés ; l’intégration de la PR 179 crée deux ventes et vérifie qu’une réponse ne crée aucun asset dans l’autre vente ; trigger d’association appliqué en production.                          |
| Rejeu du webhook                                | Un seul message et une seule pièce, sans candidat en double.                                             | Déduplication livrée ; la livraison dupliquée et la reprise après un échec après insertion des candidats sont maintenant couvertes sur Supabase local ; fournisseur réel et concurrence restent à éprouver.            |
| Pièce liée à une autre vente                    | L’extraction est refusée et aucune donnée ne traverse vers l’autre annonce.                              | Contrôle worker + SQL ; l’intégration locale vérifie les `case_id`/`sale_id` de l’asset et des candidats, puis l’absence de l’asset dans l’autre vente.                                                                |
| Expéditeur différent                            | Message visible en revue, aucun fait ni pièce publiable.                                                 | Livré par PR 170 ; le signal Resend est conservé séparément de `From` ; règles d’admission au point 8.                                                                                                                 |
| Citation du message initial ou HTML atypique    | Aucun fait tiré d’une citation ; le corps utile est conservé.                                            | Texte brut et `blockquote` couverts ; transferts et variantes mobiles à compléter.                                                                                                                                     |
| PDF texte, scanné, chiffré ou MIME trompeur     | Pages sourcées si lisibles ; état explicite sinon ; aucune acceptation prématurée.                       | Extraction locale couverte ; OCR de production à qualifier.                                                                                                                                                            |
| Pièce hors format, trop grande ou vidéo         | Motif visible, aucun téléchargement non borné, aucune publication.                                       | Limites PR 170 livrées ; cas 500+ et flux interrompu à compléter en intégration.                                                                                                                                       |
| Revue admin d’une pièce en cours d’analyse      | Bouton inactif, refus serveur et refus en base.                                                          | Tests ciblés et migration sur schéma complet passés ; l’intégration de la PR 179 utilise un véritable objet Storage local et vérifie le refus avant extraction. Le rendu visuel de l’aperçu reste à vérifier.          |
| Deux tentatives de publication concurrentes     | Chaque tentative possède son propre chemin ; une revue ne peut pas accepter le chemin d’une autre.       | Contrôles par chemin et CAS inclus dans la PR 176 ; rejeu du schéma complet passé, essai avec stockage de test à faire.                                                                                                |
| Fermeture d’un dossier pendant la revue         | Les candidats `pending`/`conflict` sont rejetés ; aucun nouvel upload public ne démarre.                 | Trigger de migration appliqué ; garde serveur et tests inclus dans la PR 176.                                                                                                                                          |
| Révocation des droits après staging/acceptation | Réponse `409` fail-closed ; aucune suppression automatique ambiguë ; dépublication manuelle obligatoire. | Route et CAS localement testés ; procédure opérationnelle de dépublication à formaliser et exécuter sur environnement de test.                                                                                         |
| Signature invalide ou panne                     | HTTP 400 pour signature invalide ; HTTP 500 pour permettre la reprise.                                   | Tests de route locaux passés ; l’intégration de la PR 179 vérifie un webhook signé, une panne après candidats et sa reprise sur Supabase local. Les pannes et la livraison par le fournisseur réel restent à vérifier. |

## Travail restant avant tout essai réel

1. Le rejeu des migrations et pgTAP sur le schéma Supabase complet sont passés en CI ; la migration est appliquée en production et le contrôle de dérive est vert. Vérifier le déploiement du web et du worker après fusion de la PR 176.
2. Les doubles livraisons concurrentes et une reprise après erreur sont couvertes par des fixtures en mémoire. L’intégration Supabase locale de la PR 179 rejoue une livraison dupliquée et une panne injectée après téléchargement, stockage et insertion des candidats ; elle vérifie le checkpoint `failed`, la reprise, les identifiants `case_id`/`sale_id`, l’absence de doublon et le téléchargement de l’objet privé. Les pannes du fournisseur réel, les erreurs indépendantes de téléchargement/stockage et les objets orphelins sur cette voie restent à éprouver.
3. Constituer un corpus synthétique de réponses Gmail/Outlook, texte et HTML, transferts, alias, négations, corrections de valeurs, documents multipages, photos, HEIC/HEIF, DOCX/ZIP et tailles limites.
4. Le workflow `.github/workflows/information-agent-evidence.yml` configure `PDF_OCR_ENABLED=true` et installe Tesseract français/anglais. Vérifier encore dans l’exécution de déploiement que l’OCR fonctionne, que les erreurs sont observables et que les limites de pages et de durée sont respectées ; hors workflow, la valeur par défaut reste désactivée.
5. Vérifier que le panneau admin permet d’écarter les logos/signatures, d’autoriser les droits et de contrôler le dérivé avant acceptation. L’aperçu privé à URL signée est présent dans la PR 179 ; un objet Storage privé local est exercé en CI, mais le rendu du panneau reste à contrôler visuellement.
6. Vérifier les réponses arrivant après un envoi marqué `failed`, les réponses sans fait et la conservation des messages anciens sans doublon ni omission lorsque de nouveaux messages arrivent avec les curseurs `(created_at,id)`.
7. Tester les deux tentatives concurrentes, le CAS d’abandon après erreur, le nettoyage d’un chemin unique et la conservation volontaire d’un objet lorsque l’acceptation a gagné la course. Formaliser et tester la dépublication manuelle avant toute révocation réelle des droits.
8. Resend expose, lors de la récupération d’un email reçu, un objet `authentication` contenant les résultats SPF/DKIM/DMARC calculés par son serveur de réception ([documentation Resend](https://resend.com/docs/api-reference/emails/retrieve-received-email)). Le code persiste maintenant ces trois résultats après normalisation dans `sender_authentication`. En mode `INFORMATION_AGENT_REQUIRE_EMAIL_AUTHENTICATION=true`, l’admission exige `dmarc=pass` et au moins un de `spf`/`dkim=pass` ; `gray`, `processing_failed`, `unknown`, un résultat manquant, un échec DMARC ou deux échecs SPF/DKIM conduisent à la revue sans extraction ni pièce. Un échec SPF ou DKIM isolé reste admissible si l’autre mécanisme fait passer DMARC. Les scénarios locaux couvrent le webhook synchrone, la réception différée et le worker ; le faux endpoint reproduit le contrat utilisé, mais ne valide pas le payload livré par Resend en conditions réelles.

## Critères de sortie

La phase locale est acceptée seulement si : **zéro email externe**, **zéro association inter-annonces**, **zéro publication sans revue admin et extraction terminée**, **aucune pièce silencieusement perdue**, et **reprise idempotente** après doublon ou panne. Les pièces non exploitables ont un état et un motif visibles. Chaque scénario produit un relevé d’erreur exploitable. Sans staging séparé, `INFORMATION_AGENT_REQUIRE_EMAIL_AUTHENTICATION=true` est testé sur Supabase local et devra être contrôlé lors d'un essai interne supervisé en production avant tout contact réel ; la valeur `false` de `.env.example` sert uniquement à préserver la compatibilité pendant les tests.

Un essai fournisseur ultérieur peut éviter une boîte et un domaine de staging distincts :
Resend fournit [l'adresse de test `delivered@resend.dev`](https://resend.com/changelog/sending-test-emails)
pour vérifier la voie d'envoi et [une adresse entrante `@<id>.resend.app`](https://resend.com/features/inbound)
pour recevoir un message synthétique avec pièce et observer le webhook. Cet essai doit
rester isolé des vraies annonces et des vrais contacts, et contrôler la configuration
réelle de l'application. Il n'a pas encore été exécuté ; la simulation locale ne
démontre pas la livraison ni la réception par Resend.
Pour la voie sortante, `INFORMATION_AGENT_OUTBOUND_CANARY_ONLY` vaut `true` par
défaut dans le code et dans `.env.example` : même avec
`INFORMATION_AGENT_OUTBOUND_ENABLED=true`, seul `delivered@resend.dev` est admis.
Le contrôle intervient avant toute modification de mission et de nouveau juste
avant l'appel fournisseur. Un envoi à un véritable interlocuteur exige donc une
activation explicite de l'envoi **et** la valeur `false` du mode canari, après
validation de l'essai fournisseur.

**Décision actuelle : ne pas autoriser l’envoi réel.** La migration et la CI sont validées ; les essais fournisseur et les limites restantes ci-dessus doivent encore être qualifiés avant toute adresse réelle. L’interrupteur d’envoi reste fermé jusqu’à autorisation explicite.
Le dépôt contient le harnais isolé
[`scripts/send-information-agent-provider-canary.mjs`](../../scripts/send-information-agent-provider-canary.mjs).
Il n'importe ni l'application ni Supabase, n'accepte aucun destinataire en
paramètre et refuse de démarrer si une configuration Supabase est présente dans
l'environnement. Il exige deux indicateurs explicites, une clé Resend, un
expéditeur vérifié et la confirmation littérale de l'adresse de test. Il envoie
un seul message texte/HTML fixe vers `delivered@resend.dev`, sans annonce, mission
ni pièce jointe.

La commande à exécuter ultérieurement, depuis la racine du dépôt, est la suivante.
Charger au préalable `RESEND_API_KEY` dans le shell depuis le coffre de secrets,
sans coller sa valeur dans la commande ou dans l'historique :

```sh
env -i PATH="$PATH" \
  INFORMATION_AGENT_PROVIDER_CANARY=true \
  INFORMATION_AGENT_OUTBOUND_ENABLED=true \
  INFORMATION_AGENT_OUTBOUND_CANARY_ONLY=true \
  INFORMATION_AGENT_CANARY_CONFIRM=delivered@resend.dev \
  INFORMATION_AGENT_CANARY_FROM='Expéditeur vérifié <adresse@domaine-verifie.example>' \
  RESEND_API_KEY="$RESEND_API_KEY" \
  node scripts/send-information-agent-provider-canary.mjs
```

Le résultat attendu est un JSON `{"ok":true,"provider":"resend","recipient":"delivered@resend.dev","messageId":"..."}`.
En l'absence de clé, d'expéditeur vérifié, d'un des deux indicateurs ou avec une
variable Supabase présente, la commande doit s'arrêter avant tout appel réseau.
L'essai n'a pas été exécuté dans cette validation car aucune clé Resend n'est
disponible dans l'environnement local.
