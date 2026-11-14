# État des lieux général du 14/11/2026

**Mission.** Faire le point sur tout Immojudis six jours après l'état des lieux du 08/11
(`2026-11-08-etat-des-lieux.md`). Depuis, environ 300 commits sont arrivés sur `main` (d80a590 → e874bc8) :

- registre des pièces, lots R1 à R2c ;
- agent d'information, enrichissement automatique et pilote d'envoi aux avocats ;
- administration ;
- contacts Licitor et notaires ;
- démarrage robuste de la collecte ;
- prérequis Stripe (#453) ;
- lecture des pièces v4 ;
- refonte des 12 et 13/11.

Une attention particulière a été portée à trois échéances :

- la simulation du pilote, lundi 16/11 ;
- les premiers envois réels manuels, prévus du 17 au 19/11 ;
- l'ouverture des paiements.

En cours de session, le propriétaire a ajouté une demande : optimiser le classement sur une liste de mots-clés
(export Keyword Planner du 12/11). Elle fait l'objet de la section 6.

**Déroulé.**

- **Analyse.** 20 spécialistes ont travaillé en lecture seule, en une seule vague (Technique 8, Données 5,
  Produit 3, Commercial 3, juridique-rgpd 1).
- **Consolidation.** Les rapports ont ensuite été consolidés par les quatre chefs de département
  (`architecte-logiciel`, `qualite-donnees`, `product-explorer`, `directeur-marketing`).
- **Juridique.** `juridique-rgpd` rend compte directement.
- **Mots-clés.** Un second passage de `seo-expert` a porté sur le fichier de mots-clés.
- **Fichiers et base.** Aucun fichier du dépôt n'a été modifié, hors ce compte-rendu. La base de production n'a
  reçu que des SELECT bornés, passés par `qualite-donnees` entre 10:54 et 10:58 UTC.
- **Lectures publiques.** Trois lectures publiques de production ont été faites : `/api/billing/offer`,
  `/robots.txt` et `/offres`.
- **Vérification.** J'ai rouvert moi-même dans le code chaque proposition Critique et chaque Haute du tableau
  (liste en section 8).
- **Annexes.** Les quatre consolidations, le rapport juridique et le rapport sur les mots-clés figurent en
  annexe, sans retouche.

**Vérifications de base (Node 24).**

| Contrôle               | Résultat                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| tsc                    | OK, avec `--max-old-space-size=6144` : il manque de mémoire à 2 Go quand 20 agents tournent, voir E1 |
| lint                   | OK                                                                                                   |
| Vitest                 | 1 070 fichiers et 15 302 tests verts                                                                 |
| Invariants de sécurité | 56 contrôles OK                                                                                      |

Le premier `npm ci` a échoué : la session démarre en Node 22, alors que le projet exige Node 24 (`/opt/node24/bin`).

---

## 1. Synthèse

Le code reste sain : les contrôles passent, et le pilote ne peut rien envoyer seul. Le mode réel est verrouillé
en profondeur, avec cinq verrous indépendants. Trois sujets dominent cet état des lieux.

1. **Le paiement de l'offre Analyse est ouvert en production, sans trace de décision.**
   - **Constat [vérifié].** `/api/billing/offer` répond `configured: true` : clé Stripe, Price, secret du
     webhook, identité légale et configuration email sont tous posés. `/offres` présente l'offre comme
     souscriptible.
   - **Ce qui manque.** La recette en mode test n'est notée nulle part. Les CGU en vigueur portent encore la note
     « BROUILLON à faire valider par un avocat avant la mise en ligne ».
   - **Défauts vérifiés dans le code.** Une rétractation relancée peut rembourser deux fois. Le retour arrière
     du runbook ferait passer les abonnés prélevés en Découverte. Rien n'empêche une clé de test en production.
   - **Inconnu.** On ne sait pas si l'ouverture est voulue, ni si la clé est en mode test ou en mode réel.
2. **Les envois réels aux avocats, du 17 au 19/11, ne sont pas prêts.**
   - **Côté juridique.** La mise en balance n'est ni à jour ni validée. Il n'y a pas d'AIPD. Les contrats de
     sous-traitance de Resend et de Replicate ne sont pas signés. L'accord de Licitor n'est pas versé au dossier.
   - **Côté technique.** Accepter une réponse d'avocat écrit encore la fiche par l'ancien chemin, sans la
     protection du registre : la collecte suivante peut l'écraser. L'administration n'a pas de second facteur.
   - **Côté rédaction.** L'email aux avocats mérite trois retouches avant le premier envoi.
3. **La simulation de lundi tiendra, mais peut s'arrêter d'elle-même.** Un brouillon réutilisé dont la vente a
   changé est compté comme « rejet de politique ». Deux rejets en 7 jours arrêtent le pilote et remettent à zéro
   l'horloge des 7 jours. La marche décrite le 14/11 doit aussi être mise à jour : `qualite-donnees` mesure le
   pilote **déjà en simulation depuis le 14/11 à 10:47 UTC**, alors que le compte-rendu du matin le disait
   éteint.

**Côté investisseur, rien n'a bougé depuis le 08/11.**

- Aucune mesure d'usage n'a été relevée.
- La base compte 0 déblocage sur le mois courant.
- Le registre des pièces n'a encore aucune décision, et aucune valeur d'avocat n'a été publiée.
- Les deux modèles LightGBM antérieurs à la porte d'activation sont toujours actifs (D1 du 08/11).
- La page publique de méthode affirme une vérification qu'ils n'ont pas eue.

---

## 2. Décisions qui reviennent au propriétaire

Elles sont classées par urgence. Les numéros renvoient au tableau de la section 3.

1. **Aujourd'hui : le paiement (C1).**
   - Questions : l'ouverture est-elle voulue ? Quel est le préfixe de `STRIPE_SECRET_KEY` sur la cible
     Production ? Combien d'abonnements existent ?
   - **Ma recommandation : refermer la vente jusqu'à ce que C3 (contrôle du mode), C4 (recette) et C5 (CGU
     relues par un avocat) soient faits.** Pour refermer, il faut appliquer la consigne de C2 : copier d'abord
     le Price dans `STRIPE_ANALYSIS_LEGACY_PRICE_IDS`, **puis** retirer `STRIPE_ANALYSIS_PRICE_ID`. Retirer le
     Price seul, comme le dit le runbook, laisserait d'éventuels abonnés prélevés sans accès.
2. **Avant lundi 9 h 30 : l'état du pilote.**
   - Qui l'a passé en simulation le 14/11 à 10:47 UTC, et quel réglage a changé à 10:45 ?
   - Quelles sont les valeurs actuelles de « Licitor décodées » et de « Article 14 » ?
   - Il reste aussi à traiter les 2 réponses non rattachées (D1).
3. **Les envois réels du 17 au 19/11 (J7).** Ma recommandation : **les reporter**, sans toucher à la
   simulation, jusqu'à ce que trois conditions soient remplies :
   - (a) la mise en balance est mise à jour et validée ;
   - (b) les contrats de sous-traitance de Resend et de Replicate sont signés, avec leur garantie de transfert ;
   - (c) la trace écrite de l'accord de Licitor est versée au dossier.

   À défaut, limiter les envois aux adresses publiées en clair. Ce délai laisse le temps de faire T3 (second
   facteur), T4 (protection des valeurs acceptées), T10, C12 à C14 et J10.

4. **Le second facteur de l'administration (T3).** Faut-il rouvrir le risque accepté le 12/11 ? Les envois
   réels et le paiement ouvert sont des faits nouveaux. Ma recommandation : oui, avant le premier envoi réel.
5. **Le texte de la mention de source sur la fiche** (conflit A, section 4). À trancher avec `juridique-rgpd` et
   `gardien-marque`, avant d'écrire le pied d'email de J10.
6. **Le palliatif de T4** : passer par `accept_auction_fact_claim`, ou rendre visibles les observations du pont.
7. **Les modèles de valorisation (D2).** Faire le retour arrière (action B du runbook), ou déployer la correction
   de code qui cesse de les servir.
8. **La refonte par zone** (conflit B). Agent d'information à partir du 23/11 (Technique), ou rien hors des
   zones « Maintenant » avant l'ouverture du paiement (Produit) ?
9. **Le référencement.**
   - Avez-vous accès à Google Search Console, sur quelle propriété, et depuis quand ?
   - Comment répartir « enchères immobilières » entre l'accueil et `/sales` (S1) ?
   - Faut-il créer les pages des ventes notariales, des maisons et appartements, et des ventes de l'État
     (S3, S4, S7) ?
   - Quelle règle appliquer aux robots d'IA ?
10. **Les essais payants** (section 7). Ils coûtent de 0,08 à 1,53 USD chacun.
11. **La refonte des 13/11.** Qui a validé les listes de tests supprimés (T18) ?

---

## 3. Tableau des propositions Critiques et Hautes

La numérotation est propre à ce compte-rendu. L'ancien numéro du 08/11 est donné entre parenthèses quand un
point est repris. Les préfixes sont les suivants :

| Préfixe | Origine                    |
| ------- | -------------------------- |
| D       | Données                    |
| T       | Technique                  |
| P       | Produit et expérience      |
| C       | Commercial et contenus     |
| J       | juridique-rgpd             |
| S       | Mots-clés (section 6)      |
| E       | Fonctionnement de l'équipe |

Les propositions Moyennes et Basses sont résumées en section 5, et détaillées dans les annexes. Elles se
valident par leur numéro de la même façon.

**Échéances :**

- **L** : avant lundi 16/11 ;
- **E** : avant le premier envoi réel ;
- **€** : maintenant que le paiement est ouvert ;
- **R** : avant le mode réel du pilote.

Avis du chef : **garder**, **discutable** (dépend d'une décision ou d'une mesure), **écarté**.

### Critiques

| N°       | Agents                                                | Proposition                                                                                                                                                                                                                                                                                                  | Effort           | Éch. | Avis   |
| -------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- | ---- | ------ |
| C1       | directeur-marketing, paiements-stripe                 | Décision écrite sur l'ouverture du paiement, mode de la clé, nombre d'abonnements (décision 1). **[vérifié]** `configured: true` en production.                                                                                                                                                              | S (propriétaire) | €    | garder |
| C2       | paiements-stripe                                      | Le retour arrière du runbook prive d'accès des abonnés prélevés (`ouverture-paiements.md:121-122`, `billing.ts:1238-1243`). Consigne immédiate : copier le Price en « legacy » avant de le retirer. Correction durable : un interrupteur de vente lu par la garde, et le runbook corrigé. **[vérifié]**      | S                | €    | garder |
| C3       | paiements-stripe                                      | Refuser `sk_test_` au build Production, rejeter un webhook dont `livemode` diverge de la clé, et fermer la garde en cas de divergence (`analysis-checkout-readiness.ts:44-58`). **[vérifié]** que rien ne le contrôle.                                                                                       | S                | €    | garder |
| C4       | paiements-stripe, directeur-marketing                 | Recette en mode test jamais notée. Corriger d'abord le scénario 7. Cocher `invoice.payment_action_required` sur le webhook. Relire en production les migrations `20261110140000`, `20261110140100` et `20261113100000`.                                                                                      | M                | €    | garder |
| C5 (J17) | juridique-rgpd, directeur-marketing, paiements-stripe | CGU 2026-11-10.1 en vigueur alors que leur note dit « BROUILLON à faire valider par un avocat avant la mise en ligne » (`legal-documents.ts:24-35`). Préavis de l'article 14, article 8 sans les informations transmises par l'avocat, « 59 € TTC » à côté de « TVA non applicable ». **[vérifié]**          | S + avocat       | €    | garder |
| J7       | juridique-rgpd                                        | Conditions du premier envoi réel non remplies : mise en balance sans validateur et périmée (pilote, notaires, affichage des réponses), DPA de Resend et Replicate « à vérifier », accord de Licitor absent du dossier. Aucun envoi réel avant (a), (b) et (c) (décision 3). **[vérifié]** sur les documents. | M                | E    | garder |
| D1       | qualite-donnees                                       | 2 réponses non rattachées en attente ; l'alerte `information_agent.unrouted.pending` est ouverte depuis le 11/11 (147 occurrences). Elles sont à traiter dans l'onglet Réponses. [mesuré par qualite-donnees]                                                                                                | S (propriétaire) | L    | garder |

Les chefs ont ramené à Haute deux Critiques des spécialistes. Le premier est le faux arrêt de la simulation
(T1) : il échoue du côté sûr, sans tort à un tiers. Le second est la ligne de base produit (P1) : elle ne porte
aucun risque, mais c'est un préalable à toute mesure. Je confirme ces deux arbitrages.

### Hautes : Technique

| N°  | Agents                                | Proposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Effort   | Éch.                  | Avis                |
| --- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------- | ------------------- |
| T1  | code-reviewer, fiabilite-sre          | Le pilote réutilise un brouillon dont la vente a changé, ou dont l'avocat vient de recevoir un envoi manuel. L'aperçu le refuse et le compte `policy_rejected`. Deux refus en 7 jours arrêtent le pilote et remettent l'horloge à zéro. De plus, les 5 mêmes ventes reviennent à chaque passage. Correction : écarter les ventes déjà simulées, compter un brouillon périmé en `draft_stale` sans rejet, appliquer le délai de 30 jours à la sélection. Sans code : avant tout envoi manuel, annuler les autres brouillons du pilote adressés au même avocat. **[vérifié]** (`information-agent-autopilot.ts:326-342, 512-540` ; `preview.ts:116-118` ; `autopilot-rules.ts:511`) | S        | L                     | garder              |
| T2  | fiabilite-sre                         | Procédure de pilotage dans le runbook : lire les événements, vérifier un arrêt, réarmer, que faire d'un pilote muet, remettre `INFORMATION_AGENT_OUTBOUND_ENABLED` à son état initial (la variable ouvre l'envoi manuel de tout l'agent). **[vérifié]** absence.                                                                                                                                                                                                                                                                                                                                                                                                                  | S        | L                     | garder              |
| T3  | securite-applicative, fiabilite-sre   | L'administration n'a pas de second facteur (`admin-mfa.ts:22-24`, faux par défaut). Un mot de passe volé suffit pour écrire à des avocats et décider sans plafond au registre. Enrôler le TOTP et activer les trois interrupteurs (application, base, registre). **[vérifié]** code ; enrôlement inconnu.                                                                                                                                                                                                                                                                                                                                                                         | S        | E, €                  | garder (décision 4) |
| T4  | archeologue-code, architecte-logiciel | « Accepter et mettre à jour la fiche » passe encore par l'ancien noyau : `update auction_sales` direct (`20261114100000:265-317`), sans `held_fields`. Le pont crée une observation `accepted` sans décision, visible dans aucune file. Le noyau admet aussi `owner_occupied` et `squatted`, que le registre refuse. La bascule R2 « noyau → observation, décision, projection » n'est pas faite. Palliatif S (décision 6), puis bascule L en lot dédié. **[vérifié]**                                                                                                                                                                                                            | S puis L | E                     | garder              |
| T5  | fiabilite-sre, expert-postgres        | Le pilote est absent de `cron.stale` (`20261117100600:38-42`). Une panne de pg_cron, de Vault ou de `VERCEL_ENV` ne sonne nulle part. Or la porte « 7 jours de simulation » compte le temps écoulé, pas les passages : un pilote muet la remplit. Alerte `information_agent.autopilot.silent`, et porte comptée en jours avec passage. **[vérifié]**                                                                                                                                                                                                                                                                                                                              | M        | pendant la simulation | garder              |
| T6  | fiabilite-sre                         | Dès qu'une tâche a été reportée par le budget IA, `pipeline.enrichment.stalled` ne regarde plus que `source_detail` (`20261029170100:516-523`) : une lecture PDF bloquée reste invisible. Compter à part toute tâche immobile depuis 24 h. **[vérifié]**                                                                                                                                                                                                                                                                                                                                                                                                                          | M        | semaine du 16/11      | garder              |

### Hautes : Données

| N°           | Agents                             | Proposition                                                                                                                                                                                                                                                                                                | Effort | Éch.                | Avis                        |
| ------------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------- | --------------------------- |
| D2 (D1, D19) | qualite-donnees, qa-modeles        | Les 2 modèles `lgbm-cqr-20260713` sont toujours actifs, sans `localMarket` ni comparaison [mesuré]. Correction : cesser de servir un modèle sans export, en renvoyant `null` au lieu de `legacyLocalFeatures` (`hybrid-market-valuation.ts:104-106`). Retour arrière à décider (décision 7). **[vérifié]** | S      | €                   | garder                      |
| D3           | qa-modeles                         | La page publique dit que la couverture « est mesurée avant sa mise en service » (`methode-ecart-marche/page.tsx:143-146`). C'est faux pour les modèles actifs. À corriger avec D2, relecture `juridique-rgpd`. **[vérifié]**                                                                               | S      | €                   | garder                      |
| D4           | qa-modeles                         | Un entraînement qui échoue aux seuils absolus ne laisse ni rapport ni artefact (`valuation_training.py:217-231`, pas de `if: always()`). Écrire le rapport avant le contrôle.                                                                                                                              | S      | —                   | garder                      |
| D5 (D6)      | prompts-llm, qa-modeles            | Le titre d'un point de lecture n'est contrôlé que pour les contacts (`document_reading.py:644-650`) : pas pour les chiffres absents de la page, les mots de risque, les formules promotionnelles, ni pour la contradiction d'occupation hors thème.                                                        | S      | —                   | garder                      |
| D6           | prompts-llm                        | La lecture des pièces n'appelle pas `contains_prompt_injection` : une consigne cachée dans un PDF arrive au modèle. Retirer ces pages et écarter les points cités dessus. **[vérifié]** absence.                                                                                                           | S-M    | —                   | garder                      |
| D7           | prompts-llm                        | Une réponse hors format (sans `points`) donne une lecture `completed` à 0 point, qui écrase une bonne lecture (`document_reading.py:874-885, 1083`). La classer `failed`. **[vérifié]**                                                                                                                    | S      | —                   | garder                      |
| D8 (D18)     | prompts-llm, qualite-donnees       | Règle `unsupported_risk_term` absente : un résumé « mérule, amiante, squat » sans appui passe et remplace la description publique. **[vérifié]** absence.                                                                                                                                                  | S      | —                   | garder                      |
| D9           | data-pipeline                      | Notaires : le nom du contact (négociateur, personne physique) devient `lawyer_name` sans préfixe professionnel (`notaires.py:697-698`), et `lawyer_contact` reprend son téléphone et son email. **[vérifié]** code ; affichage public non vérifié.                                                         | S      | E (envois notaires) | garder                      |
| D10          | qualite-donnees                    | Contacts : Licitor 177 sur 382 ventes à venir ; notaires 0 sur 204 alors que 188 ont une adresse. Cause non établie.                                                                                                                                                                                       | M      | E                   | discutable (mesure d'abord) |
| D11          | data-pipeline                      | Décodage des adresses Licitor actif par défaut (`data-pipeline.yml:160`, `\|\| 'true'`) sur un accord non versé. Tenir un dossier daté (pièce, conservation, purge). Lié à J7 (c). **[vérifié]**                                                                                                           | S / M  | E                   | garder                      |
| D12          | qualite-donnees                    | Tâche PDF en `running` depuis le 11/11 12:58 (bail expiré) qui bloque une vente ; 413 tâches `source_detail` de plus de 24 h jamais essayées. Débloquer, en lien avec T6. [mesuré]                                                                                                                         | M      | semaine du 16/11    | garder                      |
| D13          | qualite-donnees                    | 33 ventes à venir visibles, sans date, non revues depuis août ou septembre (encheres_publiques 13, notaires 18, avoventes 1, cessions_etat 2). Les masquer ou les passer en statut inconnu. [mesuré]                                                                                                       | S      | —                   | garder                      |
| D14          | qualite-donnees                    | 0 décision et 0 publication : contrôler à la main la première décision acceptée (cohérence avec l'annonce et les pièces). [mesuré]                                                                                                                                                                         | S      | E                   | garder                      |
| D15          | qa-modeles, statisticien           | Les 215 cas du banc servent à régler et à certifier : « zéro publication fausse » sera atteint par construction (`2026-11-10-enrichissement-automatique-fiches.md:284`). Il faut un jeu scellé, dimensionné (zéro sur 17 ne prouve qu'un taux inférieur à 16 %). **[vérifié]**                             | M      | R                   | garder                      |
| D16 (+ P8)   | statisticien, analyste-indicateurs | Écrire le protocole du pilote et du lot R8 : indicateur par cohorte, ce que les effectifs permettent de conclure (aucun taux sur 1 à 3 envois), requête agrégée après le premier envoi.                                                                                                                    | S      | L                   | garder                      |
| D17 (T23)    | statisticien, archeologue-code     | Prix au m² et rendement calculés sur la surface présumée de 20 m² : `kind` reste facultatif. Appels concernés : `MapPanel.tsx:1048`, `sales-statistics-summary.ts:24`, `SaleComparisonTable.tsx:87`. **[vérifié]**                                                                                         | S-M    | —                   | garder                      |
| D18          | qa-modeles, prompts-llm            | L'essai réel de l'agent n'a jamais tourné. La v4 a été promue sur ses ventes de réglage, et une règle a été ajoutée après le dernier essai. Fixer les critères avant tout essai (section 7).                                                                                                               | M      | R                   | discutable (payant)         |

### Hautes : Produit et expérience

| N°               | Agents                                 | Proposition                                                                                                                                                                                                                                                                                                                                                   | Effort           | Éch.                                | Avis                                    |
| ---------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------- | --------------------------------------- |
| P1 (P2, P7)      | product-explorer, analyste-indicateurs | Ligne de base relevée par le propriétaire avant le 18/11 : activation à 7 et 30 jours (Pilotage), plafonds calculables (Contrôles qualité), plan Vercel et console Events. Un déblocage se compte dans `user_sale_unlocks`, pas avec `sale_unlock_confirmed`. **[vérifié]** que les écrans existent.                                                          | S (propriétaire) | —                                   | garder (ramené de Critique)             |
| P2               | ux-designer, chef de département       | Mettre à jour la marche de lundi : état réel d'abord ; dépliant « Réglages » et non l'onglet ; rien avant 9 h 30 ; les « Non » du contrôle de préparation sont attendus ; lexique des codes ; ne pas réarmer après `policy_rejections`.                                                                                                                       | S (texte)        | L                                   | garder                                  |
| P3 (+ J9)        | ux-designer, juridique-rgpd            | « Licitor décodées » et « Article 14 » sont deux boutons d'état collés, sans confirmation (`AdminInformationAgentAutopilotPanel.tsx:155-180`). « Attester l'AIPD » est dans le même bloc. Boutons d'action, Article 14 non désactivable et borné de 1 à 30 jours en base (aujourd'hui 1 à 365, `20261110230000:46-47`), bloc Conformité à part. **[vérifié]** | S + S            | E                                   | garder                                  |
| P4 (P30)         | ux-designer                            | Mention de l'avocat : la placer après « Prix de départ », mettre les termes au glossaire, lien « Où consulter le cahier », corriger « (sans l'heure) » et les accords. Le **texte** reste en conflit (A).                                                                                                                                                     | S                | avant la première décision acceptée | garder (placement) ; discutable (texte) |
| P5 (P1)          | product-explorer, ux-designer          | « S'inscrire » de l'en-tête perd la vente (`site-header-shared.tsx:86`) : la fiche note son adresse en `sessionStorage`, `/login` la lit.                                                                                                                                                                                                                     | S                | —                                   | garder                                  |
| P6 (P17)         | product-explorer                       | Liste go / no-go à dater du 14/11 : P7 codé, second facteur refusé le 12/11, Lovable supprimé, notaires sur accord oral, Vercel, recette Stripe, et ouverture du paiement (C1).                                                                                                                                                                               | S                | —                                   | garder                                  |
| P7               | product-explorer                       | Lot R3 : traiter les lots et la surface avant le nombre de pièces, qui ne bloque aucun plafond.                                                                                                                                                                                                                                                               | S (décision)     | avant R3                            | discutable                              |
| P9 (C5 du 08/11) | product-explorer                       | La fiche publique vend l'adresse plutôt que le plafond (`SalePublicPreview.tsx:634-639`).                                                                                                                                                                                                                                                                     | S-M              | —                                   | discutable (conflit 1 du 08/11)         |
| P10              | product-explorer                       | Reporter le DPE, l'occupation automatique, R9 et la refonte hors des zones « Maintenant » jusqu'à l'ouverture du paiement.                                                                                                                                                                                                                                    | S                | —                                   | discutable (conflit B)                  |

### Hautes : Commercial et contenus

| N°             | Agents                                       | Proposition                                                                                                                                                                                                                                      | Effort | Éch. | Avis                                       |
| -------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | ---- | ------------------------------------------ |
| C6 (C9)        | paiements-stripe                             | Rétractation en mode `full` relancée plus de 24 h après : une autre charge est remboursée, soit 59 € de plus (`contract-withdrawal.ts:143-158`). Consigne immédiate : ne jamais relancer sans lire les remboursements dans Stripe. **[vérifié]** | S      | €    | garder                                     |
| C8 (C7)        | strategie-email (08/11), directeur-marketing | Un rebond ou une plainte n'arrête ni l'avis J+5 ni l'email d'ouverture (`account-email-delivery-events.ts:95-106`). Ne pas lancer l'envoi d'ouverture avant.                                                                                     | M      | €    | garder                                     |
| C9             | directeur-marketing                          | Mois épuisé : « Voir l'offre Analyse » perd la vente visée. Proposer « Ouvrir cette vente avec Analyse », avec retour sur la fiche.                                                                                                              | M      | €    | garder                                     |
| C10 (C18)      | directeur-marketing                          | Carte Analyse de l'accueil : dire les vraies différences (toutes les ventes au-delà de 3, jusqu'à 25 alertes, email quotidien), et « 7 jours pour ouvrir toutes les ventes, sans carte bancaire ».                                               | S      | €    | garder                                     |
| C11 (C2)       | directeur-marketing, juridique-rgpd (J5)     | Fin d'essai : nommer ce que la personne a construit et ce qu'elle garde.                                                                                                                                                                         | M      | €    | garder                                     |
| C12            | directeur-marketing                          | Email et formulaire : « Rien n'est publié sans vérification » contredit « non vérifiée par Immojudis » : écrire « relecture ».                                                                                                                   | S      | E    | garder                                     |
| C13 (+ J15)    | directeur-marketing, juridique-rgpd          | Bloc de dépôt de l'email (bouton doré qui évoque un hameçonnage), invitation à joindre « documents ou photos » et citation du procès-verbal descriptif, qui contient l'identité des occupants : une ligne de texte, sans invitation aux pièces.  | S-M    | E    | garder                                     |
| C14            | directeur-marketing                          | Email aux avocats : remonter l'intérêt de l'avocat avant les questions ; retirer la leçon de procédure (« 10 % de la mise à prix… »).                                                                                                            | S      | E    | garder                                     |
| C15            | directeur-marketing                          | Page publique « Vous avez reçu une demande d'Immojudis ? », qui pourra porter la procédure de retrait de J10.                                                                                                                                    | M      | R    | garder                                     |
| C16 (C3-C5)    | directeur-marketing, seo-expert              | Chapô des départements, de `/sales` et de la fiche : attend le conflit 1 du 08/11. « dès qu'elles sont publiées » (`department-view.tsx:454`) se corrige tout de suite.                                                                          | M      | —    | garder (la phrase) ; discutable (le reste) |
| C17 (C8)       | directeur-marketing                          | Consentement aux alertes daté, et source `onboarding_trial`.                                                                                                                                                                                     | M      | €    | garder                                     |
| C18 (C15, C16) | directeur-marketing                          | Page « méthode du plafond », encart Alsace-Moselle.                                                                                                                                                                                              | M      | —    | garder                                     |
| C19 (C13)      | directeur-marketing                          | « Essai d'ouverture » : la décision P3 du 08/11 devient urgente.                                                                                                                                                                                 | M      | €    | discutable (décision)                      |
| C20 (C14)      | directeur-marketing                          | Mettre à jour 3 articles de `/ressources`.                                                                                                                                                                                                       | S      | —    | discutable (non vérifié)                   |

