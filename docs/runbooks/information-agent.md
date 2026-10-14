# Agent d’information — guide d’exploitation

Mise à jour : 14 octobre 2026. Écran : **Admin › Agent IA** (`/admin/agent-ia`). L’envoi réel reste coupé en production (`INFORMATION_AGENT_OUTBOUND_ENABLED=false`) ; aucune mission n’existe à cette date.

## Règle d’exploitation

> Chaque e-mail est déclenché à la main par un administrateur, fiche par fiche, après l’affichage de l’aperçu exact du message. Aucun cron, webhook, workflow, déclencheur SQL ou relance n’envoie de message. Seule la lecture des réponses est automatique, et elle n’envoie rien.

## Parcours pour une fiche

1. **Inventaire.** À l’ouverture d’une fiche depuis la file, le serveur établit ce que la fiche contient déjà et ce qui manque (module `src/lib/information-agent-inventory.ts`). Il lit :
   - les champs de la vente (date, mise à prix, surfaces, occupation, pièces, visites, tribunal) ;
   - `source_blocks` de la vente et de chaque source fusionnée, dont `caracteristiques_bien` (pièces jointes, photos, surfaces, échéance, prix, désignation cadastrale) et `listing_completeness.source_property_features` ;
   - les pièces `auction_documents` de **toutes** les URL sources de la fiche (annonce principale, `source_urls`, observations) et la liste `source_blocks.documents` ;
   - les faits extraits des PDF par le pipeline (`pdf_occupancy_candidates`, `pdf_rooms_candidates`, `pdf_surface_candidates`…), `source_energy_diagnostics`, `cadastre_location`, `visit_contact`. Seuls le libellé de la pièce et la page sont repris, jamais l’extrait.

   Une valeur publiée par une source compte comme disponible : elle se vérifie dans la revue des faits, pas auprès du contact. Sont demandées les informations **absentes, contradictoires ou estimées**. Les éléments sans objet ne sont pas demandés (PV descriptif hors vente judiciaire ; surface, pièces et diagnostics d’un parking ; diagnostics d’un terrain). Si le cahier des conditions de vente est consultable, les modalités (consignation, frais, délais) ne sont pas redemandées.

2. **Brouillon.** Le serveur choisit le contact référencé de la fiche (avocat, notaire, gestionnaire) s’il est unique et fiable ; sinon l’administrateur saisit l’adresse. Ne sont jamais proposées ni acceptées, quelle que soit leur origine : les adresses de juridiction (`@justice.fr`, `@*.justice.gouv.fr`), la messagerie RPVA des avocats (`@avocat-conseil.fr`), les adresses de l'Ordre, du barreau, du bâtonnier et des CARPA, et les adresses `noreply`, `dpo` et `rgpd` (`src/lib/information-agent/excluded-addresses.ts`, miroir Python `information_sufficiency.py`, cas partagés `information_agent_contact_cases.json`). L'opposition est contrôlée avant de retenir une adresse : un professionnel opposé sous une autre adresse n'est ni proposé ni enregistré. Au plus quatre questions, par priorité ; les pièces manquantes sont regroupées en une question qui les nomme (« le cahier des conditions de vente, le procès-verbal descriptif et le dossier de diagnostics techniques »). L’inventaire est enregistré dans la mission (`metadata.inventory`) et affiché dans le panneau : « À obtenir » et « Déjà disponible ».

3. **Aperçu (obligatoire).** Le bouton « Afficher l’aperçu » (`POST /api/admin/information-agent/missions/preview`) rend l’e-mail exact (HTML et texte) sans rien écrire ni envoyer, et liste les motifs qui bloqueraient l’envoi :
   - contact opposé ou en rebond permanent ;
   - contact déjà sollicité dans les 30 derniers jours (toutes ventes) ;
   - origine de l’adresse inconnue (adresse absente de l’annonce de cette vente et aucune page publique indiquée, ou source d'annuaire, de site ou d'autre annonce sans lien exact) ;
   - professionnel opposé sous une autre adresse (clé d'identité), adresse exclue (juridiction, RPVA, Ordre, CARPA, `noreply`, `dpo`, `rgpd`) ;
   - mention commerciale dans l'objet, le texte ou le message rendu (offre, compte, inscription, mise en avant, prix, lien vers `/offres` ou l'inscription) ;
   - prestataire d'IA configuré (`LLM_PROVIDER`) absent de la liste nommée dans le pied ;
   - envoi désactivé, restriction canari, configuration d’envoi, identité du responsable de traitement ou secret du lien d’opposition manquants.

   L’aperçu renvoie une empreinte HMAC du contenu exact et de l’administrateur. Seuls le jeton de l’adresse de réponse et le lien privé de dépôt sont illustratifs : ils sont attribués à l’envoi.

