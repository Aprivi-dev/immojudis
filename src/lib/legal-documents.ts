import { ConfigurationError } from "@/lib/api-errors";
/**
 * Dates d'effet des versions du 26/10/2026 (repère « Pépite »). Elles n'entrent pas dans l'empreinte
 * du texte.
 *
 * - CGU 2026-10-26.1 (articles 2, 8 et 10 : repère « Pépite », enchère ou offre plafond selon la
 *   vente, indépendance vis-à-vis de la publicité) : elles s'appliquent dès l'inscription aux
 *   comptes créés à partir de leur mise en ligne, et le 1er décembre 2026 aux comptes existants.
 *   L'article 14 impose d'informer les titulaires de compte au moins 30 jours avant l'entrée en
 *   vigueur : l'information doit partir au plus tard le 1er novembre 2026. Si elle part plus tard,
 *   repousser cette date (date d'envoi + 30 jours au moins) avant la mise en ligne. Jusque-là, la
 *   version 2026-10-25.1 reste applicable aux comptes existants (voir PREVIOUS_LEGAL_DOCUMENTS).
 * - Mentions légales 2026-10-26.1 (« Estimations, rapports et responsabilité » et « Mise en relation
 *   avec un avocat ») : en vigueur à leur mise en ligne, sans préavis.
 *
 * Historique : la version CGU 2026-10-25.1 est entrée en vigueur le 25 octobre 2026 (article 13
 * « Essai gratuit à l'inscription », qui remplace l'offre de lancement, et article 14 « Modification
 * des conditions » ; relecture de conformité du 25/10/2026, à faire valider par un avocat). La
 * section « Classement, référencement et mise en avant » est en vigueur depuis la version
 * 2026-10-14.1 (14 octobre 2026).
 */
export const PEPITE_TERMS_EFFECTIVE_DATE = "1er décembre 2026";

/**
 * CGU 2026-11-10.1 (ouverture des paiements, BROUILLON à faire valider par un avocat avant la mise en
 * ligne) : l'article 4 ne dit plus que la souscription n'est pas encore ouverte et précise le régime de TVA
 * retenu le 09/11/2026 (franchise en base : « TVA non applicable, art. 293 B du CGI », mention reprise sur
 * les factures Stripe, `VAT_EXEMPTION_INVOICE_MENTION`). L'article 2 dit en toutes lettres que le prix est
 * prélevé automatiquement chaque mois jusqu'à la résiliation (contrat à durée indéterminée : pas de
 * « reconduction », qui le ferait lire comme un contrat à durée déterminée reconduit tacitement), et
 * l'article 13 ne parle plus d'une souscription « une fois ouverte » (demande du propriétaire du
 * 10/11/2026 : l'offre est un abonnement mensuel, plus l'ancien accès de 30 jours). La version 2026-10-26.1 est
 * archivée. Date d'effet gardée au 1er décembre 2026 pour les comptes existants (même calendrier que la
 * 2026-10-26.1) ; à valider : préavis de 30 jours de l'article 14 pour ce changement, alors que toute
 * souscription accepte la version en cours au paiement (`commercial-acceptance.ts`).
 */

export const PEPITE_LEGAL_EFFECTIVE_DATE = "26 octobre 2026";

/**
 * Versions du 26/10/2026 liées au contrôle du risque d'inondation de la règle `pepite-v2` (coordonnées d'une
 * vente transmises à Géorisques et à l'API Carto de l'IGN, données publiques réutilisées). Elles ne touchent pas
 * aux CGU : la décision du fondateur est prise, les CGU restent intactes (version 2026-10-26.1) et aucun email
 * d'information n'est envoyé aux titulaires de compte pour ce lot (la politique de confidentialité et les mentions
 * légales entrent en vigueur à la mise en ligne, sans préavis).
 *
 * - Politique de confidentialité 2026-10-26.1 : ligne de traitement « Repère « Pépite » : contrôle du risque
 *   d'inondation d'une vente » et destinataires (BRGM, IGN) ; en vigueur à la mise en ligne, sans préavis.
 * - Mentions légales 2026-10-26.2 : paragraphe « Données publiques réutilisées » ; en vigueur à la mise en ligne,
 *   sans préavis.
 * Les dates d'effet ci-dessous sont celles de la rédaction : à décaler à la date réelle de mise en ligne si elle
 * diffère (elles n'entrent pas dans l'empreinte du texte).
 */
export const FLOOD_LEGAL_EFFECTIVE_DATE = "26 octobre 2026";

/**
 * Politique de confidentialité 2026-10-31.1 : complète le tableau des traitements (événements d'usage
 * par compte et clics des emails, retours « Utile / Pas pertinent », instantanés d'estimation) et
 * corrige « sans identifiant de personne », « noms remplacés par leur rôle » et les réglages Google
 * Analytics non vérifiés. Relecture `juridique-rgpd` à faire ; en vigueur à la mise en ligne, sans
 * préavis (aucun traitement nouveau, seulement une description plus complète). Date à décaler à la
 * date réelle de mise en ligne si elle diffère (elle n'entre pas dans l'empreinte du texte).
 */
