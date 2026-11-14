# Agent d’information — guide d’exploitation

Mise à jour : 23 octobre 2026 (renvois et variables) ; 14 novembre 2026 (pilote, lot B). Écran : **Admin › Agent IA** (`/admin/agent-ia`). État de production : l’envoi manuel est ouvert depuis le 2 novembre 2026 (`INFORMATION_AGENT_OUTBOUND_ENABLED=true`, constaté le 14/11), voir « Piloter le pilote » ; à revérifier avant de s’y fier.

## Règle d’exploitation

> Chaque e-mail est déclenché par un administrateur, fiche par fiche, après l’affichage de l’aperçu exact du message, **sauf** ceux du pilote automatique (lot 2, décision du propriétaire du 02/11/2026, qui remplace la décision du 14/10). Le pilote est le seul expéditeur automatisé ; il est **désactivé par défaut**, en simulation il n’envoie rien, et son mode réel est bloqué par le contrôle de préparation (voir « Pilote automatique »). Aucun cron, webhook, workflow ni déclencheur SQL autre que celui du pilote n’envoie de message. Aucune relance. Seule la lecture des réponses est automatique, et elle n’envoie rien.

## Parcours pour une fiche

1. **Inventaire.** À l’ouverture d’une fiche depuis la file, le serveur établit ce que la fiche contient déjà et ce qui manque (module `src/lib/information-agent-inventory.ts`). Il lit :
   - les champs de la vente (date, mise à prix, surfaces, occupation, pièces, visites, tribunal) ;
   - `source_blocks` de la vente et de chaque source fusionnée, dont `caracteristiques_bien` (pièces jointes, photos, surfaces, échéance, prix, désignation cadastrale) et `listing_completeness.source_property_features` ;
   - les pièces `auction_documents` de **toutes** les URL sources de la fiche (annonce principale, `source_urls`, observations) et la liste `source_blocks.documents` ;
   - les faits extraits des PDF par le pipeline (`pdf_occupancy_candidates`, `pdf_rooms_candidates`, `pdf_surface_candidates`…), `source_energy_diagnostics`, `cadastre_location`, `visit_contact`. Seuls le libellé de la pièce et la page sont repris, jamais l’extrait.

   Une valeur publiée par une source compte comme disponible : elle se vérifie dans la revue des faits, pas auprès du contact. Sont demandées les informations **absentes, contradictoires ou estimées**. Les éléments sans objet ne sont pas demandés (PV descriptif hors vente judiciaire ; surface, pièces et diagnostics d’un parking ; diagnostics d’un terrain). Si le cahier des conditions de vente est consultable, les modalités (garantie exigée pour enchérir, frais, délais) ne sont pas redemandées.

2. **Brouillon.** Le serveur choisit le contact référencé de la fiche (avocat, notaire, gestionnaire) s’il est unique et fiable ; sinon l’administrateur saisit l’adresse. Ne sont jamais proposées ni acceptées, quelle que soit leur origine : les adresses de juridiction (`@justice.fr`, `@*.justice.gouv.fr`), la messagerie RPVA des avocats (`@avocat-conseil.fr`), les adresses de l'Ordre, du barreau, du bâtonnier et des CARPA, et les adresses techniques (`noreply`, `dpo`, `rgpd`, `abuse`, `postmaster`…) (`src/lib/information-agent/excluded-addresses.ts`, miroir Python `information_sufficiency.py`, cas partagés `information_agent_contact_cases.json`). L'opposition est contrôlée avant de retenir une adresse : un professionnel opposé sous une autre adresse n'est ni proposé ni enregistré. Au plus quatre questions, par priorité ; les pièces manquantes donnent une seule question, qui demande où et comment consulter le cahier des conditions de vente et ses annexes, dont les diagnostics, sans demander de transmission ni nommer le procès-verbal descriptif (relecture juridique-rgpd du 14/11/2026). L’inventaire est enregistré dans la mission (`metadata.inventory`) et affiché dans le panneau : « À obtenir » et « Déjà disponible ».