4. **Envoi manuel.** « Valider et envoyer » reste grisé tant que l’aperçu n’a pas été affiché pour la version finale ou qu’un contrôle échoue. Toute modification (destinataire, nom, objet, texte, page d’origine) invalide l’aperçu. Le serveur refuse un envoi sans empreinte valide (`approve_and_send` exige `approvalConfirmed: true` et `previewFingerprint`), revérifie l’opposition avant l’approbation, après l’approbation et juste avant l’appel au fournisseur ; le déclencheur `information_agent_missions_contact_guard` refuse aussi en base le passage en `sending`/`sent` d’un contact opposé. Un échec laisse la mission en `failed` : on la reprend à la main, rien n’est rejoué automatiquement.

5. **Réponses.** Trois canaux, tous rattachés au dossier de la vente avec leur provenance :
   - réponse à l’adresse `enquete+<jeton>@…` : webhook Resend signé, puis file traitée toutes les 2 minutes (`/api/cron/information-agent-inbound`, pg_cron) — **réception seulement** ;
   - dépôt via le lien privé (`/contribuer/<mission>`) : note, liens, fichiers contrôlés (signature, taille, quota) ;
   - réponse reçue hors circuit (téléphone, courrier, autre adresse) : « Consigner une réponse reçue » sur une mission envoyée, enregistrée comme import manuel (expéditeur non vérifié).

   Une demande de ne plus être contacté (« merci de ne plus me contacter », « STOP »…) vaut opposition globale sur chacun des trois canaux. Les faits extraits deviennent des candidats `pending` ; la revue affiche leur provenance (e-mail, portail, import manuel, expéditeur différent du contact). Rien n’est publié sans décision humaine ; une pièce ou une photo exige en plus des droits « autorisés », une analyse terminée et le « caviardage vérifié ». Les faits acceptés alimentent `auction_fact_claims` (déclencheur `bridge_accepted_information_agent_fact_claim`).

## Contenu de l’e-mail

- Objet court et formule d’appel nominative ou neutre.
- Objet du message en une phrase (« afin de vérifier des informations publiées sur cette vente ») : plus de présentation d’Immojudis ni de son service, ni de slogan, ni de lien vers le site (gabarit `information_request_v8`, révision 6 du gabarit éditable). Référence de la fiche et date annoncée (« Audience annoncée » pour une vente judiciaire, « Date de vente annoncée » sinon), questions, consignes de réponse.
- En tête, sous la référence de suivi : origine de l’adresse selon le **type de source** enregistré, avec le lien exact et la date de consultation. Annonce : « figure dans l’annonce publique de cette vente sur Licitor (lien), consultée le JJ/MM/AAAA » ; autre annonce du professionnel ; fiche de l’annuaire officiel nommé ; site du cabinet ; saisie d’un administrateur (« relevée par un membre de l’équipe Immojudis sur une page publique (lien), le JJ/MM/AAAA »). Une adresse d’annuaire n’est donc jamais présentée comme figurant dans l’annonce.
- Lien privé de dépôt sans compte.
- Aucune invitation à créer un compte professionnel ni aucune sollicitation commerciale (décision du 13 octobre 2026) : le message reste purement informatif. L’ancien bloc « Vous avez d’autres ventes à partager ? » est retiré s’il figure encore dans un modèle éditable. Un contrôle automatique (`src/lib/information-agent-commercial-guard.ts`) refuse offres, comptes, inscription, « mise en avant », prix et tout lien vers le site d’Immojudis hors politique de confidentialité, dépôt privé, opposition et page de l’outil : il s’applique au gabarit par défaut (test), à l’aperçu (motif bloquant) et à l’envoi.
- Pied RGPD (art. 14) complet : pourquoi ce message (finalité, base, responsable de traitement), catégories de données et origine de l’adresse, mention de la recherche automatique quand l’adresse a été retrouvée par l’outil, destinataires et prestataires (hébergement, envoi des courriels, prestataire d’IA nommé d’après `LLM_PROVIDER`, transferts hors UE), durées de conservation (30 jours si aucun message n’est envoyé, 12 mois sans réponse, 24 mois après le dernier échange), droits, droit d’opposition formulé séparément (« Ne plus être contacté ») et réclamation auprès de la CNIL, lien vers la politique de confidentialité.
- En-têtes `List-Unsubscribe` et `List-Unsubscribe-Post` (désinscription en un clic de la messagerie, RFC 8058).