export const PRIVACY_COMPLETION_EFFECTIVE_DATE = "31 octobre 2026";

/**
 * Politique de confidentialité 2026-11-01.1 : ajoute les demandes aux greffes (contact de secours d'une vente
 * au tribunal sans adresse d'avocat : au plus un message par vente et, par tribunal, au plus un plafond
 * quotidien configuré, base de l'intérêt légitime, opposition). La version 2026-10-31.1, en production depuis le
 * 01/11/2026 au matin, est archivée. Aucun consentement n'est redemandé : la version n'est qu'enregistrée
 * avec l'acceptation d'une inscription ou d'un achat, aucun contrôle n'impose de la ré-accepter. En vigueur
 * à la mise en ligne, sans préavis (information sur un traitement nouveau qui ne touche que des
 * destinataires institutionnels). Date à décaler à la date réelle de mise en ligne si elle diffère (elle
 * n'entre pas dans l'empreinte du texte).
 */
export const PRIVACY_COURT_REGISTRY_EFFECTIVE_DATE = "1er novembre 2026";

/**
 * Politique de confidentialité 2026-11-01.2 : ajoute le paragraphe d'information (art. 13) sur les messages
 * écrits à l'adresse de réponse de l'agent sans dossier ouvert (conservation de l'adresse, du nom, de l'objet,
 * de la date et d'un extrait ; intérêt légitime ; 12 mois si nous avions écrit, 21 jours sinon). La version
 * 2026-11-01.1 est archivée. Aucun consentement n'est redemandé : la version n'est qu'enregistrée avec
 * l'acceptation d'une inscription ou d'un achat, aucun contrôle n'impose de la ré-accepter. En vigueur à la
 * mise en ligne, sans préavis. Date à décaler à la date réelle de mise en ligne si elle diffère (elle
 * n'entre pas dans l'empreinte du texte).
 */
export const PRIVACY_UNROUTED_MESSAGES_EFFECTIVE_DATE = "1er novembre 2026";

/**
 * Politique de confidentialité 2026-11-01.3 : ajoute le journal des emails envoyés par Immojudis (ligne du
 * tableau des traitements : intérêt légitime, 90 jours, suppression avec le compte), Resend comme
 * sous-traitant (30 jours, États-Unis), les consultations tracées 6 mois, l'adresse et l'objet dans le journal
 * pour les professionnels contactés, et l'effacement du compte. La version 2026-11-01.2 est archivée. Aucun
 * consentement n'est redemandé : la version n'est qu'enregistrée avec l'acceptation d'une inscription ou d'un
 * achat, aucun contrôle n'impose de la ré-accepter. En vigueur à la mise en ligne, sans préavis. Date à décaler
 * à la date réelle de mise en ligne si elle diffère (elle n'entre pas dans l'empreinte du texte).
 */
export const PRIVACY_EMAIL_LOG_EFFECTIVE_DATE = "1er novembre 2026";

/**
 * Politique de confidentialité 2026-11-14.1 (état des lieux du 14/11/2026, points J3 et J11, rédaction validée par
 * le propriétaire le 14/11/2026) : professionnels contactés (outil qui prépare les projets de messages, opposition
 * par adresse, par identité et par structure rattachée avec certitude, identité « mauvais destinataire » gardée
 * 24 mois, adresses jamais utilisées pour la mise en avant payante) ; valeurs transmises affichées sur la fiche sans
 * nom, pièces sous un libellé neutre, retrait sous un mois sur demande et opposition valant retrait, durées des
 * journaux de provenance ; coordonnées de l'organisateur lisibles par les comptes connectés ; photos tirées des
 * pièces, procès-verbaux descriptifs compris, et leur retrait ; profil d'investisseur et prix final noté par le
 * compte ; clauses contractuelles types de Resend ; Replicate, transfert sans garantie vérifiée à ce jour (J18). La version
 * 2026-11-01.3 est archivée. Aucun consentement n'est redemandé : la version n'est qu'enregistrée avec l'acceptation
 * d'une inscription ou d'un achat. En vigueur à la mise en ligne, sans préavis. Date d'effet portée au 16/11/2026
 * (mise en ligne prévue au plus tôt le week-end des 14 et 15/11), la version garde la date de rédaction ; à décaler
 * à la date réelle de mise en ligne si elle diffère (elle n'entre pas dans l'empreinte du texte). Relue par
 * `juridique-rgpd` le 14/11/2026 (« publiable après corrections bloquantes », corrections appliquées) ; relecture
 * d'un avocat à faire. Elle reste inférieure à `AUTOPILOT_LEGAL_MIN_PRIVACY_VERSION` : le mode réel du pilote reste
 * verrouillé, et le texte (« à ce jour, chaque message est relu et validé par un membre de l'équipe ») ne vaut que
 * tant qu'il l'est.
 */