### Hautes : juridique-rgpd

| N°                | Proposition                                                                                                                                                                                                                                                      | Effort | Éch.             | Avis                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------- | ------------------------------------------------------------ |
| J8                | Aucune AIPD n'existe alors qu'au moins quatre critères CNIL sont réunis. La rédiger sur l'agent, le pilote, le registre et les photos. Écrire « requise » au registre. Lier l'attestation à un document versionné (chemin et empreinte) et non à un texte libre. | L      | R (E recommandé) | garder                                                       |
| J10               | L'avocat ne sait pas que sa réponse peut être affichée, ni comment la faire retirer. Pied de message à compléter ; une opposition vaut retrait. Dépend du conflit A.                                                                                             | S-M    | E                | garder                                                       |
| J11               | Nouvelle version de la politique de confidentialité : affichage des réponses des avocats, photos tirées des pièces, opposition par structure, garanties de transfert nommées, plus les restes de J3.                                                             | M      | E                | garder                                                       |
| J12 (+ T16)       | Registre en retard : aucune ligne pour le pilote (journal 5 ans, exclusions 24 mois, attestations 5 ans), purge présentée comme « à prévoir » alors qu'elle existe, notaires.fr marqué désactivé. Tables du pilote absentes de la matrice de conservation.       | S      | E                | garder                                                       |
| J14 (T1 du 08/11) | Photos des procès-verbaux d'huissier toujours publiées, avec une base légale « à renseigner ». Minimum : mise en balance écrite, paragraphe dans la politique, retrait des photos où l'on voit des personnes ou des effets personnels.                           | M      | —                | discutable (le propriétaire a décidé de les garder le 08/11) |

### Hautes : mots-clés (détail en section 6)

| N°  | Proposition                                                                                                                                                 | Effort | Avis                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------- |
| S1  | Titre de l'accueil centré sur « enchères immobilières » (~26 000 recherches par mois), au lieu de « judiciaires » (~3 150). Répartir l'accueil et `/sales`. | S      | garder (décision de répartition)            |
| S2  | Titre de l'article notarial tourné vers « enchères des notaires ».                                                                                          | S      | garder                                      |
| S3  | Page « Ventes aux enchères notariales » avec catalogue serveur, et seuil d'indexation.                                                                      | L      | discutable (décision)                       |
| S4  | Pages « maison aux enchères » et « appartement aux enchères », une seule fois chacune, contenu réel.                                                        | L      | discutable (règle de canonique de `/sales`) |
| S9  | Règle : aucune marque de concurrent dans un titre, un H1 ou une description. Aucune page « alternative à… ».                                                | S      | garder                                      |

---

## 4. Conflits

**Tranchés par les chefs de département, confirmés par moi**

- **Gravité de T1.** Ramené de Critique à Haute : il échoue du côté sûr, mais doit être fait avant l'étape 4.
- **Gitleaks (T14).** devops-ci le classait Haute, securite-applicative Basse : il passe en Moyenne. Les deux
  agents proposent la même correction.
- **D4 (« 5.3 ventes »).** Fait, et non partiel (`market-estimate-ceiling.ts:66`, `market-estimate-display.ts:38-42`).
- **La mention de source « n'apparaît sur aucune fiche ».** C'est vrai, et c'est cohérent avec la description
  qu'en fait ux-designer. Le code est prêt, mais aucune décision n'a encore été acceptée.