### Source des adresses, conservation et opposition par identité

- **Source typée.** Chaque adresse retenue porte dans `information_agent_contacts` : `source_kind` (annonce de la vente, autre annonce du professionnel, site du cabinet, annuaire officiel avec son nom dans `source_directory_name`, saisie d'administrateur), l'URL exacte, `observed_at` (date de relevé) et l'auteur (`observed_by` : agent ou administrateur). Une adresse saisie à la main est enregistrée à l'envoi avec la page publique indiquée et la date de création du brouillon.
- **Purge** (`purge_information_agent_data`, appelée par `run_data_retention`, cron hebdomadaire) : brouillon, demande annulée ou échec sans envoi, 30 jours ; approuvée ou en cours d'envoi sans suite, 6 mois ; envoyée sans réponse, 12 mois ; avec réponse, 24 mois après le dernier échange. Une adresse du registre qu'aucune demande ne vise est supprimée 30 jours après son relevé. Les lignes d'opposition ou de rebond permanent et la liste d'opposition par identité ne sont jamais purgées.
- **Opposition par identité.** En plus de l'adresse, une clé d'identité normalisée (rôle, nom, barreau ou ville, ou SIREN quand il est connu) est enregistrée avec l'adresse et la demande. Toute opposition par adresse (lien, réponse, STOP, dépôt, réponse consignée) alimente `information_agent_identity_oppositions` avec les clés connues pour cette adresse. La clé est vérifiée avant de retenir une adresse (création du brouillon), à l'aperçu, avant et pendant l'envoi, et en base (`information_agent_missions_contact_guard`). Limites : sans nom exploitable ni barreau ou ville, seule l'opposition par adresse s'applique ; une opposition reçue après la purge des lignes qui portent l'identité ne peut plus être rattachée à une identité ; un avocat qui postule dans un autre barreau que celui de la vente n'est reconnu que pour Paris, Bobigny, Créteil et Nanterre (multipostulation).
- **Recherche automatisée d'adresse.** Hors périmètre de ce guide tant qu'elle n'est pas activée. Elle ne pourra démarrer qu'après validation du test de mise en balance et de l'analyse de seuil d'AIPD (`docs/rgpd-mise-en-balance-agent-information.md`) ; l'outil s'identifie par la page publique `/agent-information`.

### Désinscription

`GET /api/information-agent/opt-out?e=…&t=…` affiche une page de confirmation et n’écrit rien (les passerelles qui ouvrent les liens pour les analyser ne désinscrivent personne). `POST` sur la même adresse (bouton de la page ou messagerie en un clic) enregistre l’opposition globale dans `information_agent_contacts`. Le jeton est un HMAC de l’adresse, sans expiration.

## Garanties « aucun envoi automatique »

| Contrôle                                                                                                                                                                     | Où                                                                                                                  | Test qui le verrouille                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Un seul appel au fournisseur pour l’agent, dans `approveAndSendMission`, après l’empreinte d’aperçu et la revérification de l’opposition                                     | `src/lib/information-agent.ts`                                                                                      | `src/lib/information-agent-no-automatic-send.test.ts`                                |
| `approveAndSendMission` n’est appelé que par l’action admin `approve_and_send` (route `PATCH /api/admin/information-agent/missions`, administrateur, confirmation explicite) | idem                                                                                                                | idem, `missions/route.test.ts`                                                       |
| Crons, webhooks, traitement des réponses et portail n’importent ni le module d’envoi ni le fournisseur                                                                       | `src/app/api/cron/**`, `src/app/api/webhooks/**`, `information-agent-inbound*`, `information-agent-contribution.ts` | `information-agent-no-automatic-send.test.ts`                                        |
| Aucune relance : aucun message `followup` n’est créé ; les colonnes héritées `followup_count` / `last_followup_at` ne sont jamais alimentées                                 | code TypeScript et Python                                                                                           | idem                                                                                 |
| pg_cron : la seule tâche de l’agent est `immojudis-information-agent-inbound`, qui appelle la route de lecture des réponses                                                  | migrations                                                                                                          | idem (et relevé de production du 11 octobre : 6 tâches, aucune autre liée à l’agent) |
| Aucune tâche Vercel, aucun workflow GitHub ni code Python n’envoie pour l’agent ; le workflow `information-agent-evidence` n’a pas de secret d’envoi                         | `vercel.json`, `.github/workflows`, `services/data-pipeline`                                                        | idem                                                                                 |
| Un envoi sans aperçu, ou modifié après l’aperçu, est refusé avant toute écriture                                                                                             | serveur                                                                                                             | `information-agent-preview.test.ts`, `missions/route.test.ts`                        |
| Un contact désinscrit n’est jamais sollicité, même avec un aperçu valide                                                                                                     | serveur et base                                                                                                     | `information-agent-preview.test.ts`, `information-agent.test.ts`                     |
| Le bouton d’envoi reste grisé sans aperçu à jour ou avec un motif bloquant                                                                                                   | interface                                                                                                           | `AdminInformationAgentMissionsPanel.test.tsx`, `e2e/admin-information-agent.spec.ts` |

## Variables d’environnement

| Variable                                                                                               | Rôle                                                                                |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `INFORMATION_AGENT_OUTBOUND_ENABLED`                                                                   | `true` autorise l’envoi manuel ; `false` (production) le bloque.                    |
| `INFORMATION_AGENT_OUTBOUND_CANARY_ONLY`                                                               | Tant qu’elle n’est pas `false`, seul `delivered@resend.dev` peut être destinataire. |
| `INFORMATION_AGENT_EMAIL_FROM`, `RESEND_API_KEY`, `INFORMATION_AGENT_INBOUND_DOMAIN`                   | Expéditeur (sous-domaine dédié recommandé), clé, domaine de réception.              |
| `INFORMATION_AGENT_PORTAL_SECRET`                                                                      | ≥ 32 octets ; signe le lien de dépôt, le lien d’opposition et l’empreinte d’aperçu. |
| `NEXT_PUBLIC_LEGAL_ENTITY_NAME`, `NEXT_PUBLIC_LEGAL_ENTITY_ADDRESS`, `NEXT_PUBLIC_LEGAL_CONTACT_EMAIL` | Responsable de traitement du pied RGPD ; sans nom et adresse, l’envoi est refusé.   |

## Avant le premier envoi réel

1. Faire valider le gabarit complet (aperçu) par un juriste : le message ne contient aucune invitation à créer un compte ni aucune mention commerciale, et le pied art. 14 est complet. Si un modèle publié (éditeur de gabarit) contient encore l'ancienne présentation d'Immojudis, le republier à partir de la révision 6.
   Faire valider le test de mise en balance (`docs/rgpd-mise-en-balance-agent-information.md`) et les durées de conservation annoncées (30 jours, 12 mois, 24 mois).
2. Configurer le sous-domaine d’envoi (SPF, DKIM, DMARC) et `INFORMATION_AGENT_EMAIL_FROM`.
3. Vérifier `INFORMATION_AGENT_PORTAL_SECRET` et l’identité légale en production.
4. Passer `INFORMATION_AGENT_OUTBOUND_ENABLED=true`, puis `INFORMATION_AGENT_OUTBOUND_CANARY_ONLY=false` seulement après un envoi de contrôle à une adresse interne.
5. Envoyer une première demande, vérifier la réception de la réponse (webhook, file, revue) et le lien d’opposition.

## Limites connues

- Licitor masque les adresses e-mail des avocats derrière la protection de Cloudflare (« [email protected] » dans 105 fiches actives le 11 octobre) : aucun contact n’est trouvé automatiquement ; l’administrateur saisit l’adresse et la page publique où il l’a relevée. Le décodage relève du parseur Licitor.
- Une seule sollicitation par adresse et par période de 30 jours, toutes ventes confondues : un avocat chargé de plusieurs ventes ne reçoit qu’une demande par mois.
- Les pièces ne sont reconnues que par leur libellé ou leur type ; un PDF au nom neutre (« 3742_001.pdf ») n’est pas compté.