// Mise en ligne réelle : le 15/11/2026.
export const PRIVACY_PROFESSIONALS_EFFECTIVE_DATE = "15 novembre 2026";

/**
 * Offre gratuite : un seul déblocage de vente, plus d'essai (décision du propriétaire du 15/11/2026).
 *
 * - CGU 2026-11-15.1 (BROUILLON, à faire valider par un avocat avant la mise en ligne) : l'article 2
 *   décrit le compte Découverte avec un déblocage de vente en tout (`FREE_SALE_UNLOCKS`) au lieu de
 *   trois par mois civil ; le déblocage est rendu automatiquement si la vente est retirée avant
 *   d'avoir lieu, sur demande si Immojudis retire elle-même la fiche, et redevient disponible
 *   24 mois après le déblocage. L'article 13 ne décrit plus un essai proposé : il constate la fin
 *   de l'essai gratuit à l'inscription et le retour des comptes concernés à Découverte. Les renvois
 *   à l'essai (articles 2, 6, 9 et 14) sont retirés. La version 2026-11-10.1 est archivée.
 * - Calendrier, décision du propriétaire prise le 15/11/2026 en connaissance des articles 2 et 14
 *   (préavis de 30 jours) et de l'article 13 (essais en cours) de la version en vigueur, contre la
 *   recommandation qui lui a été faite : la nouvelle règle (article 2 pour l'offre Découverte et
 *   article 13) s'applique à tous les comptes, nouveaux et existants, dès la mise en ligne, sans
 *   ce préavis, et les essais en cours prennent fin à la mise en ligne. Aucune information
 *   préalable de 30 jours n'a été envoyée : le texte publié ne le dit pas. Les autres stipulations
 *   gardent leur calendrier (1er décembre 2026 pour les comptes existants,
 *   `PEPITE_TERMS_EFFECTIVE_DATE`). À faire valider par un avocat avant la mise en ligne.
 * - Politique de confidentialité 2026-11-15.1 : lignes « Essai gratuit » (plus proposé) et
 *   « Déblocage de vente » (plus de compteur mensuel ; une vente supprimée du site garde le
 *   déblocage compté dans la limite de 24 mois). La version 2026-11-14.1 est archivée. En vigueur à
 *   la mise en ligne, sans préavis, comme les versions précédentes.
 *
 * Date de la mise en ligne prévue ; à décaler à la date réelle si elle diffère (elle n'entre pas
 * dans l'empreinte du texte).
 */
// Mise en ligne réelle : le 15/11/2026.
export const FREE_UNLOCK_EFFECTIVE_DATE = "15 novembre 2026";

/**
 * Le déblocage d'une vente ouvre toute l'offre Analyse sur cette vente ; nouvelle vue du compte
 * gratuit (décision du propriétaire du 15/11/2026, lot 2).
 *
 * - CGU 2026-11-15.2 (BROUILLON, à faire valider par un avocat avant la mise en ligne) : l'article 2
 *   dit qu'un déblocage ouvre l'ensemble des éléments de l'offre Analyse propres à la vente
 *   débloquée, lorsqu'elle les comporte (estimation détaillée, ventes comparables, budget travaux,
 *   urbanisme et cadastre, rapport enregistré et rapport PDF compris), et ce qui reste réservé à
 *   l'offre Analyse (autres ventes, export CSV, alertes avancées et quotidiennes, favoris au-delà de
 *   la limite, statistiques des autres tribunaux, partage d'un rapport par lien, mise en relation
 *   avec un avocat référencé). La description de Découverte ne comprend plus la fourchette de valeur
 *   ni l'écart chiffré avec la mise à prix : seulement un niveau d'écart, sans chiffre, et un aperçu
 *   chiffré de l'analyse (nombres de ventes comparables, de points relevés dans les pièces, de
 *   passages). La version 2026-11-15.1 est archivée.
 * - Calendrier, décision du propriétaire du 15/11/2026 : la nouvelle rédaction de l'article 2 pour
 *   l'offre Découverte et son déblocage s'applique à tous les comptes, nouveaux et existants, dès la
 *   mise en ligne, sans le préavis de 30 jours des articles 2 et 14, comme pour la version
 *   2026-11-15.1. Ce changement retire au compte gratuit la fourchette de valeur et l'écart chiffré,
 *   jusque-là visibles sans déblocage. Aucune information préalable de 30 jours n'a été envoyée : le
 *   texte publié ne le dit pas. Les autres stipulations gardent leur calendrier. À faire valider par
 *   un avocat.
 *
 * Date de la mise en ligne prévue ; à décaler à la date réelle si elle diffère (elle n'entre pas
 * dans l'empreinte du texte).
 */
export const FULL_SALE_UNLOCK_EFFECTIVE_DATE = "15 novembre 2026";