- **C6 du 08/11 (événements de mesure).** Commercial le classait Haute (C7), Produit Moyenne. Je retiens
  **Moyenne** et je le fusionne dans P21 : sans plan Vercel Pro, les événements ne seraient pas lisibles (P1
  d'abord).
- **Fermer la vente en retirant le Price.** Écarté au profit de C2 : retiré seul, il priverait d'accès des
  abonnés prélevés.

**Non tranchés**

- **A. Texte de la mention « non vérifiée par Immojudis »** (`lawyer-fact-sources.ts:123`, validé le 10/11).
  - ux-designer : « Source : avocat poursuivant, message du … À confirmer dans le cahier des conditions de vente,
    comme toute donnée de la fiche. »
  - directeur-marketing : « …reprise telle quelle. Seul le cahier des conditions de vente fait foi : vérifiez-la. »
  - juridique-rgpd : garder le texte actuel et le citer dans le pied d'email (J10).

  Argument des deux reformulations : la source la plus sûre est aujourd'hui la seule marquée « non vérifiée ».
  Mais « comme toute donnée de la fiche » n'est vrai que si les autres valeurs portent une réserve équivalente.
  Au propriétaire, avec juridique-rgpd et gardien-marque, avant le premier envoi réel. C12 avance sans attendre.

- **B. Refonte par zone.** Technique : agent d'information et pilote en premier, pas avant le 23/11, après le
  compte-rendu de la refonte des 12-13/11 (T18) et la bascule T4. Option contraire : « santé opérationnelle et
  planification », plus petite. Produit (P10) : aucune refonte hors des zones « Maintenant » avant l'ouverture du
  paiement. **Mon avis : pas de refonte la semaine du 16/11.** La suite est au propriétaire.
- **C. Palliatif de T4** (décision 6).
- **D. Conflit 1 du 08/11** (« l'enchère à ne pas dépasser », J2). Toujours ouvert, il bloque P9 et C16.

---

## 5. Propositions Moyennes et Basses (résumé)

Le détail, les fichiers et les preuves sont dans les annexes de chaque département.

**Technique.**

- **Moyennes, lot du pilote recommandé avant lundi :**
  - T7 : panne passagère d'Auth qui arrête le pilote ;
  - T8 : `markSimulated` peut écraser `metadata` ;
  - T9 : libellé `run_errors` faux.
- **Moyennes, autres :**
  - T10 : « 1 250 m² » lu 250 m² dans les réponses d'avocats, avant E ;
  - T11 : file recalculée à chaque passage ; mesure M1 lundi ;
  - T12 : statut « accepté » à deux sources ;
  - T13 : forme des variables d'envoi non contrôlée ;
  - T14 : Gitleaks par valeur exacte ;
  - T15 : invariants (webhooks, `live_allowed`) ;
  - T16 : fusionné dans J12 ;
  - T17 : runbooks des alertes `fact_registry.*` et `catalogue.quality.*` ;
  - T18 : compte-rendu a posteriori de la refonte des 12-13/11 ;
  - T19 : budget JS relevé 4 fois (relais `format.ts`) ;
  - T20 : deux budgets IA (USD et EUR) ;
  - T21 : contrôle de dérive (cron, Vault, droits) ;
  - T22 : pas d'alerte si le webhook Resend se tait ;
  - T23 : plafonds non simulés ;
  - T24 : 10 routes sans appelant ;
  - T25 : filets de test de routes, dont `sale-analysis-sets` ;
  - T26 : clore l'incident Licitor sur preuve (8 passages réussis depuis le 11/11) ;
  - T27 : concurrence du quota de déblocage ;
  - T28 : clé de verrou recopiée 5 fois ;
  - T29 : garde CI contre les réparations dans les migrations.
- **Basses :**
  - T30 : bail du pilote à 330 s, dans le lot du pilote ;
  - T31 : codes bruts dans « Derniers événements », dans le lot du pilote ;
  - T32 à T40 : règle de numérotation des migrations, documentation périmée (README, runbook, SKILL phase 4,
    définitions d'agents), rangement de l'agent, résidus Lovable, seconde liste des noms de sources, etc.
- **Règle à retenir.** Toute nouvelle migration porte un numéro ≥ `20261119100600`.

**Données.**

- **Moyennes :**
  - D19 : le worker de file ne voit pas la perte du verrou ;
  - D20 : lecture en avance qui dépasse son délai ;
  - D21 : `revalidate_stored_readings` jamais appelée ;
  - D22 : 71 groupes de doublons, fusion non activée ;
  - D23 : réserve des pages département sur `total < 3` ;
  - D24 : porte du modèle sans contrôle par territoire ;
  - D25 : test Vitest de la parité du mélange ;
  - D26 : indicateurs de pilotage biaisés (taux de réponse censuré, porte des 30 envois, rappels) ;
  - D27 : mesurer la coupe à 2 500 caractères ;
  - D28 : pas de retour arrière pour la lecture v4 ;
  - D29 : champs manquants par source, dont la surface Licitor à 37 % ;
  - D30 : Vench et Petites Affiches en quarantaine sans alerte ;
  - D31 : registre inerte.
- **Basses :** D32 à D38 (5 alertes ouvertes, arrondissements, « Fourchette probable à 80 % », « k ventes sur
  n », reproductibilité, réglages des lectures, espace avant « % »).

**Produit.**

- **Moyennes :**
  - P11 : arrêt d'urgence en style « danger », « Réel » en couleur d'alerte ;
  - P12 : libellés français des codes, et prochain passage ;
  - P13 : dépliant « Réglages du pilote », « Non » en couleur neutre ;
  - P14 : `/bienvenue` qui annonce le retour à la vente ;
  - P15 : compteur `manual_oppositions` ;
  - P16 : compter les surfaces saisies ;
  - P17 : mesure avant / après de P5 ;
  - P18 : un seul nom pour le quota ;
  - P19 : prix au m² sur mobile ;
  - P20 : état vide avant le bandeau ;
  - P21 : `upgrade_prompt_viewed`, si P1 confirme le plan Pro ;
  - P22 : « Information demandée au professionnel le … ».

**Commercial.**

- **Moyennes :**
  - C21 : expéditeur `enquete@` codé en dur en trois endroits ;
  - C22 : double email au 3-D Secure ;
  - C23 : bruit du rapprochement ;
  - C24 : prorata de rétractation à la date de la demande ;
  - C25 : tests de rendu serveur ;
  - C26 : `lastmod` figés ;
  - C27 : vente `unknown` passée dans le sitemap ;
  - C28 : `sameAs` ;
  - C29 : FAQ des articles pivots, fusionnée avec S12 ;
  - C30 : repère chiffré sous le prix ;
  - C31 : les réponses des avocats comme argument, plus tard ;
  - C32 : points du 08/11 inchangés.
- **Basse :** C33.

**juridique-rgpd.**

- **Moyennes :**
  - J13 : journaux en ajout seul sans durée ;
  - J16 : risque de requalification en prospection (L. 34-5 CPCE). Garantir techniquement que les adresses de
    l'agent ne servent jamais à vendre la mise en avant ;
  - J18 : sous-traitant du modèle Qwen peut-être non nommé (Haute si Replicate relaie vers Alibaba Cloud).
- **Statut des points du 08/11 :**
  - J1 fait ;
  - J2 ouvert (conflit 1) ;
  - J3 partiel (politique en 2026-11-01.3) ;
  - J4 ouvert (hébergeur) ;
  - J5 ouvert, atténué ;
  - J6 ouvert (formulaire de rétractation sans adresse).

**Fonctionnement de l'équipe (proposé par le chef).**

- **E1 (Moyenne, S).** La session démarre en Node 22. `npm ci` échoue, un spécialiste n'a pas pu lancer
  Vitest, et tsc manque de mémoire quand 20 agents tournent. Inscrire dans `.claude/skills/equipe/SKILL.md` :
  `PATH=/opt/node24/bin:$PATH`, un seul `npm ci` par le chef avant de lancer l'équipe, et
  `NODE_OPTIONS=--max-old-space-size=6144` pour tsc. C'était déjà le point E1 du 08/11 (T31).
- **E2 (Basse, S).** Sept spécialistes sans Bash n'ont pas vu l'historique git, et le clone commence à d80a590.
  Le brief doit leur donner la liste des commits et des fichiers changés, préparée par le chef.

---

## 6. Mots-clés stratégiques (demande du propriétaire, export Keyword Planner du 12/11)

**Les données.**

- **Volume réel.** 976 mots-clés, regroupés en 573 groupes parce que Keyword Planner donne les mêmes chiffres
  aux variantes proches. Cela fait environ **150 000 recherches par mois**, et non 560 000 (somme brute).
- **Concurrence.** La colonne « concurrence » est publicitaire (Google Ads), pas une difficulté de classement.
- **Position actuelle.** Inconnue : les colonnes de position sont vides.
- **Indexation.** Elle est ouverte en production [vérifié] : `robots.txt` annonce les sitemaps, et il n'y a pas
  d'en-tête `noindex`.

**Ce qu'Immojudis peut viser : environ 54 000 recherches par mois.**

| Famille                                         | Recherches par mois             | Page d'Immojudis                   |
| ----------------------------------------------- | ------------------------------- | ---------------------------------- |
| Enchères immobilières générales                 | ~26 000 (-19 à -33 % sur un an) | Accueil, `/sales`                  |
| Maison et appartement aux enchères              | ~11 300                         | Aucune page propre                 |
| Saisies                                         | ~7 800                          | Un article                         |
| Judiciaire strict                               | ~3 150                          | `/ventes-immobilieres-judiciaires` |
| Enchères notariales (bougie, vente interactive) | ~2 600                          | Un article                         |
| Part immobilière des ventes de l'État           | ~1 100                          | Un article                         |
| Géographique                                    | ~1 200                          | Pages département                  |

La demande géographique est très fragmentée : aucune ville ni aucun département ne dépasse 160 recherches.

**Ce qu'il ne faut pas viser : environ 96 000 recherches par mois.**

- **« immobilier notaire(s) » (33 100) et les annonces notariales classiques (~50 000 en tout).** Ce sont des
  ventes de gré à gré, servies par le site des notaires. Immojudis ne les propose pas : les viser serait
  trompeur.
- **« vente domaniales » seul (27 100).** C'est surtout des ventes mobilières du Domaine [supposé], qu'Immojudis
  ne couvre pas.
- **Les marques de concurrents** (Agorastore ~6 400, Licitor ~1 540, Immonotairesencheres, Avoventes).
- **Les sites d'enchères généralistes, les maisons de vente d'art et la vente côté vendeur.**

**Propositions, dans l'ordre conseillé.**

| N°  | Proposition                                                                                                                                                                                          | Priorité | Effort |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| S1  | Titre de l'accueil (`home-seo.ts:10`, aujourd'hui « …judiciaires »), par exemple « Enchères immobilières : tribunal et notaire - Immojudis » ; la mention de l'État est à valider par juridique-rgpd | Haute    | S      |
| S2  | Titre de l'article `ventes-notariales-domaniales-differences-tribunal`                                                                                                                               | Haute    | S      |
| S9  | Aucune marque de concurrent dans les titres                                                                                                                                                          | Haute    | S      |
| S6  | `/ventes-immobilieres-judiciaires` porte « vente judiciaire immobilier »                                                                                                                             | Moyenne  | S      |
| S5  | Angle « acheter un bien saisi » dans le guide et l'article sur la saisie                                                                                                                             | Moyenne  | S      |
| S8  | Fusionné dans C16                                                                                                                                                                                    | —        | —      |
| S12 | Fusionné avec C29 : FAQ et réponse directe sur les articles pivots                                                                                                                                   | Moyenne  | M      |
| S3  | Page des enchères notariales                                                                                                                                                                         | Haute    | L      |
| S4  | Pages maison et appartement aux enchères                                                                                                                                                             | Haute    | L      |
| S10 | Article « Acheter une maison aux enchères »                                                                                                                                                          | Moyenne  | M      |
| S7  | Page des ventes immobilières de l'État, après décision, sans titrer « vente domaniales » ni promettre des enchères                                                                                   | Moyenne  | M-L    |
| S11 | Article sur l'adjudication                                                                                                                                                                           | Basse    | S      |

Les contenus sont à confier à `redacteur-contenu`, et toute mention des notaires ou de l'État à faire relire par
`juridique-rgpd`.

**Mesure.** Il faut un accès à Search Console (décision 9). La mesure de départ porte sur les 28 derniers jours
(impressions, clics, position, page classée), pour 14 requêtes :

- enchères immobilières ;
- ventes aux enchères immobilières ;
- vente immobilière aux enchères ;
- maison aux enchères ;
- appartement aux enchères ;
- vente aux enchères saisies ;
- ventes aux enchères immobilières judiciaires ;
- vente judiciaire immobilier ;
- vente par adjudication ;
- vente saisie immobilière ;
- enchère des notaires ;
- notaire vente aux enchères ;
- vente domaniale immobilier ;
- un témoin local : « vente au enchere immobilier haute savoie ».

La marque « immojudis » sert de témoin. Relever avant tout changement, puis 2 à 4 semaines après chaque lot. Avec
un mois d'indexation seulement (depuis le 15/10), la mesure de départ est une référence, pas un verdict.

---

## 7. Mesures et essais

**Mesures en base (qualite-donnees, 14/11, 10:54-10:58 UTC).**

- **Pilote.** Mode `simulation` depuis 10:47, `live_allowed=false`, publication automatique `off`, aucun
  passage (samedi).
- **Registre.** 0 décision, 45 799 observations, aucune alerte `fact_registry.%` ouverte.
- **Déblocages.** 0 sur le mois courant.
- **Licitor.** 8 passages réussis depuis l'échec du 11/11.
- **Fraîcheur.** Licitor, encheres_immobilieres et avoventes datent de moins de 24 h. Vench et Petites Affiches
  n'ont rien inséré depuis le 28/10.
- **Complétude des ventes visibles.** Mise à prix 94 %, date 95 %, tribunal 74 %, surface 79 %.

**Mesures à faire.**

- **Lundi, après les premiers passages :** M1 (durée de la file), M3 (passages du pilote, `busy`) et Q3
  (événements).
- **Ensuite :** M2 (`/sales` en compte connecté), M4 (`cron.job` et droits des fonctions) et M5 (interrupteurs du
  registre).
- **Avant de corriger T4 :** relire en base qu'une valeur acceptée est bien réécrite par la collecte.

Le détail est dans l'annexe Technique.

**Essais payants demandés, non lancés.** Ils sont à autoriser par le propriétaire, critères fixés avant (D18).

| Essai                                  | Montant          | Ce qu'il prouve                                                   |
| -------------------------------------- | ---------------- | ----------------------------------------------------------------- |
| Pilote de 5 appels du jeu d'évaluation | plafond 1 USD    | Le comportement réel de `semantic_evidence_v3` sur du texte libre |
| Essai complet, avec deux répétitions   | ~0,51 à 1,53 USD | La même chose, à l'échelle du jeu                                 |
| Réessai de la v4 telle que déployée    | ~0,08 USD        | La version jamais essayée telle quelle                            |

---

## 8. Vérifications du chef d'orchestre

J'ai rouvert moi-même, à la ligne citée :

**Paiement.**

- **C1.** `GET /api/billing/offer` répond `{"configured":true,"trialDays":7,"trialAvailable":false,"label":"59 € TTC / mois"}`.
  D'après `analysis-checkout-readiness.ts:44-58`, cela veut dire que la clé, le Price, le webhook, l'identité et
  l'email sont tous configurés.
- **C2.** `ouverture-paiements.md:121-122` et `billing.ts:1238-1243` : un Price non reconnu fait passer
  l'abonné en `decouverte`.
- **C5.** La note « BROUILLON » est dans `legal-documents.ts:24-35`.
- **C6.** `contract-withdrawal.ts:143-158` : `find(paid && !refunded)` saute la charge déjà remboursée et en
  rembourse une autre.

**Pilote.**

- **T1.** `information-agent-autopilot.ts:326-342` réutilise le brouillon. `draft-checks.ts:56-69` le refuse
  (« La vente a changé… », 409). `preview.ts:116-118` change ce refus en blocage. `information-agent-autopilot.ts:526-540`
  le compte `policy_rejected`, et `autopilot-rules.ts:511` arrête le pilote à 2 rejets sur 7 jours.
- **T5.** La liste de `20261117100600:38-42` ne contient pas le pilote.
- **P3 et J9.** Boutons voisins sans confirmation (`AdminInformationAgentAutopilotPanel.tsx:155-180`), et
  `art14_max_age_days between 1 and 365` (`20261110230000:46-47`).

**Sécurité, registre et alertes.**

- **T3.** `admin-mfa.ts` : `isAdminMfaRequired` ne vaut vrai que si `ADMIN_MFA_REQUIRED` vaut « true ».
- **T4.** `20261114100000:265-317` écrit `update public.auction_sales` directement. `owner_occupied` et
  `squatted` sont admis à la ligne 303.
- **T6.** `20261029170100:516-523` : quand le budget a reporté des tâches, seul `delayed_source_detail` compte.

**Données et modèles.**

- **D2.** `hybrid-market-valuation.ts:104-106` sert `legacyLocalFeatures`.
- **D3.** `methode-ecart-marche/page.tsx:143-146`.
- **D6 et D8.** Aucune occurrence de `contains_prompt_injection` dans `document_reading.py`, ni de
  `unsupported_risk_term` dans le dépôt.
- **D7.** `document_reading.py:874-885` et `:1083`.
- **D9.** `notaires.py:697-698` et `normalize.py:191-200`.
- **D11.** `data-pipeline.yml:160`.
- **D15.** Ligne 284 du compte-rendu du 10/11.
- **D17.** `MapPanel.tsx:1048` et `geo.ts:200-207`.

**Référencement.**

- **S1.** `home-seo.ts:10`.
- **Canonique.** `sales-catalogue.tsx:22-24` : canonique `/sales`.
- **Indexation.** `robots.txt` de production annonce trois sitemaps.

**Non revérifié par moi.** Les mesures en base de qualite-donnees (D1, D10, D12, D13) et les points Moyens et Bas
qui portent [vérifié par leur auteur].

**Points écartés par les chefs.** J'ai relu les listes : aucun rejet injustifié.

- testeur-api B1 est ramené en Moyenne : les scénarios testent déjà `busy` et `off`.
- fiabilite-sre B5 est écarté : aucune alerte `fact_registry` n'est ouverte, d'après la mesure.
- L'adresse d'expéditeur passe en Moyenne : elle est codée en dur en trois endroits.
- « Identité de l'éditeur ouverte » est périmé : `/legal` publie la SASU.
- AI 3, 9 et 11 sont reportés : il n'y a encore rien à mesurer.

---

## 9. Ordre d'exécution proposé (si validé)

1. **Aujourd'hui.** Décision 1 sur le paiement, et C2 en consigne si la vente est refermée.
2. **Avant lundi 9 h 30.** Les actions du propriétaire, puis les textes et un lot de code :
   - **Propriétaire :** décision 2 et D1.
   - **Textes :** P2 (marche de lundi) et T2 (runbook).
   - **`developpeur`, un seul lot du pilote :** T1, T7, T8, T9, T30, T31 et P12, relu par `code-reviewer`.
3. **Avant le premier envoi réel.** J7 réglé, puis :
   - T3 (second facteur) et T4 (palliatif) ;
   - T10 et D9 ;
   - C12 à C14, J10 à J12 ;
   - P3, et la décision sur le conflit A.
4. **Paiement ouvert, ou avant sa réouverture :**
   - C3, C4 et C5 ;
   - C6 et C8 ;
   - D2 et D3 ;
   - T25 (`sale-analysis-sets`) et T27.
5. **Semaine du 16/11, hors pilote :**
   - T5, T6 et D12 ;
   - D5 à D8 et D13 ;
   - D17 ;
   - P5 et P6 ;
   - S1, S2 et S9.
6. **Ensuite :** tout le reste, et la refonte par zone selon le conflit B.

---

## Annexe : consolidation du département Technique (chef : architecte-logiciel)

# Département Technique : consolidation au 14/11/2026

J'ai lu en entier les 8 rapports bruts du département : architecte-logiciel, code-reviewer, securite-applicative, expert-postgres, archeologue-code, fiabilite-sre, devops-ci et testeur-api. Le 9e rapport n'existe pas : testeur-qa et performance-web n'ont pas été sollicités. J'ai ouvert à la ligne citée chaque point Critique ou Haute. Je n'ai rien modifié dans le dépôt et rien écrit en base.

**Aucun point ne reste Critique après arbitrage.** Le seul défaut sérieux pour lundi est T1 : le pilote s'arrête, aucun envoi ne part, mais l'horloge de simulation repart à zéro. Les chemins sont relatifs à `/home/user/immojudis/`.

**Échéances :**

- **L** : avant lundi 16/11.
- **E** : avant le premier envoi réel, ou avant d'accepter la première réponse d'un envoi réel.
- **P** : maintenant que le paiement est ouvert.
- **R** : avant le mode réel du pilote (lot 3).
- **—** : ensuite.

**Règle pour les migrations à venir.** Toute nouvelle migration doit porter un numéro ≥ `20261119100600`. La CI de PR refuse un numéro plus ancien que `main` (`ci.yml:288`). T5 et T6 sont concernés.

## 1. Propositions

### Hautes

| N°  | Sources                                                                      | Proposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Fichier:ligne                                                                                                                                                               | Effort   | Éch.                                                                                              | Vérification                                                                                                                                                |
| --- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | code-reviewer B1+B3 ; fiabilite-sre B6 (volume)                              | **Problème.** Un brouillon du pilote réutilisé est bloqué à l'aperçu dans deux cas : sa vente a changé (renvoi, mise à prix), ou son avocat a reçu un envoi manuel (délai de 30 j). Le blocage est compté `policy_rejected`. Deux rejets en 7 j arrêtent le pilote et remettent `simulation_started_at` à null. De plus, la sélection ne retire pas les ventes déjà simulées : les 5 mêmes reviennent environ 27 fois par jour. **Correction.** Écarter de la sélection les ventes qui ont déjà un brouillon simulé. Sur un brouillon réutilisé, un refus 409 donne annulation + `draft_stale`, sans rejet. Ajouter le délai de 30 j à la sélection. **Sans code :** avant chaque envoi manuel, annuler les autres brouillons du pilote adressés au même avocat. **Prix :** les brouillons s'accumulent (jusqu'à 5 par passage), donc il faut plafonner les brouillons simulés en attente. | `information-agent-autopilot.ts:326-342, 526-541` ; `autopilot-candidates.ts:189-231` ; `autopilot-rules.ts:435-480, 511` ; `20261119100500:125-127` ; `20261110230000:447` | S        | L, au plus tard avant l'étape 4                                                                   | **[vérifié]** pour la chaîne entière. Fréquence [supposé].                                                                                                  |
| T2  | fiabilite-sre B4                                                             | Ajouter au runbook la procédure de pilotage du pilote : lire « Derniers événements », vérifier qu'un arrêt est effectif, réarmer après un arrêt automatique, conduite si aucun passage (T5), contournement de T1. Remettre `INFORMATION_AGENT_OUTBOUND_ENABLED` à son état initial après l'essai : cette variable ouvre l'envoi manuel de tout l'agent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `docs/runbooks/information-agent.md:53-67`                                                                                                                                  | S        | L                                                                                                 | **[vérifié]** : les arrêts sont décrits (l.60), aucune procédure n'existe.                                                                                  |
| T3  | securite-applicative B1 ; fiabilite-sre B3 ; archeologue-code (point mineur) | **Risque.** L'administration n'a pas de second facteur alors que s'ouvrent les envois réels et le paiement. Un mot de passe volé suffit pour écrire à des avocats, décider sans plafond au registre (oppositions, retraits définitifs) et lire les demandes RGPD. **A (préférée) :** enrôler le TOTP, `set_admin_mfa_required(true)`, `ADMIN_MFA_REQUIRED=true`, `set_fact_registry_decisions_second_factor(true)`. **B :** exiger `aal2` pour `approve_and_send` hors canari. **Palliatif sans A ni B :** lancer `fact-registry-check` toutes les heures au lieu de 05:28. Les deux interrupteurs (application et base) sont recopiés à la main.                                                                                                                                                                                                                                          | `src/lib/admin-mfa.ts:22-24` ; `20261119100100:17-23` ; `vercel.json:84-85`                                                                                                 | S        | E, P                                                                                              | Code **[vérifié]**. Absence d'enrôlement [supposé] (constat du 11/11).                                                                                      |
| T4  | archeologue-code B1 ; architecte-logiciel B1                                 | **Constat.** « Accepter et mettre à jour la fiche » passe encore par l'ancien noyau : `update auction_sales` direct, sans `held_fields`. Le pont crée une observation `accepted` sans décision, visible dans aucune file. Aucune migration ne redéfinit le noyau ni le pont après `20261114100000`. La bascule R2 n'est donc pas faite : `registre-des-pieces.md` la liste encore sous « Reste pour le lot R2c ». Le noyau admet aussi `owner_occupied` et `squatted`, que le registre refuse. **Correction.** Palliatif S au choix (§4). Bascule complète L, en lot dédié. Test pgTAP : valeur acceptée, puis écriture de la collecte, la valeur reste.                                                                                                                                                                                                                                   | `20261114100000:265-334, 303` ; `admin-information-agent.ts:374-392` ; `AdminInformationAgentReviewPanel.tsx:642` ; `docs/architecture/registre-des-pieces.md:721-723`      | S puis L | E                                                                                                 | Chemin d'écriture **[vérifié]**. Réécriture par la collecte [supposé] : constatée le 11/11, non remesurée. Au 14/11 : 0 décision et 0 publication (mesure). |
| T5  | fiabilite-sre B1 ; expert-postgres B2                                        | **Constat.** Le pilote est absent de `cron.stale` : rien ne sonne si pg_cron, Vault ou `VERCEL_ENV` bloquent l'appel. **Ajout issu de ma vérification :** le contrôle « 7 jours de simulation sans anomalie » compte le temps écoulé depuis `simulation_started_at`, pas les passages. Un pilote muet le remplit donc. **Correction.** Alerte `information_agent.autopilot.silent` : mode ≠ off, plage horaire ouverte, aucun `run` depuis 40 min. Corriger `planification.md:64`. **En complément :** exiger des jours avec passage dans ce contrôle. `wouldSendDays` existe déjà mais n'est pas utilisé, et cette option suppose T1.                                                                                                                                                                                                                                                     | `20261117100600:38-44` ; `autopilot-readiness.ts:196-199` ; `autopilot-rules.ts:88,144`                                                                                     | M        | Pendant la simulation, avant que la porte des 7 j serve. Lundi, la lecture des événements suffit. | **[vérifié]**                                                                                                                                               |
| T6  | fiabilite-sre B2                                                             | **Constat.** Dès qu'une tâche a été reportée par le budget IA dans les 24 h, `pipeline.enrichment.stalled` ne regarde plus que `source_detail`. Une tâche de lecture PDF bloquée reste invisible. **Correction.** Compter à part toute tâche dont `attempt_count` et `updated_at` n'ont pas bougé depuis 24 h.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `20261029170100:516-523` (dernière définition)                                                                                                                              | M        | Semaine du 16/11, hors pilote                                                                     | Masquage **[vérifié]**. Lien avec la tâche PDF `running` depuis le 11/11 [supposé].                                                                         |

### Moyennes

| N°        | Sources                                   | Proposition                                                                                                                                                                                                                                                       | Fichier:ligne                                                                             | Effort | Éch.                        | Vérif.                                                                                                                                                                                |
| --------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T7        | code-reviewer B2                          | `isActiveAdmin` rend « non » sur une panne passagère de l'API Auth. Le pilote s'arrête et l'horloge repart. Lever l'erreur, sauf si l'utilisateur est réellement introuvable.                                                                                     | `autopilot-readiness.ts:278-293` ; `information-agent-autopilot.ts:427-430`               | S      | L, dans le lot de T1        | [vérifié]                                                                                                                                                                             |
| T8        | code-reviewer B4 ; expert-postgres B4     | `markSimulated` ne lit pas ses erreurs. Si la lecture échoue, `metadata` est écrasé : le brouillon passe pour un brouillon d'administrateur et la vente est écartée pour de bon. Faire la fusion en SQL et contrôler les erreurs.                                 | `information-agent-autopilot.ts:270-280`                                                  | S      | L (même lot)                | [vérifié]                                                                                                                                                                             |
| T9        | code-reviewer B5                          | `run_errors` n'a pas de libellé : l'accueil affiche « proche d'un seuil d'arrêt » à tort, et le test de concordance ne le voit pas.                                                                                                                               | `operational-alert-labels.ts:109-117,157-161`                                             | S      | L                           | [vérifié]                                                                                                                                                                             |
| T10       | code-reviewer B6                          | Dans les réponses d'avocats, « 1 250 m² » est lu 250 m².                                                                                                                                                                                                          | `information-agent-inbound/fact-extraction.ts:341-343`                                    | S      | E                           | [vérifié par mesure]                                                                                                                                                                  |
| T11 (T19) | architecte B5 ; expert-postgres B1        | Chaque passage peut relire 10 pages de la file, et chaque page recalcule toute la population. Calculer une fois par passage et passer des colonnes simples à `sale_has_court_registry_email`. Passe en Haute si un appel dépasse 2 s.                             | `autopilot-candidates.ts:81-98` ; `20261110220000:48-120`                                 | M      | Mesure M1 lundi             | coût [supposé]                                                                                                                                                                        |
| T12       | architecte B2                             | Le statut « accepté » a deux sources de vérité : la vue et le journal des décisions. Dériver le statut du journal.                                                                                                                                                | `20261117100700:113-130` ; `auction-fact-claims.ts:41`                                    | M      | avec T4                     | effet [supposé]                                                                                                                                                                       |
| T13       | devops-ci B2                              | Aucun contrôle de forme des variables d'envoi : `OUTBOUND_ENABLED`, plafonds, `PORTAL_SECRET`, `INBOUND_DOMAIN`, `RESEND_WEBHOOK_SECRET`.                                                                                                                         | `scripts/verify-production-env.mjs:99-127`                                                | S      | E                           | auteur                                                                                                                                                                                |
| T14       | devops-ci B1 ; securite-applicative B4    | Une dizaine de commits d'exception Gitleaks, tous pour la même cause. Exception par valeur exacte, sans liste de chemins. Les jetons synthétiques restent par chemin. Ajouter un test témoin. L'élargissement de la regex est à valider par securite-applicative. | `.gitleaks.toml:6-66`                                                                     | S      | —                           | [vérifié]                                                                                                                                                                             |
| T15       | securite B3                               | Invariants : signature des webhooks vérifiée avant toute lecture ; aucune écriture de `live_allowed`.                                                                                                                                                             | `check-security-invariants.mjs:2620-2663`                                                 | S      | R                           | auteur                                                                                                                                                                                |
| T16       | securite B2                               | Les 3 tables du pilote manquent au registre RGPD, à la matrice de conservation et au dictionnaire. Ajouter un test de couverture des tables.                                                                                                                      | `20261110230000:148-159,626-650`                                                          | S-M    | R                           | auteur                                                                                                                                                                                |
| T17 (T29) | fiabilite-sre B8 ; archeologue B4         | Un runbook par famille d'alertes : `fact_registry.*` (13 contrôles) et `catalogue.quality.*`.                                                                                                                                                                     | `docs/runbooks/`                                                                          | M      | —                           | auteurs                                                                                                                                                                               |
| T18       | archeologue B3 ; architecte B6            | 26 commits « Refonte » les 12-13/11 sans compte-rendu ni zone nommée. Des listes de tests supprimés sont dites « validées le 13/11 », sans trace écrite. Rédiger le compte-rendu a posteriori.                                                                    | `CLAUDE.md:40-45`                                                                         | S      | avant toute zone            | auteurs                                                                                                                                                                               |
| T19 (T7)  | architecte B4 ; devops-ci                 | Le budget JS total a été relevé 4 fois (+160 000 octets) malgré la règle du 08/11. Supprimer le relais `format.ts` et mesurer.                                                                                                                                    | `check-build-budgets.mjs:151-159` ; `src/lib/format.ts:1-32`                              | S-M    | —                           | gain [supposé]                                                                                                                                                                        |
| T20       | archeologue B2                            | Deux budgets IA quotidiens, en USD et en EUR. Le runbook conseille un réglage qui n'a pas d'effet.                                                                                                                                                                | `pipeline_usage.py:33-35,100-110`                                                         | S-M    | —                           | auteur                                                                                                                                                                                |
| T21       | expert-postgres B5                        | Le contrôle de dérive ignore `cron.job`, Vault, Storage et les droits. Ajouter un contrôle hebdomadaire en lecture seule.                                                                                                                                         | `check-supabase-schema-drift.mjs:84`                                                      | S-M    | —                           | droits [supposé]                                                                                                                                                                      |
| T22       | fiabilite-sre B7                          | Aucune alerte si le webhook Resend ne reçoit plus rien.                                                                                                                                                                                                           | `src/lib/information-agent/`                                                              | M      | R                           | [supposé]                                                                                                                                                                             |
| T23       | fiabilite-sre B6                          | La simulation n'exerce pas les plafonds. L'écrire comme une limite de la porte des 7 jours.                                                                                                                                                                       | `autopilot-readiness.ts`                                                                  | S      | R                           | auteur                                                                                                                                                                                |
| T24 (T24) | archeologue ; testeur-api ; code-reviewer | 10 routes sans appelant (dont `api-keys`), plus `billing-reconciliation` GET et `missions` POST. knip reste informatif. Décider route par route.                                                                                                                  | `ci.yml:65-67`                                                                            | M      | —                           | auteurs                                                                                                                                                                               |
| T25 (T11) | testeur-api B1-B5, B8                     | Filets de test de routes : cron du pilote (seul `retryDelaysMs: []` n'est pas couvert), POST `autopilot` et `auto-publication`, `sale-analysis-sets` avec la création du lien partagé, test paramétré 401/403 des routes admin, en-têtes v1.                      | `src/app/api/…`                                                                           | M      | P pour `sale-analysis-sets` | Absence [vérifié]. Protections [vérifié] : `information-agent-autopilot.scenarios.test.ts:333-389`, `adminRoute` + invariant, `live_allowed` en SQL, `sale-analysis-sets.ts:303-307`. |
| T26       | fiabilite-sre B9, B10                     | Clore sur preuve l'incident Licitor du 11/11 (Q2). Confirmer que la sonde externe existe.                                                                                                                                                                         | `docs/operations/supervision-externe.md`                                                  | S      | —                           | [supposé]                                                                                                                                                                             |
| T27       | testeur-api B7                            | La concurrence du quota de déblocage n'est pas prouvée.                                                                                                                                                                                                           | `sales/[id]/unlock/route.ts`                                                              | M      | P                           | [supposé]                                                                                                                                                                             |
| T28 (T16) | architecte B3 ; archeologue               | Clé de verrou recopiée 5 fois en Python. archeologue en comptait 3 ; j'en ai vérifié 5.                                                                                                                                                                           | `source_detail.py:207` ; `source_detail_reuse.py:53` ; `supabase_client.py:502,2586,2846` | S      | —                           | [vérifié]                                                                                                                                                                             |
| T29 (T17) | expert-postgres ; architecte              | Toujours aucune garde CI contre les réparations dans les migrations.                                                                                                                                                                                              | `check-security-invariants.mjs:556-577`                                                   | M      | —                           | auteurs                                                                                                                                                                               |

### Basses (effort S, sauf T34)

- **T30** (testeur-api B10 ; expert-postgres B3) : bail du pilote de 600 s pour une fonction coupée à 300 s. Le passer à 330 s (`information-agent-autopilot.ts:247`). Échéance L s'il entre dans le lot de T1.
- **T31** (code-reviewer B7) : codes bruts dans « Derniers événements » (`autopilot-view.ts:88`).
- **T32** (devops-ci B4) : migrations datées des 17-19/11 et déjà appliquées. La CI couvre déjà le risque (`apply-supabase-migrations.mjs:281-288`). Il reste à écrire la règle de numérotation.
- **T33** (archeologue B5, B6, B9, B10, B11 ; devops-ci B6 ; architecte B7) : documentation et échafaudages périmés :
  - runbook et `current-state.md:93` (PostgREST) ;
  - README (`raw_app_meta_data`, OSM) ;
  - phase 4 de SKILL ;
  - définitions d'agents ;
  - `planification.md:435` ;
  - `migration_pending` et `ANNOUNCED_CODES` ;
  - « registre » homonyme.
- **T34** (code-reviewer B8 et points cités ; architecte) : rangement de l'agent. `actingAuth`, harnais d'évaluation, `dry-run.manual.test.ts`, `autopilot-readiness.ts` mixte, `user_favorites` lus directement, NaN, limite de 10. Effort M.
- **T35** (T2 ; archeologue B8) : résidus Lovable. Le test 421 contredit le 892 ; l'étape CI et le script restent.
- **T36** (archeologue B7) : deuxième liste de noms de sources (`AdminRunPanels.tsx:16-26`).
- **T37** (architecte B7) : `licitor_cloudflare_decoded` écrit 5 fois, hors contrat TypeScript-Python.
- **T38** (expert-postgres B6) : interrupteurs du registre sans historique.
- **T39** (devops-ci B3, B5, B7) : `.env.example` du pipeline, Gitleaks relit tout l'historique, `stripe` figé dans Dependabot (échéance P).
- **T40** (testeur-api B6, B9 ; expert-postgres ; securite) :
  - 400 avant 401 sur `unlock` ;
  - idempotence des POST admin après 504 (l'envoi est protégé : `send.ts:228`) ;
  - index des statistiques ;
  - CHECK sans `NOT VALID` ;
  - `RATE_LIMIT_IP_SALT` lu brut ;
  - `npm audit` : 3 vulnérabilités modérées.

### Ordre d'exécution proposé

- **Avant lundi :** un seul lot pilote de `developpeur` (T1, T7, T8, T9, T30, T31), plus le runbook T2.
- **Avant le premier envoi réel :** T3, T4 (palliatif), T10, T13.
- **Paiement ouvert :** T3, T25 (`sale-analysis-sets`), T27, T39.

## 2. Statut des points T du 08/11

| N°                      | Statut                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| T1                      | Partiel. Doc faite ; base légale « à renseigner » (juridique-rgpd).                                    |
| T2                      | Fait, avec des résidus (T35). Application en production non vérifiée par securite-applicative.         |
| T3, T6, T8, T9, T10     | Fait.                                                                                                  |
| T5                      | Fait dans le code. Pose effective du secret non vérifiée.                                              |
| T4                      | Ouvert (mesure M2 pour qualite-donnees).                                                               |
| T7                      | Partiel. Le référentiel est fait, mais les plafonds ont été relevés (T19).                             |
| T11                     | Fait pour l'essentiel ; reste T25.                                                                     |
| T12, T13, T25, T28, T30 | Non revus. Agents non sollicités.                                                                      |
| T14                     | Partiel. La porte est sortie ; `readSaleForDoor` est absent. L'échéance « avant Stripe » est dépassée. |
| T15, T18                | Ouverts. La pratique des fonctions patchées par fragment continue.                                     |
| T16                     | Ouvert (T28).                                                                                          |
| T17                     | Partiel (T29).                                                                                         |
| T19                     | Ouvert, actif dès lundi (T11).                                                                         |
| T20, T22                | Ouverts, inchangés.                                                                                    |
| T21, T23                | Partiels (T23 : `sales-statistics-summary.ts:24`, `MapPanel.tsx:1048`).                                |
| T24                     | Partiel. 4 routes retirées (T24).                                                                      |
| T26                     | Partiel (T13).                                                                                         |
| T27                     | Fait : `Retry-After` posé sur 429 seulement (`api-errors.ts:21`).                                      |
| T29                     | Ouvert (T17).                                                                                          |
| T31                     | Ouvert dans le texte, appliqué en pratique.                                                            |
| T32                     | Partiel. P5 fait en grande partie, P6 ouvert, le reste non revu.                                       |

## 3. Propositions écartées ou requalifiées

- **testeur-api B1 (Critique) :** fondu dans T25 en Moyenne. `busy` et `off` sont déjà testés par les scénarios. `CRON_SECRET` est couvert par l'invariant. Seul `retryDelaysMs: []` reste sans test.
- **code-reviewer B1 (Critique) :** ramené à Haute (T1), voir §4.
- **fiabilite-sre B5 (`projection_drift` ouverte en permanence) :** écarté. La mesure du 14/11 contredit sa prémisse : aucune alerte `fact_registry.%` n'est ouverte. À rouvrir si elle s'ouvre.
- **fiabilite-sre B3 :** fondu dans T3 comme palliatif. Le risque a été accepté par écrit le 12/11, il n'y a aucune décision au registre, et le vrai remède est le second facteur.
- **devops-ci B4 :** ramené à Basse (T32), car il est déjà couvert par `validateMigrationOrder` en PR.
- **Priorités ramenées à Moyenne :**
  - testeur-api B2-B4 : la route n'est qu'un relais, les gardes sont en base, dans la bibliothèque et dans l'invariant.
  - code-reviewer B2 : le fonctionnement en échec fermé est un choix écrit dans le code (`autopilot-readiness.ts:278-280`), l'évènement est rare et l'échec reste du côté sûr.
- **archeologue (copies de T16) :** décompte corrigé, 5 copies et non 3.
- **testeur-api T27 « supposé » :** tranché par la vérification de code-reviewer.
- **archeologue `sale_is_land_sale` / `isLandOnlySurface` :** écarté. Les deux sont distincts par conception et la base tranche ; c'est la conclusion de l'auteur.
- **expert-postgres `continue-on-error` des types :** non reproposé (tranché le 31/10). La condition paraît remplie [supposé] ; je le signale au propriétaire.
- **expert-postgres PostGIS dans `public` :** doublon du 12/11.
- **archeologue « 59 € TTC » sous franchise de TVA :** hors du domaine technique, transmis à juridique-rgpd.

## 4. Conflits et dépendances

### Conflits tranchés

- **Gravité de T1.** code-reviewer le classe Critique ; architecte et securite-applicative ne voient aucun point Critique. Ils ne jugent pas la même chose : la sûreté (aucun envoi possible) d'un côté, la réussite de la simulation de l'autre. Je retiens **Haute** : l'échec reste du côté sûr, sans tort à un tiers. Mais le plan de lundi le déclenche lui-même : la correction doit précéder l'étape 4.
- **Gitleaks (T14).** devops-ci propose Haute, securite-applicative Basse. Je retiens **Moyenne** : c'est une friction visible et sans danger, que les deux agents corrigent de la même façon.
- **Pilote muet (T5).** Je retiens **Haute**, à cause de la porte des 7 jours.

### Conflits non tranchés, pour le propriétaire

1. **Palliatif de T4.**
   - archeologue : faire passer l'acceptation par `accept_auction_fact_claim`, ou changer le libellé et prévenir l'administrateur.
   - architecte : afficher dans la file des décisions les observations du pont qui n'ont pas de décision.

   La seconde option rend le problème visible sans protéger la valeur. La première protège, mais touche le chemin de décision tout juste ouvert.

2. **T3 : rouvrir le risque accepté le 12/11 ?** Les envois réels et le paiement ouvert sont des faits nouveaux.
3. **T1 : quel plafond de brouillons simulés en attente ?** Question à poser aussi à Produit.
4. **T18 : qui a validé le 13/11 les listes de tests supprimés ?**

### Dépendances

- **juridique-rgpd :**
  - `owner_occupied` et `squatted` acceptés par l'ancien noyau (T4) ;
  - durées de conservation des tables du pilote (T16) ;
  - accord Licitor « déclaré, pièce non versée au dossier » ;
  - base légale de T1 du 08/11 ;
  - « 59 € TTC » sous franchise de TVA ;
  - **checkout ouvert alors que la société n'est pas créée, si Stripe est en mode réel.**
- **Données :**
  - qualite-donnees : mesures M1 (lundi), M2, M3, M4, M5, Q1 et Q2, et nouvelle mesure de la réécriture d'une valeur acceptée (T4) ;
  - data-pipeline : tâche PDF `running` à bail expiré depuis le 11/11, jamais reprise ; T20 ; T28 ; `catalogue_readiness.py:354` (lié à T4) ;
  - statisticien : T23 du 08/11.
- **Produit et expérience :** libellés (T9, T31), plafond des brouillons (T1), route `api-keys` (T24), T20 et T22 du 08/11.
- **Commercial et contenus :**
  - redacteur-contenu : T2, T17, T33 ;
  - paiements-stripe : mode du checkout et mise à jour de `stripe` (T39).
- **Propriétaire, à confirmer :** second facteur enrôlé, mode Stripe, sonde externe, `RATE_LIMIT_IP_SALT` posé. Ses actions du 14/11 restent ouvertes : 2 réponses non routées, brouillons d'octobre.

## 5. Refonte par zone (/untangle-codebase)

**Avertissement :** cette recommandation rejoint celle de mon rapport brut. Je donne aussi l'option contraire.

**La condition « après le lot R2 » est ambiguë.** Les étapes R2a, R2b et R2c sont en production depuis le 12/11. Mais la définition du plan (« le noyau écrit observation, décision, projection ; le pont est retiré ») n'est pas réalisée (T4). Je la considère levée pour les zones qui ne touchent ni le registre ni l'agent.

**Préalables :**

1. T18 : rédiger le compte-rendu a posteriori de la refonte des 12-13/11.
2. Aucune refonte pendant la semaine du 16/11 : les lots T1, T5 et T6 touchent les zones candidates.

**Première zone recommandée : « agent d'information et pilote ».**

- **Pourquoi :** le propriétaire l'a nommée en premier le 12/11. C'est la même fonctionnalité rangée de quatre façons, environ 48 500 lignes tests compris. Elle va beaucoup changer (lot 3, mode réel) : c'est là que la refonte rapporte le plus. T34 en donne la matière.
- **Fenêtre :** pas avant le 23/11. Il faut d'abord que la simulation soit terminée ou arrêtée, que la bascule R2 (T4) soit fusionnée comme un lot normal, et qu'aucune bascule en mode réel ne tombe la même semaine. La refonte doit être finie avant le début du lot 3.
- **Prix :** une régression sur le chemin d'envoi pendant les envois manuels. Les scénarios et l'invariant « pas d'envoi automatique » la limitent.

**Option contraire : commencer par « santé opérationnelle et planification ».** Cette zone est plus petite. On y trouve T5, T6 et T15 du 08/11, trois planificateurs, et une définition courante qui n'existe qu'en base. Elle passerait en premier si le propriétaire veut le mode réel rapidement, car l'agent resterait alors figé. Je la recommande aussi si la mesure M1 impose de toute façon de reprendre la file.

**Cas où cette recommandation devient caduque :** arrêt du pilote ou report du lot 3 au-delà de décembre. L'agent devient alors la zone évidente et peut être prise sans attendre.

## Fichiers ouverts pour la vérification

- /home/user/immojudis/src/lib/information-agent-autopilot.ts
- /home/user/immojudis/src/lib/information-agent/autopilot-rules.ts
- /home/user/immojudis/src/lib/information-agent/autopilot-candidates.ts
- /home/user/immojudis/src/lib/information-agent/autopilot-readiness.ts
- /home/user/immojudis/src/lib/information-agent/draft-checks.ts
- /home/user/immojudis/src/lib/information-agent/preview.ts
- /home/user/immojudis/supabase/migrations/20261119100500_information_agent_autopilot_rearm.sql
- /home/user/immojudis/supabase/migrations/20261114100000_information_agent_publication_core.sql
- /home/user/immojudis/supabase/migrations/20261117100600_cron_stale_fact_registry_check.sql
- /home/user/immojudis/supabase/migrations/20261029170100_pipeline_observer_alerts.sql
- /home/user/immojudis/supabase/migrations/20261119100100_fact_decision_limits_switch_and_author_lock.sql
- /home/user/immojudis/src/lib/admin-mfa.ts
- /home/user/immojudis/src/lib/admin-information-agent.ts
- /home/user/immojudis/docs/runbooks/information-agent.md
- /home/user/immojudis/.gitleaks.toml
- /home/user/immojudis/src/lib/operational-alert-labels.ts
- /home/user/immojudis/src/lib/information-agent-inbound/fact-extraction.ts

## Annexe : consolidation du département Données (chef : qualite-donnees)

Consolidation du département Données au 14/11/2026. Les cinq rapports ont été lus en entier. J'ai ouvert les fichiers cités pour les points Critique ou Haute que j'ai pu rouvrir, et je marque [non vérifié par moi] les autres. Aucune nouvelle mesure en base : [mesuré] veut dire mesuré par qualite-donnees (qd) le 14/11, non refait. Abréviations : dp = data-pipeline, qa = qa-modeles, st = statisticien, pl = prompts-llm.

## 1. Tableau consolidé (D1 à D38 ; ancien numéro du 08/11 entre parenthèses)

| N°           | Sources                                   | Proposition                                                                                                                                                                                                                                                                               | Fichier:ligne                                                                                                            | Prio                                                                                                                       | Eff.                                                                                                    | Vérification                                                                                                                                                                                                  |
| ------------ | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----------------------------------------- |
| D1           | qd #1                                     | Traiter ou classer les 2 réponses non routées avant lundi. Alerte `information_agent.unrouted.pending` ouverte depuis le 11/11 (147 occurrences).                                                                                                                                         | table `information_agent_unrouted_messages`                                                                              | Critique                                                                                                                   | S                                                                                                       | [mesuré, non revérifié]                                                                                                                                                                                       |
| D2 (D1, D19) | qd #10 et A, qa #1, st (question ouverte) | Les 2 modèles LightGBM `lgbm-cqr-20260713` sont toujours actifs, sans `localMarket` ni `comparison`. Renvoyer `null` plutôt que `legacyLocalFeatures` : la correction passe au déploiement. Retour arrière à décider par le propriétaire avant les paiements.                             | `src/lib/hybrid-market-valuation.ts:104-106,127-133`                                                                     | Haute                                                                                                                      | S                                                                                                       | [vérifié] code ; production [mesuré]                                                                                                                                                                          |
| D3           | qa #3                                     | La page publique dit qu'un modèle sous 70 % de couverture « n'est pas mis en service ». C'est faux pour les 2 modèles actifs (activés le 27/07 avant la porte).                                                                                                                           | `src/app/methode-ecart-marche/page.tsx:144-146`                                                                          | Haute                                                                                                                      | S                                                                                                       | [vérifié] texte ; base [mesuré]                                                                                                                                                                               |
| D4           | qa #2                                     | Un échec des seuils absolus ne laisse ni rapport ni artefact : `validate_promotion` lève avant l'écriture, et l'envoi d'artefact n'a pas `if: always()`. Les 3 échecs de juillet restent inexplicables.                                                                                   | `valuation_training.py:219,230-231` ; `valuation-model-training.yml:114-120`                                             | Haute                                                                                                                      | S                                                                                                       | [vérifié]                                                                                                                                                                                                     |
| D5 (D6)      | pl #1, qa #12, qd A                       | Le titre d'un point de lecture n'est contrôlé que pour les contacts : pas de chiffre sur la page, pas de mot de risque, pas de formule promotionnelle, contradiction d'occupation testée seulement sous un thème. L'explication, elle, est contrôlée.                                     | `document_reading.py:644-650` contre `:653-670`                                                                          | Haute                                                                                                                      | S                                                                                                       | [vérifié] code ; effet réel [supposé]                                                                                                                                                                         |
| D6           | pl #2                                     | Consigne cachée dans un PDF non filtrée : `contains_prompt_injection` n'est pas appelée par la lecture des pièces.                                                                                                                                                                        | `document_reading.py` (aucune occurrence) ; `information_agent_semantic.py:403`                                          | Haute                                                                                                                      | S-M                                                                                                     | [vérifié] absence d'appel ; sonde non rejouée                                                                                                                                                                 |
| D7           | pl #4                                     | Un objet sans liste `points` donne une lecture `completed` à 0 point et écrase une bonne lecture, que seul `failed` protège.                                                                                                                                                              | `document_reading.py:874-885,1083`                                                                                       | Haute                                                                                                                      | S                                                                                                       | [vérifié] chemin de code ; sonde non rejouée                                                                                                                                                                  |
| D8 (D18)     | pl #5, qd A                               | La règle `unsupported_risk_term` n'existe pas : un résumé « mérule, amiante, squat » sans appui passe et remplace la description publique.                                                                                                                                                | `display_evidence.py:135-215` ; `extract_structured.py:2043-2054`                                                        | Haute                                                                                                                      | S                                                                                                       | [vérifié] (seule occurrence dans `docs/equipe/2026-11-08-etat-des-lieux.md`)                                                                                                                                  |
| D9           | dp #1, qd #3                              | Notaires : un nom de personne passe en `lawyer_name` sans `PROFESSIONAL_PREFIX_RE` (utilisé seulement pour Petites Affiches). `lawyer_contact` reprend téléphone et mail du négociateur.                                                                                                  | `src/sources/notaires.py:697-699` ; `petites_affiches_extraction.py:237`                                                 | Haute                                                                                                                      | S                                                                                                       | [vérifié] code ; données réelles [supposé]                                                                                                                                                                    |
| D10          | qd #3                                     | Contacts insuffisants pour le pilote : Licitor 177 ventes sur 382 (46 %) ; notaires 0 sur 204 alors que 188 ont une adresse dans `lawyer_contact`. Cause non établie.                                                                                                                     | `storage/internal_contacts.py`                                                                                           | Haute                                                                                                                      | M                                                                                                       | [mesuré] chiffres ; cause [supposé]                                                                                                                                                                           |
| D11          | dp #2                                     | Décodage des adresses Licitor actif par défaut (`                                                                                                                                                                                                                                         |                                                                                                                          | 'true'`) sur un accord « déclaré, pièce à verser ». Tenir un registre daté de la pièce, de la conservation et de la purge. | `.github/workflows/data-pipeline.yml:160` ; `docs/audits/licitor-decodage-reactivation-2026-11-11.md:6` | Haute                                                                                                                                                                                                         | S / M | [vérifié] configuration ; purge [supposé] |
| D12          | qd #5, dp #4 (lien supposé)               | Tâche PDF `running` depuis le 11/11 12:58 (environ 70 h), bail expiré, bloque une vente cessions_etat. File : 503 `source_detail` en attente (413 de plus de 24 h), 15 PDF épuisés.                                                                                                       | migration `20261111050000` l.70-80                                                                                       | Haute                                                                                                                      | M                                                                                                       | [mesuré] ; cause [supposé]                                                                                                                                                                                    |
| D13          | qd #4                                     | 33 ventes à venir non masquées, sans date, non revues depuis août ou septembre (encheres_publiques 13, notaires 18, avoventes 1, cessions_etat 2).                                                                                                                                        | `auction_sales`                                                                                                          | Haute                                                                                                                      | S                                                                                                       | [mesuré] ; affichage [supposé]                                                                                                                                                                                |
| D14          | qd #2                                     | 0 décision, 0 publication, `auto_publication_settings.mode=off`. Contrôler la première décision lundi.                                                                                                                                                                                    | `information_agent_*`                                                                                                    | Haute                                                                                                                      | S                                                                                                       | [mesuré]                                                                                                                                                                                                      |
| D15          | qa #7 et #8, st #6                        | Les 215 cas servent à régler et à certifier : « zéro publication fausse » sera atteint par construction. Il faut un jeu scellé. Le seuil n'est pas dimensionné (zéro sur 17 ne prouve qu'un taux sous 16 % ; « suiveur » : 41 fausses sur 58 ; environ 300 valeurs pour passer sous 1 %). | `docs/equipe/2026-11-10-enrichissement-automatique-fiches.md:284` ; `docs/runbooks/information-agent.md:250,325-332,393` | Haute                                                                                                                      | M                                                                                                       | [non vérifié par moi] ; vérifié par qa                                                                                                                                                                        |
| D16          | st #2                                     | Écrire le protocole du pilote et du lot R8 avant lundi (indicateur par cohorte, durée, effets). 0 réponse sur 3 donne une borne haute de 56 % ; environ 80 dossiers pour ±10 points.                                                                                                      | plan R8, `2026-11-11-registre-des-pieces.md` §4                                                                          | Haute                                                                                                                      | S                                                                                                       | [non vérifié par moi] ; vérifié par st                                                                                                                                                                        |
| D17 (T23)    | st #1                                     | Prix au m² et rendement calculés sur la surface présumée de 20 m² : `kind` reste facultatif, et `MapPanel.tsx:1048` et `sales-statistics-summary.ts:24` l'omettent.                                                                                                                       | `src/lib/geo.ts:205` ; `src/components/search/MapPanel.tsx:1048`                                                         | Haute                                                                                                                      | S-M                                                                                                     | [vérifié] pour `kind` facultatif et ces deux appels. `SaleComparisonTable.tsx:87` omet aussi `kind` (ajout de ma part). `sale-exports.ts:528` le passe déjà. Rendement de `alert-matches.ts:1057` non tranché |
| D18          | qa #9 et #10, pl (essai 1)                | L'essai réel de l'agent n'a jamais tourné. Les 3 essais v4 portent sur les 12 mêmes ventes, et une règle a été ajoutée après le dernier. Les réponses aux premiers envois seront probablement du texte libre, jamais mesuré. Fixer les critères avant l'essai.                            | `scripts/document_reading_trial.py:78-100,311` ; `information-agent-email-template.ts:306`                               | Haute                                                                                                                      | M                                                                                                       | [non vérifié par moi] ; vérifié par qa et pl                                                                                                                                                                  |
| D19 (D9)     | dp #3                                     | Le worker de file ne contrôle pas le verrou perdu et sort en code 0.                                                                                                                                                                                                                      | `src/queued_runner.py:1554-1558`                                                                                         | Moyenne                                                                                                                    | S                                                                                                       | [vérifié]                                                                                                                                                                                                     |
| D20 (D17)    | dp #4, qd                                 | Lecture en avance : une tâche hors délai continue de tourner (`shutdown(wait=True)`).                                                                                                                                                                                                     | `document_prefetch.py:213-216,238`                                                                                       | Moyenne                                                                                                                    | S-M                                                                                                     | [vérifié par dp et qd]                                                                                                                                                                                        |
| D21          | pl #3                                     | `revalidate_stored_readings` n'est appelée que par les tests : les règles D5, D6, D8 n'atteignent les lectures stockées qu'après relecture payante.                                                                                                                                       | `document_reading.py:1135-1163`                                                                                          | Moyenne                                                                                                                    | S                                                                                                       | [vérifié] par grep                                                                                                                                                                                            |
| D22 (D12)    | qd                                        | 71 groupes, 147 lignes de doublons visibles. Fusion non activée.                                                                                                                                                                                                                          | —                                                                                                                        | Moyenne                                                                                                                    | M                                                                                                       | [mesuré]                                                                                                                                                                                                      |
| D23 (D13)    | qd, st                                    | Département : réserve sur `total < 3`, pas sur `medianSampleSize` ; meta description sans condition d'effectif.                                                                                                                                                                           | `department-view.tsx:274` ; `department-pages.ts:533-536`                                                                | Moyenne                                                                                                                    | S                                                                                                       | [vérifié] ligne 274 ; 533 non ouverte                                                                                                                                                                         |
| D24          | qa #4                                     | Aucun contrôle de la porte par département ou tranche de prix.                                                                                                                                                                                                                            | `valuation_activation_gate.py:129-186`                                                                                   | Moyenne                                                                                                                    | M                                                                                                       | [non vérifié par moi]                                                                                                                                                                                         |
| D25          | qa #5                                     | Aucun test Vitest ne lit `served_blend_parity.json`.                                                                                                                                                                                                                                      | `hybrid-market-valuation.ts:135-149`                                                                                     | Moyenne                                                                                                                    | S                                                                                                       | [non vérifié par moi]                                                                                                                                                                                         |
| D26          | st #3, #4, #5                             | Indicateurs de pilotage biaisés : taux de réponse censuré à droite, porte « 30 envois manuels propres » (21 % de passage si le vrai taux est 5 %), verdict des rappels sur estimation ponctuelle.                                                                                         | `operations-view.ts:109-117` ; `autopilot-readiness.ts:180-193` ; `admin-pilotage.ts:470-476`                            | Moyenne                                                                                                                    | S-M                                                                                                     | [vérifié par st]                                                                                                                                                                                              |
| D27          | pl #6                                     | Mesurer la coupe à 2 500 caractères avant toute v5.                                                                                                                                                                                                                                       | `document_reading.py:63`                                                                                                 | Moyenne                                                                                                                    | S                                                                                                       | [supposé] pour l'effet                                                                                                                                                                                        |
| D28          | qa #11                                    | Pas de retour arrière ni de témoin pour la lecture v4.                                                                                                                                                                                                                                    | `document_reading.py:958-976`                                                                                            | Moyenne                                                                                                                    | S-M                                                                                                     | [vérifié par qa]                                                                                                                                                                                              |
| D29 (D15)    | qd #8, #9                                 | Champs essentiels manquants selon la source ; surface Licitor absente 142 sur 382 (37 %), cause non établie.                                                                                                                                                                              | `auction_sales`                                                                                                          | Moyenne                                                                                                                    | M                                                                                                       | [mesuré]                                                                                                                                                                                                      |
| D30          | qd #7                                     | Vench 98 sur 102 et Petites Affiches 6 sur 6 en quarantaine, aucune insertion depuis le 28/10, pas d'alerte.                                                                                                                                                                              | `catalogue_quarantined`                                                                                                  | Moyenne                                                                                                                    | M                                                                                                       | [mesuré]                                                                                                                                                                                                      |
| D31          | qd #6                                     | Registre des pièces inerte : 0 décision, 0 blocage, 45 799 observations.                                                                                                                                                                                                                  | `auction_fact_fields`                                                                                                    | Moyenne                                                                                                                    | S                                                                                                       | [mesuré]                                                                                                                                                                                                      |
| D32          | qd #11, #12                               | 5 alertes ouvertes, tableau « à traiter » pas vert lundi ; sources obsolètes encheres_immobilieres et cessions_etat.                                                                                                                                                                      | `operational_alerts`                                                                                                     | Basse                                                                                                                      | S                                                                                                       | [mesuré]                                                                                                                                                                                                      |
| D33 (D14)    | qd, st                                    | Regroupement des arrondissements inchangé.                                                                                                                                                                                                                                                | `department-pages.ts:159,284-285`                                                                                        | Basse                                                                                                                      | S                                                                                                       | [vérifié par qd et st]                                                                                                                                                                                        |
| D34 (D21)    | st, qa                                    | « Fourchette probable à 80 % » avec p50 en grand. À signaler à juridique-rgpd si des prédictions existent (non mesuré).                                                                                                                                                                   | `OutcomeForecast.tsx:314`                                                                                                | Basse                                                                                                                      | S                                                                                                       | [vérifié par qa et st]                                                                                                                                                                                        |
| D35          | st #7                                     | Résidu de D5 : « la moitié des ventes » devient « k ventes sur n » (75 % à n=4, 56 % à n=9).                                                                                                                                                                                              | `BidCeilingMarket.tsx:113`                                                                                               | Basse                                                                                                                      | S                                                                                                       | [non vérifié par moi] (chemin non retrouvé)                                                                                                                                                                   |
| D36          | qa #6                                     | Reproductibilité : pas d'empreinte des données, de SHA ni de versions ; limite 9 de la model card probablement fausse.                                                                                                                                                                    | `valuation_training.py:316-381`                                                                                          | Basse                                                                                                                      | S                                                                                                       | [vérifié par qa] ; base [supposé]                                                                                                                                                                             |
| D37          | pl #7                                     | Réglages (température, plafond, prompt) non enregistrés avec la lecture.                                                                                                                                                                                                                  | `document_reading.py:888-903`                                                                                            | Basse                                                                                                                      | S                                                                                                       | [vérifié par pl]                                                                                                                                                                                              |
| D38          | st #8, #9 ; dp #5                         | Espace avant « % » (U+202F, `numbers.ts:88`) ; part d'« Utile » sans intervalle de Wilson (`admin-pilotage-page.tsx:616-620`) ; horodatage sans fuseau (`dvf_statistics_import.py:121`).                                                                                                  | voir colonne                                                                                                             | Basse                                                                                                                      | S                                                                                                       | [vérifié par leurs auteurs]                                                                                                                                                                                   |

## 2. Statut des points D du 08/11

| Point                  | Statut                   | Remarque                                                                                                              |
| ---------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| D1                     | Ouvert en production     | Documents faits ; en base, les 2 modèles sont toujours actifs ; 0 brouillon d'entraînement réussi sur 7. Voir D2, D4. |
| D2                     | Fait                     | [vérifié] `market-estimate-ceiling.ts:49-55`.                                                                         |
| D3                     | Fait                     | qd, st, qa concordent.                                                                                                |
| D4                     | Fait                     | [vérifié] voir section 4.                                                                                             |
| D5                     | Partiel                  | Résidu : D35.                                                                                                         |
| D6                     | Partiel                  | [vérifié] `document_reading.py:644-650`. Voir D5.                                                                     |
| D7                     | Non tranché              | pl dit fait (`extraction_grounding.py:98-117`), qd n'a rien trouvé. [non vérifié par moi]                             |
| D8                     | Fait                     | qd, dp, pl concordent.                                                                                                |
| D9                     | Partiel                  | [vérifié] worker de file non couvert : D19.                                                                           |
| D10, D11               | Ouverts                  | Non remesurés.                                                                                                        |
| D12, D13, D14          | Ouverts                  | D22, D23, D33.                                                                                                        |
| D15                    | Partiel                  | 37 % contre 41 %. D29.                                                                                                |
| D16                    | Partiel                  | Compteurs faits.                                                                                                      |
| D17                    | Ouvert                   | D20.                                                                                                                  |
| D18 (risque)           | Ouvert                   | D8.                                                                                                                   |
| D18 (2 500 caractères) | Ouvert, en partie traité | D27.                                                                                                                  |
| D19                    | Partiel                  | Porte sur le mélange faite ; plancher de couverture manquant ; porte JS ne relit pas `blend` (qa).                    |
| D20                    | Ouvert                   | `tribunal_label_conflict` seulement dans `tribunal.py`.                                                               |
| D21                    | Partiel                  | « ≈ 13 % » calculé, réglette dépassée, `OutcomeForecast` ouvert : D34.                                                |
| D22 (Python)           | Partiel                  | CI en 3.12, local en 3.13.                                                                                            |
| D22 (n°6)              | Fait                     | pl : #448.                                                                                                            |
| T1                     | Dépassé par décision     | Photos de PV gardées par le propriétaire.                                                                             |
| T3, T5, T8, T9         | Faits                    | dp (T8 et T9 : documents non relus).                                                                                  |
| P6                     | Position st              | Garder 15 % comme garde de vraisemblance ; remplacer « non significatif » (`public-rental-yield.ts:51`).              |
| T17                    | Non examiné              |                                                                                                                       |

## 3. Propositions écartées

- qd #11 (collecte saine) : constat sans proposition, anomalies reprises en D32.
- qd #12 (alertes ouvertes) : fusionnée dans D32 ; les causes sont en D1, D12, D13.
- st #9 (« Utile » sans Wilson) : gardée, regroupée dans D38.
- dp : pistes sans preuve (ordre des actions du lot R2a, cohérence des nettoyages Python et TypeScript), non relues donc non retenues.
- dp T1 : dépassé par décision du propriétaire.
- Aucune proposition rejetée sur le fond.

## 4. Conflits et dépendances

Conflits tranchés :

- D4 : fait, selon st. [vérifié] `market-estimate-ceiling.ts:66` transmet `sampleSize`, `market-estimate-display.ts:38-42` refuse un effectif non entier. Le « partiel » de qd venait d'une recherche de tests.
- D5 : partiel, selon st. Les quartiles sont observés, le libellé « la moitié » reste (D35). Fichier du libellé non rouvert.
- D1 : qa « partiel » (documents), qd « ouvert » (base mesurée). Retenu : ouvert en production.
- D6 : qd « fait », pl et qa « partiel ». [vérifié] partiel.
- D9 : qd « fait », dp « partiel ». [vérifié] partiel.

Conflits non tranchés :

- D7 (qd contre pl).
- D17 : rendement de `alert-matches.ts:1057` à vérifier.
- Causes de l'écart de contacts (D10) et de la surface Licitor manquante (D29).
- Nombre de prédictions existantes (D34), non mesuré.

Dépendances :

- juridique-rgpd : D3 (affirmation publique fausse), D9 (mail et téléphone du négociateur), D11 (accord Licitor, conservation, purge), D34 si des prédictions existent, transfert de pièces réelles à Replicate si v5.
- Technique : D4, D12, D19, D20, D22, D24.
- Produit et expérience : D13 (affichage), D17, D23, D26, D34, D35.
- Commercial et contenus : D16 (protocole du pilote), contenu de la page de méthode (D3).

## 5. Essais payants demandés (non lancés, à autoriser par le propriétaire)

| Essai                                                             | Montant                            | Ce qu'il prouve                                                           | Source |
| ----------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------- | ------ |
| Pilote de 5 appels du jeu d'évaluation                            | plafond 1 USD                      | Comportement réel de `semantic_evidence_v3` sur le texte libre            | pl     |
| Essai complet (203 appels au plus)                                | environ 0,51 USD au plus           | Idem, sur pièces fictives                                                 | pl     |
| Essai complet avec deux répétitions                               | 1,53 USD au plus                   | Idem, plus la variabilité                                                 | pl     |
| Réessai de la v4 en production                                    | environ 0,08 USD                   | La v4 telle que déployée, jamais essayée                                  | qa     |
| Essai comparatif sur 12 ventes, seulement si D27 conduit à une v5 | environ 0,16 USD (jetons supposés) | Effet réel d'une coupe plus large ; envoie des pièces réelles à Replicate | pl     |

Gratuits, à faire avant : l'essai local `--input` sans `--publish` (qa, D4) et les rejeux hors ligne des règles D5 à D8 (pl).

Ce qui menace lundi : D1, D10, D12, D14, D15, D16. À régler avant les envois réels du 17 au 19/11 : D9 et D11.

Trois corrections les plus rentables pour la fiabilité perçue : D2 avec D3 (modèle et page publique), D5 avec D8 (titres et résumés non prouvés), D13 (ventes fantômes).

## Annexe : consolidation du département Produit et expérience (chef : product-explorer)

# Produit et expérience : consolidation de l'état des lieux du 14/11/2026

Sources : product-explorer (PE), ux-designer (UX), analyste-indicateurs (AI). Les numéros entre parenthèses renvoient aux propositions de chaque rapport. Je suis resté en lecture seule. J'ai relu dans le code chaque point Critique ou Haute.

**En bref.** Rien dans le département n'empêche la simulation de lundi : elle n'envoie rien, et le serveur refuse le mode réel (`admin-information-agent-autopilot.ts:143-151`, [vérifié]). Trois points sont à régler avant lundi :

- la marche de lundi est périmée : selon qualite-donnees, le pilote est déjà en simulation depuis le 14/11 à 10:47 UTC ;
- un seul clic coupe la règle de l'article 14 ;
- deux refus d'aperçu en 7 jours arrêtent le pilote, même en simulation (constat fait en vérifiant le code).

Côté paiement, la nouvelle est mauvaise : 0 déblocage en novembre (qualite-donnees), aucune mesure d'usage relevée depuis le 08/11, et le plan Vercel est toujours inconnu.

## 1. Propositions consolidées

| N°                            | Sources                                               | Proposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Fichier:ligne                                                                                                                                                     | Prio.        | Effort           | Vérification                                                                                                                                                                | Quand                                                                                  |
| ----------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| P1 (ancien P2 + valeur de P7) | PE 1 ; AI 1, 2, 12                                    | Le propriétaire relève la ligne de base : activation à 7 et 30 jours (Pilotage), plafonds calculables par type de vente (Contrôles qualité), plan Vercel et console Events. Règles de lecture : un déblocage, c'est une ligne de `user_sale_unlocks`, pas `sale_unlock_confirmed`, qui part avant la réponse du serveur. Les 0 déblocages de novembre se lisent avec l'activation, puisque l'essai n'a pas de quota.                                                                                                                                       | `admin-pilotage-page.tsx:712-742` ; `AdminCatalogueQualityPanel.tsx:120-151` ; `product-events.ts:1,82` ; `SaleUnlockPanel.tsx:236`                               | **Critique** | S (propriétaire) | [vérifié] écrans, envoi vers Vercel seul ; valeurs non mesurées                                                                                                             | avant le 18/11                                                                         |
| P2                            | UX 7, 8, 9 (volet marche) ; qualite-donnees Q3 ; chef | Compléter la marche de lundi. **0** : lire l'état d'abord (pilote déjà en simulation, un réglage changé le 14/11 à 10:45 UTC) et vérifier « Licitor décodées : oui » et « Article 14 : oui ». **1** : le bouton est dans le dépliant « Réglages », sous les compteurs, pas dans l'onglet Réglages. **2** : rien avant le passage de 9 h 30. **3** : les « Non » du contrôle de préparation sont normaux. **4** : petit lexique des codes. **5** : si l'état passe à « Arrêté automatiquement » (`policy_rejections`), ne pas réarmer et lire les blocages. | `2026-11-14-administration-et-pilote.md:70-83` ; `information-agent-autopilot.ts:412-420,526-531` ; `autopilot-rules.ts:511` ; migration `20261119100500:125-127` | **Haute**    | S (texte)        | [vérifié] code ; état du 14/11 mesuré par qualite-donnees, que je n'ai pas revérifié                                                                                        | **avant lundi 9 h 30**                                                                 |
| P3                            | UX 6 ; juridique-rgpd J8, J9                          | Panneau du pilote. Les boutons doivent dire l'action (« Ouvrir les adresses Licitor décodées »), pas l'état. La désactivation de l'article 14 sort de l'écran (J9 : borne de 1 à 30 jours en base). « Attester l'AIPD » passe dans un bloc Conformité, avec confirmation et lien vers un document versionné (J8). Aujourd'hui, une fois le motif saisi, un clic coupe la règle, sans confirmation ni garde côté serveur. Comme la règle est revérifiée à l'envoi, une erreur de lundi toucherait les envois de mardi.                                      | `AdminInformationAgentAutopilotPanel.tsx:155-180` ; `admin-information-agent-autopilot.ts:158-177` ; `autopilot-rules.ts:463-469`                                 | **Haute**    | S + S (base)     | [vérifié] ; fonction RPC non relue                                                                                                                                          | avant le premier envoi réel                                                            |
| P4 (ancien P30)               | UX 1, 2, 3 ; juridique-rgpd J10                       | Mention de l'avocat. La placer après « Prix de départ, hors frais ». Faire de « avocat poursuivant » et « cahier des conditions de vente » des termes du glossaire. Ajouter un lien « Où consulter le cahier » qui ne mène pas qu'à la section payante : le cahier se consulte au greffe ou au cabinet de l'avocat poursuivant (art. R. 322-11 CPCE, source secondaire à revérifier). Corriger « (sans l'heure) » et les accords. La reformulation (UX 2) se décide avec le pied de message de J10, qui citera ce texte aux avocats.                       | `SalePublicPreview.tsx:577-589` ; `LawyerFactSourceNote.tsx:13-20` ; `lawyer-fact-sources.ts:121-124,200,205-228` ; `ceiling/Terme.tsx:34,109`                    | **Haute**    | S                | [vérifié] code ; effet sur la confiance [supposé]                                                                                                                           | texte figé avant le premier envoi réel ; placement avant la première décision acceptée |
| P5 (reste de l'ancien P1)     | PE 3, UX 4, AI (P1)                                   | Le bouton « S'inscrire » de l'en-tête garde la vente : la fiche note son adresse en `sessionStorage`, et `/login` la lit quand `redirect` manque. L'en-tête ne reçoit aucun JS. Mesure : `signup_submitted` avec `entry=direct`, si P1 confirme que les événements arrivent.                                                                                                                                                                                                                                                                               | `site-header-shared.tsx:84-86` ; `login-page.tsx:65-75`                                                                                                           | **Haute**    | S                | [vérifié] ; fréquence [supposé]                                                                                                                                             | semaine du 16/11                                                                       |
| P6 (ancien P17)               | PE 2 ; AI (P17)                                       | Mettre à jour la liste go / no-go : P7 est codé (la ligne 109 dit « Pas en place ») ; double authentification refusée le 12/11, risque accepté (ligne 29) ; Lovable supprimé (#492) ; envois aux notaires ouverts le 12/11 sur accord oral ; lignes Vercel 66-67 ; recette Stripe.                                                                                                                                                                                                                                                                         | `conditions-de-lancement-2026-10-10.md:29,66-67,109` ; `2026-11-11-registre-des-pieces.md:364-370`                                                                | **Haute**    | S                | [vérifié]                                                                                                                                                                   | avant le 18/11                                                                         |
| P7                            | PE 4                                                  | Lot R3 : traiter les lots et la surface avant le nombre de pièces. Les pièces (101 candidats) ne bloquent aucun plafond, la surface si. Mais les PDF ne règlent que 6 surfaces sur 277 : le gain viendrait du rattachement des lots (33 ventes à plusieurs lots sans surface) et des réponses d'avocats.                                                                                                                                                                                                                                                   | `bid-ceiling-gaps.ts:80-88` ; annexe 01, l. 118-125, 178-181                                                                                                      | **Haute**    | S (décision)     | [vérifié] chiffres du 11/11 ; gain [supposé]                                                                                                                                | avant le lancement de R3                                                               |
| P8                            | AI 4, 5, 6, 7                                         | Mesure du pilote. Lundi, on ne lit que les `would_send`, les codes de refus et `would_send_days`. Aucun taux de réponse avant les envois réels ; sur 1 à 3 envois, on décrit sans conclure. Après le premier envoi, qualite-donnees lance une requête SELECT agrégée : statuts, délai médian `replied_at - sent_at`, décisions acceptées, effectif brut à côté de chaque taux.                                                                                                                                                                             | migration `20261119100500:97-141` ; `20260825103748:7-30`                                                                                                         | **Haute**    | S puis M         | [vérifié] statistiques et table `cases`. Table des décisions [non vérifié] : AI la nomme `information_agent_fact_decisions`, qualite-donnees `auction_fact_claim_decisions` | cadrage lundi ; requête après le premier envoi                                         |
| P9 (C5)                       | PE 6                                                  | Le texte d'inscription de la fiche publique vend l'adresse, l'occupation, les photos et la fourchette de valeur, pas le plafond.                                                                                                                                                                                                                                                                                                                                                                                                                           | `SalePublicPreview.tsx:634-639`                                                                                                                                   | **Haute**    | S-M              | [vérifié] texte ; effet [supposé]                                                                                                                                           | bloqué par le conflit 1                                                                |
| P10                           | PE 12                                                 | Décision : reporter le DPE, l'occupation automatique, R9 et la refonte hors des zones de « Maintenant » jusqu'à l'ouverture du paiement.                                                                                                                                                                                                                                                                                                                                                                                                                   | –                                                                                                                                                                 | **Haute**    | S                | gain [supposé]                                                                                                                                                              | à arbitrer (4.B)                                                                       |
| P11                           | UX 10                                                 | Arrêt d'urgence en style « danger » (aujourd'hui `admin-button-primary`) et affiché sur l'accueil quand le pilote tourne. « Réel » en couleur d'alerte plutôt qu'en vert. Passe en Haute avant le mode réel.                                                                                                                                                                                                                                                                                                                                               | `AdminAutopilotEmergencyStop.tsx:35` ; `AdminInformationAgentSummary.tsx:9-13`                                                                                    | Moyenne      | S                | [vérifié]                                                                                                                                                                   | –                                                                                      |
| P12                           | UX 9                                                  | Libellés français pour les codes des candidats écartés ; ligne « prochain passage ».                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `autopilot-view.ts:88`                                                                                                                                            | Moyenne      | S                | [vérifié]                                                                                                                                                                   | –                                                                                      |
| P13                           | UX 7, 8 (volet code)                                  | Dépliant renommé « Réglages du pilote » ; mention « Attendu » et « Non » en couleur neutre pendant la simulation.                                                                                                                                                                                                                                                                                                                                                                                                                                          | `AdminInformationAgentAutopilotPanel.tsx:104-119`                                                                                                                 | Moyenne      | S                | [vérifié]                                                                                                                                                                   | –                                                                                      |
| P14                           | UX 5                                                  | `/bienvenue` depuis une fiche : annoncer le retour à la vente dès l'étape 1, et un encadré final cohérent avec ce retour.                                                                                                                                                                                                                                                                                                                                                                                                                                  | `InvestorOnboarding.tsx:177-179,321-328,348`                                                                                                                      | Moyenne      | S                | [vérifié] par UX                                                                                                                                                            | –                                                                                      |
| P15                           | AI 8                                                  | Compteur `manual_oppositions` : aujourd'hui, une opposition après un envoi manuel n'est comptée nulle part.                                                                                                                                                                                                                                                                                                                                                                                                                                                | migration `20261119100500:107-111,132-134`                                                                                                                        | Moyenne      | S-M              | [vérifié]                                                                                                                                                                   | avant le 30e envoi manuel                                                              |
| P16 (ancien P8, mesure)       | PE 5, réduit                                          | Compter une fois en SQL les surfaces saisies par les utilisateurs : aucun écran ne lit `user_surface_m2`.                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `admin-catalogue-quality.ts:267-268`                                                                                                                              | Moyenne      | S                | [vérifié]                                                                                                                                                                   | –                                                                                      |
| P17 (ancien P18)              | AI 10, modifié                                        | Avant / après de P5 et P14 : mesurer l'activation à 7 jours, pas les déblocages (nuls pendant l'essai). Témoin : les 14 jours précédents ; relire 5 parcours ; pas de test A/B.                                                                                                                                                                                                                                                                                                                                                                            | `admin-pilotage-page.tsx:712-715`                                                                                                                                 | Moyenne      | S                | [vérifié] définition                                                                                                                                                        | –                                                                                      |
| P18 (ancien P23)              | PE 7                                                  | Un seul nom pour le quota.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `offers-page.tsx:106,390`                                                                                                                                         | Moyenne      | S                | [vérifié] par PE                                                                                                                                                            | –                                                                                      |
| P19 (ancien P21)              | PE 8, UX                                              | Prix au m² sur les cartes mobiles (CSS seulement).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `SearchResults.tsx:680`                                                                                                                                           | Moyenne      | S                | [vérifié] par PE et UX                                                                                                                                                      | –                                                                                      |
| P20 (ancien P19)              | PE 9                                                  | État vide avant le bandeau d'essai.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `SearchResults.tsx:250-258`                                                                                                                                       | Moyenne      | S                | [vérifié] par PE                                                                                                                                                            | –                                                                                      |
| P21 (ancien C6/P9)            | PE 10, AI                                             | `upgrade_prompt_viewed` et propriété `surface`, seulement si P1 confirme le plan Pro.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `product-events.ts:19-37,76`                                                                                                                                      | Moyenne      | S                | [vérifié]                                                                                                                                                                   | –                                                                                      |
| P22                           | PE 11                                                 | R4 réduit : « Information demandée au professionnel le … » sur la fiche, et repère « fiche complétée » sur les ventes suivies.                                                                                                                                                                                                                                                                                                                                                                                                                             | absent de `src/`                                                                                                                                                  | Moyenne      | M                | [vérifié] absence ; valeur [supposé]                                                                                                                                        | après juridique-rgpd                                                                   |

## 2. Statut des points P du 08/11

| Statut        | Points                                                                                                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fait          | P3, P4, P5, P6 (seuil de 15 % non confirmé par `statisticien`), P7 (codé, valeur jamais relevée), P8 (application en production non vérifiée), P10a, P11, P12 (non revérifié), P14, P16 |
| Partiel       | P1 → P5 ; P17 → P6 ; P30 → P4 (l'argumentaire « pourquoi 59 € » n'existe pas ; prix vérifié dans `analysis-offer.ts:24,36`)                                                             |
| Ouvert        | P2 → P1 ; P9/C6 → P21 ; P18 → P17 ; P19 → P20 ; P21 → P19 ; P23 → P18 ; P13, P15, P22, P25, P26, P27, P28 inchangés                                                                     |
| Non revérifié | P10b-c, P20, P24, P31                                                                                                                                                                   |
| Dépassé       | P29 : le propriétaire a fait de l'agent d'information un chantier prioritaire                                                                                                           |

## 3. Propositions écartées ou fusionnées

- **AI 12** (part des comptes à 3 déblocages) : déjà mesurée par qualite-donnees (0 déblocage, 0 compte en novembre). Fusionnée dans P1.
- **AI 2**, comme correction de code : l'envoi de l'événement avant la réponse est voulu et documenté (`product-events.ts:82`). On garde seulement la règle de lecture (P1).
- **AI 4** : c'est un constat sain (seuils de sécurité déjà calculables). Fusionné dans P8.
- **AI 3** (propriété `enriched`), **AI 9** (effet de l'enrichissement), **AI 11** (mesure de la mention) : reportés. Avec 0 décision, 0 publication et 0 déblocage, il n'y a rien à mesurer, et ils dépendent de P1.
- **PE 5**, volet écran « plafonds rendus calculables » : reporté, il afficherait 0. Remplacé par P16.
- **UX 6**, volet « confirmation explicite » pour l'article 14 : remplacé par J9 (aucune désactivation possible).
- **UX 1**, mesure de la position du bouton : devient un critère d'acceptation de P4.
- **PE, « Ensuite : premiers envois du pilote »** : sorti de ma feuille de route, car ces envois dépendent de J7 (juridique-rgpd).

## 4. Conflits et dépendances

**Tranchés**

1. **Mention de source.** PE écrit qu'elle ne s'affiche sur aucune fiche, UX décrit son affichage : les deux sont vrais. Le code est prêt et testé, mais la mention ne s'affiche que si une décision acceptée porte une valeur encore égale à la colonne (`lawyer-fact-sources.ts:162-169`). Qualite-donnees mesure 0 décision et 0 publication. Le parcours de Claire décrit donc la première fiche qui la portera, peut-être après les envois de cette semaine.
2. **P7** : AI le dit ouvert, mais il est codé (`AdminCatalogueQualityPanel.tsx:120`). Sa valeur n'a jamais été relevée.
3. **P1** : AI le supposait ouvert. Il est partiel, vérifié (`InvestorOnboarding.tsx:129-132`).
4. **UX 6 contre J9** : J9 l'emporte pour l'article 14.
5. **AI 10** : on mesure l'activation, pas les déblocages.
6. **Portée du pilote** : PE cite 62 ventes avec adresse au 11/11 ; qualite-donnees mesure 219 ventes avec un contact au 14/11. Le chiffre du 14/11 fait foi. La part réellement éligible reste inconnue jusqu'à lundi.
7. **Surface** : 277 manques sur 1 056 dans l'annexe du 11/11, environ 197 sur 843 ventes visibles au 14/11. Les périmètres diffèrent ; la ligne de base prend le 14/11.

**Non tranchés**

- **A.** UX 2 (« non vérifiée par Immojudis » fait baisser la confiance) contre le texte validé le 10/11, que J10 reprend dans le pied de message. À trancher par juridique-rgpd et gardien-marque avant le premier envoi réel.
- **B.** P10 (refonte limitée aux zones de « Maintenant ») contre la décision du propriétaire du 12/11 (refonte zone par zone après R2). Au propriétaire de trancher.
- **C.** État du pilote : le compte-rendu du 14/11 note `mode=off` à 09:27 UTC ; qualite-donnees mesure `simulation` depuis 10:47 UTC. Qui a basculé, et quel réglage a changé à 10:45 ? [non vérifié]. Le propriétaire doit confirmer avant lundi.
- **D.** Conflit 1 (terme du plafond) toujours ouvert : il bloque P9.

**Dépendances**

- **juridique-rgpd**
  - J7 conditionne les envois du 17 au 19/11. Cela répond à la question de PE : oui, les préalables s'appliquent aussi aux envois manuels.
  - J8 et J9 → P3 ; J10 → P4 ; P22.
  - `sessionStorage` de P5 : confirmer l'exemption de l'art. 82 de la loi Informatique et Libertés.
  - Art. R. 322-11 CPCE à revérifier sur Légifrance.
- **Technique**
  - L'arrêt automatique sur deux refus d'aperçu en simulation est-il voulu ? (code-reviewer)
  - Contrainte en base de J9.
  - Budget JS de `/sales` (T7) pour P19 et P20, qui n'ajoutent pas de JS.
  - Tâche PDF bloquée depuis le 11/11.
- **Données** : P7, P8, P16. Les 2 réponses non rattachées sont à traiter avant lundi (Critique chez qualite-donnees).
- **Commercial et contenus** : P9 et le conflit 1 ; P18 (gardien-marque) ; argumentaire 59 €.
- **securite-applicative** : ligne double authentification (P6). **statisticien** : seuil de 15 %.

## 5. Feuille de route du département

|            | Sujet                                                                                         | Responsable                                                 | Métrique (actuel → cible)                                                                                                                                              | Échéance ou signal                                                    |
| ---------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Maintenant | 1. Lundi sans surprise : P2, puis P3                                                          | chef d'orchestre (marche), developpeur, juridique-rgpd (J9) | Réglages modifiés par erreur : 0. `would_send_days` : 0 → 1 le 16/11. Aucun arrêt automatique inexpliqué                                                               | Marche : 16/11, 9 h. P3 : avant le premier envoi réel                 |
| Maintenant | 2. Ligne de base (P1)                                                                         | propriétaire                                                | Activation à 7 et 30 jours, plafonds calculables par type : non mesurés → relevés. Plan Vercel : inconnu → oui ou non                                                  | 18/11                                                                 |
| Maintenant | 3. Mention de l'avocat prête (P4)                                                             | developpeur, après juridique-rgpd et gardien-marque         | Test e2e à 390 px : mention sous le prix, termes cliquables, « Créer mon compte gratuit » visible au premier écran                                                     | Avant la première décision acceptée                                   |
| Maintenant | 4. Reste de P1 (P5)                                                                           | developpeur                                                 | Test e2e : en-tête → `/login` → retour sur `#calculation`. Activation à 7 jours comparée (P17)                                                                         | 20/11                                                                 |
| Maintenant | 5. Liste go / no-go (P6)                                                                      | product-explorer, propriétaire                              | Chaque ligne datée du 14/11 ou après ; date cible d'ouverture du paiement écrite                                                                                       | 18/11                                                                 |
| Ensuite    | P7 ; P8 après les envois ; P9 après le conflit 1 ; P11 à P15 (avant le mode réel) ; P16 à P21 | divers                                                      | Hypothèses : les lots et la surface débloquent plus de plafonds que les pièces ; un taux de réponse se lit sur 30 envois ; un abonné qui obtient son plafond convertit | –                                                                     |
| Plus tard  | P22 et écran « plafonds rendus calculables »                                                  | –                                                           | –                                                                                                                                                                      | 20 décisions acceptées ou plus                                        |
| Plus tard  | AI 3, 9 et 11 ; anciens P26 et P13                                                            | –                                                           | –                                                                                                                                                                      | Plan Pro confirmé ; dizaines de fiches enrichies ; T7 et D12 faits    |
| Plus tard  | Anciens P10b-c, P15, P22, P24, P25, P27, P28, P31                                             | –                                                           | –                                                                                                                                                                      | Paiement ouvert ; cible choisie (ancien P22)                          |
| Plus tard  | Outcome Graph ; offre Pro                                                                     | –                                                           | –                                                                                                                                                                      | Gel levé ; hypothèse testée                                           |
| Non        | Envoi réel avant que J7 soit tranché                                                          | –                                                           | –                                                                                                                                                                      | Mise en balance validée, DPA signés, trace écrite de l'accord Licitor |
| Non        | DPE et occupation automatiques, R9 avant le lancement                                         | –                                                           | Le DPE n'entre pas dans le plafond                                                                                                                                     | Paiement ouvert                                                       |
| Non        | Filtre « plafond au-dessus de la mise à prix »                                                | –                                                           | Il retient 92 % des ventes                                                                                                                                             | Aucun élément nouveau                                                 |

**Sources web**

- [Vercel, Custom events](https://vercel.com/docs/analytics/custom-events), relevée par PE.
- [Article R322-11 CPCE, french-business-law.com](https://french-business-law.com/rench-legislation-art/article-r322-11-of-the-french-code-of-civil-enforcement-procedures), source secondaire à revérifier sur Légifrance.

**Fichiers clés**

- /home/user/immojudis/src/components/admin/AdminInformationAgentAutopilotPanel.tsx
- /home/user/immojudis/src/lib/information-agent-autopilot.ts
- /home/user/immojudis/src/lib/information-agent/autopilot-rules.ts
- /home/user/immojudis/src/lib/lawyer-fact-sources.ts
- /home/user/immojudis/src/components/SalePublicPreview.tsx
- /home/user/immojudis/src/components/site-header-shared.tsx
- /home/user/immojudis/docs/roadmaps/conditions-de-lancement-2026-10-10.md
- /home/user/immojudis/docs/equipe/2026-11-14-administration-et-pilote.md

## Annexe : consolidation du département Commercial et contenus (chef : directeur-marketing)

**Département Commercial et contenus : consolidation au 14/11/2026** (chef : directeur-marketing)

J'ai travaillé en lecture seule, sur HEAD e874bc8. J'ai lu en entier les trois rapports du département, et les passages utiles des rapports juridique-rgpd, ux-designer et analyste-indicateurs. J'ai rouvert le code de chaque proposition Critique ou Haute. J'ai fait deux lectures publiques le 14/11 : `/tmp/claude-0/-home-user-immojudis/506d74fb-0896-53e2-9882-fc683276f6ac/scratchpad/legal.html` et `/tmp/claude-0/-home-user-immojudis/506d74fb-0896-53e2-9882-fc683276f6ac/scratchpad/offres.html`. Aucun appel à Stripe, rien écrit. Les chemins sont relatifs à `/home/user/immojudis`.

**Le paiement est ouvert : ce que ça change**

- **Ce que montre la production.**
  - `/offres` ne dit plus « pas encore ». Elle affiche « Analyse : abonnement à 59 € TTC / mois, sans engagement ».
  - `/legal` publie une SASU immatriculée au RCS de Bordeaux, en franchise de TVA.
  - Le bloquant « identité de l'éditeur : ouverte » du rapport paiements-stripe est donc **périmé**.
- **Ce que disent les documents.** `conditions-de-lancement-2026-10-10.md:36` (« Stripe configuré en production : À faire par le propriétaire ») et `:100` (recette en mode test) ne sont pas cochés. Aucun document ne trace l'ouverture. Deux explications sont possibles, toutes deux [supposé] : une configuration réelle non notée, ou une clé de test en Production.
- **Bloquants de paiements-stripe :**
  - **n° 2 devient Critique** : son § 5 est la procédure de fermeture qu'on appliquerait aujourd'hui. Mon propre n° 1 la recommandait.
  - **n° 3 devient Critique** : le mode est inconnu. Avec une clé de test, Analyse s'obtient gratuitement avec la carte de test. Avec une clé réelle, les prélèvements tournent sans recette.
  - **n° 1 reste Haute** : il devient Critique dès le premier abonné réel. D'ici là, une consigne opératoire immédiate suffit.
- **Simulation de lundi** : rien dans le département ne la menace, puisqu'elle n'envoie rien. Une contrainte toutefois : si l'email aux avocats change avant le 17/11, figer le modèle avant la simulation, ou régénérer les brouillons avant l'envoi.

### 1. Propositions consolidées

**A. Maintenant que le paiement est ouvert**

| N°  | Sources                                                                         | Proposition                                                                                                                                                                                                                                                                                                                                                             | Fichier:ligne                                                                                             | Prio.                               | Effort | Vérif.                                                          |
| --- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------ | --------------------------------------------------------------- |
| C1  | directeur-marketing 1 ; paiements-stripe 3 (constat)                            | Aujourd'hui, le propriétaire : (1) dit par écrit si l'ouverture est voulue ; (2) lit le préfixe de `STRIPE_SECRET_KEY` sur la cible Production ; (3) compte les abonnements existants, en lecture seule. Si l'ouverture n'est pas voulue ou si la clé est de test : fermer par la consigne de C2. Si elle est voulue avec une clé réelle : C2 à C6 passent en immédiat. | `analysis-checkout-readiness.ts:44-58` ; `conditions-de-lancement…:36,100`                                | Critique                            | S      | [vérifié] état ; intention et mode [supposé]                    |
| C2  | paiements-stripe 2 (remplace la fermeture de directeur-marketing 1)             | Le retour arrière « retirer `STRIPE_ANALYSIS_PRICE_ID` » fait passer les abonnés prélevés en `decouverte` et coupe le rapprochement. Consigne immédiate : copier d'abord le Price dans `STRIPE_ANALYSIS_LEGACY_PRICE_IDS`, ce qui garde aussi le rapprochement actif. Correction durable : un interrupteur de vente lu par la garde, et le runbook corrigé.             | `ouverture-paiements.md:124-125` ; `billing.ts:1179-1188,1239-1244` ; `billing-reconciliation.ts:266-270` | Critique                            | S      | [vérifié]                                                       |
| C3  | paiements-stripe 3                                                              | Refuser `sk_test_` au build Production. Rejeter un événement dont `livemode` diverge de la clé. Fermer la garde en cas de divergence.                                                                                                                                                                                                                                   | `analysis-checkout-readiness.ts:44-58` ; `scripts/lib/launch-config.mjs:77-98` ; `billing.ts:522`         | Critique                            | S      | [vérifié] absence ; seul `billing.ts:848` enregistre `livemode` |
| C4  | C10 et C11 du 08/11 ; paiements-stripe A, C et n° 7 ; directeur-marketing A     | Recette en mode test, jamais notée. Corriger d'abord le scénario 7, puis : version d'API, alerte Radar, base du Preview distincte. Cocher `invoice.payment_action_required` sur le webhook. Relire en production les migrations `20261110140000`, `20261110140100` et `20261113100000` (Technique).                                                                     | `ouverture-paiements.md:71-73,102,115-116`                                                                | Critique si la clé est réelle       | M      | [vérifié] doc ; état Stripe et migrations [non vérifié]         |
| C5  | directeur-marketing et paiements-stripe (transmis) ; J17 juridique-rgpd         | Les CGU 2026-11-10.1 sont en vigueur alors que leur note dit « BROUILLON à faire valider par un avocat avant la mise en ligne », et chaque souscription les accepte. S'y ajoutent : la variante « ouverte » des textes de C12 (08/11) non relue ; « 59 € TTC » à côté de « TVA non applicable » ; « Directeur de publication : Immojudis », vu en production.           | `legal-documents.ts:23-35,107-112`                                                                        | Critique                            | S      | [vérifié] ; juridique-rgpd                                      |
| C6  | C9 du 08/11 ; paiements-stripe 1                                                | En mode `full`, une rétractation relancée plus de 24 h après rembourse une autre charge : 59 € de plus. Consigne immédiate : ne jamais relancer une rétractation sans lire les remboursements dans Stripe.                                                                                                                                                              | `contract-withdrawal.ts:143-158`                                                                          | Haute ; Critique au 1er abonné réel | S      | [vérifié]                                                       |
| C7  | C6 du 08/11 ; directeur-marketing A et n° 10 ; analyste-indicateurs C6 et n° 12 | Mesure : pas de `upgrade_prompt_viewed`, et ni `checkout_started` ni `opening_notification_requested` n'ont de propriété `surface`. Je ramène ma cote « Critique » à Haute : aucun risque pour le client, et l'enchaînement `offers_viewed`, `checkout_started`, `checkout_returned` existe déjà, si la console Vercel est lisible (P2).                                | `product-events.ts:19-37,70-76`                                                                           | Haute                               | S-M    | [vérifié] ; registre : juridique-rgpd                           |
| C8  | C7 du 08/11 ; directeur-marketing A (origine strategie-email)                   | Un rebond ou une plainte n'arrête ni l'avis J+5 ni l'email d'ouverture. Ne pas lancer le lot d'ouverture, envoyé à la main depuis l'administration, avant cette correction.                                                                                                                                                                                             | `account-email-delivery-events.ts:95-106` ; `admin-offer-opening-notifier.ts:315`                         | Haute                               | M      | [vérifié] ; filtre éventuel en base [non vérifié]               |
| C9  | directeur-marketing 10                                                          | Mois épuisé : « Voir l'offre Analyse » mène à `/offres` et fait perdre la vente visée. Proposer « Ouvrir cette vente avec Analyse », avec retour sur la fiche après le paiement, et garder l'option gratuite (le 1er du mois).                                                                                                                                          | `SaleUnlockPanel.tsx:399-406`                                                                             | Haute                               | M      | [vérifié] ; parcours : ux-designer                              |
| C10 | directeur-marketing 8 ; C18 du 08/11                                            | La carte Analyse de l'accueil liste des fonctions. La remplacer par les vraies différences : toutes les ventes au-delà de 3 par mois, jusqu'à 25 alertes (`plans.ts:176`), un email quotidien seulement si C1 (08/11) est en production. Ligne courte de `/sales` : « 7 jours pour ouvrir toutes les ventes, sans carte bancaire ».                                     | `HomeOffers.tsx:33-38` ; `launch-offer.ts:36`                                                             | Haute                               | S      | [vérifié]                                                       |
| C11 | directeur-marketing 9 ; C2 du 08/11 ; J5                                        | Fin d'essai : nommer ce que la personne a construit (alertes, favoris, plafonds calculés) et ce qu'elle garde.                                                                                                                                                                                                                                                          | `AccountLaunchOfferEnd.tsx:52-55` ; `launch-offer.ts:58-59`                                               | Haute                               | M      | [vérifié] absence ; J5 : juridique-rgpd                         |

**B. Avant le premier envoi réel aux avocats**

Le modèle d'email est sous validation juridique (`.env.example:270-272`) : chaque changement est relu par juridique-rgpd. Si J7 (juridique, Critique) est retenu, les envois réels sont décalés, ce qui laisse le temps de faire ces changements.

| N°  | Sources                                    | Proposition                                                                                                                                                                                                                                                                                                                                                | Fichier:ligne                                                                                                            | Prio. | Effort | Vérif.                            |
| --- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----- | ------ | --------------------------------- |
| C12 | directeur-marketing 6 (première moitié)    | « Rien n'est publié sans vérification par notre équipe » (email et formulaire) contredit « non vérifiée par Immojudis » (fiche). Écrire « relecture », ce que l'équipe fait réellement. La mention validée de la fiche n'est pas touchée.                                                                                                                  | `emails/information-request.tsx:200-201` ; `InformationAgentContributionForm.tsx:559-560` ; `lawyer-fact-sources.ts:123` | Haute | S      | [vérifié]                         |
| C13 | directeur-marketing 4 ; J15 juridique-rgpd | Bloc de dépôt : un encadré doré et un bouton venant d'un expéditeur inconnu font penser à un hameçonnage [supposé]. Le remplacer par une ligne de texte sans bouton. Selon J15, retirer aussi l'invitation à joindre des « documents ou photos » et la citation du procès-verbal descriptif. Les deux textes sont dans la même zone : une seule relecture. | `emails/information-request.tsx:199-216` ; `information-agent-email-template.ts:306`                                     | Haute | S-M    | [vérifié]                         |
| C14 | directeur-marketing 2 et 3                 | Remonter avant les questions la phrase « une fiche exacte évite aux candidats de vous interroger ». Retirer la leçon de procédure (« 10 % de la mise à prix, 3 000 € au minimum… ») posée à un avocat. Le texte d'introduction existe en double.                                                                                                           | `information-agent-email-template.ts:293,313` ; `recipient-templates.ts:50` ; `information-agent-questions.ts:65`        | Haute | S      | [vérifié] texte ; effet [supposé] |
| C15 | directeur-marketing 7                      | Page publique « Vous avez reçu une demande d'Immojudis ? », puis l'autoriser comme lien dans l'email. Elle peut porter la procédure de retrait que demande J10. Réaliste avant le mode réel, pas avant le 17/11.                                                                                                                                           | `information-agent-commercial-guard.ts:77-81`                                                                            | Haute | M      | [vérifié] absence                 |

**C. Contenus, acquisition et suites**

| N°  | Sources                                                   | Proposition                                                                                                                                                                                                                                                                          | Fichier:ligne                                                                                                                                        | Prio.   | Effort | Vérif.                                          |
| --- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------ | ----------------------------------------------- |
| C16 | C3, C4, C5 du 08/11 ; directeur-marketing ; seo-expert    | Chapô des départements et de `/sales`, promesse de la fiche : ils attendent le conflit 1. La correction de « dès qu'elles sont publiées » n'attend pas.                                                                                                                              | `department-view.tsx:454` ; `SalesCatalogueHead.tsx:121-124` ; `SalePublicPreview.tsx:875`                                                           | Haute   | M      | [vérifié] ouvert                                |
| C17 | C8 du 08/11                                               | Consentement aux alertes daté, et source `onboarding_trial`.                                                                                                                                                                                                                         | `notification-preferences.ts:246-248`                                                                                                                | Haute   | M      | [vérifié] absence                               |
| C18 | C15 et C16 du 08/11                                       | Page « méthode du plafond » ; encart Alsace-Moselle.                                                                                                                                                                                                                                 | `src/app/`                                                                                                                                           | Haute   | M      | [vérifié] absence                               |
| C19 | C13 du 08/11                                              | « Essai d'ouverture » : la décision P3 devient urgente.                                                                                                                                                                                                                              | `conditions-generales.tsx:348`                                                                                                                       | Haute   | M      | [non vérifié]                                   |
| C20 | C14 du 08/11                                              | Mettre 3 articles à jour.                                                                                                                                                                                                                                                            | `src/content/resources/`                                                                                                                             | Haute   | S      | [non vérifié] : l'historique s'arrête à d80a590 |
| C21 | directeur-marketing 5                                     | Expéditeur `enquete@` remplacé par `fiches@`. **Ramené à Moyenne** : `enquete+` est codé en dur dans le Reply-To et dans l'analyse des réponses. Changer la seule variable laisse `enquete+…` visible quand l'avocat répond, et un changement complet doit accepter les deux formes. | `.env.example:274` ; `information-agent/send.ts:259` ; `information-agent-inbound/job-queue.ts:56` ; `information-agent-inbound/reply-intent.ts:144` | Moyenne | M      | [vérifié]                                       |
| C22 | paiements-stripe 4                                        | Double email au 3-D Secure.                                                                                                                                                                                                                                                          | `billing.ts:1045-1055`                                                                                                                               | Moyenne | S      | [non vérifié]                                   |
| C23 | paiements-stripe 5                                        | Bruit du rapprochement ; issue des relances à écrire au runbook.                                                                                                                                                                                                                     | `billing-reconciliation.ts:69,155-165`                                                                                                               | Moyenne | S      | [non vérifié]                                   |
| C24 | paiements-stripe 6                                        | Prorata calculé jusqu'à `submitted_at` ; délai de 14 jours non contrôlé.                                                                                                                                                                                                             | `contract-withdrawal.ts:102,168`                                                                                                                     | Moyenne | S      | [non vérifié] ; juridique-rgpd (L221-25)        |
| C25 | C26 du 08/11 ; seo-expert 1 et 10                         | Tests de rendu serveur (index, département, tribunal, fiche). Le HTML doit porter la mention de l'avocat, et le JSON-LD ne doit pas présenter ces valeurs comme vérifiées.                                                                                                           | `seo-server-render.test.tsx:45,52`                                                                                                                   | Moyenne | M      | [non vérifié]                                   |
| C26 | seo-expert 3 ; C33 du 08/11                               | `lastmod` figés : `/offres` et l'accueil au 28/10 ; CGU datées 2026-10-26 pour une version 2026-11-10.1.                                                                                                                                                                             | `sitemap.ts:35-58`                                                                                                                                   | Moyenne | S      | dates [vérifié]                                 |
| C27 | seo-expert 4                                              | Une vente `unknown` déjà passée reste dans le sitemap.                                                                                                                                                                                                                               | migration `20261028100300:58`                                                                                                                        | Moyenne | M      | [non vérifié] ; Données                         |
| C28 | seo-expert 8                                              | `sameAs`, avec les seuls profils que le propriétaire détient.                                                                                                                                                                                                                        | `seo.ts:588-640`                                                                                                                                     | Moyenne | S      | [non vérifié]                                   |
| C29 | seo-expert 9 ; C24 du 08/11                               | FAQ et réponse directe sur 4 articles pivots, faits sourcés.                                                                                                                                                                                                                         | `src/content/resources/`                                                                                                                             | Moyenne | M      | [non vérifié]                                   |
| C30 | directeur-marketing 11                                    | Repère chiffré et sourcé sous le prix.                                                                                                                                                                                                                                               | `offers-page.tsx:276-290`                                                                                                                            | Moyenne | S      | statisticien, juridique-rgpd                    |
| C31 | directeur-marketing 12                                    | À explorer : les réponses des avocats comme argument, seulement après les premières publiées, jamais « sans réponse ».                                                                                                                                                               | `HomeSections.tsx:291`                                                                                                                               | Moyenne | M      | [supposé] effet                                 |
| C32 | C17, C19, C21, C22, C23, C25, C27, C28, C31, C32 du 08/11 | Inchangés, voir tableau 2.                                                                                                                                                                                                                                                           |                                                                                                                                                      | Moyenne |        |                                                 |
| C33 | paiements-stripe 8, 9 et 10 ; C30 du 08/11 ; seo-expert 5 | Route admin sans appelant ; clé d'idempotence ; identité « valide » plutôt que « remplie » ; `payment_method_types` ; `/publish` en `noindex`.                                                                                                                                       | voir les rapports                                                                                                                                    | Basse   | S      | [non vérifié]                                   |

### 2. Statut des points C du 08/11

| C                                 | Statut                                                                                                                                        | Repris en             |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| C1                                | Fait (code) ; migration en production [supposé]                                                                                               | C10 (email quotidien) |
| C2                                | Ouvert                                                                                                                                        | C11                   |
| C3, C4, C5                        | Ouverts (conflit 1)                                                                                                                           | C16                   |
| C6                                | Ouvert                                                                                                                                        | C7                    |
| C7                                | Ouvert                                                                                                                                        | C8                    |
| C8                                | Ouvert                                                                                                                                        | C17                   |
| C9                                | Partiel : prorata fait, mode `full` ouvert                                                                                                    | C6                    |
| C10                               | Fait (code) ; case du webhook et recette restent                                                                                              | C4                    |
| C11                               | Partiel : runbook écrit, retour arrière faux, recette non notée                                                                               | C2, C4                |
| C12                               | Fait (code) ; relecture juridique de la variante « ouverte »                                                                                  | C5                    |
| C13                               | Ouvert, décision P3                                                                                                                           | C19                   |
| C14                               | [non vérifié]                                                                                                                                 | C20                   |
| C15, C16                          | Ouverts                                                                                                                                       | C18                   |
| C17                               | Ouvert (`offers-page.tsx:115,221`) [vérifié]                                                                                                  | C32                   |
| C18                               | Ouvert                                                                                                                                        | C10                   |
| C19                               | Partiel : description unique faite ; descriptions de fiche et mesure restent                                                                  | C32                   |
| C20                               | Partiel : fil d'Ariane fait (seo-expert) ; lien vers le département absent, `SalePublicPreview.tsx` sans lien [vérifié] (directeur-marketing) | C32                   |
| C21                               | Ouvert (`offer-comparison.ts:73`)                                                                                                             | C32                   |
| C24                               | Partiel : 7 articles sur 25 ont une FAQ                                                                                                       | C29                   |
| C26                               | Ouvert                                                                                                                                        | C25                   |
| C29                               | Partiel : sous-domaine de l'agent                                                                                                             | C32                   |
| C30                               | Ouvert, risque réduit                                                                                                                         | C33                   |
| C33                               | `lastmod` ouvert                                                                                                                              | C26                   |
| C22, C23, C25, C27, C28, C31, C32 | Non revérifiés, [supposé] ouverts                                                                                                             | C32                   |

### 3. Propositions écartées ou corrigées

1. **Fermer la vente en « retirant une variable de la garde »** (directeur-marketing 1) : écarté. Appliqué tel quel, cela prive d'accès des abonnés prélevés. Remplacé par C2.
2. **Cote Critique de C6 du 08/11** (directeur-marketing) : ramenée à Haute (C7). Il n'y a aucun risque pour le client, et une mesure minimale existe déjà.
3. **Cote Haute de l'expéditeur** (directeur-marketing 5) : ramenée à Moyenne (C21). L'adresse est codée en dur, et la modifier un jour avant les envois touche l'analyse des réponses.
4. **« Identité de l'éditeur : ouverte »** (paiements-stripe, bloquant 1) : périmé. `/legal` la publie en production depuis au moins le 14/11.
5. **seo-expert 2** (fiche sans mise à prix) : rien à corriger. Une question passe à Données : les fiches Licitor sans prix ni surface sont en `noindex`.
6. **seo-expert 6** (pages d'administration) : sans objet, déjà correctement exclues.

### 4. Conflits non tranchés et dépendances

**Conflit 1 : mention « non vérifiée par Immojudis »** (`lawyer-fact-sources.ts:123`, texte validé le 10/11). Trois positions :

| Source                                 | Texte proposé                                                                                                                     |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| directeur-marketing 6 (seconde moitié) | « …reprise telle quelle. Seul le cahier des conditions de vente fait foi : vérifiez-la. »                                         |
| ux-designer 2                          | « Source : avocat poursuivant, message du … À confirmer dans le cahier des conditions de vente, comme toute donnée de la fiche. » |
| juridique-rgpd J10                     | Garde « non vérifiée par Immojudis » et propose de la citer telle quelle dans le pied de l'email aux avocats.                     |

Je ne tranche pas : c'est au propriétaire, avec juridique-rgpd et gardien-marque. Trois faits pour éclairer la décision :

- ux-designer a vérifié dans le code que la source la plus sûre est la seule marquée « non vérifiée ». Cet argument vaut pour les deux reformulations. Mais « comme toute donnée de la fiche » n'est vrai que si les autres valeurs portent une réserve équivalente : à vérifier.
- **Ordre à respecter** : décider avant d'écrire le pied de J10 et avant le premier envoi réel. Sinon, on annonce aux avocats un texte qui changera.
- C12 avance sans attendre.

Placement de la mention et glossaire (ux-designer 1) : relève du département Produit et expérience.

**Autres conflits encore ouverts**

- **Conflit 1 du 08/11** (« l'enchère à ne pas dépasser », et J2) : toujours ouvert. Il bloque C16.
- **Calendrier des envois réels** : J7 (juridique-rgpd, Critique) contre le plan du 17 au 19/11. Ce n'est pas au département de trancher.

**Conflits tranchés**

- Statut de C20 : partiel, voir le tableau 2.
- Méthode de fermeture : C2.
- Identité de l'éditeur : publiée.

**Dépendances**

| Qui                       | Points                                                                                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Technique (`developpeur`) | C2, C3, C6, C7, C8, C9, C12 à C14, C21 à C25, C33                                                                                                                                  |
| Technique (lecture seule) | migrations en production, variables Vercel (C4)                                                                                                                                    |
| Données                   | C18 (Alsace-Moselle), C27, fiches Licitor en `noindex`                                                                                                                             |
| Produit et expérience     | C9, ux-designer 1 et 4, `optimisation-interface`                                                                                                                                   |
| analyste-indicateurs      | C7, P2 (console Vercel)                                                                                                                                                            |
| statisticien              | C30, C17 du 08/11                                                                                                                                                                  |
| juridique-rgpd            | C5, C7 (registre), C11, C12 à C15, C24, conflit de la mention, promesse « notre équipe la relit » si la publication automatique ouvre un jour (`auto-publication-policy.ts:43-44`) |

### 5. Décisions qui reviennent au propriétaire

1. **Aujourd'hui** : l'ouverture est-elle voulue ? Quel est le mode de la clé ? Combien d'abonnements existent ? (C1)
2. **Ma recommandation** : refermer par la consigne de C2 jusqu'à ce que C3, C4 et C5 soient faits (recette, CGU validées), même si l'ouverture est voulue. Si vous gardez la vente ouverte, vous acceptez des CGU encore « brouillon » et une recette jamais faite.
3. **Texte de la mention sur la fiche**, et son annonce dans le pied de l'email aux avocats (J10), avant le premier envoi réel.
4. **Email aux avocats** : appliquer C12 à C14 avant la simulation de lundi, ou après en régénérant les brouillons.
5. **Adresse d'expéditeur** (C21), avant le mode réel.
6. **Conflit 1 du 08/11** ; décision P3 sur l'essai d'ouverture (C19).
7. **Règle des robots d'IA** (seo-expert 7 : tout autoriser, tout bloquer, ou bloquer l'entraînement seulement), et profils publics à déclarer en `sameAs`.
8. **Ne pas envoyer** le lot d'emails d'ouverture avant C8.

## Annexe : rapport de juridique-rgpd

**Juridique et RGPD : état au 14/11/2026 (lecture seule)**

Je n'ai modifié aucun fichier et je n'ai rien écrit en base. Je n'avais pas de shell, donc pas de `git log d80a590..HEAD` : les constats viennent du répertoire de travail. Je ne suis pas avocat : tout ce qui suit est à faire valider. « [Texte] » signale ce qu'établit un texte cité. Tout le reste est mon appréciation.

### A. Statut de J1 à J6 (points du 08/11)

| N°                                                  | Statut                                                        | Preuve                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| J1 (rapport partagé)                                | Fait                                                          | `reports/shared/[token]/page.tsx:210-213` affiche l'avertissement avant les chiffres. Les anciens libellés ne restent qu'en commentaire (`:128`). [vérifié]                                                                                                                                                                                                                                   |
| J2 (« tous les frais », « à ne pas dépasser »)      | Ouvert, en attente de l'arbitrage du propriétaire (conflit 1) | `offers-page.tsx:115`, `HomeHero.tsx:64` [vérifié]                                                                                                                                                                                                                                                                                                                                            |
| J3 (politique et registre en retard)                | Partiel                                                       | Le registre est à jour (lignes 14, 15 et 42). Mais la politique est toujours en version 2026-11-01.3 (`legal-documents.ts:113-118`) : ni profil d'investisseur, ni prix final (`privacy.tsx:82`). `AccountPage.tsx` n'a aucun lien vers la politique. Les lignes 28 et 106 du registre disent encore « aucune purge » des captures Licitor, alors que la ligne 42 indique 90 jours. [vérifié] |
| J4 (hébergeur)                                      | Ouvert                                                        | `legal.tsx:78-91`, `legal-documents.ts:154-158` : ni le téléphone de Vercel, ni Supabase. [vérifié]                                                                                                                                                                                                                                                                                           |
| J5 (alerte quotidienne qui repasse en hebdomadaire) | Ouvert, atténué                                               | `conditions-generales.tsx:78` et `launch-offer.ts:58-59` n'ont pas changé. La case de consentement annonce bien les deux rythmes (registre, ligne 12). [vérifié]                                                                                                                                                                                                                              |
| J6 (formulaire de rétractation)                     | Ouvert                                                        | `conditions-generales.tsx:410-415` demande « Nom et email » et pas l'adresse [Texte : C. conso. R. 221-1 et son annexe]. [vérifié]                                                                                                                                                                                                                                                            |

### B. Problèmes nouveaux ou manqués

La simulation n'envoie rien : je n'y vois rien de bloquant. En revanche, l'étape 4 de la marche de lundi prépare des envois réels manuels dès mardi. Ce qui conditionne ces envois est donc classé Critique, à trancher lundi avant l'étape 4.

| N°  | Constat et proposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Fichier:ligne                                                                                                                                               | Priorité                                  | Effort | Preuve                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------ | ------------------------------------------------------- |
| J7  | **Conditions du premier envoi réel non remplies.** La mise en balance n'a pas de validateur (« À renseigner ») et date du 14/10. Ses garanties ne tiennent plus : « validation humaine de chaque message » est faux en mode pilote, et le critère 2 y est jugé « Non ». Elle ne couvre ni les notaires (ouverts le 12/11) ni l'affichage des réponses. Les contrats de sous-traitance (DPA) et les garanties de transfert sont encore « à vérifier avant le premier envoi réel ». L'accord de Licitor n'est pas dans le dépôt. **Proposition** : aucun envoi manuel tant que (a) la mise en balance n'est pas mise à jour et validée, (b) les DPA de Resend et de Replicate ne sont pas signés avec leur garantie nommée, (c) la trace écrite de l'accord de Licitor n'est pas versée. À défaut, limiter l'étape 4 aux adresses publiées en clair. [Texte] art. 6.1.f, 28 et 44-46 RGPD. | `rgpd-mise-en-balance-agent-information.md:16,37,147` ; registre, lignes 28-29 et 35 ; `licitor-decodage-reactivation-2026-11-11.md:6-7`                    | Critique (lundi, avant l'étape 4)         | M      | [vérifié] ; absence d'envoi réel antérieur [supposé]    |
| J8  | **Aucune AIPD n'existe.** [Texte] La CNIL demande une AIPD dès que deux des neuf critères sont réunis. Ici, au moins quatre : croisement de données, usage innovant, échelle (jusqu'à 60 envois par jour, `autopilot-rules.ts:160`), données hautement personnelles dans les réponses. Le registre écrit « recommandée ». L'« attestation » est un texte libre de 1 à 40 caractères que tout administrateur peut poser. **Proposition** : rédiger l'AIPD (description, nécessité, risques, mesures) sur l'ensemble agent, pilote, registre des pièces et photos. Écrire « requise » au registre. Lier l'attestation à un document versionné (chemin et empreinte).                                                                                                                                                                                                                       | registre, ligne 28 ; `20261110230000_information_agent_autopilot.sql:364-394`                                                                               | Haute                                     | L      | [vérifié]                                               |
| J9  | **La règle « Article 14 » se désactive et accepte jusqu'à 365 jours.** Un test valide 90 jours. [Texte] L'art. 14.3.a fixe un délai « ne dépassant pas un mois ». **Proposition** : contrainte en base `between 1 and 30`, et aucune désactivation possible. Question de fond pour l'avocat : une adresse « conservée tant que le détail de l'annonce est relu » peut rester plus d'un mois sans que la personne soit informée.                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `…autopilot.sql:46-47` ; `AdminInformationAgentAutopilotPanel.tsx:124,166` ; `autopilot-rules.test.ts:365-366` ; `privacy.tsx:140`                          | Haute                                     | S      | [vérifié]                                               |
| J10 | **L'avocat ne sait pas que sa réponse peut être affichée.** Rien ne lui dit qu'elle peut apparaître avec « Information transmise par l'avocat poursuivant le [date] », ni comment la faire retirer. Le corps du message et le pied ne parlent que du contact. L'effacement ne retire pas ce qui est déjà publié. [Texte] art. 14.1.c et 21 RGPD. **Ajouter au pied** : « Les informations que vous nous transmettez peuvent être affichées sur la fiche, sans votre nom, avec la mention “Information transmise par l'avocat poursuivant le [date], non vérifiée par Immojudis”. Pour les faire retirer : [lien distinct] ou [contact]. » Par défaut, une opposition vaut aussi retrait.                                                                                                                                                                                                 | `lawyer-fact-sources.ts:123` ; `information-agent-email-template.ts:293` ; `information-agent-compliance.ts:471` ; `docs/runbooks/information-agent.md:526` | Haute                                     | S-M    | [vérifié]                                               |
| J11 | **La politique 2026-11-01.3 ne couvre pas les nouveaux traitements.** Rien sur l'affichage des réponses des avocats, ni sur les photos tirées des pièces (aucune occurrence de « photo »), ni sur l'opposition étendue à la structure. Le pied ne nomme pas la garantie de transfert : il renvoie à une demande par email. [Texte] L'art. 14.1.f exige « la référence aux garanties appropriées ». **Proposition** : publier une nouvelle version avant le premier envoi réel, en y intégrant J3.                                                                                                                                                                                                                                                                                                                                                                                        | `privacy.tsx:276-321,389-394` ; `information-agent-compliance.ts:480-489`                                                                                   | Haute                                     | M      | [vérifié]                                               |
| J12 | **Registre en retard.** (a) Aucune ligne pour le pilote (zéro occurrence), alors qu'il garde un journal 5 ans, des exclusions d'identités 24 mois et des attestations 5 ans. (b) La ligne 29 dit « purge dédiée à prévoir », alors qu'elle existe. (c) notaires.fr reste classé « désactivé sans autorisation écrite », alors que les envois aux notaires sont ouverts depuis le 12/11 sur un accord oral. (d) La ligne 39 ne dit pas que les coordonnées de l'organisateur sont lisibles par les comptes. [Texte] art. 30 RGPD. **Proposition** : mettre à jour ces lignes et la matrice de conservation.                                                                                                                                                                                                                                                                               | `…autopilot.sql:12-17` ; `20261101150000_information_agent_cases_retention.sql:100-123` ; registre, lignes 29, 39 et 113-114                                | Haute                                     | S      | [vérifié] ; purge appliquée en production [supposé]     |
| J13 | **Journaux en ajout seul, sans durée, désormais alimentés** (R2c ouvert le 12/11). Une valeur opposée reste dans la file de relecture sans purge. [Texte] art. 5.1.e RGPD. **Proposition** : un journal de preuve sans valeur, gardé 1 an après la vente (5 ans à soumettre à l'avocat, art. 2224 C. civ.) ; purger les valeurs opposées.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `data-retention-matrix.md:91-93` ; registre, ligne 30                                                                                                       | Moyenne                                   | M      | [vérifié]                                               |
| J14 | **Photos des procès-verbaux d'huissier toujours publiées**, avec une base légale « à renseigner », sans mise en balance ni information publique. [Texte] R. 322-2 CPCE (le PV décrit les lieux et l'identité des occupants), art. 9 C. civ., art. 6.1.f et 14.5.b RGPD. **Proposition minimale** : mise en balance écrite, paragraphe dans la politique, retrait des photos où l'on voit des personnes ou des effets personnels. Sinon, retirer `pv_huissier` et `proces_verbal` en attendant l'avocat.                                                                                                                                                                                                                                                                                                                                                                                  | `pdf_photos.py:97` ; `data-pipeline.yml:184` ; registre, ligne 41                                                                                           | Haute                                     | M      | [vérifié]                                               |
| J15 | **Le message invite l'avocat à joindre « documents ou photos » et cite le procès-verbal descriptif.** Ces pièces contiennent l'identité des occupants et partent sans masquage vers le prestataire d'IA, aux États-Unis. [Texte] art. 66-5 de la loi n° 71-1130 (secret professionnel), art. 5.1.c et 44 RGPD. **Proposition** : retirer cette invitation des messages du pilote ; masquer les noms avant la lecture par l'IA ; s'en tenir aux mentions de l'avis de vente (R. 322-31 CPCE).                                                                                                                                                                                                                                                                                                                                                                                             | `information-agent-email-template.ts:306`                                                                                                                   | Haute                                     | M      | [vérifié]                                               |
| J16 | **Risque de requalification en prospection (L. 34-5 CPCE).** [Texte, source secondaire] La prospection directe inclut les messages qui promeuvent « l'image d'une personne » qui vend des services, et Immojudis vend de la mise en avant aux avocats. [Texte] La CNIL admet l'intérêt légitime entre professionnels si l'objet est lié à la profession, avec information et opposition. **Proposition** : garder la garde anti-commerciale. Vérifier, puis garantir techniquement, que les adresses de l'agent ne servent jamais à vendre la mise en avant, et l'écrire au registre.                                                                                                                                                                                                                                                                                                    | `rgpd-mise-en-balance-agent-information.md:133-135`                                                                                                         | Moyenne                                   | S      | séparation technique [supposé]                          |
| J17 | **CGU 2026-11-10.1 en vigueur alors que leur propre note dit « BROUILLON à faire valider par un avocat avant la mise en ligne ».** Elles s'appliquent le 1er décembre aux comptes existants : le préavis de 30 jours de l'article 14 n'est tenu que si l'information est partie avant le 1er novembre. L'article 8 ne parle pas des informations transmises par l'avocat, désormais affichées. **Proposition** : relecture d'avocat avant l'ouverture des paiements ; décaler la date d'effet si besoin ; ajouter à l'article 8 le texte de l'annexe 07 (proposition 16).                                                                                                                                                                                                                                                                                                                | `legal-documents.ts:24-35,107-112` ; `conditions-generales.tsx:243-256`                                                                                     | Haute                                     | S      | texte [vérifié] ; mise en ligne en production [supposé] |
| J18 | **Sous-traitant du modèle d'IA peut-être non nommé.** Le modèle par défaut est `qwen/qwen3-7-plus`, via Replicate. Les modèles Qwen « Plus » sont servis par Alibaba Cloud. Si Replicate relaie l'appel, un sous-traitant non nommé reçoit les réponses des avocats. **Proposition** : faire confirmer par Replicate où le modèle s'exécute, puis nommer le sous-traitant et la garantie au registre, dans la politique et dans le pied. Traiter J4 au passage.                                                                                                                                                                                                                                                                                                                                                                                                                          | `information-agent-ai-provider.ts:6,22-24`                                                                                                                  | Moyenne (Haute si le relais est confirmé) | S      | [supposé]                                               |

### C. Ce qui est sain

- **Verrous du mode réel en profondeur.** Il faut à la fois une version de politique future, une migration `live_allowed`, une AIPD attestée, 30 envois manuels et 7 jours de simulation.
- **Le pilote reprend les gardes existantes** : délai de 30 jours par adresse, garde anti-commerciale, opposition par adresse, par identité et par structure. Le pied art. 14 est complet sur l'essentiel.
- **Fiche publique.** La mention « non vérifiée par Immojudis » est en place, avec le lien « Signaler une erreur sur cette fiche » (`ListingPreparation.tsx:392`).

### À faire valider par un avocat

1. Mise en balance (pilote, notaires, affichage des réponses) et AIPD.
2. Article 14 : adresses relevées en lot et gardées plus d'un mois ; mention du décodage Licitor dans le pied.
3. Portée de l'accord de Licitor et de l'accord oral des notaires (immobilier.notaires.fr).
4. Application de l'article L. 34-5 CPCE, compte tenu de l'offre de mise en avant vendue aux avocats.
5. Secret professionnel : questions et pièces que l'on peut demander à un avocat et à un notaire.
6. Affichage des réponses : responsabilité (art. 1240 C. civ., L. 121-2 C. conso.), libellé, procédure de retrait.
7. Photos des procès-verbaux d'huissier.
8. Durées des journaux en ajout seul.
9. CGU 2026-11-10.1 (préavis, article 8) et formulaire de rétractation.
10. Transferts : Resend, Replicate et l'éventuel sous-traitant du modèle.

**Fichiers clés**

- `/home/user/immojudis/docs/rgpd-mise-en-balance-agent-information.md`
- `/home/user/immojudis/docs/rgpd-processing-register.md`
- `/home/user/immojudis/docs/data-retention-matrix.md`
- `/home/user/immojudis/src/routes/privacy.tsx`
- `/home/user/immojudis/src/lib/information-agent-compliance.ts`
- `/home/user/immojudis/src/lib/information-agent-email-template.ts`
- `/home/user/immojudis/src/lib/lawyer-fact-sources.ts`
- `/home/user/immojudis/src/lib/information-agent/autopilot-rules.ts`
- `/home/user/immojudis/src/lib/information-agent/autopilot-readiness.ts`
- `/home/user/immojudis/supabase/migrations/20261110230000_information_agent_autopilot.sql`
- `/home/user/immojudis/src/lib/legal-documents.ts`
- `/home/user/immojudis/services/data-pipeline/src/pdf_photos.py`

**Sources**

- [RGPD, EUR-Lex](https://eur-lex.europa.eu/legal-content/FR/TXT/?uri=CELEX:32016R0679)
- [CNIL, chapitre III du RGPD](https://www.cnil.fr/fr/reglement-europeen-protection-donnees/chapitre3)
- [CNIL, AIPD](https://www.cnil.fr/fr/ce-quil-faut-savoir-sur-lanalyse-dimpact-relative-la-protection-des-donnees-aipd)
- [CNIL, prospection par courrier électronique](https://www.cnil.fr/fr/la-prospection-commerciale-par-courrier-electronique)
- [Article L. 34-5 CPCE, source secondaire à revérifier sur Légifrance](https://www.baumann-avocats.com/CPCE/article-l34-5-du-code-des-postes-et-des-communications-electroniques.php)
- [Loi n° 71-1130, Légifrance](https://www.legifrance.gouv.fr/loda/id/JORFTEXT000000508793)
- [CPCE, Légifrance](https://www.legifrance.gouv.fr/codes/texte_lc/LEGITEXT000025024948/)
- [Alibaba Cloud, Qwen-Plus](https://www.alibabacloud.com/help/en/model-studio/qwen-plus-us)

## Annexe : rapport de seo-expert sur les mots-clés stratégiques

Rapport seo-expert, 14/11/2026. Lecture seule. [vérifié] = fichier ouvert ; [supposé] = non vérifié. La position actuelle d'Immojudis est inconnue (colonnes vides de l'export) : rien n'est présenté comme un classement.

## 0. Lecture rapide

1. **La « concurrence » de l'export est publicitaire (Google Ads), pas une difficulté de classement.** Un indice de 1 ou 2 ne dit pas qu'un mot-clé est facile à ranker.
2. **Seuls ~54 000 des ~150 000 recherches/mois sont servables.** Les 96 000 autres sont hors sujet, trompeuses ou navigationnelles chez un tiers. Le plus gros groupe (33 100) est un piège : « immobilier notaire » désigne les annonces classiques de gré à gré, pas des enchères.
3. **Aucune page ne vise ni les ventes notariales ni les ventes de l'État.** Les filtres du catalogue ont pour canonique `/sales` (`src/app/sales/sales-catalogue.tsx:22-24`) : aucune page indexable n'existe pour ces ventes, hors un article de `/ressources`.
4. **Le cœur de cible tient en peu de groupes** : « enchères immobilières » (8 100), « ventes aux enchères immobilières » (5 400), « vente immobilière aux enchères » (4 400), « maison aux enchères » (4 400), puis les saisies (~7 800). Il est en baisse de 18 à 33 % sur un an [vérifié, export].

Méthode : j'ai classé les 573 groupes à la main, sans script. Les volumes ci-dessous sont des estimations à ±10 %, la queue de groupes à 10 recherches étant arrondie. La somme de contrôle fait ~151 000, cohérente avec vos ~150 000.

## 1. Carte des intentions

| #   | Famille                                                                                                                                                                                                                                                                                                                                | Vol./mois                                           | Tendance (export)                                          | Intention réelle                                                             | Page Immojudis                                                                      | Verdict                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Enchères immobilières générales (« enchères immobilières » 8 100, « ventes aux enchères immobilières » 5 400, « vente immobilière aux enchères » 4 400, « encheres immobilieres » 1 900, « bien/immeuble aux enchères ») + « publiques » (~1 050) + « adjudication » (~1 600) + « en ligne » (~600) + « sites d'enchères immo » (~330) | ~26 000                                             | -19 % à -33 % sur 1 an ; pics nov. 2025 et janv. 2026      | Mixte : trouver des annonces (transactionnelle)                              | Accueil, `/sales`, index départements (se chevauchent)                              | **Viser, à arbitrer** (S1)                                                                                                                |
| F2  | Maison et appartement aux enchères (« maison aux enchères » 4 400, « vente maison aux enchères » 2 900, « appartement aux enchères » 880, « acheter une maison aux enchères » 390…)                                                                                                                                                    | ~11 300                                             | Stable (maison), -28 % (appartement)                       | Transactionnelle ou exploration                                              | Aucune page indexable propre                                                        | **Viser** (S4)                                                                                                                            |
| F3  | Saisies (« vente aux enchères saisies » 1 900, « vente maison saisie judiciaire » 720, « vente saisie immobilière » 590, « maison sur saisie » 320, « achat maison saisie »…)                                                                                                                                                          | ~7 800                                              | -55 % sur « saisies »                                      | Mixte : informationnelle (comment) et transactionnelle                       | Article `saisie-immobiliere-etapes-vente-forcee-acheteur`                           | **Viser**, à renforcer (S5)                                                                                                               |
| F4  | Judiciaire strict (« ventes aux enchères immobilières judiciaires » 1 600, « vente judiciaire immobilier » 590, « enchère judiciaire immobilière » 210) + liquidation (~450)                                                                                                                                                           | ~3 150                                              | Stable ; +19 % sur « judiciaires »                         | Informationnelle et transactionnelle                                         | `/ventes-immobilieres-judiciaires` ; article liquidation                            | **Viser**, à renforcer (S6)                                                                                                               |
| F5  | Enchères notariales (« enchère des notaires » 720, « immo enchère notaire » 480, « notaire vente aux enchères » 320, « vente interactive » ~250, « bougie » ~220)                                                                                                                                                                      | ~2 600                                              | Baisse ~-46 % sur 1 an pour « notaire vente aux enchères » | Informationnelle, un peu transactionnelle                                    | Article `ventes-notariales-domaniales-differences-tribunal` ; pas de page catalogue | **Viser**, page absente (S3)                                                                                                              |
| F6  | Ventes domaniales / État                                                                                                                                                                                                                                                                                                               | ~31 700, dont 27 100 pour « vente domaniales » seul | +46 à +85 % sur 3 mois                                     | **Ambiguë** : [supposé] mélange mobilier (véhicules, matériel) et immobilier | Article seul ; pas de page catalogue                                                | **Viser seulement la part immobilière** (~1 100 : « vente domaniale immobilier » 590, « enchère domaine immobilier » 170…). Décision (S7) |
| F7  | Géographique (Haute-Savoie ~160, Grasse 70, Loire-Atlantique ~110, Gironde ~60, 974 ~70…)                                                                                                                                                                                                                                              | ~1 200                                              | Stable                                                     | Transactionnelle locale                                                      | Pages département (`/ventes-encheres-immobilieres/[departement]`)                   | **Existant**. Aucune ville ou département à plus de 160 : très fragmenté                                                                  |
| F8  | Informationnelles « comment » (surenchère ~80, bien occupé ~100, consignation, indivision, risques, journal officiel 170)                                                                                                                                                                                                              | ~600                                                | n/d                                                        | Informationnelle                                                             | `/ressources` (25 articles)                                                         | **Existant** ; l'export reflète peu cette demande                                                                                         |
| F9  | Marques de tiers (Agorastore ~6 400 [+315 % sur 1 an], Licitor ~1 540 [+1 043 %], Immonotairesencheres 760, Avoventes 390, autres ~400)                                                                                                                                                                                                | ~9 500                                              | Licitor et Avoventes en forte hausse, pic oct. 2026        | **Navigationnelle** : l'internaute veut ce site                              | Aucune                                                                              | **NE PAS VISER** (S9)                                                                                                                     |
| F10 | Annonces et ventes notariales classiques, gré à gré (« immobilier notaire » 33 100, « vente immobilière notaire » 5 400, « annonces notaires » 2 900, « ventes notaires » 2 400, « maison notaire à vendre » ~4 000, prix m² notaires ~530)                                                                                            | ~50 000                                             | -18 % à -34 % sur 1 an                                     | Transactionnelle sur des ventes classiques                                   | Aucune                                                                              | **NE PAS VISER** : trompeur                                                                                                               |
| F11 | Sites d'enchères généralistes (« vente en ligne enchère » 2 900, « site de vente aux enchère » 1 000, « site vente enchère » 880)                                                                                                                                                                                                      | ~5 000                                              | +175 % sur 3 mois pour « en ligne »                        | Tous biens, pas l'immobilier                                                 | Aucune                                                                              | **NE PAS VISER**                                                                                                                          |
| F12 | Maisons de vente / art (Drouot, Ader, Pastor…)                                                                                                                                                                                                                                                                                         | ~1 500                                              | n/d                                                        | Navigationnelle ou mobilier                                                  | Aucune                                                                              | **Hors sujet**                                                                                                                            |
| F13 | Vendre aux enchères (~300)                                                                                                                                                                                                                                                                                                             | ~300                                                | n/d                                                        | Côté vendeur                                                                 | Aucune                                                                              | **Hors sujet** : Immojudis sert les acheteurs                                                                                             |
| F14 | Autres (meubles, voitures, fonds de commerce, Ferrari…)                                                                                                                                                                                                                                                                                | ~300                                                | n/d                                                        | Sans lien                                                                    | Aucune                                                                              | **Hors sujet**                                                                                                                            |

À noter : les 33 100 de « immobilier notaire » sont servis par le site officiel des notaires. Cibler la requête ferait promettre ce qu'Immojudis ne propose pas (des annonces de gré à gré).

## 2. État des pages cibles (lu dans le code)

- **Accueil** : le titre est « Ventes immobilières aux enchères judiciaires - Immojudis » (`src/lib/home-seo.ts:10`). Il pose « judiciaires », donc une famille de 3 150, alors que F1 pèse ~26 000. La description cite tribunaux, notaires et État quand les ventes notariales et de l'État sont affichées (`home-seo.ts:12-16`). Le H1 est « Les enchères immobilières, en toute clarté » (`src/components/home/HomeHero.tsx:56-60`), déjà sur la cible. Des données structurées Organization et FAQPage sont présentes (`src/app/page.tsx:62-85`). Rendu serveur [vérifié].
- **`/sales`** : titre « Ventes immobilières aux enchères en France », description citant tribunal, notaire et État (`sales-catalogue.tsx:17-19`). Le catalogue est rendu côté serveur. Les adresses filtrées ont pour canonique `/sales` (`sales-catalogue.tsx:22-24`) : pas de page propre pour une famille, une ville ou un type de bien.
- **`/ventes-encheres-immobilieres`** (index) : titre « Ventes aux enchères immobilières par département » (`src/lib/department-pages.ts:500`). Le H1 est un comptage dynamique « N ventes… dans M départements » (`page.tsx:56-66`). Le fil d'Ariane est le seul balisage (`page.tsx:146-148`). La description est correcte (`page.tsx:44-45`). Les pages département ont le titre « Enchères immobilières : {nom} » (`department-pages.ts:503-505`), un ItemList et le seuil d'indexation de 3 ventes (`department-pages.ts:33`). Le texte « dès qu'elles sont publiées » est toujours à `department-view.tsx:454` (point C3 de ce matin).
- **`/ventes-immobilieres-judiciaires`** : titre « Vente immobilière judiciaire : guide de l'adjudication » (`page.tsx:8`), description à `page.tsx:9-10`, H1 long (`resources-guide.tsx:431-433`), « Définitions en bref » (l. 466-470), section « Tribunal, notaire ou État » (l. 569-575), FAQ en fin de page. Elle couvre F4 et F3 en partie.
- **Articles de `/ressources`** : ce sont les meilleures pages d'Immojudis pour les familles « comment ».
  - `ventes-notariales-domaniales-differences-tribunal.json` : seoTitle « Ventes notariales et domaniales : différences » (l. 6), `directAnswer` (l. 303), 4 questions de FAQ (l. 304-320). Contenu sourcé Légifrance et Notaires de France.
  - Un article sur la saisie existe, et un sur la liquidation judiciaire.
  - Aucun article ne cible « maison aux enchères » ni « acheter un appartement aux enchères ».
  - Aucune page dédiée à la bougie ou à la vente interactive : elles sont des sections de l'article ci-dessus.
- **Couverture réelle** : le pipeline notarial lit `VAE` (vente aux enchères) et `VNI` (vente notariale interactive) sur `immobilier.notaires.fr`, par département (`services/data-pipeline/src/sources/notaires.py:55`). Un commentaire estime l'inventaire VNI à ~800 ventes en ligne (l. 107) : [supposé] non recoupé avec la base. Côté État, `cessions_etat` couvre adjudication, gré à gré et appel d'offres (`cessions_etat_procedure.py:27-29`), et AGRASC est une source à part. Les ventes mobilières du Domaine ne sont pas couvertes. Les ventes notariales classiques de gré à gré ne le sont pas non plus.

## 3. Propositions, classées valeur / effort

### A. Pages existantes

**S1. Réaligner le titre de l'accueil et départager l'accueil de `/sales`.** Priorité Haute, effort S. Preuve [vérifié] pour l'état, [supposé] pour l'effet.

- Fichier : `src/lib/home-seo.ts:10`. Famille F1, ~26 000.
- Exemple de titre, 59 caractères (limite 60 du test) : « Enchères immobilières : tribunal, notaire, État - Immojudis ». La mention de l'État est à valider par `juridique-rgpd` : ces ventes ne sont pas toutes des enchères, comme le dit `src/lib/sale-types.ts:53`. Variante sans l'État : « Enchères immobilières : tribunal et notaire - Immojudis ».
- Répartition proposée : accueil = « enchères immobilières » ; `/sales` = « ventes immobilières aux enchères » (déjà en titre). Décision du propriétaire.

**S2. Reprendre le titre de l'article notarial pour viser « enchères notariales ».** Priorité Haute, effort S. Preuve [vérifié].

- Fichier : `src/content/resources/ventes-notariales-domaniales-differences-tribunal.json:6`. Famille F5, ~2 600.
- Contenu à confier à `redacteur-contenu`. Chaque fait juridique doit rester sourcé, comme dans l'article actuel. Les chiffres de Notaires de France datent de 2019 à 2021 : ne rien ajouter qui ne soit pas relu à la source.

**S5. Renforcer l'angle « saisie » dans le guide et l'article saisie.** Priorité Moyenne, effort S. Preuve [supposé] pour la demande.

- Fichiers : `src/content/resources/saisie-immobiliere-etapes-vente-forcee-acheteur.json:5-6`, `resources-guide.tsx:569`. Famille F3, ~7 800.
- Ajouter une réponse directe sur « acheter un bien saisi » (une saisie qui aboutit à une vente aux enchères) et un lien vers le catalogue.

**S6. Faire porter à `/ventes-immobilieres-judiciaires` la requête « vente judiciaire immobilier ».** Priorité Moyenne, effort S. Preuve [vérifié] sur le titre.

- Fichier : `src/app/ventes-immobilieres-judiciaires/page.tsx:8`. Famille F4, ~3 150.
- Le titre actuel porte « adjudication ». Vérifier que « enchères judiciaires » apparaît au moins dans le H2 d'ouverture.

**S8. Corriger le texte « dès qu'elles sont publiées » et le chapô de département (C3).** Priorité Moyenne, effort S. Preuve [vérifié].

- Fichier : `department-view.tsx:454`. Famille F7, ~1 200.
- Le bénéfice SEO est faible (queries très fragmentées). La cohérence du texte est le vrai motif.

### B. Nouvelles pages

**S3. Page « Ventes aux enchères notariales » avec catalogue.** Priorité Haute, effort L. Preuve [vérifié] pour la donnée, [supposé] pour l'effet.

- Création, probablement sous `src/app/`. Famille F5, ~2 600 + ~250 interactives.
- Contenu réel : liste serveur des ventes notariales à venir, distinction explicite « enchère à la bougie / vente interactive par offres / annonce classique », lien vers l'article.
- Ne pas viser « immobilier notaire ». Ajouter un seuil d'indexation comme celui des départements (`department-pages.ts:33`) pour ne pas indexer une page vide.

**S4. Pages « maison aux enchères » et « appartement aux enchères », une seule fois chacune.** Priorité Haute, effort L. Preuve [supposé].

- Création. Famille F2, ~11 300.
- Contenu réel : liste serveur des biens à venir de ce type + guide court. Pas de pages par ville générées en masse (la demande par ville est inférieure à 160).
- Décision du propriétaire : changer la règle de canonique de `/sales` pour ce cas.

**S7. Page « Ventes immobilières de l'État » : décision requise avant tout travail.** Priorité Moyenne, effort M à L. Preuve [supposé].

- Famille F6. La demande de 27 100 est [supposé] en majorité mobilière : la SERP de « vente domaniales » (WebSearch, non rejouée) mêle une page Bercy sur la vente domaniale, une plaquette DGFiP sur les ventes mobilières du Domaine, et des sites d'investissement locatif.
- N'afficher que ce qui est servi (immobilier, cessions et AGRASC). Ne pas titrer « vente domaniales » seul. Ne pas promettre d'enchères : une part des cessions est amiable.

### C. Contenus de `/ressources` à confier à `redacteur-contenu`

- **S10.** « Acheter une maison aux enchères : étapes, frais, risques ». Famille F2. Priorité Moyenne, effort M. Appuyer sur les articles existants ; chaque fait juridique sourcé.
- **S11.** « Adjudication : définition et déroulé » avec réponse directe en tête. Famille F1 (~590) et glossaire. Priorité Basse, effort S.
- **S12.** Réponse directe et FAQ sur les articles sans FAQ, comme le rapport de ce matin (point 9). Priorité Moyenne, effort M.

### D. Ce qui ne doit pas être fait

**S9. Aucun titre, H1 ni description ne contient Agorastore, Licitor, Avoventes, Immonotairesencheres ou autre marque.** Priorité Haute, effort S. Preuve [vérifié] : aucune de ces marques n'est dans les titres actuels.

- Les sources d'Immojudis (Licitor, Avoventes, notaires.fr) peuvent rester nommées dans les fiches et sur la page des sources, de manière factuelle. Pas de page « alternative à Licitor ».
- Hors sujet : F10, F11, F12, F13, F14 (soit ~58 000 recherches de volume cumulé). Pas de page, pas de mot-clé forcé.

**Ordre conseillé** : S1, S2, S9, S6, S5, S8, S12, puis S3 et S4 (les deux plus gros chantiers, après décision), S10, S7, S11.

## 4. Ce qu'il faut mesurer

- **Search Console** : je n'ai trouvé aucune balise de vérification dans le dépôt (la vérification peut passer par le DNS : [supposé] non vérifiable ici). **À faire dire au propriétaire** : a-t-il un accès, sur quel type de propriété (domaine ou préfixe d'URL), et depuis quand ?
- L'indexation est ouverte depuis le 15/10 : au mieux un mois de données. Les positions seront probablement basses ou absentes [supposé]. La mesure de départ sert de référence, pas de verdict.
- **Mesure de départ à relever** (28 derniers jours, requête exacte) : impressions, clics, position moyenne, page classée. À compléter par un contrôle manuel de la page de résultats, navigation privée, avec la date.
- **Mots-clés à suivre (14)** :
  1. enchères immobilières (8 100)
  2. ventes aux enchères immobilières (5 400)
  3. vente immobilière aux enchères (4 400)
  4. maison aux enchères (4 400)
  5. appartement aux enchères (880)
  6. vente aux enchères saisies (1 900)
  7. ventes aux enchères immobilières judiciaires (1 600)
  8. vente judiciaire immobilier (590)
  9. vente par adjudication (590)
  10. vente saisie immobilière (590)
  11. enchère des notaires (720)
  12. notaire vente aux enchères (320)
  13. vente domaniale immobilier (590)
  14. vente au enchere immobilier haute savoie (110, échantillon local)
- Ajouter la marque « immojudis » comme témoin de la visibilité de départ.
- **Fréquence** : un relevé avant tout changement, puis 2 à 4 semaines après chaque lot publié.

## 5. À faire relire

**`juridique-rgpd`** :

- Le titre de l'accueil avec « État » (S1). Les cessions de l'État ne sont pas toutes des enchères.
- Toute mention des ventes notariales dans S2 et S3 : chiffres de Notaires de France de 2019 à 2021 (consignation, frais), à ne pas durcir.
- Toute formulation sur les ventes de l'État (S7).
- Aucune mention de concurrent dans un contenu public (S9). La mention factuelle des sources de données est à valider.

**`redacteur-contenu`** : S2, S5, S6, S10, S11, S12 ; la rédaction de S3, S4 et S7 une fois la décision prise. Pas de promesse de rentabilité.

**Décisions du propriétaire** :

- Répartition accueil / `/sales` pour « enchères immobilières » (S1).
- Création des pages notariales, maison / appartement et État (S3, S4, S7), et changement de la règle de canonique de `/sales`.
- Accès à Search Console.

Fichiers : `/home/user/immojudis/src/lib/home-seo.ts`, `/home/user/immojudis/src/app/sales/sales-catalogue.tsx`, `/home/user/immojudis/src/lib/department-pages.ts`, `/home/user/immojudis/src/content/resources/ventes-notariales-domaniales-differences-tribunal.json`, `/home/user/immojudis/services/data-pipeline/src/sources/notaires.py`.

Sources : https://www.economie.gouv.fr/cedef/fiches-pratiques/quest-ce-quune-vente-domaniale
