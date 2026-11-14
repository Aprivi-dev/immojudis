# Repasse de l'administration et préparation du pilote automatique (14/11/2026)

**Mission.** Demande du propriétaire : « Tu vas faire une repasse sur toutes les fonctionnalités qui sont
disponibles, présentes dans le panel administration. Tu vas t'assurer que tout est utile, tout fonctionne. Et à
la fin de tout ça, on va lancer les premiers tests de pilote automatique sur l'envoi de mails pour aller
collecter les informations manquantes. »

**Déroulé.**

1. Audit en quatre volets, en lecture seule : routes (`testeur-api`), parcours et interface (`testeur-qa`,
   captures à 390 et 1440 px), utilité des sections (`product-explorer`), pilote automatique (`code-reviewer`).
   État de production relevé en lecture seule par le chef d'orchestre.
2. Compte-rendu numéroté (corrections 1 à 10) validé par le propriétaire : « Ok, avec tes corrections de 1 à 10,
   je suis d'accord. » Corrections du pilote validées avec le plan en deux temps (« D'accord, vas-y pour les deux
   temps ») et l'ouverture des adresses Licitor décodées pour le pilote (« Oui ouvre le »).
3. Cinq lots de `developpeur` en parallèle, chacun relu par un relecteur indépendant (`code-reviewer` ou
   `securite-applicative`), points importants corrigés avant fusion, puis contre-vérifiés.

---

## 1. Ce que l'audit a établi

- Rien de cassé : aucune page blanche, aucun lien mort, aucune erreur d'exécution sur `/admin` ou `/api/admin`
  en 7 jours ; 268 tests des routes, 307 tests des écrans et 61 parcours e2e verts.
- Défauts : débordement d'Inscriptions à 390 px ; accueil vert malgré 5 alertes ouvertes, alertes illisibles
  (clés techniques) ; « signal timed out » brut ; page Sécurité orpheline et chargement sans fin ; double
  lancement de collecte possible ; rôle administrateur vérifié après lecture du corps sur une vingtaine de
  routes ; jargon ; pagination « NaN » ; deux boutons « Accepter » aux effets différents.
- Utilité : doublons (panneau des sources deux fois, diagnostic deux fois, navigation trois fois), sections
  vides (Publications : 0 demande ; avocats référencés : 0).

## 2. Corrections mises en ligne

| PR | Contenu | Points |
| --- | --- | --- |
| #501 | Pilote : arrêt automatique réarmable après un arrêt automatique seulement, file triée avant les 25 examens, erreurs classées, modèle par rôle, brouillons ouvrables, marque Pilote/Manuel, arrêt d'urgence dans le bandeau. Migration `20261119100500`. | pilote |
| #502 | Rôle administrateur vérifié avant tout, sur les 69 gestionnaires, avec invariant et test par découverte ; collecte avec confirmation et refus d'un double lancement ; confirmation serveur du retrait de contrat ; `mode` obligatoire pour les pépites ; messages de délai et de réseau en français. | 3, 5, 6, 7 |
| #503 | Menu de 13 à 10 entrées (Comptes, Pépites dans Qualité, Publications hors menu), Sécurité du compte joignable et sans chargement infini, Inscriptions à 390 px, libellés exacts des décisions, finitions. | 1, 4, 7, 8, 10 |
| #504 | Accueil « À traiter » (alertes en français, pilote, réponses, RGPD, annonces, collectes), pastille jamais verte si une alerte est ouverte ou la surveillance arrêtée, libellés d'alertes partagés, Opérations accessible. | 2, 7, 9 |

Menu : 10 entrées et non 9. Aller à 9 aurait forcé un regroupement sans logique (Pilotage dans Qualité, ou
Conformité dans Configuration).

## 3. Ce que les relectures ont rattrapé avant la mise en ligne

- Pilote : réarmement possible par un simple changement de mode ; arrêt à tort possible dès le premier jour
  (plafond de validations, erreur passagère) ; compteur de simulation gonflé ; avocats très actifs écartés.
- Routes : le contrôle automatique de l'ordre des gardes était contournable de cinq façons ; il est devenu
  une règle unique, vérifiée sur chaque route.