/**
 * Achat d'une vente à l'unité (décision du propriétaire du 15/11/2026, lot 3). À FAIRE VALIDER PAR UN
 * AVOCAT AVANT L'OUVERTURE DE L'ACHAT.
 *
 * - CGU 2026-11-15.3 : nouvel article 2 bis « Achat d’une vente à l’unité », placé après l'article 2
 *   pour ne décaler aucun numéro cité ailleurs : objet (déblocage d'une vente, mêmes éléments qu'un
 *   déblocage du compte gratuit, tant que la vente est en ligne et 24 mois au plus), prix (19 € TTC,
 *   TVA non applicable, art. 293 B du CGI ; paiement unique par carte, par Stripe), fourniture
 *   immédiate d'un contenu numérique à la demande expresse du client, qui reconnaît perdre son droit
 *   de rétractation une fois l'accès fourni, confirmation par email, crédit sans remboursement pour
 *   une vente retirée avant d'avoir lieu ou plus disponible au paiement, déduction des achats des 30
 *   derniers jours sur le premier mois d'abonnement dans la limite de son prix, caractère personnel.
 *   Mis en cohérence : article 1 (champ d'application), article 2 (renvoi à l'article 2 bis) et
 *   article 6 (rétractation : renonciation pour l'achat à l'unité ; la perte du droit « en cas
 *   d'exécution complète » ne vise plus que l'abonnement). La version 2026-11-15.2 est archivée.
 * - L'article 2 bis ne produit d'effet qu'à l'ouverture de l'achat (`saleUnlock.open` de
 *   `GET /api/billing/offer`) ; l'en-tête des CGU le dit. Les autres stipulations gardent leur
 *   calendrier. Aucune justification juridique n'est avancée ici : la qualification en contenu
 *   numérique et la renonciation, le crédit au lieu du remboursement et sa durée de validité (le
 *   texte n'en fixe pas), la déduction présentée comme une remise et la facture d'un particulier
 *   sont à soumettre à l'avocat.
 *
 * Date de la mise en ligne prévue ; à décaler à la date réelle si elle diffère (elle n'entre pas
 * dans l'empreinte du texte).
 */
export const SALE_PURCHASE_TERMS_EFFECTIVE_DATE = "15 novembre 2026";

/**
 * Politique de confidentialité 2026-11-21.1 : nouveau sous-traitant Anthropic (décision du propriétaire du
 * 21/11/2026, option « pages telles quelles »). À publier AVANT le premier envoi d'une pièce à Anthropic.
 *
 * - Rôle : lecture par IA (Claude Haiku 5.5 et Claude Sonnet 5.5, par l'API d'Anthropic) des pièces publiques
 *   des ventes judiciaires (cahier des conditions de vente, procès-verbal descriptif, diagnostics), pour en
 *   extraire surface, terrain, nombre de pièces, occupation et dates de visite.
 * - Données : contenu des pièces, pages transmises telles quelles, y compris le nom des parties qui y figurent
 *   (débiteur saisi, occupants). Replicate reçoit le texte des annonces et le texte tiré des pièces
 *   (`fact_sections_for_sale`) ; Anthropic reçoit les fichiers PDF.
 * - Cocontractant d'un client établi dans l'EEE selon les conditions commerciales d'Anthropic (en vigueur le
 *   17/06/2025) : Anthropic Ireland, Limited. Données stockées aux États-Unis, traitement possible aux
 *   États-Unis, en Europe, en Asie ou en Australie (centre de confidentialité, article du 15/06/2026 « Where
 *   are your servers located? »).
 * - Garantie du transfert hors de l'EEE : NON ÉTABLIE. Les clauses contractuelles types de l'accord de
 *   traitement des données d'Anthropic (Data Processing Addendum, en vigueur le 24/02/2025 : décision (UE)
 *   2021/914, modules 2 et 3, « to the extent required ») ont pour importateur « the Anthropic entity that
 *   executed the Agreement », soit Anthropic Ireland, société de l'EEE : elles n'encadrent pas le passage
 *   vers les États-Unis. Le DPA ne prévoit pour les sous-traitants qu'un contrat « substantially as
 *   protective » et la responsabilité d'Anthropic (section C.2), plus une aide à l'analyse d'impact du
 *   transfert, sur demande (section I.4). Il ne nomme ni Anthropic, PBC comme sous-traitant, ni de garantie
 *   du chapitre V entre les entités Anthropic ; la liste des sous-traitants (trust.anthropic.com) n'a pas pu
 *   être lue ; aucune certification au cadre UE–États-Unis n'a été vérifiée. Le texte publié n'affirme donc
 *   aucune garantie. À demander à Anthropic (section I.4) : garantie du transfert Irlande vers les
 *   États-Unis, liste des sous-traitants. Pages consultées le 21/11/2026.
 * - Conservation chez Anthropic (centre de confidentialité, article du 01/07/2026) : entrées et sorties de
 *   l'API supprimées dans les 30 jours, sauf service à conservation plus longue choisie par le client (Files
 *   API : non utilisée, les PDF sont joints à la requête en bloc document base64, selon le chef d'orchestre
 *   le 21/11/2026, code non encore présent dans le dépôt) ; si signalées par les contrôles automatiques :
 *   entrées et sorties jusqu'à 2 ans, scores de classement de sécurité jusqu'à 7 ans ; plus si la loi
 *   l'impose.
 * - Tableau des traitements : ligne « Lecture automatique des pièces des ventes » (intérêt légitime ; durée
 *   reprise de la ligne « Annonces de ventes et pièces publiques »). Droit d'opposition (art. 21, § 4)
 *   présenté dans une section à part, « Votre droit de vous opposer à la lecture automatique des pièces » :
 *   l'arrêt de la lecture pour une vente sur opposition doit exister avant le premier envoi.
 * - « Décisions automatisées et enrichissements » : la phrase « toute intégration d'information sur une fiche
 *   [est validée] par un membre de l'équipe » était déjà fausse pour les valeurs relevées automatiquement
 *   dans les pièces publiques ; elle ne vise plus que les informations transmises par un professionnel
 *   (relecture juridique du 21/11/2026, PR #545).
 * - Hors champ : les pièces jointes envoyées par les avocats restent lues à la main ; les messages aux
 *   professionnels ne changent pas.
 *
 * La version 2026-11-15.1 est archivée. Aucun consentement n'est redemandé : la version n'est qu'enregistrée
 * avec l'acceptation d'une inscription ou d'un achat. En vigueur à la mise en ligne, sans préavis. Date de
 * rédaction ; à décaler à la date réelle de mise en ligne si elle diffère (elle n'entre pas dans l'empreinte
 * du texte). Relecture `juridique-rgpd` et d'un avocat à faire.
 */