3. **Aperçu (obligatoire).** Le bouton « Afficher l’aperçu » (`POST /api/admin/information-agent/missions/preview`) rend l’e-mail exact (HTML et texte) sans rien écrire ni envoyer, et liste les motifs qui bloqueraient l’envoi :
   - contact opposé ou en rebond permanent ;
   - contact déjà sollicité dans les 30 derniers jours (toutes ventes), à cette adresse ou sous une autre adresse du même professionnel (clés d’identité), avec la date du dernier envoi et celle de la levée ; ce contrôle et le refus d’un second brouillon pour une vente déjà sollicitée à cette adresse s’appliquent dès la création du brouillon ;
   - vente relue : retirée, vendue ou supprimée, date annoncée passée, ou date ou mise à prix changées depuis le brouillon (régénérer le brouillon) ;
   - message sans aucune question (aucune ligne commençant par « - ») ;
   - origine de l’adresse inconnue (adresse absente de l’annonce de cette vente et aucune page publique indiquée, ou source d'annuaire, de site ou d'autre annonce sans lien exact) ;
   - professionnel opposé sous une autre adresse (clé d'identité), adresse exclue (juridiction, RPVA, Ordre, CARPA, `noreply`, `dpo`, `rgpd`), page d'origine d'une adresse saisie exclue (réseau social, moteur de recherche, annuaire commercial, notaires.fr, annuaires des barreaux de Paris et de Marseille) ;
   - mention commerciale dans l'objet, le texte ou le message rendu (offre, compte, inscription, mise en avant, partenariat, mise en relation, prix d'Immojudis, tout lien hors politique de confidentialité, dépôt privé, opposition, plainte CNIL et page source de l'adresse) ;
   - prestataire d'IA configuré (`LLM_PROVIDER`) absent de la liste nommée dans le pied ;
   - envoi désactivé, restriction canari, configuration d’envoi, identité du responsable de traitement ou secret du lien d’opposition manquants.

   L’aperçu renvoie une empreinte HMAC du contenu exact et de l’administrateur. Seuls le jeton de l’adresse de réponse et le lien privé de dépôt sont illustratifs : ils sont attribués à l’envoi.

4. **Envoi manuel.** « Valider et envoyer » reste grisé tant que l’aperçu n’a pas été affiché pour la version finale ou qu’un contrôle échoue. Toute modification (destinataire, nom, objet, texte, page d’origine) invalide l’aperçu. Le serveur refuse un envoi sans empreinte valide (`approve_and_send` exige `approvalConfirmed: true` et `previewFingerprint`), revérifie l’opposition avant l’approbation, après l’approbation et juste avant l’appel au fournisseur ; le déclencheur `information_agent_missions_contact_guard` refuse aussi en base le passage en `sending`/`sent` d’un contact opposé. Un échec avant l’envoi laisse la mission en `failed` : on la reprend à la main, rien n’est rejoué automatiquement. Une fois le message accepté par Resend, la mission n’est plus jamais rétrogradée : si l’enregistrement qui suit échoue, elle reste `sent` avec l’identifiant Resend et un motif « enregistrement incomplet », et l’administrateur ne la renvoie pas. L’appel à Resend est limité à 15 secondes ; après une expiration, la reprise réutilise la même clé d’idempotence.

5. **Réponses.** Trois canaux, tous rattachés au dossier de la vente avec leur provenance :
   - réponse à l’adresse `enquete+<jeton>@…` : webhook Resend signé, puis file traitée toutes les 2 minutes (`/api/cron/information-agent-inbound`, pg_cron) — **réception seulement**. Un message sans dossier ouvert (jeton absent ou inconnu, dossier supprimé avec la vente, dossier clos, jetons multiples) n’est jamais ignoré en silence : il est conservé pour un administrateur (voir « Messages non rattachés » plus bas), son motif est journalisé (« Inbound email without an open case », sans adresse ni contenu) et une demande d’opposition d’un expéditeur authentifié est enregistrée sur son adresse ;
   - dépôt via le lien privé (`/contribuer/<mission>`) : note, liens, fichiers contrôlés (signature, taille, quota). La page rappelle les questions de l’email. Le quota est de 12 fichiers par dossier ; une réservation expirée sans validation est libérée (objet orphelin supprimé d’abord, 15 minutes après l’expiration du lien) avant toute nouvelle réservation ;
   - réponse reçue hors circuit (téléphone, courrier, autre adresse) : « Consigner une réponse reçue » sur une mission envoyée, enregistrée comme import manuel (expéditeur non vérifié).

   Une demande de ne plus être contacté vaut opposition globale sur chacun des trois canaux : « STOP » ou « Stop, merci » seul sur une ligne, « (merci de / veuillez / je vous demande de) ne plus me contacter, m’écrire, me solliciter, me relancer », « ne m’écrivez plus », « cessez vos envois », « je me désabonne », « je ne souhaite plus recevoir vos messages » ou « être contacté », « je m’oppose au traitement de mes données » (`information-agent-inbound/reply-intent.ts`). Une opposition de trop coûte moins qu’une opposition manquée. Les faits extraits deviennent des candidats `pending` ; la revue affiche leur provenance (e-mail, portail, import manuel, expéditeur différent du contact). Rien n’est publié sans décision humaine ; une pièce ou une photo exige en plus des droits « autorisés », une analyse terminée et le « caviardage vérifié ». Les faits acceptés alimentent `auction_fact_claims` (déclencheur `bridge_accepted_information_agent_fact_claim`).

## File de travail, préparation en deux étapes et suivi (lot 1, 02/11/2026)

- **File utile.** La « File d’enrichissement » (Admin › Agent IA) n’est plus la file de maturité du catalogue : la RPC `admin_information_agent_queue` filtre **avant** la pagination (vente en cours, date non passée, pas déjà sollicitée) et répartit en classes A (avocat ou cabinet, adresse dans l’annonce ou au registre interne), C (greffe du tribunal), B (adresse seulement dans un texte libre : « à confirmer ») et D (contact impossible). L’ordre est A, C puis B. Le SQL est un filtre sûr (sur-ensemble) ; la page affichée est revérifiée en TypeScript avec le résolveur du brouillon (`classifyInformationAgentSaleContacts`, greffe compris). Les fiches de classe D sont dans un bloc replié « Contact impossible (N) » avec le motif (téléphone seul, nom seul, rien) et l’action « Saisir une adresse trouvée sur une page publique » (flux manuel, page d’origine obligatoire). La file ne dépend plus d’`INFORMATION_AGENT_ADDRESS_SEARCH_ENABLED`. Une vente dont le dossier a rebondi redevient éligible pour un autre destinataire.
- **Préparer.** « Ouvrir le message » appelle `POST /api/admin/information-agent/missions/prepare` : brouillon (créé, ou retrouvé s’il est unique, modifiable et au gabarit publié courant) **et** aperçu exact dans la même réponse. L’administrateur relit, coche « J’ai relu le message exact… », puis « Valider et envoyer » (`PATCH approve_and_send`, inchangé : empreinte d’aperçu, confirmation explicite). Plafond de **30 validations par administrateur et par jour de Paris** (`INFORMATION_AGENT_ADMIN_DAILY_APPROVAL_CAP`), contrôlé à l’aperçu (information) et **dans la fonction d’approbation** (`approve_information_agent_mission_admin`, verrou consultatif par administrateur : deux validations simultanées ne dépassent jamais le plafond).
- **Hygiène des adresses** (`address-hygiene.ts`, `address-deliverability.ts`) : longueurs (254 / 64 / 63), artefacts d’extraction (`mailto`, `%`, `..`, noms d’images), domaines réservés, domaine sans MX ni A/AAAA (NXDOMAIN ou « null MX » : bloquant ; SERVFAIL ou délai : non bloquant), cache DNS de 24 h en mémoire, **deux rebonds passagers en 30 jours : bloquant**. Aucune sonde SMTP, aucun service tiers. Interrupteur de secours `INFORMATION_AGENT_ADDRESS_CHECK=off`, **sans effet en production** (`VERCEL_ENV=production`) ; la suite de tests l’utilise. La résolution DNS est bornée : 2 s par requête, un essai, 4 s au total par domaine, une seule résolution pour des appels simultanés, un échec retenu 60 s. Adresses techniques exclues en plus : `abuse`, `postmaster`, `hostmaster`, `webmaster`, `root`, `mailer-daemon`, `spam`, `privacy`, `security`, `newsletter`, `unsubscribe` (miroir Python à jour). Limite connue : la fonction SQL `app_private.listing_has_contact_email` (règle du minimum d’annonce) n’a pas ces exclusions, volontairement (la modifier changerait les suppressions d’annonces vides).
- **Messageries grand public** (gmail, outlook, orange, free…) : listées dans `INFORMATION_AGENT_CONSUMER_MAIL_BRANDS`, réservées à la validation manuelle (jamais au pilote automatique).
- **Suivi de remise.** `email_send_log` (webhooks delivered, delayed, failed, bounced, complained) donne l’état de chaque message. Un rebond ou une plainte marque aussi le dossier et la mission (`metadata.delivery`). Trois alertes de santé s’ajoutent (`evaluate_information_agent_health`) : taux de rebond définitif ≥ 3 % sur 14 jours (au moins 10 envois ; critique à 5 %), plainte, message sans dossier en attente depuis plus de 24 h.
- **Indicateurs.** Le panneau « Suivi des envois et de la réception » donne, sur 30 jours, envoyés, remis, retardés, rebonds, plaintes, oppositions, réponses et délai de réponse, toujours avec l’effectif (« 1 sur 12 »).
- **Aller-retour attesté.** Le bouton « J’ai vérifié l’aller-retour réel » enregistre la date (`information_agent_operations`). Procédure : envoyer un message d’essai à une adresse interne, y répondre, vérifier que la réponse arrive en revue. Un contrôle de préparation du pilote exigera moins de 30 jours.

## Pilote automatique (lot 2, 02/11/2026)

**État à la livraison : désactivé (`off`). Le mode réel est impossible** tant que `AUTOPILOT_LEGAL_MIN_PRIVACY_VERSION` (`autopilot-readiness.ts`, fixée à `2099-01-01.0`) n’est pas abaissée par le lot 3, qui publie la nouvelle politique de confidentialité.

- **Périmètre.** Seulement l’avocat poursuivant dont l’adresse figure dans l’annonce de la vente (`source_kind = sale_listing`). Jamais : greffes, adresses retrouvées par recherche, saisies d’administrateur, messageries grand public (gmail, outlook, orange, free…), notaires, commissaires, gestionnaires. Adresses Licitor décodées exclues tant que le réglage `allow_licitor_decoded` (accord écrit de Licitor) n’est pas activé. Aucune relance ; contenu = ce que `buildInformationRequestDraft` produit avec le gabarit publié, questions du catalogue fermé, aucun texte libre ni d’IA.
- **Candidat** (`autopilot-rules.ts`, `autopilot-candidates.ts`) : classe A de la file, contact non ambigu, identité complète (nom et barreau ou ville), domaine non grand public, MX valide, adresse relevée il y a au plus 6 mois, audience à 10 jours ou plus, au moins une lacune, aucun brouillon d’administrateur sur la vente (jamais annulé), identité non exclue, **article 14** (première adresse enregistrée depuis au plus le délai, ou personne déjà informée ; délai réglable de 1 à 90 jours, voir « Délai Article 14 du pilote » ; règle non désactivable depuis le lot B du 14/11/2026, à l’écran, côté serveur et en base : migration `20261119100810`), pause de 90 jours après une réponse, 6 mois après 2 envois sans réponse. Depuis le lot B : une vente qui a déjà un **brouillon simulé en attente** n’est pas reprise (`simulated_draft_pending`), et le **délai de 30 jours par destinataire** (toutes ventes, même règle que la création d’un brouillon) s’applique dès la sélection (`recipient_cooldown`).
- **Brouillons simulés en attente** (« Prêtes à valider ») : 10 au plus (`AUTOPILOT_MAX_PENDING_SIMULATED_DRAFTS`). En tête de chaque passage de simulation, les brouillons en attente sont relus comme à l’aperçu : celui dont la vente a changé depuis sa préparation (date, mise à prix, vente retirée ou passée) est annulé et compté `draft_stale`, **jamais** comme rejet de politique ; de même pour un brouillon réutilisé. Plafond encore atteint ensuite, la simulation ne cherche plus de candidat (code du passage `simulated_backlog`) jusqu’à ce qu’un administrateur en envoie ou en annule.
- **Plafonds** (manuels inclus dans le total du jour ; minimum entre phase, réglage et `INFORMATION_AGENT_AUTOPILOT_DAILY_CAP`) : semaine 1 : 5 par jour, 3 par heure ; semaine 2 : 10 ; semaine 3 : 20 ; semaine 4 : 30 ; croisière 40 ; dur 60 par jour et 12 par heure. Par structure (cabinet, office notarial, service de l’État) : 1 par jour et 2 par 7 jours, 15 minutes entre deux envois vers le même domaine ; sur un domaine partagé par toute une profession (`notaires.fr`, `gouv.fr`), la structure est l’office (code CRPCEN) ou, sans code, la boîte, et le domaine partagé a en plus son plafond de 3 par jour (`AUTOPILOT_SHARED_DOMAIN_DAY_CAP`), voir « Destinataires lus dans l’annonce » ; par tribunal : 3 par jour ; intervalle aléatoire de 2 à 12 minutes. Plage : lundi au vendredi hors jours fériés, 9 h 30-11 h 30 et 14 h-16 h 30 (Paris). La phase suit la date du premier envoi automatique et n’avance que si la semaine précédente est propre.
- **Arrêt automatique** (mode « off », alerte critique `information_agent.autopilot.auto_stop`, réactivation manuelle et journalisée) : 1 plainte sur les 100 premiers envois (puis 2 sur 14 jours) ; 3 rebonds définitifs sur les 30 premiers envois ou 3 % sur 100 envois mûrs ; 2 rejets de politique ou de contenu en 7 jours ; moins de 95 % remis sur 24 h (20 envois au moins) ; 6 % d’oppositions sur 14 jours (3 au moins) ; 3 erreurs d’API consécutives hors 429 ; tout envoi « à vérifier » ; échec de domaine ou de quota ; administrateur d’exécution rétrogradé ; réponse « mauvais destinataire ». **Pause de 24 h** si 20 % des messages sont retardés. Avertissements à la moitié des seuils.
- **Mauvais destinataire.** Une réponse d’un expéditeur authentifié qui dit « ce n’est pas moi », « je ne suis pas l’avocat de ce dossier », « erreur de destinataire »… (`detectWrongRecipientSignal`) exclut l’identité du pilote pendant 24 mois (validation manuelle seulement ; la juriste tranchera au lot 3) et, si le message venait du pilote, l’arrête (`wrong_recipient`). Vocabulaire voisin (autre cabinet, confrère, pas concerné) : relecture humaine, aucun arrêt. Bouton « Mauvais destinataire » dans la revue des réponses, même effet.
- **Contrôle de préparation** (mode réel, à l’activation et à chaque passage) : environnement d’envoi ouvert et canari coupé ; secrets ; expéditeur sur le domaine de réception ; domaine Resend vérifié (lecture de `GET /domains`) ; aller-retour attesté depuis moins de 30 jours ; version de politique de confidentialité au moins égale à la constante ; AIPD attestée ; au moins 30 envois manuels réels avec taux propres ; au moins 7 jours de simulation sans anomalie, **dont 5 jours effectifs** (depuis le lot B : un jour compte s’il a au moins un envoi simulé par un passage planifié et aucun passage en erreur, `clean_simulation_days`, migration `20261119100820` ; les envois simulés d’un passage lancé à la main ne comptent pas ; une erreur de passage, planifié ou à la main, gâte sa journée sans remettre la simulation à zéro) ; aucune mission bloquée ; administrateur d’exécution toujours administrateur.
- **Attestation de l’aller-retour.** Plus un simple clic : une réponse de test **reçue par le circuit réel** (jamais importée à la main, expéditeur authentifié et identique au destinataire, identifiant du fournisseur présent), routée vers un dossier **envoyé** de l’administrateur dont le destinataire est une adresse d’un **domaine interne** (liste blanche `information_agent_internal_domains`, `immojudis.com` par défaut, modifiable par la RPC journalisée `set_information_agent_internal_domain` ; jamais une messagerie grand public), doit exister dans les 24 dernières heures. Procédure : créer une demande à une adresse interne, y répondre, attendre qu’elle arrive en revue, puis cliquer sur « J’ai vérifié l’aller-retour réel ». Chaque attestation est inscrite (qui, quand) dans `information_agent_roundtrip_attestations`, en ajout seul.
- **Verrous du lot 3.** Colonne `live_allowed` des réglages (faux par défaut) : tant qu'une migration du lot 3 ne la passe pas à vrai, même un appel direct de la RPC ne peut pas mettre le pilote en mode réel. Le journal, les attestations et les réglages ne s'écrivent que par les RPC (`service_role` n'a ni `delete` ni `update`, la purge est bornée à la date du jour, `truncate` bloqué). Un « @ » dans un motif est neutralisé dans le journal (l'arrêt d'urgence ne peut pas échouer) ; les motifs saisis refusent « @ ».
- **Revérification à l'envoi.** Juste avant le fournisseur (et avant l'approbation), l'envoi du pilote revérifie : pilote en mode réel, ni greffe ni autre origine que l'annonce (origine résolue et aucune autre origine enregistrée pour l'adresse et la vente), rôle avocat, ni messagerie grand public (sous-domaines compris), aucune identité exclue, pauses de 90 jours et de 6 mois, article 14, date de relevé présente. Le pilote n'est pas soumis au plafond de 30 validations des administrateurs (il a ses propres plafonds). Un brouillon du pilote validé à la main est réécrit `trigger = manual`.
- **Exécution.** `pg_cron` toutes les 10 minutes (`immojudis-information-agent-autopilot`), appel HTTP **seulement si le mode n’est pas « off »**, production seulement (`VERCEL_ENV=production`), bail `information-agent-autopilot` de 330 secondes (la route est coupée à 300). Simulation : brouillons et aperçus, événements `would_send`, aucun appel au fournisseur. Réel : `runAdminInformationAgentAction` (`approve_and_send`) avec `trigger: autopilot`, mode d’envoi `autopilot` dans le journal, trace (passage, empreinte du texte rendu pied compris, contrôles). Filet SQL : une mission marquée `trigger = autopilot` ne passe pas en `sending` si le pilote n’est pas en mode réel.
- **Réglages et journal.** Panneau « Pilote automatique » (Admin › Agent IA › onglet Pilote) : interrupteur à trois états, motif obligatoire, arrêt d’urgence toujours permis (bouton rouge, en haut de chaque onglet et dans le panneau), ligne « Dernier passage planifié … · prochain passage : … », dépliant « Réglages du pilote » (plafond par jour, « Ouvrir » ou « Fermer les adresses Licitor décodées »), dépliant « Conformité » (délai de l’article 14, attestation de l’AIPD, chacun avec confirmation), journal en ajout seul (`information_agent_autopilot_events`, sans adresse, 5 ans, purge dédiée `purge_information_agent_autopilot` appelée par `runDataRetention`).
- **Interdits.** Les adresses, réponses et silences collectés ne servent jamais à la mise en avant payante, au classement d’avocats ni à la mise en relation.

## Piloter le pilote (lot B, 14/11/2026)

Tout se lit dans **Admin › Agent IA › onglet Pilote**. Les heures sont celles de Paris.

### Lire les « Derniers événements »

- **Où.** Le dépliant « Derniers événements » (les 20 derniers, du plus récent au plus ancien). Au-dessus des boutons, la ligne « Dernier passage planifié : … · prochain passage : … » donne l’heure du dernier passage de la tâche planifiée qui a travaillé (un passage lancé à la main n’y compte pas) et celle du prochain créneau possible (toutes les 10 minutes, dans la plage d’envoi).
- **Passage.** Un évènement par passage qui a travaillé : « 7 examinées, 2 préparées, 2 simulées, 0 envoyées · écartées : motif (n), … · en erreur : motif (n) ». Un passage hors plage, en pause, pilote éteint, hors production ou pendant qu’un autre passage tient le bail **ne laisse aucun évènement**.
- **Envoi simulé.** Un brouillon prêt, ajouté à « Prêtes à valider ».
- **Candidat écarté.** Un refus à l’aperçu ou au dernier contrôle avant l’envoi. **Seuls « rejet de politique à l’aperçu » et « rejet de contenu à l’aperçu » comptent pour l’arrêt automatique** (2 en 7 jours, comptés depuis la dernière réactivation). Les motifs « écartées » d’un passage ne comptent jamais.
- **Arrêt automatique, Arrêt d’urgence, Changement de mode, Réglages modifiés, AIPD attestée.** Avec le motif saisi ou le motif de l’arrêt, en clair.
- Un code inconnu de l’écran s’affiche « motif non répertorié (code) » : le signaler.

### Vérifier qu’un arrêt est effectif

Après « Arrêt d’urgence » ou un arrêt automatique :

1. Le panneau dit « État : Éteint » ; le bandeau dit « Éteint » ou « Arrêté automatiquement » ; « Arrêt d’urgence » est grisé.
2. La ligne dit « prochain passage : aucun (pilote éteint) » ou « aucun (arrêt automatique, réactivation manuelle) ».
3. Le journal commence par « Arrêt d’urgence » ou « Arrêt automatique ».
4. **Plus aucun appel** : en mode « off », la tâche pg_cron n’appelle plus l’application. Vingt minutes plus tard (deux créneaux), aucun nouvel évènement « Passage ». Un passage déjà commencé relit le mode avant chaque candidat et s’interrompt (`interrupted`).
5. Si l’écran affiche « Arrêt enregistré, état non relu », recharger la page avant toute autre action.

### Réarmer après un arrêt automatique

1. Lire le motif : avis rouge du panneau, alerte critique « Pilote de l’Agent IA arrêté automatiquement » de l’accueil.
2. Lire ce qui l’a précédé dans « Derniers événements ». Pour `policy_rejections` : chaque « Candidat écarté : rejet de politique à l’aperçu » porte l’identifiant de la vente dans le journal ; ouvrir la vente dans « À contacter », préparer le message et lire les motifs de blocage de l’aperçu. **Ne pas réarmer tant que la cause n’est pas comprise**, et corrigée si c’est un défaut.
3. Saisir un motif qui dit ce qui a été vérifié, puis « Simulation ». La réactivation est journalisée ; les rejets et les erreurs d’API se recomptent depuis elle (`20261119100500`). L’horloge des 7 jours de simulation repart de cet instant : un arrêt automatique la remet à zéro.
4. Au créneau suivant, vérifier que « Dernier passage planifié » avance et qu’aucun nouvel arrêt n’apparaît.

### Si aucun passage n’a lieu

En mode « Simulation », dans la plage d’envoi (lundi au vendredi hors jours fériés, 9 h 30-11 h 30 et 14 h-16 h 30), un évènement « Passage » paraît toutes les 10 minutes, même plafond atteint (« écartées : plafond des brouillons simulés en attente atteint »). Si « Dernier passage planifié » a plus de 20 minutes pendant la plage (un passage lancé à la main ne la fait pas avancer) :

1. **Panneau.** Mode « Simulation » ? Aucun avis de pause ni d’arrêt ? « Prochain passage » cohérent ?
2. **Passage en erreur.** Une erreur levée (base, API d’authentification indisponible : depuis le lot B, elle fait échouer le passage au lieu d’arrêter le pilote) ne laisse aucun évènement. Lire les journaux Vercel de `/api/cron/information-agent-autopilot` (lignes `information_agent.autopilot`) et, en lecture seule dans l’éditeur SQL : `select started_at, status, error_message from public.operational_job_runs where job_name = 'information-agent-autopilot' order by started_at desc limit 10;`.
3. **Appel jamais parti.** Tâche pg_cron `immojudis-information-agent-autopilot` : `select status, return_message, start_time from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'immojudis-information-agent-autopilot') order by start_time desc limit 5;`. Puis les secrets Vault `immojudis_operational_health_url` et `immojudis_operational_health_secret`, et `VERCEL_ENV=production` sur le déploiement.
4. **Aucune alerte ne sonne aujourd’hui** pour un pilote muet (T5, à venir), et la porte « 7 jours de simulation » compte le temps écoulé, pas les passages : noter les plages sans passage dans le compte-rendu de la journée. Un passage lancé à la main ne remplace pas la tâche planifiée : ses envois simulés ne font pas un jour effectif.

### `INFORMATION_AGENT_OUTBOUND_ENABLED` : l’envoi manuel de tout l’agent

- **État.** `true` en production depuis le 02/11/2026, sur décision du propriétaire : envois manuels, validés un par un. `INFORMATION_AGENT_OUTBOUND_CANARY_ONLY=false`. Constaté dans Vercel par le chef d’orchestre le 14/11.
- **Portée.** Cette variable ouvre l’envoi **manuel** de tout l’agent (« Valider et envoyer », pour tout destinataire admis), pas le pilote. En simulation, le pilote ne s’en sert pas : il ne fait que des aperçus. En mode réel, elle n’est qu’un des verrous du contrôle de préparation.
- **Couper en urgence.** La passer à `false` dans Vercel (cible Production), puis **redéployer la production** : la valeur ne s’applique qu’au déploiement suivant. Si le pilote tourne, cliquer en plus « Arrêt d’urgence ». Vérification : l’aperçu d’un brouillon affiche « Envoi de l’agent désactivé pendant la phase de validation. » et « Valider et envoyer » reste grisé.

### Lexique des codes

Les codes paraissent dans les journaux Vercel, dans le résumé rendu par la tâche planifiée et dans le journal du pilote (`skip_<code>`, `error_<code>`). L’écran les traduit ; liste complète et libellés : `AUTOPILOT_CODE_LABELS` (`src/lib/information-agent/autopilot-view.ts`), complétée par un test à chaque nouveau code.

| Codes                                                                                                                          | Sens                                                                                                                                           | Conduite                                                  |
| ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `disabled`, `auto_stopped`, `paused`, `outside_window`, `not_production`, `busy`                                               | Passage sauté : éteint, arrêté, en pause, hors plage, hors production, bail tenu                                                               | Rien, sauf durée anormale                                 |
| `not_ready`, `not_live`                                                                                                        | Contrôle de préparation non satisfait ; pilote plus en mode réel                                                                               | Attendu tant que le mode réel est verrouillé              |
| `on_demand_started`, `not_simulation`, `on_demand_cooldown`                                                                    | Passage de simulation lancé à la main : trace de début ; refusé hors Simulation ; déjà lancé il y a moins de 10 min                            | Rien ; réessayer après le délai                           |
| `simulated_draft_pending`, `simulated_backlog`                                                                                 | Vente déjà simulée ; plafond de 10 brouillons simulés en attente atteint                                                                       | Envoyer ou annuler des brouillons de « Prêtes à valider » |
| `recipient_cooldown`, `draft_refused`                                                                                          | Destinataire sollicité il y a moins de 30 jours ; brouillon refusé par les garde-fous                                                          | Attendu après un envoi manuel                             |
| `draft_stale`                                                                                                                  | Brouillon caduc (vente changée depuis sa préparation), annulé                                                                                  | Rien : le passage suivant en prépare un neuf              |
| `policy_rejected`, `content_rejected`                                                                                          | Rejet de politique ou de contenu à l’aperçu : **compte pour l’arrêt**                                                                          | Lire les blocages de l’aperçu (voir « Réarmer »)          |
| `licitor_decoded_refused`, `sale_too_soon`, `notary_send_closed`, `role_not_lawyer`, `consumer_domain`, `not_class_a`          | Écartés par la file : Licitor fermé, vente à moins de 10 jours, vente notariale, pas un avocat, messagerie grand public, pas de contact unique | Rien                                                      |
| `art14_window_expired`, `art14_unknown`                                                                                        | Adresse relevée depuis plus que le délai de l’article 14, ou date inconnue                                                                     | Rien : validation manuelle seulement                      |
| `opposition_check_failed`                                                                                                      | Contrôle d’opposition impossible (panne passagère) : candidat écarté, journalisé                                                               | Une répétition se signale                                 |
| `opposed`, `address_excluded`, `identity_excluded`, `admin_draft_exists`, `reply_pause`, `silence_pause`, `no_unpublished_gap` | Opposition ou rebond définitif, adresse exclue ou structure inconnue, identité exclue, brouillon d’administrateur, pauses, rien à demander     | Rien                                                      |
| `cap_reached`, `hour_cap`, `interval`, `domain_cap`, `court_cap`, `structure_cap`                                              | Plafonds (mode réel)                                                                                                                           | Rien                                                      |
| `draft_error`, `cancel_failed`, `preview_error`, `mark_failed`, `stale_check_failed`, `run_errors`                             | Erreurs du passage : alerte « Pilote de l’Agent IA : dernier passage en erreur »                                                               | Lire les journaux Vercel ; une répétition se signale      |
| `policy_rejections`, `api_errors`, `acting_admin_invalid`, `wrong_recipient`, `unverified_send`, `complaint`                   | Motifs d’arrêt automatique                                                                                                                     | Voir « Réarmer après un arrêt automatique »               |

## Avant d’appliquer les migrations du lot B (au plus tard le 16/11 à 9 h 30)

Trois migrations : `20261119100800` (marque « simulé » posée par la base), `20261119100810` (article 14 non
désactivable, délai de 1 à 90 jours, valeur par défaut 90), `20261119100820` (jours de simulation effectifs). Avant de les appliquer, en
lecture seule dans l’éditeur SQL :

1. **Lire la ligne de réglages.**
   `select mode, simulation_started_at, auto_stopped_at, allow_licitor_decoded, art14_rule_enabled, art14_max_age_days from public.information_agent_autopilot_settings;`
   `art14_rule_enabled` doit valoir `true` et `art14_max_age_days` être entre 1 et 90. Sinon, rétablir d’abord par l’écran (Conformité : « Rétablir la règle de l’article 14 », délai de 90 jours au plus, motif journalisé) : `20261119100810` refuse de s’appliquer tant que la ligne est hors bornes, sans rien modifier. La migration ne change pas la valeur enregistrée. Mesure du chef d’orchestre le 14/11 : règle active, 30 jours, `allow_licitor_decoded = true`.
2. **Compter les brouillons simulés en attente.**
   `select count(*) from public.information_agent_missions where status = 'draft' and metadata ->> 'trigger' = 'autopilot' and metadata ->> 'autopilot_simulated' = 'true';`
   Au-delà de 10, la simulation ne préparera rien avant qu’on en envoie ou en annule (après annulation automatique des brouillons caducs). Mesure du 14/11 : 0.
3. **Vérifier que la fonction de marque existe**, avant le passage du 16/11 à 9 h 30 si le code du lot B est déjà déployé :
   `select to_regprocedure('public.mark_information_agent_autopilot_simulated(uuid)') is not null;`
   Sans elle, chaque brouillon simulé finit en erreur `mark_failed` : aucun envoi simulé, alerte « dernier passage en erreur », et aucun jour effectif.

Après application, relire le panneau : « Conformité » doit dire « appliqué à chaque candidat, non désactivable » et le délai appliqué ; un délai enregistré de plus de 90 jours s’y affiche « enregistré : … jours, appliqué : 90 : à rétablir ». Puis, si le propriétaire le décide, passer le délai à 90 jours (section suivante).

### Délai Article 14 du pilote

**Délai Article 14 du pilote : 90 jours au plus, décision du propriétaire du 14/11/2026, contre l’avis de juridique-rgpd (art. 14.3.a RGPD : information au plus tard un mois après le relevé) ; risque accepté par le propriétaire.** Les lignes directrices WP260 vont dans le même sens que l’avis de juridique-rgpd. La base admet 1 à 90 jours (`20261119100810`, valeur par défaut de la colonne : 90), l’application aussi (`AUTOPILOT_ART14_MAX_DAYS`). La valeur enregistrée en production reste 30 tant qu’on ne la change pas.

Passer la valeur à 90 depuis l’écran, après le déploiement et la migration :

1. Admin › Agent IA › onglet Pilote : saisir un motif de 8 caractères au moins (par exemple « Délai article 14 à 90 jours, décision du propriétaire du 14/11 »).
2. Ouvrir le dépliant « Conformité (article 14, AIPD) », saisir `90` dans « Délai en jours ».
3. Cliquer « Modifier le délai de l’article 14 », lire la confirmation (« … de 30 à 90 jours ? … »), puis confirmer.
4. Vérifier : « Conformité » affiche « délai d’information : 90 jours (réglable de 1 à 90) », et « Derniers événements » commence par « Réglages modifiés » avec le motif.

## Marche de la simulation (à partir du 16/11/2026)

Elle remplace la marche du compte-rendu `docs/equipe/2026-11-14-administration-et-pilote.md`.

0. **Lire l’état d’abord, sans rien cliquer.** Selon la base (mesure du 14/11), le pilote est en simulation depuis le 14/11 à 10:47 UTC (11 h 47 à Paris), et un réglage a été modifié à 10:45 UTC (11 h 45). Dans l’onglet Pilote :
   - « État : Simulation (aucun envoi) » : ne recliquer ni « Simulation » (refusé : « Le pilote est déjà dans ce mode ») ni « Éteint » (l’horloge des 7 jours repartirait de zéro) ;
   - « Derniers événements » : retrouver « Réglages modifiés » de 11 h 45 et « Changement de mode » de 11 h 47, avec leurs motifs. Si l’un ne vous dit rien, le noter et le signaler avant d’aller plus loin ;
   - « Réglages du pilote » : adresses Licitor décodées ouvertes ou fermées au pilote (décision du 14/11 : ouvertes) ;
   - « Prêtes à valider » : le nombre sur 10. Pour qu’un jour compte dans la porte du mode réel (5 jours effectifs), la simulation doit pouvoir préparer au moins un brouillon ce jour-là : traiter la liste chaque jour (envoyer ou annuler).
1. **Où sont les réglages.** Dans le dépliant « Réglages du pilote » du panneau, sous les compteurs ; l’article 14 et l’AIPD dans « Conformité ». L’onglet « Réglages » de l’Agent IA (gabarit, publication automatique) ne règle pas le pilote.
2. **Rien ne se passe avant le passage de 9 h 30.** Le pilote ne travaille que du lundi au vendredi, 9 h 30-11 h 30 et 14 h-16 h 30, jours fériés exclus : aucun passage n’a eu lieu le samedi 14 ni le dimanche 15. La ligne « prochain passage » le confirme.
3. **Les « Non » du contrôle de préparation sont attendus.** Il porte sur le mode réel (verrou du lot 3, politique de confidentialité, AIPD, 30 envois manuels, 7 jours de simulation…) ; la simulation ne s’en sert pas.
4. **Lexique des codes** : voir « Piloter le pilote ». Les plus fréquents lundi : `licitor_decoded_refused`, `sale_too_soon`, `simulated_draft_pending`, `recipient_cooldown`, `simulated_backlog`.
5. **Après un arrêt `policy_rejections`** (« deux rejets de politique ou de contenu en 7 jours »), **ne pas réarmer** avant d’avoir lu les blocages : voir « Réarmer après un arrêt automatique ».
6. **Avant chaque envoi manuel, annuler les autres brouillons du pilote adressés au même avocat**, tant que le lot B (T1) n’est pas en production : ouvrir chaque vente de « Prêtes à valider » (le destinataire s’affiche dans l’éditeur), puis « Annuler la mission » pour chacune adressée au même avocat ou au même cabinet. Sans cela, l’aperçu de ces brouillons serait refusé (délai de 30 jours), et deux refus arrêteraient le pilote. Une fois le lot B en production, ces brouillons ne sont plus repris par le pilote : les annuler libère seulement le plafond de 10.
7. **Envois manuels** : un par un, comme décrit dans le compte-rendu du 14/11 (« Reprendre », aperçu, « J’ai relu le message exact », « Valider et envoyer »). En cas de doute : « Arrêt d’urgence ».

## Protocole de mesure du pilote (D16, 14/11/2026)

Défini avec `statisticien` avant le premier envoi : rien ne se décide sur un chiffre choisi après coup.

- **Indicateur principal.** Part des dossiers envoyés qui apportent **au moins une information acceptée dans les 14 jours** suivant l’envoi.
  - Numérateur : dossiers envoyés dont au moins une information tirée d’une réponse (e-mail, dépôt, réponse consignée) a été acceptée par un administrateur au plus 14 jours après l’envoi.
  - Dénominateur : tous les dossiers envoyés de la cohorte, remis ou non : un rebond n’a rien apporté.
  - Cohorte : semaine d’envoi (lundi-dimanche, heure de Paris). Elle se lit 14 jours après son dernier envoi, pas avant : les envois du 17 au 19/11 se lisent le 03/12 au plus tôt.
  - Toujours en quatre cases, jamais fondues : **pilote** (`trigger = autopilot`) ou **envoi manuel**, croisé avec **adresse Licitor décodée** ou **autre adresse**.
  - Indicateurs secondaires, même découpage : remis, réponse reçue, opposition, délai de réponse.
- **Ce que les effectifs permettent.**
  - Sur 1 à 3 envois, un taux ne dit rien : 0 réponse sur 3 laisse une borne haute de 56 % (intervalle de Wilson à 95 %).
  - Pour une précision de ±10 points, il faut environ 80 dossiers par case si la part est voisine de 30 % (près de 100 si elle est voisine de 50 %).
  - En deçà, on rapporte les effectifs et l’intervalle, sans conclusion.
- **Jamais un taux sans son effectif.** On écrit « 2 sur 7 (29 %, intervalle de 8 à 64 %) », jamais « 29 % ».
- **Requête.** Une requête agrégée, en lecture seule et sans adresse, est écrite et lancée après le premier envoi réel, puis chaque lundi, par `qualite-donnees` avec `statisticien`. Elle sert aussi au lot R8 du registre des pièces.

## Destinataires lus dans l’annonce : avocats, notaires, services de l’État (lot du 11/11/2026)

Décision du propriétaire (11/11/2026) : l’outil ne contacte pas que des avocats, il contacte aussi les notaires et toute personne référencée sur la source ; une adresse générique suffit, quelqu’un de la structure saura transmettre. Ce lot ne fait que la première étape : **l’outil voit et sait utiliser les adresses déjà en base**. Il n’envoie rien de plus : la recherche d’adresse reste éteinte, le pilote automatique reste réservé à l’avocat poursuivant (`role_not_lawyer`) et verrouillé, la publication automatique reste verrouillée, et **les envois aux notaires sont fermés par défaut** (voir plus bas).

- **Où est le code.** `contact-resolution.ts` (résolution pure des destinataires), `listing-contacts.ts` (blocs de contact de l’annonce et tables des rôles), `contact-structure.ts` (adresse générique, domaines, office, plafond), `opposition-keys.ts` (seule définition des clés d’opposition d’un destinataire), `recipient-questions.ts` et `recipient-templates.ts` (questions et texte par destinataire), `contacts.ts` (registre, oppositions, écritures), `dry-run.ts` (mesure à blanc).
- **Ce qui est lu.** En plus de `lawyer_contact`, des blocs cités, des descriptions et du registre interne, le résolveur lit `raw_payload.source_property_features` de la vente et de chaque observation fusionnée : `contact` (`name`, `email`), `manager` (`manager_name`, `email`, `direction_email`, `managers[]`, ancienne forme `contacts[]`), `lawyer` (`name`, `email`) et `listing.office_crpcen`. Seuls ces champs sont recopiés dans l’instantané interne de la vente. L’origine enregistrée est l’annonce (`sale_listing`), avec la source et l’URL de l’annonce lue.
- **Rôle** (tables fermées `informationAgentListingBlockRole` et `informationAgentSaleFieldRole`). Il vient de l’organisateur de la vente (`sale_procedure.organizer_type`, colonne puis `raw_payload`) **et de la source de l’annonce**, jamais du nom d’un champ :
  - vente notariale : le bloc `contact` et `lawyer_contact` sont « notaire » seulement si la source est `notaires` ; sinon « contact de l’annonce » ;
  - cession de l’État : le bloc `manager` et `lawyer_contact` sont « service de l’État » (rôle `organizer` au registre) seulement si la source est `cessions_etat` ;
  - avocat poursuivant : le bloc `lawyer` est l’avocat ; le bloc `contact` ne l’est que si son adresse est aussi celle de l’avocat ; `lawyer_contact` est l’avocat, sauf sur une source `notaires` ou `cessions_etat` (contact de l’annonce) ;
  - organisateur inconnu, absent ou hors liste : le rôle de la source (`notaires`, `cessions_etat`) ; à défaut, `lawyer_contact` n’est « avocat » que si un bloc `lawyer` porte la même adresse ; sinon « contact de l’annonce ». Le pilote refuse tout rôle autre qu’avocat.
  - **Conséquence à connaître :** une vente au tribunal dont la procédure ne déclare pas d’organisateur (`organizer_type` absent ou `unknown`, source `vench` par exemple) et dont l’annonce n’a pas de bloc `lawyer` donne maintenant « contact de l’annonce » au lieu d’« avocat ». C’est le sens sûr : le pilote ne lui écrit pas, l’administrateur voit le contact et décide. Le volume se mesure avec la mesure à blanc (`selectedByRole.source_contact`).
  - Sur une source `notaires` ou `cessions_etat`, un bloc cité, une description ou une ligne du registre ne donne jamais le rôle « avocat ». Organisateur non déclaré : la source vaut organisateur (`informationAgentImpliedOrganizerType`), l’adresse d’un « avocat » est refusée comme sur une vente notariale ou une cession déclarée (`role_not_sale_interlocutor`). Organisateur déclaré « avocat poursuivant » sur une telle source : l’adresse reste « contact de l’annonce », à confirmer par l’administrateur.
- **Jamais retenu** : un avocat publié dans une vente notariale ou une cession, un notaire cité dans une vente au tribunal, un gestionnaire hors cession, y compris quand l’adresse vient du registre interne (`role_not_sale_interlocutor`) ; une adresse précédée, dans la même ligne ou la même phrase, d’une autre qualité (syndic, conseil ou avocat d’une partie, partie saisie, liquidateur, mandataire ou administrateur judiciaire, créancier inscrit, locataire, occupant : `not_sale_interlocutor`, liste fermée) ; « étude » seule ne vaut plus « notaire ».
- **Cessions de l’État.** `direction_email` est la boîte du service : lue d’abord, toujours retenue. Elle est générique quand elle porte un mot de boîte fonctionnelle au sens du pipeline (`INFORMATION_AGENT_STATE_FUNCTIONAL_MAILBOX_WORDS`, copie de `_FUNCTIONAL_MAILBOX_RE` dans `services/data-pipeline/src/sources/cessions_etat_page.py`, comparée mot pour mot par un test) ; sinon le pipeline a désigné une personne et l’adresse reste nominative. Le gestionnaire nommé (`manager_name`) se reconnaît par son nom normalisé (« DURAND Marie » et « Marie Durand ») ; ce n’est que si aucune personne ne porte ce nom que la première personne listée est le contact de la vente. L’adresse nominative d’une autre personne n’est jamais retenue, même répétée ailleurs (`nominative_other_person`).
- **Générique avant nominative.** Une adresse est générique si sa partie locale commence par un mot de `INFORMATION_AGENT_GENERIC_LOCAL_PARTS` (`contact`, `accueil`, `etude`, `office`, `cabinet`, `secretariat`, formes d’exercice, boîtes des services de l’État), ou si elle est **seule ou suivie de chiffres** pour un mot ambigu de `INFORMATION_AGENT_GENERIC_LOCAL_PARTS_ALONE` (`bureau`, `domaine`, `courrier`, `ventes`… : `bureau.martin@` est une personne). La préférence ne joue qu’entre des adresses que l’annonce donne **ensemble** pour un même interlocuteur (même bloc de contact, ou champ `lawyer_contact` quand les deux adresses partagent le même domaine propre ; `jean.dupont@cabinet-a` et `contact@cabinet-b` restent à départager par l’administrateur) : la générique passe devant la nominative, avec l’écart de 12 points qui la fait choisir seule. Un domaine commun ou une mention dans un texte libre ne donne ni rang ni rôle.
- **Questions et texte selon le destinataire.** Avocat poursuivant : inchangé. Notaire et service de l’État : surface, pièces, occupation, visites, lieu de consultation du cahier des charges, et rien d’autre. Quand le rôle n’est pas établi (adresse saisie, contact de l’annonce), **l’organisateur de la vente décide**, et quand il n’est pas déclaré, la source de l’annonce (`notaires`, `cessions_etat`) : liste courte par défaut sur une vente notariale ou une cession. Le destinataire retenu est enregistré (`metadata.question_audience`) et relu à l’aperçu et à l’envoi ; une question hors liste est refusée avec un message. **Un brouillon sans ce champ (créé avant ce lot) est refusé à l’aperçu et à l’envoi : il faut le régénérer** avec le bouton « Régénérer le brouillon » du brouillon ouvert (toujours actif sur un brouillon modifiable, que la vente vienne de la file ou que le brouillon soit ouvert depuis la liste des envois). Le serveur recrée le brouillon et annule l’ancien pour cette vente et cette adresse. Resélectionner la vente dans la file ne suffit pas : cela rouvre l’ancien brouillon. **Avant tout passage du pilote en simulation**, annuler les brouillons du pilote antérieurs à ce lot (`metadata.trigger = autopilot`, sans `question_audience`) : relus par le pilote, ils seraient comptés `policy_rejected`, et deux rejets en 7 jours déclenchent son arrêt automatique. Chaque destinataire a son texte (`recipient-templates.ts`) : celui du notaire ne cite ni le cahier des conditions de vente, ni le procès-verbal descriptif, ni la garantie, ni l’audience, n’invite pas à joindre de documents (pas de lien de dépôt) et dit que son secret professionnel prime ; celui du service de l’État dit que les règles de son administration priment.
- **Envois aux notaires fermés par défaut** (`assertInformationAgentNotarySendAllowed`, `config.ts`). Tant que `INFORMATION_AGENT_NOTARY_SEND_ENABLED` ne vaut pas exactement `true`, l’aperçu signale le blocage et l’approbation comme l’envoi sont refusés pour un destinataire de rôle notaire, pour tout destinataire d’une vente notariale (y compris une vente d’une source `notaires` sans organisateur déclaré) et pour toute adresse en `notaires.fr` ou l’un de ses sous-domaines, quels que soient le rôle et la vente. Le brouillon et la mesure à blanc restent possibles. À n’activer qu’après l’autorisation attendue sur la réutilisation des annonces notariales.
- **Opposition au niveau de la structure**, sans migration : clés `structure|office|<crpcen>` et `structure|domain|<domaine propre>` dans `information_agent_identity_oppositions`.
  - Jamais de clé pour un domaine partagé (`notaires.fr`, `gouv.fr`), une messagerie de profession ou d’accès (`INFORMATION_AGENT_PROVIDER_MAIL_DOMAINS` : `avocat.fr`, `avocatline.fr`, `nomade.fr`…) ni une messagerie grand public.
  - L’opposition d’un domaine vaut pour ses sous-domaines (les domaines parents sont contrôlés) ; l’inverse n’est pas vrai. Un suffixe public à deux niveaux (`asso.fr`, `com.fr`, `co.uk`… : `INFORMATION_AGENT_PUBLIC_SUFFIXES`) n’est jamais une structure.
  - Quand les blocs de l’annonce ne publient qu’un seul code d’office, il vaut pour tout notaire retenu sur cette vente, que l’organisateur soit déclaré ou non ; une adresse saisie ensuite sur un domaine sans structure propre garde l’office de la vente (`informationAgentOfficeCodeFor`).
  - Seule l’adresse **générique** porte la clé de sa structure : si elle s’oppose (lien, réponse, STOP), le déclencheur existant propage la clé et l’opposition vaut pour la structure ; l’opposition d’une adresse nominative ne vaut que pour la personne. Le pied du message et la page d’opposition le disent. Sur la page d’opposition, cette information vient d’une lecture qui ne bloque jamais rien : si elle échoue, l’erreur est journalisée sans adresse, la page garde son texte ordinaire et l’opposition est enregistrée quand même. Conséquence : le délai de 30 jours s’applique aussi entre deux adresses génériques d’une même structure.
  - Contrôlée au brouillon, à l’aperçu, avant l’approbation, après l’approbation, juste avant le fournisseur, à la sélection du pilote et dans la mesure à blanc, toujours par `recipientOppositionKeys`.
  - Enregistrement manuel : fonction serveur `recordInformationAgentStructureOpposition` (réservée à un administrateur, aucun bouton à ce stade) ou, en `service_role`, `insert into public.information_agent_identity_oppositions (identity_key) values ('structure|domain|<domaine>');`. Levée : même procédure que pour une clé d’identité.
- **Pied du message, variante « structure ».** Le mot suit la structure : « votre cabinet » pour un avocat, « votre étude » pour un notaire, « votre service » pour un service de l’État, formule générale quand la structure n’est pas connue. Adresse générique **sans personne nommée** : catégories « l’adresse de contact de votre cabinet et, si vous répondez, le nom, la fonction et les coordonnées de la personne qui répond » et origine « L’adresse de contact de votre cabinet figure dans l’annonce… ». Adresse générique **avec un nom** (« Me … ») : catégories et origine ordinaires. Dans les deux cas, quand une structure est identifiée : « Si vous vous opposez depuis l’adresse de contact de votre cabinet, nous n’écrirons plus à aucune adresse de ce cabinet. »
- **Plafonds du pilote** (`autopilot-rules.ts`). `AUTOPILOT_STRUCTURE_DAY_CAP` (1) et `AUTOPILOT_STRUCTURE_WEEK_CAP` (2) : hors domaine partagé la structure est le domaine (inchangé, code `domain_cap`) ; sur `notaires.fr` et `gouv.fr` elle est l’office ou la boîte (`structure_cap`), et le domaine a son plafond bas `AUTOPILOT_SHARED_DOMAIN_DAY_CAP` (3 par jour, sous-domaines confondus, `shared_domain_cap`). Les envois par structure y sont comptés par l’application (`loadAutopilotStats`, lecture seule des missions des 8 derniers jours, même définition d’un envoi que la fonction SQL de la migration `20261110230000_information_agent_autopilot.sql`). Au-delà de 1 000 missions sur 8 jours le compte est rendu incomplet : le pilote n’écrit plus en domaine partagé (`structure_count_incomplete`) et l’écran du pilote l’affiche, sans erreur. Le pilote refusant aujourd’hui tout destinataire qui n’est pas un avocat, ces plafonds ne servent qu’à partir du jour où ce périmètre sera élargi.
- **Adresses écartées**, inchangées et valables pour tous les rôles : juridictions (`justice.fr` hors greffe de secours), RPVA, Ordre, CARPA, adresses techniques, opposition, rebond définitif. Une messagerie grand public publiée dans l’annonce reste admise en validation manuelle ; le pilote la refuse toujours.
- **Écran d’administration.** Sous le champ « Email » du brouillon : rôle (Avocat, Notaire, Service de l’État…), origine de l’adresse et nature (générique ou nominative). Le libellé, la source et le lien viennent de la même provenance ; une adresse du registre interne s’affiche « relevée à la collecte de l’annonce (masquée sur la page) », jamais « publiée ». La ligne disparaît dès que l’administrateur saisit une autre adresse.
- **Mesure à blanc** (`dry-run.ts`, `measureInformationAgentRecipients({ auth, saleIds })`). Fonction serveur en lecture seule, réservée à un administrateur, sans route (un test l’interdit) : pour chaque vente, le destinataire que l’outil retiendrait, son rôle, l’origine et la nature de l’adresse, ou le motif. Elle n’écrit rien et n’envoie rien. Pour la lancer : mettre un identifiant de vente par ligne dans un fichier, puis `INFORMATION_AGENT_DRY_RUN_SALE_IDS_FILE=/chemin/ventes.txt SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npx vitest run src/lib/information-agent-dry-run.manual.test.ts`. La sortie ne contient que des comptages (issue, rôle, nature de l’adresse, source, motifs de refus et de blocage). Écarts connus avec un vrai brouillon : délai de 30 jours, vente déjà sollicitée, statut de la vente et résolution DNS non contrôlés.
- **Limites connues.** La recherche d’adresse (`address-search.ts`) ne cherche toujours que l’avocat. La fonction SQL de classement de la file (`admin_information_agent_queue`) et le miroir Python ne lisent pas `source_property_features` : une vente dont la seule adresse est dans ces blocs peut manquer dans la file avant la vérification exacte par le résolveur (migration à prévoir). Les listes de domaines sont fermées : un domaine commun à une profession qui n’y figure pas serait traité comme un domaine propre. La lecture des demandes d’une adresse pour la page d’opposition se fait par comparaison insensible à la casse (`ilike`), comme le délai de 30 jours : la table des demandes n’a pas de colonne d’adresse normalisée, une lecture par index demanderait une migration.

## Motifs de relecture des informations extraites et règle d’éligibilité (10/11/2026)

Chaque information extraite d’une réponse est lue dans sa phrase, par les règles TypeScript
(`src/lib/information-agent-inbound/review-signals.ts`) comme par la lecture par l’IA
(`services/data-pipeline/src/information_agent_review_signals.py`). Une erreur de catégorie ou une négation
(« n’est pas de 65 m² », autre lot que le lot vendu, terrain pris pour le logement, annexe, « pièces jointes »,
date de visite ou de renvoi prise pour la date de vente, GES pris pour le DPE) écarte l’information. Un doute
la garde, avec ses motifs dans `metadata.review_reasons` du candidat : conditionnel ou approximation, valeur
rapportée ou comparée, réserve dans la phrase ou une voisine, fourchette, correction, renvoi, question, lot
non nommé ou invérifiable, phrase de moins de 25 caractères, fait lu par les règles Python seules
(`rules_only_attachment`). La liste des codes et de leurs libellés est unique
(`src/lib/information-agent-review-reasons.ts`, `REVIEW_REASON_LABELS` côté Python) et figée par un test ; les
libellés s’affichent dans l’onglet Réponses. Les cas d’attaque de la relecture du 10/11/2026 sont des tests
permanents (`services/data-pipeline/tests/fixtures/information_agent_extraction_attack.json`).

Quand la lecture par l’IA trouve la même valeur qu’une ligne déjà écrite par les règles du corps du message,
elle complète cette ligne : ses motifs y sont fusionnés et `metadata.semantic_agreement` vaut `true` si elle
n’en a aucun (`false` sinon), avec `metadata.semantic_extraction_method`.

**Règle que le futur moteur de décision devra appliquer** (une information n’est « nette » que si tout est
vrai) :

1. une ligne des règles du corps du message (sans `evidence_asset_id`) porte la valeur, sans aucun motif dans
   `metadata.review_reasons` ni `metadata.lot_unidentified` ;
2. la lecture par l’IA, version `semantic_evidence_v3` ou suivante, a lu la même valeur sans motif :
   `metadata.semantic_agreement = true` et `metadata.semantic_extraction_method` commence par
   `semantic_evidence_v` avec un numéro de version d’au moins 3 ;
3. aucun autre lot que celui de la vente n’est nommé pour cette information (aucun motif de lot) ;
4. le message ne contient aucune autre valeur pour cette clé (aucun autre candidat du même message et de la
   même clé, quelle que soit sa provenance) ;
5. le candidat n’est pas en `conflict`, et la réponse n’a aucun motif de relecture du traitement entrant
   (`inbound_processing.reason`).

Les candidats écrits avant la version 3 (sans `semantic_agreement`, ou méthode `semantic_evidence_v2` ou
antérieure) ne sont **jamais** éligibles. Une information issue d’une pièce jointe ne l’est pas non plus. Le
détecteur de consignes adressées à un modèle est un signal qui envoie la réponse en relecture, pas une
barrière : la publication automatique restera contrôlée par ces conditions structurelles.

## Moteur « publier ou relire » : simulation, modes et arrêt d’urgence (étape 3, 10/11/2026)

**État à la livraison : mode « Arrêt ». Aucun chemin ne publie.** Le moteur décide, la décision est
journalisée et affichée, rien n’est écrit sur une fiche. Trois barrières :

- en base, la contrainte `information_agent_fact_publications_auto_locked` (`actor_kind <> 'auto'`) du
  journal des publications : le noyau `app_private.apply_information_agent_fact` y écrit dans la même
  transaction que la fiche, donc un appel avec `'auto'` échoue en entier et n’écrit rien (test pgTAP 880) ;
- le pont vers `auction_fact_claims` refuse toujours `'auto'` ;
- l’invariant `information-agent-no-automatic-publication-path` de `scripts/check-security-invariants.mjs` :
  tout appel du noyau dans une migration passe le littéral `'admin'` (identifiants entre guillemets compris),
  aucun SQL dynamique (`execute`) ne contient son nom, même partiel, aucun code de `src/` ni du pipeline ne le
  nomme, seul `src/lib/admin-information-agent.ts` appelle `review_information_agent_fact_candidate`, et
  les deux verrous ne sont ni retirés, ni renommés, ni emportés avec leur table.

La fonction de publication automatique viendra à l’étape 6, qui devra lever ces verrous explicitement.

- **Moteur** (`src/lib/information-agent/auto-publication-policy.ts`, module pur, version
  `auto_publication_v1` ; détecteurs de texte dans `auto-publication-text.ts`). Pour un fait candidat, il
  rend « aurait été publié » ou « relecture » avec toutes les raisons de refus. Il applique la règle
  ci-dessus et les conditions du compte-rendu du 10/11/2026 :
  - réponse par e-mail (ni portail, ni import manuel), expéditeur = adresse contactée, DKIM **et** DMARC à
    « pass », reçue moins de 30 jours après l’envoi du dossier ;
  - dossier adressé à l’avocat poursuivant (`recipient_kind = source_lawyer`, seul destinataire auquel la
    fiche attribue la valeur) et **toujours au statut `replied`** ;
  - aucun message entrant postérieur du même dossier en relecture, en cours de traitement, opposé ou qui
    demande de ne pas publier (motif « message postérieur ») ; aucune autre information en attente pour la
    même vente et le même champ avec une autre valeur (un « erratum : 48 m² » renvoie en relecture) ;
  - fait du corps du message lu par les règles (sans `evidence_asset_id`) ; un fait lu par l’IA seule dans le
    corps (pièce `email_body`) a son propre motif, distinct de « pièce jointe » ;
  - accord des règles et de l’IA v3 ou suivante, aucun autre candidat du même message pour la même clé ;
  - aucun motif de phrase ou de lot, réponse traitée sans motif de relecture ;
  - champ de la liste fermée, **vide** sur la fiche, valeur plausible pour le type de bien (bornes par type ;
    type inconnu : relecture). Pour la surface, « vide » suit la règle d’affichage de la fiche
    (`getRecordedSurface` : surface retenue, habitable, Carrez) et la surface de l’annonce : aucune de ces
    colonnes ne doit porter de valeur ;
  - dans l’objet **et** le corps : ni demande de ne pas publier, ni nom de particulier, ni consigne
    adressée à un modèle (voir « Limites des détecteurs de texte » ci-dessous) ;
  - pour la surface du terrain, « vide » suit aussi la règle d’affichage : un terrain nu dont la fiche
    affiche la surface retenue comme surface du terrain (`getDisplaySurface`, `app_surface_kind` ou
    `surface_scope` à « land ») n’a pas un terrain vide.

  **Limites des détecteurs de texte** (`auto-publication-text.ts`). Ce sont des motifs : ils ne peuvent pas
  être exhaustifs et ne sont qu’une première ligne. Avant tout mode automatique (étape 6), il faudra un
  signal de la lecture par l’IA (« la réponse demande-t-elle de ne pas publier ? ») et une famille « ne pas
  publier » dans le jeu d’évaluation (étape 4). Ce qu’ils voient aujourd’hui, en logique fermée (un faux
  positif ne coûte qu’une relecture) :
  - « ne pas publier » : négation proche d’une racine de publication ou de communication (publier,
    diffuser, divulguer, communiquer, partager, reprendre, reproduire, relayer, afficher, faire figurer,
    utiliser, share, disclose, post, publish, « en ligne », « rendre public », « faire état ») ; refus proche
    d’une de ces racines, sans négation (refuser, s’opposer, interdire, s’abstenir, retirer, embargo,
    secret, discrétion) ; « confidentiel », « confidential », « secret », « embargo », « discret » seuls ;
    « interne » seulement avec « usage », « strictement », « document », « note » ou « diffusion » ;
    « off the record », « pour votre information uniquement », « à votre usage », « strictement
    personnel », « gardez-la pour vous ». Lettres isolées (« N e p a s p u b l i e r »), césures
    (« pub-lier ») et chiffres à la place de lettres (« C0NFIDENTIEL ») sont recollés avant la recherche.
    Une mention de confidentialité ou de secret professionnel dans une signature d’avocat envoie donc la
    réponse en relecture : la simulation le mesurera ;
  - nom de particulier : civilité (casse indifférente, « M. », « M », « Mr », « Mme », « famille »,
    « époux »…) suivie d’un nom, y compris en minuscules après « M. », « Mme » ou une civilité en toutes
    lettres, et sans espace après le point (« M.Martin ») ; rôle (débiteur, saisi, locataire, occupant,
    propriétaire, vendeur) suivi d’un prénom et d’un nom en majuscule initiale (« le locataire Jean
    Dupont »). Exceptions : « Maître », « Me », « Madame, Monsieur, », « Monsieur le Président ». Une raison
    sociale de deux mots en majuscule initiale après « propriétaire » part en relecture, ce qui est
    acceptable ; un nom sans civilité ni rôle (« Jean Dupont » seul) n’est pas vu.

  **Échec fermé** : une donnée du fait absente ou illisible (message, messages postérieurs, dossier, vente,
  autres valeurs, pièce, métadonnées) donne « relecture », motif « données manquantes ou illisibles », et
  la lecture est signalée dans le journal serveur (`information_agent.auto_publication`). Chaque lecture
  demande le total exact (`count: "exact"`) : une lecture dont le total dépasse les lignes reçues (plafond
  `max-rows` de PostgREST, inconnu en production) est tronquée, donc illisible. Une lecture d’**état global**
  illisible ou tronquée (mode, liste des faits, dernières décisions, compteurs des plafonds) arrête la passe
  en échec **sans rien écrire** : écrire « relecture » pour tous les faits déferait le gel et gonflerait le
  journal.

- **Liste fermée** : surface (`surface_m2`), surface du terrain (`land_surface_m2`), nombre de pièces
  (`rooms_count`). Définie à un seul endroit (`AUTO_PUBLICATION_ELIGIBLE_FIELDS`) ; la contrainte du journal
  qui interdit « aurait été publié » pour tout autre champ est comparée à cette liste par un test. Les motifs
  sont eux aussi une liste fermée en base (`reasons <@ array[…]`), comparée à `AUTO_PUBLICATION_REASON_LABELS`
  par un test.
- **Plafonds**, appliqués dès la simulation (raison « plafond atteint ») : 10 informations par jour (heure
  de Paris, début du jour calculé au décalage de minuit, juste les jours de changement d’heure) et 2 par
  dossier. Un fait dont la dernière décision « aurait été publié » date d’un jour antérieur est traité comme
  publié ce jour-là : il sort du lot, il a compté dans le plafond de son jour, il compte dans celui de son
  dossier et son champ est rempli. Un champ déjà « rempli » en simulation par un autre fait de la même vente
  ne l’est pas une seconde fois. **La simulation ne fige un fait qu’à partir du lendemain** : un « aurait été
  publié » de 9 h peut repasser en « relecture » à 10 h le même jour (message postérieur, autre valeur),
  alors qu’en mode automatique il serait déjà publié. Les chiffres du jour sont donc un peu optimistes. **À faire à l’étape 6** : ces plafonds sont calculés en TypeScript à partir du
  journal ; avant le mode automatique, ils devront être tenus en base, de façon atomique, sous verrou (deux
  passes simultanées ne doivent jamais les dépasser).
- **Quand.** Seulement en mode « Simulation » : à chaque passe des réponses (`/api/cron/information-agent-inbound`,
  toutes les 2 minutes), après la file et le déclenchement de l’analyse. Le moteur lit les faits **en
  attente** d’un champ de la liste fermée reçus depuis 45 jours (500 au plus par passe), lit leurs dernières
  décisions en une requête, et n’appelle la RPC d’écriture que si l’issue, les motifs ou la version changent.
  L’écriture est bornée à 60 secondes par passe (statut `time_limit_reached` dans le résumé du cron, sans
  échec ; la suite attend la passe suivante) et s’arrête après trois échecs consécutifs du même code. Deux
  messages reçus à la même seconde sont départagés par leur date d’écriture puis leur identifiant.
  Les autres faits (hors liste, en conflit) s’affichent « relecture » sans écriture au journal. Un échec de la
  passe ne bloque pas la passe des réponses, mais fait échouer le cron (signalé dans la supervision des
  crons). En mode « Arrêt », rien n’est lu, calculé ni affiché.
- **Ordre de déploiement.** Le code peut partir avant la migration `20261115100000` : tant que la table des
  réglages n’existe pas, la passe rend `not_installed` dans le résumé du cron, sans échec ; l’onglet Réponses
  n’affiche rien. Toute autre erreur reste un échec.
- **Affichage.** Onglet Réponses : à côté de chaque information, « Simulation : aurait été publié, le
  JJ/MM/AAAA à HH:MM » ou « Simulation : relecture, le … (raisons en clair) », ou « décision pas encore
  calculée ». Une information déjà traitée garde sa dernière décision du journal quand elle en a une. Une lecture du journal
  impossible ou tronquée affiche « Simulation de la publication automatique indisponible ». Rien en mode
  arrêt.
- **Réglage** (onglet Réglages, panneau « Publication automatique des informations reçues ») : « Arrêt »,
  « Simulation », et « Automatique (verrouillé) », avec les conditions du déverrouillage : textes
  juridiques publiés, AIPD signée, validation des huit points par un avocat, jeu d’évaluation à zéro
  publication fausse, simulation concluante. Le mode automatique ne peut pas être enregistré : refus du
  serveur, refus de la RPC (`55000`) et contrainte `information_agent_auto_publication_settings_auto_locked`
  de la table (seule une migration de l’étape 6 pourra la retirer ; l’invariant de sécurité échoue sinon).
- **Changement de mode** : réservé à un administrateur (RPC `set_information_agent_auto_publication_mode`,
  jeton de l’administrateur, `is_admin` ; le rôle de service est refusé), tracé dans
  `information_agent_auto_publication_mode_changes` (qui, quand, ancien et nouveau mode, arrêt d’urgence ou
  non), en ajout seul. **À trancher à l’étape 5** : durée de conservation de l’identifiant de
  l’administrateur dans cette trace (aucune purge codée).
- **Arrêt d’urgence** : bouton « Arrêt d’urgence » (RPC `stop_information_agent_auto_publication`), un
  geste, toujours permis, sans motif, affiché même si la lecture du réglage échoue. Effet immédiat : la RPC
  d’écriture des décisions relit le mode sous verrou partagé et n’écrit plus rien dès que le mode n’est plus
  « simulation », même au milieu d’une passe.
- **Journal** `information_agent_auto_publication_decisions` : fait, dossier, vente, clé, issue, codes de
  motifs, version de la règle, date. Ni adresse, ni extrait, ni texte issu du message (motifs en liste fermée).
  Ajout seul (déclencheur : ni modification, ni suppression, ni vidage, même par le propriétaire), RLS sans
  politique, lecture par le serveur seulement, écriture par la seule RPC de service
  `record_information_agent_auto_publication_decision` (un fait ou une vente disparus depuis la lecture : rien
  n’est écrit, sans erreur). Il suit la vente (seule suppression admise). Migration `20261115100000`, tests
  pgTAP `880`.

## Jeu d’évaluation et essai réel du modèle (étape 4, 11/11/2026)

**À quoi il sert.** Mesurer, sans rien publier, ce que la chaîne entière (réception, règles, lecture par l’IA,
moteur) ferait de 215 réponses FICTIVES d’avocats, et tenir le seuil du déverrouillage : **zéro publication
fausse** (une valeur « aurait été publiée », par n’importe quel message du dossier, alors que la vérité dit
« ne doit pas être publié », ou publiée avec une autre valeur). Le jeu est dans
`services/data-pipeline/tests/fixtures/information_agent_evaluation/cases/` : 8 familles de 25 (réponses
nettes et contexte, réserves, lots, corrections, confusions de champs, « ne pas publier », manipulation,
particuliers et pièces jointes) et 15 compléments de la relecture. Chaque cas porte le message, le contexte
(type de bien, lots, fiche, destinataire, authentification, délai, messages antérieurs et postérieurs du
dossier) et la vérité pour la surface, le terrain et le nombre de pièces. 63 cas citent sous la réponse notre
demande actuelle en entier, telle que le gabarit du code la rend (`demande_actuelle.txt`, figé par un test :
un changement du gabarit le signale). Cette citation déclenche le détecteur « ne pas publier » (« Ne
communiquez que… », « secret professionnel ») : elle n’est posée que sur des cas publiables (trois sur quatre,
pour mesurer la perte de couverture) et sur les cas de la famille 6 déjà reconnus, jamais sur un piège
qu’elle masquerait. Tout est fictif (adresses en `.example`, test).

**Règles de vérité prudentes** (le propriétaire peut les assouplir ; les cas concernés sont comptés à part
dans le rapport, `decisions_proprietaire`) :

1. un message accompagné d’une pièce jointe autre que le corps est non publiable pour tous les champs ;
2. un particulier nommé dans le corps ou l’objet (débiteur, occupant, partie au dossier, y compris en
   capitales sans civilité, « BANQUE EXEMPLE c/ ROCHEVAL ») rend le message non publiable ;
3. un collaborateur du cabinet nommé en signature (assistante, secrétaire) aussi, tant que le propriétaire
   n’a pas tranché (`collaborateur_en_signature`) ;
4. des données de tiers sans nom (téléphone d’une occupante, loyer d’un couple) laissent la valeur publiable
   (`donnees_de_tiers_sans_nom`).

**Le banc, sans réseau ni modèle**, fait passer chaque dossier par la vraie chaîne en trois étapes reliées par
des fichiers (la chaîne est à cheval sur deux langages ; chaque langage vérifie que son fichier est à jour) :

1. réception et règles TypeScript (`src/lib/information-agent/evaluation/`, test Vitest), pour chaque message
   du dossier : relecture décidée à la réception (expéditeur, authentification, opposition possible, mauvais
   destinataire, consigne adressée à un modèle), opposition, réponse automatique, puis
   `extractInformationAgentFacts` et `persistFactCandidates` sur une base en mémoire → `stages/rules_stage.json` ;
2. worker Python (`services/data-pipeline/scripts/information_agent_evaluation.py`) : le vrai `_process_job`
   lit le corps de chaque message extrait puis les pièces jointes, avec une base simulée et un client de modèle
   de remplacement → `stages/worker_stage.<configuration>.json` ;
3. moteur (même test Vitest) : la vraie passe `runAutoPublicationSimulation` → `report.json`.

Configurations, toutes SIMULÉES (`modele_reel: false`, vérifié par test) tant qu’aucun essai réel n’est rejoué :

- **`regles_seules`** : IA désactivée ; rien ne doit être publiable (test de fermeture) ;
- **`modele_ideal`** : sortie égale à la vérité, citée en phrase entière (borne haute de la couverture) ;
- **`suiveur`** (pessimiste) : le modèle confirme chaque valeur lue par les règles, avec la ligne qui la
  contient. **C’est elle qui fait foi pour la sécurité** (`fait_foi: true`) tant qu’aucun essai réel complet
  n’est enregistré ;
- `enregistrement_<nom>` : sortie RÉELLE du modèle enregistrée par l’essai et rejouée à l’identique.

Le rapport donne chaque configuration dans deux états côte à côte : **`etat_attendu`** (le dossier
« replied » et le message traité sans motif, l’état que le moteur exige) et **`etat_reel`** (l’état que la
chaîne écrit vraiment : dossier et message en relecture dès qu’une réponse a un corps). Dans l’état réel,
le moteur ne publie **jamais** rien : c’est à corriger avant toute simulation utile en production.

**Seuil permanent** (test Vitest) : aucune publication fausse hors de `known_defects.json`, dans les deux
états et pour toute configuration ; chaque défaut connu doit rester observé. Un défaut connu est reconnu par
sa signature complète (configuration, état, cas, champ, valeur, message, provenance, motifs de la décision du
même fait dans l’état réel) : une nouvelle cause sur le même cas fait échouer le test. Résultats du
11/11/2026, état attendu : `regles_seules` 0 publication ; `modele_ideal` 57 publications dont 40 fausses,
couverture 17 sur 90 ; `suiveur` 58 publications dont 41 fausses, couverture 17 sur 90 ; toutes les fausses
sont des défauts connus (trous des règles et des détecteurs, groupés dans `known_defects.json`). Le mode
automatique reste verrouillé tant qu’ils ne sont pas corrigés.

**Bloqué pour la bonne raison.** Pour la configuration qui fait foi, le rapport (`blocage_suiveur`) dit, pour
chaque champ « ne doit pas être publié » qui n’est pas une publication fausse, quel motif l’a bloqué (motif du
moteur, décision de la réception, ou aucun fait proposé) et si ce motif correspond à la famille du piège
(« bonne raison ») ou non (« autre raison », liste nominative). Un test échoue si un piège dont la nature
n’est pas une demande de non-publication n’est bloqué QUE par le motif `do_not_publish_requested` venu de
notre propre demande citée : retirer la citation du cas, ou l’inscrire dans `pieges_non_eprouves` de
`known_defects.json` (liste visible et comptée). Au 11/11/2026 : 2 champs bloqués pour une autre raison
(F4-22, mauvais destinataire possible ; F9-05, citation trop courte), aucun par la seule demande citée
(4 avant la correction : F4-13, F4-24, F5-20, F5-25, devenus des défauts connus).

**Rejouer le banc** (après toute modification de la réception, des règles, du worker, du prompt ou du
moteur) :

```
npx vitest run src/lib/information-agent/evaluation -u      # étape 1 (rules_stage.json, demande citée)
cd services/data-pipeline && python -m scripts.information_agent_evaluation --write   # étape 2
cd ../.. && npx vitest run src/lib/information-agent/evaluation -u                  # étape 3 (report.json)
```

Sans `--write`, le script Python vérifie seulement que ses fichiers sont à jour (code 1 sinon) ; `pytest`
et `npm test` échouent aussi sur un fichier périmé. `-u` ne fait que réécrire les fichiers : il ne lève
jamais le seuil, qui est contrôlé à part.

**Essai réel du modèle (payant, manuel).** Workflow « Information Agent Evaluation Trial »
(`.github/workflows/information-agent-evaluation-trial.yml`) : Actions › Run workflow, branche `main`
seulement, champ `confirmation` = `ESSAI PAYANT 5 USD`, `budget_usd` (1 par défaut, 5 au plus),
`appels_max` (5 par défaut : pilote ; vide : essai complet), `reprise_run_id` (vide, ou l’identifiant d’une
exécution précédente à reprendre). Une seule exécution à la fois ; une relance par l’interface (« Re-run »)
est refusée : elle repaierait sans nouvelle confirmation. Il ne reçoit que `REPLICATE_API_TOKEN` (aucune clé
Supabase : aucune écriture en base, aucun email) et utilise les mêmes variables `REPLICATE_*` et `LLM_*` que
`information-agent-evidence.yml` (test de concordance ; `REPLICATE_MAX_CALLS_PER_HOUR` y est sans effet,
faute de base). Le script (`scripts/information_agent_evaluation_trial.py`) passe chaque pièce par le vrai
worker avec le vrai client Replicate (même prompt, `semantic_evidence_v3`, sortie plafonnée à 1 024 jetons,
un seul essai, échéance de 25 s) et enregistre pour chaque appel les jetons d’entrée et de sortie facturés,
la durée, l’identifiant et la version de la prédiction, et la sortie brute quand le JSON est invalide.

- **Plafond de dépense** : 5 USD en dur **par lancement** (et sur le fichier, reprises comprises). Avant
  chaque appel, son coût maximal est estimé (octets du prompt comme plafond des jetons d’entrée, 1 024 jetons
  de sortie, tarif de `TOKEN_PRICES` majoré de 25 %) et l’appel n’est pas fait s’il ferait dépasser le
  plafond. Après l’appel, la dépense retenue est le plus prudent de l’estimation et du coût réel calculé
  sur les jetons facturés ; l’essai s’arrête dès qu’elle dépasse. L’appel est inscrit avant d’être fait : un
  arrêt brutal laisse un fichier partiel exploitable et compte l’appel. Estimation du jeu complet : 203
  appels au plus, 0,51 USD au plus (`--estimate-only`, sans appel).
- **Procédure en quatre temps** :
  1. **pilote** (`appels_max` = 5, `budget_usd` = 1) : lire le résumé de l’exécution (`resume` du fichier :
     jetons facturés face à l’estimation, sortie au-delà de 1 024 jetons, durée face à l’échéance de 25 s).
     Ne continuer que si le pilote ne montre aucun dépassement ;
  2. **essai complet** : `appels_max` vide, `reprise_run_id` = l’exécution du pilote ;
  3. **deux répétitions** (nouveaux lancements sans reprise) pour mesurer la variance du modèle ;
  4. **nouvel essai après tout changement du prompt**, du modèle ou de ses réglages.
- **Reprise** : une pièce réussie n’est jamais rappelée ; une pièce en erreur ou interrompue est rejouée,
  et chaque tentative compte dans la dépense.
- **Ce qui invalide une sortie enregistrée** : un autre prompt système, une autre version de lecture, un
  autre modèle (la reprise est refusée), ou un autre texte de pièce (le banc refuse de rejouer une sortie dont
  l’empreinte du prompt utilisateur diffère : changement du jeu, de la réception ou du nettoyage du corps).
- **Lire le résultat** : télécharger l’artefact `information-agent-evaluation-trial` (`essai.json`), le copier
  sous `services/data-pipeline/tests/fixtures/information_agent_evaluation/model_outputs/<nom>.json`, rejouer
  les étapes 2 et 3, puis lire `report.json` (configuration `enregistrement_<nom>`). Un essai avec un cas non
  joué, une pièce en erreur, interrompue ou non appelée sans consigne repérée affiche **« essai incomplet »**
  et aucun chiffre de sécurité. Pour un essai complet, le test exige zéro publication fausse : aucun défaut
  connu ne peut l’excuser. Une publication fausse se corrige dans la chaîne, après validation, puis l’essai est
  rejoué.

**Limites.** Pièces jointes en texte (`.txt`), pas en PDF. Le modèle idéal ne rend rien pour les messages
voisins du dossier. L’état réel du dossier est reconstitué (relecture dès qu’un corps existe) faute de
fonction exportée.

## Contenu de l’e-mail

- Signature : « L’équipe Immojudis », ou « Prénom Nom / Pour l’équipe Immojudis » quand `INFORMATION_AGENT_SIGNATURE_NAME` est renseignée (modifiable dans le brouillon).
- Objet qui permet de reconnaître le dossier avant d’ouvrir : bien, ville et date (« Appartement T3 à Bordeaux, audience du 14/11/2026 : vérification de l’annonce » ; « date à confirmer » sans date sûre). Aperçu de la messagerie : « Quelques points sur une annonce ; répondre est facultatif. ». Expéditeur affiché : « Immojudis » (comme la marque), adresse `enquete@reponses.immojudis.com`. Formule d’appel nominative, sans la fonction imprimée par l’annonce (« Maître X, Avocat » → « Maître X »), ou neutre.
- Une phrase d’identité factuelle, sans promotion : « Immojudis est un site privé d’information sur les ventes immobilières aux enchères, destiné aux candidats acquéreurs. Il ne vend aucun bien et n’agit pas au nom d’un tribunal. » Ni slogan, ni lien vers le site (gabarit HTML `information_request_v12`, modèle éditable « version 10 », révision 9 ; ces trois numéros désignent des objets différents et ne sont pas alignés : le modèle publié en base ne se renumérote pas sans migration ; seuil de conformité des modèles publiés : révision 7). Bloc de la vente mis en forme : « Vente concernée » (titre, adresse, tribunal), date annoncée (« Audience annoncée » pour une vente judiciaire, « Date de vente annoncée » sinon) et mise à prix annoncée, chacune omise si elle manque ou se contredit. Questions, puis « Répondre est facultatif » et le lien de dépôt, avant la réserve de secret professionnel (le message ne demande que ce qui est communicable à tout candidat acquéreur) et la signature.
- Forme de courrier : le message s’ouvre sur la formule d’appel (« Bonjour Maître X, » ou « Madame, Monsieur, »), sans bandeau ni titre de dossier. Ordre : formule d’appel, présentation d’Immojudis, origine de l’adresse (avocat seulement : le greffe ne la répète pas, elle figure dans « Vos données »), phrase qui annonce la vente et bloc de la vente, questions, consignes de réponse et lien de dépôt, réserve de secret professionnel, « Bien cordialement, » et signature « L’équipe Immojudis ». La référence de suivi, l’adresse de réponse et le pied juridique viennent après la carte. Les textes juridiques ne changent pas d’un mot : seuls leur place et leur mise en page ont changé (test `emails/information-request.test.tsx`). Le cadre (logo PNG, carte, mode sombre) est celui de tous les emails (`src/lib/email-layout.ts`) ; le logo n’est pas cliquable et la ligne de marque ne porte aucun lien, la garde commerciale refusant tout lien vers la page d’accueil.
- Origine de l’adresse (phrase reprise mot pour mot de l’ancien « Pourquoi vous ? ») : elle suit le **type de source** enregistré, avec le lien exact et la date de consultation. Annonce : « figure dans l’annonce publique de cette vente sur Licitor (lien), consultée le JJ/MM/AAAA » ; autre annonce du professionnel ; fiche de l’annuaire officiel nommé ; site du cabinet ; saisie d’un administrateur (« relevée par un membre de l’équipe Immojudis sur une page publique (lien), le JJ/MM/AAAA »). Une adresse d’annuaire n’est donc jamais présentée comme figurant dans l’annonce.
- Lien privé de dépôt sans compte, juste après les consignes de réponse, domaine nommé.
- Aucune invitation à créer un compte professionnel ni aucune sollicitation commerciale (décision du 13 octobre 2026, confirmée par l’audit du 22/10 : `docs/audits/2026-10-22-agent-information.md`) : le message reste purement informatif. L’invitation à déposer ses prochaines ventes est montrée **seulement sur l’écran qui suit un dépôt volontaire** sur `/contribuer`, jamais après une opposition (l’API de dépôt renvoie `opposed`), sans « gratuit », « visibilité » ni « mise en avant » ; lien vers `/login?mode=professional&redirect=/publish`. Elle est **désactivée par défaut** : seule la valeur exacte `NEXT_PUBLIC_INFORMATION_AGENT_PRO_INVITATION=true` l'affiche (variable publique, prise en compte au déploiement suivant). L’ancien bloc « Vous avez d’autres ventes à partager ? » est retiré s’il figure encore dans un modèle éditable. Un contrôle automatique (`src/lib/information-agent-commercial-guard.ts`) refuse offres, comptes, inscription, « mise en avant », partenariat, mise en relation, gratuité, prix d’Immojudis et tout lien hors politique de confidentialité, dépôt privé, opposition, plainte CNIL et page source de l’adresse (le vocabulaire de la vente — mise à prix, offre d’achat, émoluments, inscription hypothécaire… — reste permis ; la référence de la vente tirée de l’annonce est écartée de l’analyse) : il s’applique au gabarit par défaut (test), à l’aperçu (motif bloquant) et à l’envoi.
- Pied RGPD (art. 14) complet, lisible (13 px, gris foncé, dans un encadré) : pourquoi ce message (finalité, base, rythme d'au plus un message par période de 30 jours et aucune relance, responsable de traitement ; **variante « greffe »** pour un message à un greffe : au plus un message par vente et, par tribunal, au plus N messages par jour, N étant le plafond réellement configuré, jamais écrit en dur), catégories de données et origine de l’adresse, mention de la recherche automatique quand l’adresse a été retrouvée par l’outil (autre annonce du professionnel, site du cabinet), destinataires et prestataires (Vercel et Supabase pour l'hébergement, Resend pour l'envoi et la réception des courriels, GitHub pour l'exécution des traitements automatisés, prestataire d’IA nommé d’après `LLM_PROVIDER`), transferts hors UE sans mécanisme affirmé (le destinataire peut demander la garantie applicable), durées de conservation (12 mois si le destinataire ne répond pas, 24 mois après le dernier échange s'il répond), droits exercés sans compte à l'adresse de contact, bloc « Opposition » distinct (lien « Ne plus être contacté », suppression des données qui ne servent qu'à contacter, échanges déjà intervenus conservés jusqu'à la fin de leur durée normale, seule l'information strictement nécessaire pour ne plus solliciter conservée au-delà) et réclamation auprès de la CNIL. L'adresse de contact (`NEXT_PUBLIC_LEGAL_CONTACT_EMAIL`) est obligatoire : sans elle, l'envoi est refusé.
- En-têtes `List-Unsubscribe` et `List-Unsubscribe-Post` (désinscription en un clic de la messagerie, RFC 8058).

### Recherche automatique de l'adresse (niveau 1)

**(si l'interrupteur est activé)** `INFORMATION_AGENT_ADDRESS_SEARCH_ENABLED=true`, uniquement sur le site de production (`https://immojudis.com` ou `https://www.immojudis.com`, origine comparée exactement) : sinon la recherche est coupée, aucune annonce n'est lue et aucun site n'est consulté, et l'administrateur saisit l'adresse et la page publique où il l'a relevée. Une adresse retrouvée par l'agent (autre annonce, site du cabinet) ne peut alors ni passer l'aperçu ni être envoyée (motifs « La recherche automatique d’adresse est désactivée »).

Quand l'annonce ne donne aucune adresse sollicitable (ni adresse saisie par l'administrateur), la préparation du brouillon (`createAdminInformationAgentDraft`, route admin, budget de 15 s dans le délai de 28 s des routes admin) tente deux sources, dans cet ordre. L'agent trouve et prépare : il n'envoie jamais seul. **L'administrateur ouvre la page source** (lien « Ouvrir la page source » de l'encadré « Adresse retrouvée automatiquement » dans l'aperçu) avant « Valider et envoyer », pour voir ce que la page dit (CGU, balise `meta robots`, identité de la personne) que l'outil ne lit pas.

1. **Autre annonce du même professionnel** (`other_listing`, `address-reuse.ts`) : même identité (ensembles de jetons du nom **égaux**, titres et formes sociales ôtés, normalisés comme `identity.ts` : « Jean Dupont » n'est pas « Jean-Louis Dupont ») **et** même téléphone normalisé (télécopies exclues) ; sans téléphone des deux côtés ou sans nom complet, pas de réemploi. La partie locale de l'adresse doit rappeler le nom et le prénom (segments entiers) ou être générique (`contact@`, `cabinet@`…). L'annonce d'origine date de moins de 6 mois (la plus récente de la date de vente et de la dernière observation ; une vente à venir est récente), n'est pas en quarantaine, ni sur un hôte exclu. Deux adresses différentes parmi les annonces concordantes, ou une lecture tronquée à 200 annonces (journal `rows_truncated`) : rien n'est retenu. La source enregistrée est l'URL de l'annonce d'origine.
2. **Site du cabinet ou de l'étude** (`firm_website`, `firm-site-search.ts`) : URL de départ tirée uniquement de l'annonce (`lawyer_contact`, blocs source `cabinet_site`, `website`, `contact_avocat`) ; jamais un moteur de recherche. Au plus 2 sites, 3 pages par domaine (la page de départ, puis contact, mentions légales ou présentation du cabinet par les liens internes du même domaine) et 8 requêtes (robots.txt et redirections comprises), GET en HTTPS uniquement, `robots.txt` lu d'abord (page interdite, fichier illisible ou démesuré, 5xx ou redirection hors domaine : aucune collecte ; 404 : rien d'interdit), jeton `ImmojudisAdresses`, expiration de 5 s par requête, pause entre requêtes, arrêt sur 401, 403, 429, 5xx, captcha ou défi anti-robot, contenu décompressé plafonné à 1 Mio, aucune requête hors du domaine de départ (redirections comprises). La résolution DNS est faite **à la connexion** (`https.request` avec `lookup` contrôlé) : une adresse non publique (IPv4 privée ou réservée, IPv6 hors `2000::/3`, formes IPv4-mappées) est refusée et la connexion part vers l'adresse contrôlée. Aucune copie de page n'est conservée : seuls l'adresse retenue, l'URL de la page et la date le sont.
   Extraction : adresses en clair (`mailto:` ou texte) ; sur les sites de cabinet, les adresses masquées par Cloudflare ne sont jamais décodées. Seules les adresses du domaine exact du site (ou d'un sous-domaine) comptent : jamais le domaine parent (hébergeurs de sites), jamais une messagerie grand public. Plusieurs adresses : celle qui porte le nom et le prénom de l'avocat (segments entiers, `luc` n'est pas `lucie`), sinon l'unique `contact@`, `cabinet@` (ou assimilée) ; une adresse unique non générique exige le nom et le prénom ; tout autre cas est une ambiguïté et rien n'est retenu. La lecture ne s'arrête après la page de départ que sur une correspondance forte (nom et prénom) ; une adresse générique est confirmée par la page de contact ou de mentions légales.

Gardes communes : sans clé d'identité (nom complet et lieu de la vente), ni A ni B ; l'opposition par identité est contrôlée **avant** toute lecture d'annonce ou requête réseau (tous les rôles, faute de rôle sûr) ; l'adresse trouvée est écartée si elle est exclue (juridiction, RPVA, Ordre, CARPA, `noreply`, `dpo`, `rgpd`), opposée par adresse ou par identité (nom imprimé par l'annonce d'origine compris), ou déjà sollicitée dans les 30 derniers jours (le brouillon n'est alors pas créé ; une adresse en rebond permanent est seulement écartée). Une erreur de contrôle écarte l'adresse et le message le dit. L'adresse retenue n'est enregistrée dans `information_agent_contacts` (`source_kind`, URL exacte, `observed_at`, `observed_by = agent`, règle d'appariement et score dans `metadata`) qu'une fois les contrôles passés **et** le brouillon créé ; elle est donc purgée au plus tard 28 jours après (purge hebdomadaire, seuil de 21 jours) si aucune demande ne l'utilise. La mission garde la trace des tentatives (`metadata.address_search` : source, résultat, domaine, nombre de pages, jamais le contenu). Le libellé d'origine du message et la mention de la recherche automatique du pied suivent le type de source ; une adresse générique du cabinet est présentée comme « l'adresse de contact de votre cabinet ».

Contrôles à l'aperçu et à l'envoi : seul l'interrupteur est contrôlé (l'origine de production ne l'est qu'à la recherche, l'adresse étant alors déjà trouvée) ; un brouillon dont `metadata.contact_discovery.method` commence par `agent_search_` exige la ligne de registre de l'agent pour son adresse et ignore toute URL d'origine saisie à la main ou toute saisie d'administrateur (motif bloquant ; destinataire modifié par l'administrateur : voie ordinaire). Si l'enregistrement de l'adresse échoue après la création du brouillon, celui-ci est annulé (« L’adresse retrouvée n’a pas pu être enregistrée… »).

Réseau : le contrôle d'adresse repose sur la **résolution DNS locale** du serveur (`lookup` de `https.request`, adresse IP littérale refusée, famille demandée respectée, plages privées, réservées et de documentation refusées). **N'activez ni `NODE_USE_ENV_PROXY` ni un proxy HTTP(S) sortant en production** : un proxy résoudrait le nom lui-même et ferait perdre ce contrôle.

Limites connues : seule la colonne `lawyer_contact` des autres annonces est lue pour la source 1 (pas leurs blocs source) ; pas de journal de consultation distinct (la trace par mission en tient lieu) ; le user-agent pointe vers `/contact` et **doit pointer vers `/agent-information`** quand cette page sera publiée (`docs/agent-information-brouillon.md`) : c'est une condition d'activation ; la politique de confidentialité et l'analyse de seuil d'AIPD restent à faire valider par un avocat.

### Greffe de secours (vente au tribunal sans avocat)

Ajout du 01/11/2026, décision du propriétaire. Pour une vente au tribunal (saisie immobilière ou autre vente judiciaire
confirmée par l'annonce, jamais notaires, cessions de l'État ni AGRASC) qui n'a **aucun** destinataire avocat ou cabinet
exploitable (ni dans l'annonce ou le registre, ni retrouvé par la recherche, aucune adresse saisie, aucun professionnel opposé
par identité), le brouillon est adressé au greffe de SON tribunal, avec l'adresse du référentiel `court_registry_contacts`
(fichier `docs/reference/tribunaux-judiciaires-emails-2026-11-01.md`). Une vente sans tribunal reconnu, ou dont le tribunal n'a
pas d'adresse, ou dont l'adresse est refusée (opposition, rebond), n'a pas de brouillon au greffe.

- **Origine distincte** : `source_kind = court_registry_fallback` au registre des contacts ; `metadata.address_origin`,
  `metadata.court_registry_fallback` (`court_code`, `court_name`) et `metadata.contact_discovery.method` de la mission ;
  `address_origin`, `court_code` et `court_name` dans `information_agent_messages.metadata` ; `recipientOrigin` dans les
  missions de l'API d'administration. L'aperçu cite l'origine : « adresse de contact de votre juridiction, issue du référentiel
  des tribunaux tenu par Immojudis… » et porte un repère « Greffe » (`addressOrigin.courtRegistry`). Ce n'est ni une recherche
  automatique ni une page consultée : l'interrupteur de recherche n'est pas concerné.
- **L'exclusion `court` reste en vigueur** pour toute autre adresse de juridiction (lue dans l'annonce, saisie à la main,
  adresse du référentiel modifiée) ; RPVA, Ordre, CARPA et adresses techniques restent exclus. L'adresse est revérifiée dans le
  référentiel à l'aperçu et à l'envoi, et **la vente est relue** (tribunal inchangé, toujours une vente au tribunal reconnue,
  sans `tribunal_inconsistent`, toujours aucun email d'avocat exploitable) : sinon l'aperçu et l'envoi sont refusés.
- **Message adapté** (`src/lib/information-agent/court-registry-template.ts`) : « Madame, Monsieur, », une seule question :
  « Pouvez-vous nous indiquer l’avocat poursuivant de cette vente ou, à défaut, où et selon quelles modalités un candidat
  acquéreur peut consulter le cahier des conditions de vente ? » (objet : « … : avocat poursuivant et consultation du
  cahier »). Aucune des questions posées à un avocat, aucun nom de personne (jamais de nom de greffier dans un champ
  structuré). Le modèle n'est pas éditable dans l'administration.
- **Gardes ordinaires conservées** : envoi désactivé et canari, opposition, rebond permanent, aperçu obligatoire, une validation
  humaine par message, un seul message par adresse et par vente. **Le délai de 30 jours par adresse est levé pour les greffes
  seulement** (décision du propriétaire du 01/11/2026, paramètre `courtRegistryFallback` de
  `assertInformationAgentRecipientCooldown`, passé pour la seule origine `court_registry_fallback`) : les avocats et les autres
  professionnels le gardent. Le pied et la politique de confidentialité annoncent la vraie fréquence (une fois par vente, plafond
  quotidien par tribunal).
- **Limites propres aux greffes** : une sollicitation par tribunal et par vente, et un plafond par tribunal et par jour (heure
  de Paris), `INFORMATION_AGENT_COURT_REGISTRY_DAILY_CAP` (défaut 3, `0` : aucune demande aux greffes). Contrôlées à la création
  du brouillon, à l'aperçu, avant l'envoi et après l'approbation (la plus ancienne approbation passe).

### Source des adresses, conservation et opposition par identité

- **Source typée.** Chaque adresse retenue porte dans `information_agent_contacts` : `source_kind` (annonce de la vente, autre annonce du professionnel, site du cabinet, annuaire officiel avec son nom dans `source_directory_name`, saisie d'administrateur), l'URL exacte, `observed_at` (date de relevé) et l'auteur (`observed_by` : agent ou administrateur). Une adresse saisie à la main est enregistrée à l'envoi avec la page publique indiquée et la date de création du brouillon.
- **Purge** (`purge_information_agent_data`, appelée par `run_data_retention`, cron hebdomadaire) : la purge est hebdomadaire et le seuil de 21 jours : une adresse non utilisée est supprimée au plus tard 28 jours après son dernier relevé. Demande jamais envoyée (brouillon, annulée, approuvée ou en cours d'envoi sans suite, échec sans identifiant du fournisseur, dossier partagé `subscribed` sans envoi) : 21 jours après sa création ; envoyée sans réponse : 12 mois après l'envoi (un échec avec identifiant du fournisseur, donc accepté par Resend, compte comme envoyé ; un dossier `subscribed` suit l'envoi du dossier partagé) ; avec réponse : 24 mois après le dernier échange (date du dernier message, pas `updated_at`). Une adresse du registre qu'aucune demande ne vise est supprimée au plus tard 28 jours après son dernier relevé (seuil de 21 jours, purge hebdomadaire) ; La purge teste la présence d’une demande par adresse, toutes ventes confondues : une adresse déjà utilisée pour un envoi garde ses lignes d’autres ventes tant que la demande est conservée. un rebond permanent au bout de 12 mois. Les lignes d'opposition et la liste d'opposition par identité ne sont jamais purgées. La table `information_agent_cases` (adresse et nom du destinataire du dossier partagé) n’est pas purgée par cette fonction : elle disparaît en cascade avec la vente (en principe 24 heures après la vente), donc parfois avant, parfois après les durées de la demande, et une opposition ne la vide pas. **Suite à prévoir : purge dédiée** des dossiers dont plus aucune demande ne subsiste ou dont les durées de 12 et 24 mois sont échues, et vidage du destinataire à l’opposition.
- **Opposition par identité.** En plus de l'adresse, une clé d'identité normalisée (rôle, nom complet d'au moins deux jetons hors titres et formes sociales, barreau ou ville, ou SIREN quand il est connu) est enregistrée avec l'adresse et la demande. Toute opposition par adresse (lien, réponse, STOP, dépôt, réponse consignée) alimente `information_agent_identity_oppositions` avec les clés connues pour cette adresse, vide la ligne d'opposition (nom, source, provenance, métadonnées : ne restent que l'adresse normalisée, les clés et la date) et supprime les autres lignes du registre et les demandes jamais envoyées à cette adresse ; les demandes déjà envoyées suivent leurs durées normales. Le traitement des clés ne peut pas faire échouer l'opposition (64 clés au plus, clés de 3 à 400 caractères en minuscules). La clé est vérifiée avant de retenir une adresse (création du brouillon), à l'aperçu, avant et pendant l'envoi, et en base (`information_agent_missions_contact_guard`). Limites : sans nom complet exploitable ni barreau ou ville, seule l'opposition par adresse s'applique ; une opposition reçue après la purge des demandes et lignes qui portent l'identité ne peut plus être rattachée à une identité ; les oppositions antérieures à la migration `20261023120000` n'ont pas de clés ; un avocat qui postule dans un autre barreau que celui de la vente n'est reconnu que pour Paris, Bobigny, Créteil et Nanterre (multipostulation). Suite possible, non faite : remplacer l'adresse normalisée de la liste par un hachage HMAC.
- **Recherche automatisée d'adresse (niveau 1).** Codée, désactivée par défaut (`INFORMATION_AGENT_ADDRESS_SEARCH_ENABLED`). Elle ne peut être activée qu'après : validation de la mise en balance et de l'analyse de seuil d'AIPD, publication de `/agent-information`, mise à jour de la politique de confidentialité, user-agent pointant vers `/agent-information`.
- **Procédure : opposition reçue en réponse et non reconnue automatiquement** : dans Admin › Agent IA, réponses reçues, bouton « Enregistrer une opposition » sur la réponse. L’opposition vaut pour l’adresse sollicitée et pour l’expéditeur s’il est différent, et la réponse sort de la file. « Marquer comme traitée » retire une réponse de la file sans rien enregistrer d’autre.
- **Procédure : opposition reçue hors lien et hors réponse** (courrier, téléphone, adresse inconnue du dossier). Traitée dans le mois suivant sa réception, par un administrateur avec accès `service_role` : `insert into public.information_agent_contacts (email, opposition_status, opposed_at) values ('<adresse>', 'opposed', now());` (le déclencheur rattache les clés d'identité connues, vide la ligne et alimente la liste par identité). Sans adresse connue (opposition d'une personne identifiée par son seul nom), insérer la clé d'identité à la main : `insert into public.information_agent_identity_oppositions (identity_key) values ('lawyer|<barreau>|<nom prénom en minuscules, jetons triés>');`.
- **Procédure : levée d'une opposition** (demande écrite de la personne). Dans cet ordre, en `service_role` : `delete from public.information_agent_identity_oppositions where identity_key = any(array['<clé>']);` puis `update public.information_agent_contacts set opposition_status = 'none', opposed_at = null where normalized_email = '<adresse>' and scope_sale_id is null;`. L'ordre compte : tant qu'une clé reste dans la liste, le déclencheur remet la ligne en opposition. Conserver la demande écrite.
- **Modèle de message publié en base.** Le code n'utilise un modèle publié que si sa révision est au moins `MIN_COMPLIANT_TEMPLATE_REVISION` (7) ; sinon il retombe sur le modèle du code, sans rien écrire en base (l'ancien modèle publié le 04/10, révision 4, contenait la présentation d'Immojudis et le mot « compte »). L'éditeur (Admin › Agent IA) l'indique et édite alors le modèle du code. Pour personnaliser le texte, enregistrer un brouillon puis le republier depuis l'éditeur : la publication refuse toute mention commerciale. La migration `20261023120000` fait avancer la séquence des révisions pour que tout modèle publié ensuite soit pris en compte.

### Désinscription

`GET /api/information-agent/opt-out?e=…&t=…` affiche une page de confirmation et n’écrit rien (les passerelles qui ouvrent les liens pour les analyser ne désinscrivent personne). `POST` sur la même adresse (bouton de la page ou messagerie en un clic) enregistre l’opposition globale dans `information_agent_contacts`. Le jeton est un HMAC de l’adresse, sans expiration.

## Garanties « aucun envoi automatique »

| Contrôle                                                                                                                                                                                            | Où                                                                                                                  | Test qui le verrouille                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Un seul appel au fournisseur pour l’agent, dans `approveAndSendMission`, après l’empreinte d’aperçu et la revérification de l’opposition                                                            | `src/lib/information-agent/send.ts`                                                                                 | `src/lib/information-agent-no-automatic-send.test.ts`                                |
| `approveAndSendMission` n’est appelé que par l’action admin `approve_and_send` (route `PATCH /api/admin/information-agent/missions`, administrateur, confirmation explicite)                        | idem                                                                                                                | idem, `missions/route.test.ts`                                                       |
| Crons, webhooks, traitement des réponses et portail n’importent ni le module d’envoi ni le fournisseur (exception nommée : la route du pilote, qui importe le seul module du pilote)                | `src/app/api/cron/**`, `src/app/api/webhooks/**`, `information-agent-inbound*`, `information-agent-contribution.ts` | `information-agent-no-automatic-send.test.ts`                                        |
| Aucune relance : aucun message `followup` n’est créé ; les colonnes héritées `followup_count` / `last_followup_at` ne sont jamais alimentées                                                        | code TypeScript et Python                                                                                           | idem                                                                                 |
| pg_cron : deux tâches pour l’agent : `immojudis-information-agent-inbound` (lecture des réponses) et `immojudis-information-agent-autopilot` (pilote, appel seulement si le mode n’est pas « off ») | migrations                                                                                                          | idem (et relevé de production du 11 octobre : 6 tâches, aucune autre liée à l’agent) |
| Aucune tâche Vercel, aucun workflow GitHub ni code Python n’envoie pour l’agent ; le workflow `information-agent-evidence` n’a pas de secret d’envoi                                                | `vercel.json`, `.github/workflows`, `services/data-pipeline`                                                        | idem                                                                                 |
| Un envoi sans aperçu, ou modifié après l’aperçu, est refusé avant toute écriture                                                                                                                    | serveur                                                                                                             | `information-agent-preview.test.ts`, `missions/route.test.ts`                        |
| Un contact désinscrit n’est jamais sollicité, même avec un aperçu valide                                                                                                                            | serveur et base                                                                                                     | `information-agent-preview.test.ts`, `information-agent.test.ts`                     |
| Le bouton d’envoi reste grisé sans aperçu à jour ou avec un motif bloquant                                                                                                                          | interface                                                                                                           | `AdminInformationAgentMissionsPanel.test.tsx`, `e2e/admin-information-agent.spec.ts` |

## Variables d’environnement

| Variable                                                                                               | Rôle                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INFORMATION_AGENT_OUTBOUND_ENABLED`                                                                   | `true` autorise l’envoi manuel de tout l’agent (production : `true` depuis le 02/11/2026) ; `false` le bloque, après redéploiement (voir « Piloter le pilote »).                                                                                                                                                                                                                                                                        |
| `INFORMATION_AGENT_OUTBOUND_CANARY_ONLY`                                                               | Tant qu’elle n’est pas `false`, seul `delivered@resend.dev` peut être destinataire.                                                                                                                                                                                                                                                                                                                                                     |
| `INFORMATION_AGENT_EMAIL_FROM`, `RESEND_API_KEY`, `INFORMATION_AGENT_INBOUND_DOMAIN`                   | Expéditeur (« Immojudis <enquete@reponses.immojudis.com> », domaine déjà vérifié en envoi et en réception, distinct des emails de compte), clé, domaine de réception.                                                                                                                                                                                                                                                                   |
| `INFORMATION_AGENT_ADDRESS_SEARCH_ENABLED`                                                             | `true` autorise la recherche automatique d’adresse (autre annonce, site du cabinet). Absente ou différente de `true` : recherche coupée. Ne passer à `true` qu’après les conditions de la section « Recherche automatique de l'adresse (niveau 1) ».                                                                                                                                                                                    |
| `INFORMATION_AGENT_NOTARY_SEND_ENABLED`                                                                | `true` ouvre l’approbation et l’envoi aux notaires et sur les ventes notariales. Absente ou différente de `true` : fermé (le brouillon et la mesure à blanc restent possibles). Ne passer à `true` qu’après l’autorisation sur la réutilisation des annonces notariales.                                                                                                                                                                |
| `INFORMATION_AGENT_SIGNATURE_NAME`                                                                     | Personne qui signe les demandes (« Prénom Nom, fonction »). Vide : « L’équipe Immojudis ».                                                                                                                                                                                                                                                                                                                                              |
| `INFORMATION_AGENT_COURT_REGISTRY_DAILY_CAP`                                                           | Plafond de demandes aux greffes par tribunal et par jour (greffe de secours). Entier de 0 à 100 ; `0` : aucune demande aux greffes ; absente ou illisible : 3.                                                                                                                                                                                                                                                                          |
| `NEXT_PUBLIC_INFORMATION_AGENT_PRO_INVITATION`                                                         | `true` affiche l’invitation au dépôt direct de l’écran de fin de dépôt (`/contribuer`) ; absente ou toute autre valeur : désactivée.                                                                                                                                                                                                                                                                                                    |
| `RESEND_WEBHOOK_SECRET`                                                                                | Secret de signature (`whsec_…`) du webhook Resend `email.received`, appelé sur `/api/webhooks/resend/information-agent` : la signature est vérifiée avant tout enregistrement, et la réception échoue sans lui. Variable sensible de Vercel Production. En production, le build s'arrête si `INFORMATION_AGENT_INBOUND_DOMAIN` est renseigné et que ce secret manque ou n'a pas la forme `whsec_…` (`scripts/verify-required-env.mjs`). |
| `INFORMATION_AGENT_PORTAL_SECRET`                                                                      | ≥ 32 octets ; signe le lien de dépôt, le lien d’opposition et l’empreinte d’aperçu.                                                                                                                                                                                                                                                                                                                                                     |
| `NEXT_PUBLIC_LEGAL_ENTITY_NAME`, `NEXT_PUBLIC_LEGAL_ENTITY_ADDRESS`, `NEXT_PUBLIC_LEGAL_CONTACT_EMAIL` | Responsable de traitement du pied RGPD ; sans nom, adresse et adresse de contact, l’envoi est refusé (le contact sert à exercer ses droits sans compte).                                                                                                                                                                                                                                                                                |

## Avant le premier envoi réel

1. Faire valider le gabarit complet (aperçu) par un juriste : le message ne contient aucune invitation à créer un compte ni aucune mention commerciale, la phrase d’identité des révisions 8 à 10 reste factuelle, et le pied art. 14 est complet. Faire valider aussi l’invitation de l’écran de fin de dépôt (`/contribuer`) (`docs/audits/2026-10-22-agent-information.md`, « Inciter les professionnels »). Traiter les points 1 à 6 du « Reste à faire » de cet audit. Si un modèle publié (éditeur de gabarit) contient encore l'ancienne présentation d'Immojudis, il est de toute façon ignoré tant que sa révision est inférieure à 7 (voir la puce « Modèle de message publié en base » de la section « Source des adresses, conservation et opposition par identité »).
   Faire valider le test de mise en balance (`docs/rgpd-mise-en-balance-agent-information.md`) et les durées de conservation annoncées (28 jours au plus après la dernière consultation de l’annonce pour une adresse non utilisée, 12 mois, 24 mois). Vérifier le mécanisme de transfert et le contrat de sous-traitance de chaque prestataire nommé dans le pied (Resend, Supabase, Vercel, Replicate, GitHub).
2. Vérifier l’authentification du domaine d’envoi `reponses.immojudis.com` (SPF, DKIM, DMARC) et renseigner `INFORMATION_AGENT_EMAIL_FROM="Immojudis <enquete@reponses.immojudis.com>"`. Cette adresse doit rester différente de celle des emails de compte (`compte@immojudis.com`, `alertes@immojudis.com`) : le webhook de l’agent ne retient un rebond ou une plainte que si l’expéditeur est exactement cette adresse (`delivery-events.ts`), ce qui garantit qu’un rebond d’un email de confirmation d’inscription ne finit jamais dans le registre de contacts de l’agent. Tant que l’ancienne valeur `assistant@immojudis.com` est en production et que les emails d’authentification en partent aussi, ne pas abonner le webhook de l’agent aux évènements `email.bounced` et `email.complained` avant d’avoir changé l’une des deux adresses (voir `docs/runbooks/emails-authentification.md`).
   Cette adresse n’a plus de repli : sans `INFORMATION_AGENT_EMAIL_FROM`, l’aperçu et l’envoi sont bloqués. Dans Resend, abonner le webhook existant (`/api/webhooks/resend/information-agent`, secret `RESEND_WEBHOOK_SECRET`) aussi aux évènements `email.bounced` et `email.complained` : un rebond définitif écrit `bounce_status = permanent` sur l’adresse (jamais plus sollicitée), un rebond passager `temporary`, une plainte vaut opposition. Seuls les emails envoyés depuis `INFORMATION_AGENT_EMAIL_FROM` sont pris en compte.
3. Vérifier `INFORMATION_AGENT_PORTAL_SECRET` et l’identité légale en production.
4. Passer `INFORMATION_AGENT_OUTBOUND_ENABLED=true`, puis `INFORMATION_AGENT_OUTBOUND_CANARY_ONLY=false` seulement après un envoi de contrôle à une adresse interne.
5. Envoyer une première demande, vérifier la réception de la réponse (webhook, file, revue) et le lien d’opposition.

## Limites connues

- Licitor : le parseur décode, à la collecte, les adresses email masquées (protection Cloudflare) des blocs avocat des annonces. Fondement : d'abord un accord oral de Licitor du 14/10/2026, invoqué à titre provisoire ; le décodage a été suspendu par défaut du 23/10/2026 au 11/11/2026 ; il est réactivé par décision du propriétaire du 11/11/2026 : accord déclaré par le propriétaire le 11/11/2026 ; pièce à verser au dossier (`docs/audits/licitor-decodage-reactivation-2026-11-11.md`). Vench : pas de décodage. Ces adresses sont masquées (« [email protected] ») : 105 fiches actives le 11 octobre, 202 fiches Licitor (52 %) selon la mesure du 14/10/2026 à 07:01 UTC (`docs/equipe/2026-10-14-adresses-contacts.md`) ; deux mesures de dates et de périmètres différents, qui ne s’additionnent pas. Le décodage se fait à la collecte, sur le HTML déjà récupéré : il n’ajoute aucune requête vers Licitor. Il est impossible sur le texte déjà stocké (l'élément masqué en a été retiré) : une adresse manquante arrive à la relecture suivante du détail de la fiche par la collecte (voir « Fiches Licitor déjà en base », plus bas). Sources lues : `data-cfemail` et liens `/cdn-cgi/l/email-protection#…`, dans les seuls blocs des professionnels. L’adresse décodée passe par les mêmes filtres qu’une adresse en clair : une adresse de juridiction (`@justice.fr`, `@*.justice.gouv.fr`), d’Ordre, de barreau ou de CARPA, une adresse RPVA (`@avocat-conseil.fr`), une adresse `noreply`, `dpo` ou `rgpd` et une donnée illisible sont écartées.
- **Email Licitor décodé : conservé, sous forme décodée, uniquement dans le registre interne de l’agent d’information, jamais publié** (décision du propriétaire, 14/10/2026). Le parseur retire l’élément masqué de la page : l’adresse n’entre ni dans `lawyer_contact`, ni dans le texte ou les blocs de la fiche (`raw_text`, `page_text`, `contact_avocat`), ni dans les caractéristiques, ni dans le point de reprise de collecte (`auction_collection_checkpoints`), ni dans l’historique, donc dans aucune vue ni fonction lisible par un visiteur ou un utilisateur connecté. Elle part dans `internal_contacts` (champ de la vente brute, extrait par `normalize_sale`, jamais sérialisé) puis dans `information_agent_contacts` (réservée au `service_role`) : `source_kind = 'sale_listing'`, `source_name = 'licitor'`, `source_url` = la page Licitor, `observed_by = 'agent'`, `observed_at` = la collecte, `display_name` = nom et fonction imprimés dans le bloc de l’avocat (le `<h3>`), portée = la vente ; le pied du message cite alors « l’annonce publique de cette vente sur Licitor » avec son lien et la date de relevé. L’écriture suit celle de la vente, dans la même transaction (un point de sauvegarde pour la relecture de l’id, un par ligne) ou par PostgREST (lectures paginées ; la liste des adresses opposées est lue une fois par run, soixante secondes au plus (`OPPOSED_CACHE_TTL_SECONDS`), et non à chaque lot ; une lecture impossible, incomplète ou au-delà de 50 000 lignes n'écrit rien et le journal l'indique, sans adresse : « Internal contacts registry read stopped at the page limit »), et ne fait jamais échouer la collecte : un échec est journalisé sans l’adresse (type d’erreur et compteur). Côté agent, un registre illisible donne une liste vide et un avertissement (sans adresse) : le brouillon se poursuit sans ces adresses.
- **Conservation de ces adresses** : Adresse relevée à la collecte de l’annonce et non utilisée pour un envoi : conservée tant que le détail de l’annonce est relu, jamais rafraîchie après la date de la vente, et supprimée au plus tard 28 jours après la dernière consultation de l’annonce (purge hebdomadaire, seuil de 21 jours). Concrètement, une vente sans date d’audience, dont l’audience est passée, ou retirée, annulée ou reportée sans nouvelle date, n’est ni écrite ni rafraîchie ; `observed_at` est rafraîchi à chaque recollecte du détail de la fiche, y compris quand le contenu de la fiche est inchangé (le registre est alors réécrit à partir des adresses décodées de la relecture, comme pour une fiche modifiée ; seul un conflit d’identité n’y touche pas), `created_at` garde la date du premier relevé et n’est jamais réécrit. Une fiche dont le détail n’est pas retéléchargé n’est pas rafraîchie : son adresse est alors purgée après 21 jours au plus. La purge teste la présence d’une demande par adresse, toutes ventes confondues : une adresse déjà utilisée pour un envoi garde ses lignes d’autres ventes tant que la demande est conservée.
- **Décodage** : interrupteur propre `LICITOR_DECODE_PROTECTED_EMAILS` (pipeline). **État au 11/11/2026 : actif en production par défaut** (décision du propriétaire du 11/11/2026, accord de Licitor déclaré par le propriétaire ; pièce à verser au dossier) : `.github/workflows/data-pipeline.yml` transmet la variable de dépôt GitHub `LICITOR_DECODE_PROTECTED_EMAILS` (Settings → Secrets and variables → Actions → Variables) et, si elle est absente, la valeur `true`. **La variable de dépôt garde la main : pour couper le décodage sans commit, la poser à `false` ; si elle vaut déjà `false` (consigne des 18, 20 et 23/10/2026), le décodage reste coupé tant qu'elle n'est pas supprimée ou passée à `true`.** Le code, lui, reste explicite : variable absente, vide ou `false`, aucun décodage (c'est le cas en local, `services/data-pipeline/.env`) ; seules `true`, `1`, `on`, `yes`, `oui` et `enabled` l'activent. Toute autre valeur laisse le décodage désactivé ; une valeur non reconnue est signalée par un avertissement dans le journal, sans la valeur. Coupé, les éléments masqués sont toujours retirés de la page (jamais publiés) mais aucune adresse n'est décodée ni écrite au registre ; la collecte et l'affichage de Licitor continuent. Aucune migration, et la suspension ne supprime rien. Pour retirer toute la source, voir `public.set_catalogue_source_withdrawal('licitor', true, '<raison>')` (service_role : arrête la collecte et retire Licitor du catalogue).
- **Supprimer les adresses déjà relevées** (non exécuté par cette PR) : par la purge, 28 jours au plus après la dernière consultation de l'annonce (rien n'est rafraîchi une fois le décodage coupé) ; ou, en urgence, par une requête manuelle en `service_role`, à valider avant toute exécution. **Couper d'abord l'interrupteur** (sinon la collecte suivante réécrit les adresses), puis compter : `select count(*) from public.information_agent_contacts where source_kind = 'sale_listing' and metadata->>'observation_channel' = 'licitor_cloudflare_decoded' and opposition_status <> 'opposed' and not exists (select 1 from public.information_agent_missions m where lower(btrim(m.recipient_email)) = normalized_email);` Si le nombre est celui attendu, remplacer `select count(*)` par `delete` dans la même requête. La condition `not exists` protège les adresses déjà utilisées pour un envoi, qui suivent la durée de leur demande ; `opposition_status <> 'opposed'` laisse intactes les lignes d'opposition.
- **Accès et effacement pour un professionnel sans compte** : la page de confirmation de l’opposition (`/api/information-agent/opt-out`) renvoie, avec le même lien signé, vers `/api/information-agent/rights`, où le professionnel choisit « copie de mes données » ou « effacement ». La demande est enregistrée dans `data_subject_requests` (sans `user_id`, `metadata.source = information_agent_professional_link`, identité vérifiée par le lien signé) et apparaît dans l’écran admin des demandes RGPD. **Accès** : bouton « Télécharger les données du professionnel (JSON) » (messages, dossiers, demandes, pièces en métadonnées, informations extraites, fiche du registre) ; envoyer le fichier à l’adresse du demandeur, pas ailleurs, dans le délai d’un mois. **Effacement** : « Exécuter l’effacement » (l’administrateur retape l’adresse) met les fichiers dans la file de suppression Storage, inscrit l’adresse à la liste d’opposition (elle seule reste, normalisée, pour ne plus être recontactée), retire des fiches les traces de ses réponses (`raw_payload.information_agent_verified_facts`, donc la mention « Source : avocat poursuivant »), puis supprime les dossiers et demandes dont elle est destinataire (messages, pièces et informations extraites en cascade). Les valeurs déjà tenues par le registre restent affichées : les retirer avant l’effacement (section du lot C, point 7). Les documents déjà publiés après validation humaine ne sont pas retirés par cette action : à traiter à part si le demandeur le demande.
- **Envoi « à vérifier »** : si Resend ne répond pas dans les 15 secondes (ou si la connexion tombe), l’email a peut-être été accepté. La demande passe en `failed` avec `metadata.send_outcome = 'unverified'` et le motif « Envoi à vérifier » (libellé « À vérifier » dans l’écran admin, pas « Motif de l’échec »). Le délai de 30 jours reste tenu : une autre demande pour la même adresse ou le même professionnel est refusée. Vérifier dans Resend (clé d’idempotence `immojudis-information-agent-case-<id du dossier>`) : si l’email est parti, le renvoi depuis l’écran admin dans les 24 h retrouve le premier envoi (pas de doublon) et passe la demande en `sent`, ce qui lève le drapeau. Au-delà de 24 h le renvoi est refusé (un doublon serait possible) : vérifier, puis, en `service_role` et après validation, soit passer la demande et le dossier en `sent` avec `sent_at` et `provider_message_id`, soit retirer le drapeau (`update public.information_agent_missions set metadata = metadata - 'send_outcome' where id = '…'`) pour autoriser un nouvel envoi.
- **Supervision de la progression** : `public.evaluate_information_agent_health` (appelée par la tâche `operational-health`, séparée d’`evaluate_operational_health`) ouvre `information_agent.mission.stuck` (demande en envoi depuis plus de 30 minutes), `information_agent.inbound.stuck` (réponse en file qui n’avance plus depuis 30 minutes), `information_agent.cron.blocked` (exécution `information-agent-*` restée `running` plus de 20 minutes, seuil placé sous les 30 minutes de la clôture automatique des exécutions orphelines) et `information_agent.send.unverified` (envoi à vérifier). Aucune adresse dans les détails des alertes.
- **Objets Storage orphelins** : `enqueue_orphan_information_agent_portal_uploads` (cron `sale-retention`) met en file de suppression, 24 h après leur création, les objets du bucket `information-agent-evidence` sans ligne de pièce : dépôts du portail (`<dossier>/portal/…`) et emails entrants (`<dossier>/<message>/body/…` et `<dossier>/<message>/<pièce>/…`).
- **Messages non rattachés** (migration `20261110200000`, table `public.information_agent_unrouted_messages`) : un message reçu à l’adresse de réponse sans dossier ouvert (jeton absent, jeton inconnu, dossier clos ou supprimé avec sa vente, jetons multiples) est conservé avec l’expéditeur, l’objet, la date, le motif, le nombre de pièces jointes et un extrait texte de 1 000 caractères au plus. **Aucune extraction de faits, aucune réponse, aucun accusé de réception** ; les pièces jointes ne sont pas conservées (le circuit des pièces est rattaché à un dossier). L’expéditeur inconnu n’est pas lu chez Resend (plafond de lectures) : seuls expéditeur, objet et date de l’événement signé sont gardés, l’identifiant Resend permet de lire le message dans le tableau de bord du fournisseur. Une opposition (« STOP ») d’un expéditeur connu et authentifié reste enregistrée comme avant, avant la conservation. Lecture : écran Agent IA, section « Messages non rattachés » (administrateurs ; RLS : `service_role` et administrateurs seulement), action « Marquer comme traité » ; pour intégrer une information à une annonce, consigner la réponse sur l’enquête concernée (action « consigner une réponse »). Conservation : 12 mois si l’expéditeur figurait dans nos données, 21 jours sinon ; l’extrait d’un message traité est effacé 90 jours après le traitement, le reste de la ligne demeure (`purge_information_agent_unrouted_messages`, seizième purge de `run_data_retention`, migrations `20261110200000` et `20261110200100`) ; effacée et exportée avec les autres données du professionnel (`/api/information-agent/rights`).
- **Résumé quotidien « N réponses à relire »** (`REPLIES_REVIEW_DIGEST_MODE`, `/api/cron/replies-review-digest`) : voir `docs/operations/planification.md`. À `off` par défaut ; passer à `preview` pour voir les nombres dans le compte rendu du passage, puis `on`. Destinataires : `OPERATIONS_ALERT_EMAIL_TO` seulement.
- **Emails sans dossier ouvert** : l’événement signé du webhook porte l’expéditeur ; le message n’est lu chez Resend que si l’expéditeur figure dans les dossiers ou le registre (une opposition d’un inconnu n’a rien à effacer), dans la limite de 30 lectures par minute pour tout le site (au-delà, la livraison est rejouée par Resend).
- **Limite d’identité** : Les lignes écrites par le relevé en lot ne portent pas de clés d’identité : l’opposition par identité n’agit qu’à l’envoi (contrôle de l’agent), pas à l’écriture ; seule l’opposition par adresse est contrôlée à la collecte. Une adresse déjà marquée opposée n’est jamais écrite ni rafraîchie.
- **Captures HTML** : Les captures HTML du collecteur d’historique Licitor (`licitor_ingestion.captures.html_gzip`) contiennent les adresses masquées sous forme encodée réversible (`data-cfemail`) ; aucune purge n’est codée à ce jour (ni migration, ni collecteur) : durée indéfinie, à trancher. L’email « conservé uniquement dans le registre » s’entend donc sous forme décodée.
- Fiches Licitor déjà en base : le rattrapage est celui de la collecte, borné par ses règles existantes, sans requête ajoutée. Le détail d'une fiche n'est tenu pour frais que 24 heures (6 heures quand l'audience est à moins de 7 jours, `src/freshness.py`) : passé ce délai il est relu, carte inchangée ou non, et l'adresse est écrite ou rafraîchie à cette lecture. La relecture reste dans le budget de la source : 42 minutes par passage, décomptées dès le début du passage, donc lecture des listes comprise ; les fiches aux audiences les plus proches passent d'abord, le reste au passage suivant. Avec un passage toutes les 12 heures environ, les ventes à venir sont couvertes en deux à trois passages après une réactivation, 36 heures environ, et une même fiche n'est jamais relue deux fois dans sa fenêtre de fraîcheur. Le texte stocké (`page_text`) contient encore « [email protected] » et la relecture sans réseau ne peut pas le décoder. Un point de reprise de collecte restauré (24 heures au plus) ne porte pas l’adresse : une fiche reprise d'un run interrompu est publiée sans adresse à ce passage, et la reçoit à la relecture suivante de son détail, au plus 24 heures après sa lecture d'origine (comportement assumé : aucune relecture forcée, aucune requête ajoutée). Dans l’intervalle, l’administrateur saisit l’adresse et la page publique où il l’a relevée. Le balayage manuel `insufficient_sales`, le rapport SQL d’informations insuffisantes et la porte de publication (`contact_emails`) ne comptent pas cette adresse comme contact : leur verdict reste celui du miroir TypeScript.
- Une seule sollicitation par professionnel (hors greffes, voir « Greffe de secours ») et par période de 30 jours, toutes ventes confondues (par adresse, et par identité quand le nom et le barreau ou la ville sont connus) : un avocat chargé de plusieurs ventes ne reçoit qu’une demande par mois, même sous deux adresses de son cabinet.
- Les pièces ne sont reconnues que par leur libellé ou leur type ; un PDF au nom neutre (« 3742_001.pdf ») n’est pas compté.

## Lot C : acceptation par le registre, textes de l’e-mail, retraits après opposition (14/11/2026)

Section propre au lot C (validé par le propriétaire le 14/11/2026), complétée le même jour par les relectures de
juridique-rgpd et de code. Migration `20261119100900`, gabarit du code en révision 11 (« version 12 »), gabarit HTML
`information_request_v14`.

**Ordre de déploiement.** Les migrations ne s’appliquent que depuis `main`, après la fusion :

- appliquer la migration du lot C (`20261119100900`) juste après la fusion ;
- n’accepter aucune réponse d’avocat entre la fusion et la fin de l’application, et n’exécuter aucun effacement de
  professionnel : sans la migration, le code enregistrerait la décision du registre sur une fiche déjà écrite par
  l’ancien noyau (le bloc « annonce » mémorisé serait la valeur de l’avocat), et l’effacement s’arrêterait sur la
  fonction qui retire les traces des réponses (`forget_information_agent_verified_facts`), avant de supprimer les
  dossiers.

**Tant que la migration n’est pas appliquée en production, ou que le test pgTAP 900 n’a pas été exécuté avec succès**
(palliatif de juridique-rgpd) : n’accepter pour affichage aucune réponse d’avocat, quel que soit le champ (surface,
terrain, nombre de pièces, occupation, mise à prix, date, type de bien), et n’exécuter aucun effacement de
professionnel. Avant toute réponse à la personne, vérifier la fiche publique en navigation privée.

**« Accepter et mettre à jour la fiche » passe par le registre des pièces (T4).**

- Pour une surface, un terrain, un nombre de pièces, une occupation, une mise à prix, une date ou un type de bien,
  choisir le rattachement au lot avant d’accepter. Seuls « Vente à un seul lot » et « Lot identifié dans la pièce »
  affichent la valeur.
- L’acceptation enregistre le fait de l’agent, puis la décision au registre, à votre nom. Surface, terrain, pièces et
  occupation sont alors affichés et tenus : la collecte ne les écrase plus. Mise à prix, date et type de bien restent
  écrits par le noyau, comme avant ; leur décision est inscrite au journal, sans protection (l’écran le dit sous le
  rattachement au lot).
- Si l’écran dit « Réponse acceptée, mais la valeur n’est pas encore sur la fiche », la décision n’a pas été
  enregistrée (import en cours, contradiction…). Le message donne l’identifiant complet de la vente et de
  l’observation, et le bouton « Ouvrir les observations de cette vente » ouvre « Observations à décider » déjà filtré.
  La réponse reste listée dans le bloc durable « Réponses acceptées sans décision au registre » de l’onglet Réponses
  tant qu’aucune décision n’est prise. Rien n’est affiché d’ici là.
- Une occupation « occupé par le propriétaire », « squatté » ou « inconnue » ne s’accepte plus : la fiche ne dit que
  « libre », « occupé » ou « loué ». Les lectures automatiques proposent désormais directement « occupé ».
- Procès-verbal descriptif et bail ne sont jamais publiés (ils nomment les occupants ou le débiteur) : l’écran et la
  base les refusent ; les rejeter.
- Si la revue indique « expéditeur différent du contact », ou pour une réponse consignée à la main, n’accepter pour
  affichage que si l’expéditeur appartient au cabinet de l’avocat poursuivant. Une réponse téléphonique n’est jamais
  affichée avec la mention. (La base n’écrit la mention « avocat poursuivant », sur la fiche comme dans le libellé d’une
  pièce, que si l’expéditeur de la réponse est le contact sollicité.)

**Mention « Source : avocat poursuivant ».** Elle n’est affichée que si l’observation du registre créée pour cette
réponse est encore acceptée (dernière décision au journal) et, pour surface, terrain, pièces et occupation, si la fiche
tient cette observation. Une opposition ou un retrait l’efface, même quand la valeur affichée est restée la même
(confirmation identique à l’annonce). Une réponse acceptée avant le lot C n’a aucune décision au journal : elle n’a
plus de mention, sa valeur reste affichée.

**Textes de l’e-mail (C12, C13, C14, J10, J15, relecture juridique-rgpd).**

- Le modèle du code passe en révision 11. Dans Admin › Agent IA › Modèle de message, vérifier l’état du modèle publié :
  - modèle publié marqué « ignoré » (révision inférieure à 7, cas constaté le 23/10) : le modèle du code s’applique,
    rien à faire ;
  - modèle publié en révision 7 ou plus : il garde les anciens textes (invitation à joindre « documents ou photos »,
    procès-verbal descriptif, ancienne signature, consignes de réponse). Le republier depuis l’éditeur, avec les blocs
    du modèle du code, avant tout envoi. La publication contrôle l’absence de mention commerciale.
- Brouillons préparés avant le déploiement : les régénérer avant tout envoi. La préparation (« Ouvrir le message ») et
  le pilote ne reprennent pas un brouillon d’une autre révision. Mais un brouillon déjà ouvert peut encore partir :
  avant le premier envoi, annuler (« Annuler la mission ») chaque brouillon dont la révision n’est pas la révision
  courante, puis rouvrir la fiche. Liste en lecture seule :
  `select id, sale_id, status, metadata->>'trigger' as declencheur, metadata->>'email_content_template_revision' as revision from public.information_agent_missions where status in ('draft', 'failed') order by created_at;`
- Aucune pièce n’est demandée : les questions demandent où consulter le cahier et ses annexes, et si des photos sont
  consultables ; le message, le formulaire de dépôt et la question au greffe disent qu’il est inutile de joindre des
  pièces.
- Pied du message, « Affichage sur la fiche » : à l’avocat poursuivant, ses informations peuvent être affichées avec
  la mention de source, qui le rend identifiable, et retirées au plus tard un mois après sa demande ; à un notaire, un
  service de l’État ou un professionnel saisi à la main, elles complètent la fiche sans nom ni qualité ; à un greffe,
  sa réponse sert à identifier l’avocat poursuivant.
- Portée de l’opposition dans le pied : « toute la structure » dès qu’une clé de structure vaut pour l’adresse (cabinet
  ou étude à domaine propre, numéro d’office), même si une personne est nommée ; à une adresse générique sans telle clé
  (gouv.fr par exemple), « cette adresse ; les autres adresses … ne sont pas concernées » ; à une personne nommée sans
  telle clé, aucune phrase de portée.

**Retrait après une opposition (J10) : un mois au plus, 28 jours en interne.** Une opposition d’un avocat vaut aussi
retrait des valeurs publiées depuis ses réponses. Le retrait n’est pas automatique : une décision du registre s’écrit
avec le jeton d’un administrateur.

1. **Déclencheur.** Chaque opposition (lien « Ne plus être contacté », réponse « STOP », bouton « Enregistrer
   l’opposition ») et chaque demande de retrait reçue (réponse à l’e-mail, courrier, téléphone). Une réponse qui
   demande de retirer quelque chose de la fiche arrive en relecture avec le motif « possible demande de ne plus être
   contacté ou de retrait de la fiche ». La page de confirmation de l’opposition annonce la date limite du retrait
   (opposition + 28 jours).
2. **Contrôle quotidien.** Admin › Agent IA › Réponses, bloc « Retraits à faire après une opposition » : une ligne par
   valeur acceptée d’un dossier dont le destinataire s’est opposé (par son adresse, ou par son identité sous une autre
   adresse ; une clé de structure ne compte que si elle vaut pour l’adresse du dossier), avec la date limite
   (opposition + 28 jours), en rouge une fois dépassée, et le lien « Ouvrir les observations de cette vente ». Une
   demande de retrait sans opposition n’y figure pas : la traiter de la même façon, à la main.
3. **Décision, dans le délai.** Dans « Observations à décider », choisir « Enregistrer une opposition » dans les deux
   cas, opposition ou simple demande de retrait : l’affichage repose sur l’intérêt légitime, pas sur une autorisation.
   « Retirer », motif « Autorisation d’affichage retirée », ne sert qu’aux pièces et photos dont la diffusion avait été
   autorisée. Ces décisions sont définitives. La valeur de l’annonce revient sur la fiche pour la surface, le terrain,
   les pièces et l’occupation ; la mention quitte la fiche pour toutes les valeurs, et la ligne quitte le bloc.
4. **Trace.** La décision reste au journal du registre (auteur, date, motif) ; c’est la preuve du retrait. Le journal
   ne porte qu’un motif : noter le canal et la date de la demande dans la demande RGPD du dossier. Une simple demande de
   retrait, ou une demande qui vise une pièce ou une photo, s’ouvre dans l’écran des demandes RGPD (Admin ›
   Conformité). Point ouvert : cet écran ne permet pas aujourd’hui de créer une demande à la main (seul le lien signé
   du professionnel en crée une) ; en attendant, garder la réponse reçue dans le dossier de l’agent (date et canal) et
   le signaler au propriétaire.
5. **Réponse à la personne**, un des trois modèles ci-dessous (crochets à remplacer ou retirer).
   - **A. Opposition, informations affichées :** « Bonjour, nous avons bien reçu le [JJ/MM/AAAA] votre demande de ne
     plus être contacté. Depuis le [JJ/MM/AAAA], nos fiches n’affichent plus aucune information tirée de vos réponses,
     ni la mention qui les attribuait à l’avocat poursuivant [; la (surface…) a repris la valeur de l’annonce]. Nous ne
     vous écrirons plus, à cette adresse ni à aucune autre adresse rattachée à votre identité professionnelle [ni à
     votre cabinet]. Nous conservons seulement votre adresse, votre identité professionnelle et la date de votre
     opposition, pour la respecter, ainsi qu’une trace interne non publiée de ce retrait ; nos échanges seront
     supprimés le [date]. Pour obtenir une copie de vos données ou demander leur effacement : [contact]. Vous pouvez
     aussi saisir la CNIL (cnil.fr/plaintes). Bien cordialement, l’équipe Immojudis »
   - **B. Opposition, rien d’affiché :** le modèle A, dont la deuxième phrase devient « Aucune information tirée de vos
     réponses n’était affichée sur nos fiches ; aucune ne le sera. »
   - **C. Retrait sans opposition :** le modèle A sans la phrase « Nous ne vous écrirons plus… », en ajoutant « Si vous
     souhaitez aussi ne plus être contacté, répondez simplement à ce message. »
6. **Ce qui reste à la main.**
   - Mise à prix, date et type de bien : le registre ne tient pas ces champs. L’opposition efface la mention et ferme la
     ligne, mais la valeur de l’avocat reste dans la colonne jusqu’à ce que la collecte de l’annonce la réécrive (valeur
     précédente : journal `information_agent_fact_publications.previous_values`). Ne pas envoyer le modèle A tant que la
     fiche publique ou celle des comptes affiche encore la valeur : la faire remettre par l’équipe technique dans les 28
     jours, puis répondre.
   - Pièces et photos publiées : aucune liste ; les retirer à la main avec l’équipe technique.
7. **Effacement d’un professionnel** (« Exécuter l’effacement »). L’effacement retire de chaque fiche les traces de ses
   réponses (`raw_payload.information_agent_verified_facts`) : la mention disparaît. Les valeurs tenues par le registre
   restent affichées, et les dossiers supprimés ne permettent plus au bloc de les lister. Avant d’exécuter
   l’effacement : enregistrer l’opposition de l’adresse (bouton « Enregistrer l’opposition » d’une de ses réponses),
   traiter les lignes du bloc « Retraits à faire » qui le concernent (point 3), puis seulement exécuter l’effacement.

**Libellé des pièces publiées.** Une pièce acceptée est publiée sous « Pièce transmise par l’avocat poursuivant le
JJ/MM/AAAA » (« Pièce transmise le … » pour un autre destinataire ou un autre expéditeur, sans date quand la date de
réception n’est pas connue), jamais sous le nom du fichier d’origine ; le type s’affiche à part, d’après
`document_type`. Les pièces publiées avant la migration gardent leur ancien libellé : aucune réparation dans une
migration (règle T17). Mesure, en lecture seule :

```sql
select count(*) as pieces, count(distinct document.source_url) as ventes
from public.auction_documents document
join public.information_agent_evidence_assets asset
  on asset.id::text = document.raw_payload->>'evidence_asset_id'
where document.raw_payload->>'source' = 'information_agent'
  and document.label = asset.original_filename;
```

Reprise proposée, à faire valider puis passer par le propriétaire comme rattrapage séparé (`supabase/repairs/`, avec
sa procédure), jamais dans une migration : réécrire `label` de ces lignes avec le même libellé neutre (« Pièce
transmise », « par l’avocat poursuivant » seulement si le message d’origine vient du contact sollicité, et le jour de
réception du message quand il est connu). Les pièces de type procès-verbal descriptif ou bail déjà publiées sont à
lister à part (`document.document_type in ('pv_huissier', 'bail')`) et à retirer avec l’équipe technique.

**Banc d’évaluation rejoué (14/11/2026, accord du propriétaire).** Les nouveaux textes changent la demande que 63 cas
du jeu citent mot pour mot : la citation a été mise à jour dans ces 63 cas, sans toucher à aucune vérité de terrain,
puis le banc a été rejoué (section « Jeu d’évaluation »). Seul le cas F5-23 change de résultat, par la lecture de
« 1 250 m² » (T10) : `modele_ideal`, état attendu, passe de 57 publications dont 40 fausses (couverture 17 sur 90) à 58
dont 40 fausses (18 sur 90) ; `suiveur` reste à 58 dont 41 fausses (17 sur 90), F5-23 y restant non confirmé par la
lecture sémantique ; `regles_seules` et l’état réel restent à 0. Les publications fausses sont les mêmes, toutes des
défauts connus.

Relecture juridique-rgpd du même jour : le second paragraphe des consignes de réponse change (« informations déjà
destinées à tout candidat acquéreur… Inutile de joindre des pièces. »). La citation a été mise à jour dans les mêmes
63 cas (aucune vérité de terrain touchée), avec la lecture « occupé » des extracteurs, le numéro écrit avant une
surface (« lot n° 3 105 m² ») et la demande de retrait repérée en relecture, puis le banc a été rejoué : rapport
identique (mêmes publications, mêmes publications fausses, même blocage de la configuration qui fait foi).