- Menu : trois libellés de décision inexacts, dont un grave : dans « Informations à contrôler », le bouton
  présenté comme une confirmation remplaçait en réalité la valeur de la fiche. Il dit désormais « Accepter et
  mettre à jour la fiche ».
- Accueil : pastille verte possible avec une surveillance arrêtée ; section qui disparaissait sur erreur.

## 4. Pilote automatique : état et marche de lundi

**État en production après le lot (14/11, lecture seule).** Migration `20261119100500` appliquée par le
workflow officiel (run 138, 09:27 UTC) ; `information_agent_autopilot_stats` et
`set_information_agent_autopilot_mode` gardent `security definer`, `search_path` vide et les mêmes droits.
Pilote : `mode=off`, `live_allowed=false`, adresses Licitor décodées fermées, aucune pause ni arrêt automatique.
Webhook Resend de l'agent : abonné à `email.received`, `email.bounced` et `email.complained` (ajout fait par le
propriétaire le 14/11) ; les rebonds et plaintes d'autres expéditeurs sont ignorés par l'agent.

**Ce que fait la simulation.** Passages toutes les 10 minutes, du lundi au vendredi, de 9 h 30 à 11 h 30 et de
14 h à 16 h 30 (Paris). À chaque passage : 25 ventes examinées au plus, 5 brouillons préparés au plus, un
événement « aurait envoyé » par brouillon, aucun appel à Resend. Le pilote n'écrit qu'aux avocats. Le mode réel
reste verrouillé par construction (version de politique `2099-01-01.0`, `live_allowed`, AIPD, 30 envois manuels,
7 jours de simulation).

**Marche de lundi 16/11 (propriétaire).**

1. Admin › Agent IA › onglet Pilote. Saisir un motif, puis ouvrir « Licitor décodées » (décision du 14/11 :
   « Oui ouvre le ») ; sans cela, aucune vente n'est candidate aujourd'hui.
2. Saisir un motif (« Essai simulation, aucun envoi »), puis cliquer « Simulation ». Ce clic fait du
   propriétaire l'administrateur d'exécution. Ne toucher ni « Article 14 », ni « Attester l'AIPD ».
3. Après un ou deux passages, lire « Derniers événements » et « Prêtes à valider » (chaque vente ouvre son
   brouillon).
4. Le chef d'orchestre propose alors la liste exacte de 1 à 3 brouillons à envoyer à la main, avocats seulement,
   de préférence du mardi au jeudi entre 9 h 30 et 11 h 30. Chaque envoi est validé un par un par le
   propriétaire (« Reprendre », aperçu, « J'ai relu le message exact », « Valider et envoyer »). Avant le premier
   envoi réel : vérifier dans Vercel `INFORMATION_AGENT_OUTBOUND_ENABLED=true` et
   `INFORMATION_AGENT_OUTBOUND_CANARY_ONLY=false`.
5. En cas de doute : « Arrêt d'urgence », en haut de chaque onglet de l'Agent IA, en un clic.

**Actions du propriétaire encore ouvertes.** Marquer traités les 2 messages non rattachés du 10/11 (onglet
Réponses) ; régénérer ou annuler les 3 brouillons d'octobre et de début novembre.

## 5. Suites notées (non faites, à valider)

- Verrou de collecte en base (index unique ou verrou consultatif) ; collecte « toutes sources » contre une source.
- Accueil : charger des compteurs plutôt que les demandes RGPD et réponses complètes ; état « Arrêté
  automatiquement » ; valeur actuelle de la fiche face à la valeur proposée dans « Informations à contrôler ».
- Pilote : alerte sur des refus répétés au moment de l'envoi (mode réel) ; simulation des plafonds ; erreurs
  encore avalées dans `markSimulated` et le classement « opposé ».
- E-mail d'incident avec des clés techniques ; type de demande RGPD brut dans Conformité ; onglets recopiés en
  trois endroits ; routes sans appelant (`billing-reconciliation` GET, `information-agent/missions` POST) ;
  réglage du budget IA sans trace de l'auteur.
- Tâche PDF bloquée depuis le 11/11 et absence d'alerte sur une tâche d'enrichissement bloquée ; délais de
  `photo-mirror` sur les pages publiques.