export const PRIVACY_ANTHROPIC_EFFECTIVE_DATE = "21 novembre 2026";

/**
 * Politique de confidentialité 2026-11-22.1 : Anthropic devient le prestataire d'IA de tous les usages
 * (décision du propriétaire du 22/11/2026 : Claude Haiku 5.5 remplace Qwen chez Replicate). À publier en
 * même temps que la bascule du réglage, et AVANT le premier envoi d'un texte à Anthropic.
 *
 * - Usages déclarés : extraction des faits des annonces et des pièces (texte), lectures détaillées de l'offre
 *   Analyse, lecture des réponses et des pièces jointes des professionnels par l'agent d'information (photos
 *   comprises, `INFORMATION_AGENT_EVIDENCE_VISION_ENABLED`). Aucun texte d'affichage n'est demandé au modèle
 *   depuis la #446 (synthèse retirée le 09/11/2026) : cette finalité n'est pas déclarée (relecture sécurité). La lecture des pages des
 *   pièces des ventes (version 2026-11-21.1, Claude Haiku 5.5 et Claude Sonnet 5.5) ne change pas : les pages
 *   partent telles quelles.
 * - Filtre des noms : les textes envoyés restent filtrés comme avec Replicate (`redact_personal_text` pour
 *   les annonces et les pièces, `redact_text_for_model` pour les réponses : noms, signatures, téléphones,
 *   adresses email). Le filtre est automatique : le texte publié dit qu'un nom peut passer. Les photos jointes
 *   à une réponse sont réduites à 1 600 px au plus, réenregistrées en JPEG, sans métadonnées (EXIF, position
 *   GPS) ; leur contenu n'est pas filtré (`_prepare_image_for_vision`, `information_agent_evidence.py`).
 * - Réponses aux 15 messages déjà partis en nommant Replicate : lues par une personne, sans IA (garde-fou du
 *   développeur) ; le texte publié le dit en une phrase, sans chiffre.
 * - Comptage de la taille du texte (`count_tokens`) avant certaines lectures longues : même service, mêmes
 *   conditions de conservation, dit à la suite du paragraphe de conservation.
 * - Anthropic : faits vérifiés le 21/11/2026, sans élément nouveau (cocontractant Anthropic Ireland,
 *   Limited ; sous-traitants liés par contrat, section C.2 du DPA ; stockage aux États-Unis ; pas
 *   d'entraînement ; garantie du transfert vers les États-Unis NON ÉTABLIE, voir la note de la 2026-11-21.1).
 *   Le paragraphe du cocontractant reprend la 2026-11-21.1 et dit en plus que le DPA ne précise pas la
 *   garantie du transfert. Passages réécrits par rapport à la 2026-11-21.1 :
 *   - parenthèse des destinataires : « (Anthropic, États-Unis) » devient « (Anthropic, Irlande, données
 *     stockées aux États-Unis) » ;
 *   - « Personnes citées » : « un modèle d'IA d'Anthropic, aux États-Unis » devient « dont les données sont
 *     stockées aux États-Unis » (le lieu de traitement n'est pas fixé dans le code) ;
 *   - « Transferts hors de l'EEE » : la phrase « traitées par ses sous-traitants dans les conditions de son
 *     accord », qui laissait croire à une garantie, est remplacée par l'absence de garantie vérifiée et la
 *     demande faite à Anthropic (relecture juridique de la PR #551). Le texte dit « Nous la demandons » :
 *     la demande doit être partie avant la mise en ligne ;
 *   - conservation de 30 jours étendue aux textes et aux photos, qui doivent eux aussi être joints à la
 *     demande, sans Files API (à confirmer par le développeur qui fait la bascule).
 * - Replicate : prestataire de secours, par réglage (`LLM_PROVIDER`). Le texte dit qu'il ne reçoit rien tant
 *   que le réglage n'est pas rebasculé, ce qu'il recevrait alors (mêmes textes filtrés et mêmes photos, pas
 *   les pages des pièces) et l'absence de garantie de transfert vérifiée (J18). Il ne promet pas de modifier
 *   la page avant une rebascule. Pour les données déjà envoyées, il reprend ce que disait la 2026-11-21.1
 *   (textes, pièces, réponses et photos, avec des données personnelles possibles) et dit que la durée de
 *   conservation chez Replicate n'était pas indiquée et n'est pas vérifiée.
 * - Pied des messages de l'agent : le prestataire nommé vient de `LLM_PROVIDER`
 *   (`information-agent-ai-provider.ts`), qui connaît désormais Anthropic.
 * - Hors champ : les textes sur la validation humaine des informations transmises par les professionnels
 *   (« Décisions automatisées et enrichissements », pied des messages) ne changent pas.
 *
 * La version 2026-11-21.1 est archivée. Aucun consentement n'est redemandé : la version n'est qu'enregistrée
 * avec l'acceptation d'une inscription ou d'un achat. En vigueur à la mise en ligne, sans préavis. Date de
 * rédaction ; à décaler à la date réelle de mise en ligne si elle diffère (elle n'entre pas dans l'empreinte
 * du texte). Relecture `juridique-rgpd` et d'un avocat à faire.
 */
export const PRIVACY_ANTHROPIC_ALL_AI_EFFECTIVE_DATE = "22 novembre 2026";

/**
 * Politique de confidentialité 2026-11-23.1 : envoi automatique des demandes d'information aux seuls avocats
 * poursuivants (pilote de l'agent d'information, décision du propriétaire du 23/11/2026). La publication
 * automatique sur les fiches reste fermée. Texte repris de la relecture conformité du 23/11/2026 (document 2,
 * section 2.1), recalé sur la 2026-11-22.1. À publier AVANT le premier envoi automatique réel.
 *
 * - Tableau, ligne « Professionnels contactés » : date du premier relevé de l'adresse et trace de l'envoi
 *   automatique, sans adresse ; base : validation par un membre de l'équipe sauf l'envoi automatique à l'avocat
 *   poursuivant, aucune publication sans vérification humaine ; durée du journal du pilote, sans adresse : 5 ans
 *   (`purge_information_agent_autopilot`). La durée de 24 mois du « mauvais destinataire » y figurait déjà.
 * - Section « Professionnels contactés » : la promesse « si nous décidions d'envoyer certains messages
 *   automatiquement, cette page serait modifiée avant, et ces messages le diraient » est retirée ; adresses
 *   Licitor décodées jamais utilisées pour un envoi automatique (`allow_licitor_decoded` faux, règle par défaut) ;
 *   nouveau paragraphe « Envoi automatique aux avocats poursuivants » : périmètre, modèle fixe sans IA, article
 *   14 (moins de 30 jours depuis le premier relevé, réglage par défaut `art14_max_age_days` = 30, bornes 1 à
 *   90), une fois par période de 30 jours sans relance, pauses de 90 jours et de 6 mois, plafonds, plage
 *   d'envoi, arrêt automatique, article 22, « mauvais destinataire » (exclusion de 24 mois et arrêt du pilote,
 *   `applyWrongRecipient`).
 * - « Destinataires et sous-traitants » : l'intermédiaire professionnel reçoit aussi les informations par l'envoi
 *   automatique. Les formulations sur Anthropic et Replicate de la 2026-11-22.1 sont gardées telles quelles,
 *   garantie de transfert non vérifiée et demandée comprise. « Transferts hors de l'EEE » : inchangé (Resend,
 *   Anthropic et Replicate y sont déjà nommés).
 * - « Décisions automatisées et enrichissements » : demande préparée à partir d'un modèle fixe, non rédigé par
 *   une IA ; validation par un membre de l'équipe sauf l'envoi automatique, sans effet juridique (article 22).
 *   La phrase sur les informations transmises (validées avant la fiche) et sur les valeurs relevées dans les
 *   pièces ne change pas.
 * - Livrés à part, dans la même PR : le pied des messages du pilote (rubrique « Envoi automatique », section 2.2
 *   de la relecture) et `AUTOPILOT_LEGAL_MIN_PRIVACY_VERSION`, fixée à cette version (« 2026-11-23.1 ») : le
 *   contrôle de préparation du mode réel exige qu'elle soit en vigueur.
 *
 * La version 2026-11-22.1 est archivée. Aucun consentement n'est redemandé : la version n'est qu'enregistrée avec
 * l'acceptation d'une inscription ou d'un achat. En vigueur à la mise en ligne, sans préavis. Le paragraphe de
 * l'envoi automatique affiche cette date (« Depuis le … ») ; à décaler à la date réelle de mise en ligne si elle
 * diffère (elle n'entre pas dans l'empreinte du texte). AIPD : `docs/rgpd-aipd-agent-information-pilote.md`, dans le
 * dépôt interne (`docs/README.md`). Relecture d'un avocat à faire.
 */
export const PRIVACY_AUTOPILOT_EFFECTIVE_DATE = "23 novembre 2026";

/**
 * Politique de confidentialité 2026-11-23.2 : les adresses masquées sur Licitor, décodées à la collecte, sont
 * ouvertes à l'envoi automatique aux avocats poursuivants (décision du propriétaire du 23/11/2026 : accord écrit de
 * Licitor, réglage `allow_licitor_decoded` activé). La 2026-11-23.1 disait le contraire.
 *
 * - Paragraphe Licitor de « Professionnels contactés » : « jamais à un envoi automatique » est retiré. Le texte dit
 *   que ces adresses sont relevées avec l'accord écrit de Licitor (son existence seulement, pas son contenu) et
 *   qu'elles reçoivent les demandes, envoi automatique compris, dans les mêmes conditions que les autres adresses
 *   d'avocats poursuivants : adresse de l'avocat de la vente, information de l'article 14 dans chaque message,
 *   opposition, au plus un envoi automatique par période de 30 jours, sans relance. Origine, conservation et
 *   purge : inchangées.
 * - Paragraphe « Envoi automatique aux avocats poursuivants » : l'exclusion « ni une adresse masquée sur Licitor »
 *   est retirée ; une adresse masquée sur Licitor compte parmi les adresses de l'annonce.
 * - Rien d'autre ne change. `AUTOPILOT_LEGAL_MIN_PRIVACY_VERSION` est portée à « 2026-11-23.2 » dans le même
 *   lot : le mode réel ne peut pas partir sous la 2026-11-23.1, qui excluait ces adresses.
 *
 * La version 2026-11-23.1 est archivée. Aucun consentement n'est redemandé. Même date d'effet que la 2026-11-23.1 ;
 * constante à part pour pouvoir la décaler à la date réelle de mise en ligne sans toucher la date « Depuis le … »
 * de l'envoi automatique. Relecture d'un avocat à faire.
 */
export const PRIVACY_AUTOPILOT_LICITOR_EFFECTIVE_DATE = "23 novembre 2026";

/**
 * Politique de confidentialité 2026-11-26.1 : consentement distinct aux emails de nouveautés et d'offres
 * d'Immojudis (décision du propriétaire du 26/11/2026, après avis juridique : la prospection par email exige
 * un consentement explicite, distinct de celui des alertes). À publier AVANT d'ouvrir la case
 * (`MARKETING_EMAILS_MODE` autre que `off`).
 *
 * - Tableau des traitements : ligne « Nouveautés et offres d’Immojudis par email » (au plus deux messages par
 *   mois) ; données : consentement daté et versionné, date de retrait, email du compte pour l'envoi par
 *   Resend ; base : consentement (case non pré-cochée, distincte), retrait en un clic dans les réglages ou par
 *   le lien de chaque email ; durée : tant que le compte existe, suppression avec le compte. Rédigée sur le
 *   modèle de la ligne « Rappels d’audience ».
 * - Aucun email de ce type n'existe encore : la ligne ne décrit que le recueil, la preuve et le retrait. Le
 *   journal des emails envoyés (ligne « Journal des emails envoyés par Immojudis ») couvrira leurs envois.
 * - Ajout dans la même version, avant sa mise en ligne (décision du propriétaire du 26/11/2026, après avis
 *   juridique) : ligne « Message unique de prise en main de votre compte » ; données : email du compte,
 *   département de la première alerte, état de l'envoi, date d'opposition ; base : intérêt légitime, avec
 *   opposition en un clic ou par écrit ; durée : journal 24 mois, opposition tant que le compte existe. À
 *   publier AVANT d'ouvrir `ONBOARDING_EMAIL_MODE`. L'empreinte de la version a été recalculée ; la version,
 *   sa date et l'archive de la 2026-11-23.2 ne changent pas.
 * - Rien d'autre ne change.
 *
 * La version 2026-11-23.2 est archivée. Aucun consentement n'est redemandé : la version n'est qu'enregistrée
 * avec l'acceptation d'une inscription ou d'un achat. En vigueur à la mise en ligne, sans préavis. Date de
 * rédaction ; à décaler à la date réelle de mise en ligne si elle diffère (elle n'entre pas dans l'empreinte
 * du texte). Relecture `juridique-rgpd` et d'un avocat à faire, avec le texte provisoire de la case.
 */
export const PRIVACY_MARKETING_EMAILS_EFFECTIVE_DATE = "26 novembre 2026";

export const LEGAL_DOCUMENTS = {
  legal: {
    version: "2026-10-26.2",
    sha256: "dde9d6be17b0ad750cb04fbcca4b51555c90324e143b9605523004ccca674247",
    effectiveDate: FLOOD_LEGAL_EFFECTIVE_DATE,
    path: "/legal",
  },
  terms: {
    version: "2026-11-15.3",
    sha256: "caca834bbfc7fb409b5817de73bd703ea61845cc25c14517022ab3244fd49a1e",
    effectiveDate: PEPITE_TERMS_EFFECTIVE_DATE,
    path: "/conditions-generales",
  },
  privacy: {
    version: "2026-11-26.1",
    sha256: "7942138ad871fb1bc03c0f367ad11beb0088e33c8b2150caa038d49e0278de53",
    effectiveDate: PRIVACY_MARKETING_EMAILS_EFFECTIVE_DATE,
    path: "/privacy",
  },
} as const;

export type LegalPublisher = {
  entityName: string | null;
  legalForm: string | null;
  capital: string | null;
  address: string | null;
  registration: string | null;
  vatNumber: string | null;
  publicationDirector: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  mediatorName: string | null;
  mediatorAddress: string | null;
  mediatorWebsite: string | null;
};

export type LegalConfigurationStatus = {
  ready: boolean;
  missing: string[];
};

const REQUIRED_PUBLISHER_FIELDS = [
  ["entityName", "NEXT_PUBLIC_LEGAL_ENTITY_NAME"],
  ["legalForm", "NEXT_PUBLIC_LEGAL_ENTITY_FORM"],
  ["address", "NEXT_PUBLIC_LEGAL_ENTITY_ADDRESS"],
  ["registration", "NEXT_PUBLIC_LEGAL_REGISTRATION"],
  ["publicationDirector", "NEXT_PUBLIC_LEGAL_PUBLICATION_DIRECTOR"],
  ["contactEmail", "NEXT_PUBLIC_LEGAL_CONTACT_EMAIL"],
  ["contactPhone", "NEXT_PUBLIC_LEGAL_CONTACT_PHONE"],
  ["mediatorName", "NEXT_PUBLIC_LEGAL_MEDIATOR_NAME"],
  ["mediatorAddress", "NEXT_PUBLIC_LEGAL_MEDIATOR_ADDRESS"],
  ["mediatorWebsite", "NEXT_PUBLIC_LEGAL_MEDIATOR_WEBSITE"],
] as const;

export const VERCEL_HOSTING_PROVIDER = {
  name: "Vercel Inc.",
  address: "440 N Barranca Avenue #4133, Covina, CA 91723, États-Unis",
  website: "https://vercel.com",
} as const;

export function publicLegalPublisher(): LegalPublisher {
  return {
    entityName: filled(process.env.NEXT_PUBLIC_LEGAL_ENTITY_NAME),
    legalForm: filled(process.env.NEXT_PUBLIC_LEGAL_ENTITY_FORM),
    capital: filled(process.env.NEXT_PUBLIC_LEGAL_ENTITY_CAPITAL),
    address: filled(process.env.NEXT_PUBLIC_LEGAL_ENTITY_ADDRESS),
    registration: filled(process.env.NEXT_PUBLIC_LEGAL_REGISTRATION),
    vatNumber: filled(process.env.NEXT_PUBLIC_LEGAL_VAT_NUMBER),
    publicationDirector: filled(process.env.NEXT_PUBLIC_LEGAL_PUBLICATION_DIRECTOR),
    contactEmail: filled(process.env.NEXT_PUBLIC_LEGAL_CONTACT_EMAIL),
    contactPhone: filled(process.env.NEXT_PUBLIC_LEGAL_CONTACT_PHONE),
    mediatorName: filled(process.env.NEXT_PUBLIC_LEGAL_MEDIATOR_NAME),
    mediatorAddress: filled(process.env.NEXT_PUBLIC_LEGAL_MEDIATOR_ADDRESS),
    mediatorWebsite: filled(process.env.NEXT_PUBLIC_LEGAL_MEDIATOR_WEBSITE),
  };
}

export function legalConfigurationStatus(
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): LegalConfigurationStatus {
  const missing = REQUIRED_PUBLISHER_FIELDS.filter(([, name]) => !filled(env[name])).map(
    ([, name]) => name,
  );
  return { ready: missing.length === 0, missing };
}

/** Uses the statically referenced public variables that Next.js includes in the client bundle. */
export function legalPublisherConfigurationStatus(
  publisher: LegalPublisher = publicLegalPublisher(),
): LegalConfigurationStatus {
  const missing = REQUIRED_PUBLISHER_FIELDS.filter(([field]) => !publisher[field]?.trim()).map(
    ([, name]) => name,
  );
  return { ready: missing.length === 0, missing };
}

export function assertPaidOfferLegalReadiness(
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): void {
  const status = legalConfigurationStatus(env);
  if (!status.ready) {
    throw new ConfigurationError(
      `Configuration juridique incomplète: ${status.missing.join(", ")}. Le checkout est suspendu.`,
    );
  }
}

export function legalValue(
  value: string | null,
  fallback = "À renseigner avant commercialisation",
) {
  return value ?? fallback;
}

function filled(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
