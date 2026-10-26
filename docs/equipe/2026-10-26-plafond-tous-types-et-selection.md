# Enchère plafond pour tous les types de vente et label de sélection

Date : 26/10/2026. Mission confiée par le fondateur :

1. proposer l'enchère plafond pour les ventes notariales, domaniales et autres, pas seulement pour le tribunal ;
2. signaler par un label les biens qui cochent de nombreux critères et semblent très intéressants si le plafond est respecté.

Le fondateur a écarté « Immojudis recommande d'investir ». Il a proposé « Pépite identifiée » ou « Les pépites d'Immojudis ».

Spécialistes consultés, tous en lecture seule : `synthese-recherche`, `qualite-donnees` (requêtes SELECT sur la production le 26/10 entre 06:38 et 06:44 UTC), `architecte-logiciel`, `statisticien`, `juridique-rgpd`, `gardien-marque`, `ux-designer`.

Aucun fichier du code ni de la base n'a été modifié. Ce compte-rendu est le seul fichier écrit.

## Synthèse

**Le plafond notarial est faisable et utile.**
- 77 % des ventes notariales ont aujourd'hui tout ce qu'il faut pour un plafond, contre 39 % au tribunal.
- Il faut d'abord leur donner leurs propres frais. Sans cela, le calcul serait faux.
- Pour les ventes notariales interactives (185 ventes sur 219), il faut employer le terme « offre » et non « enchère ».

**Les ventes domaniales sont presque impossibles à chiffrer.** 42 ventes sur 46 n'ont aucun prix publié. Seuls 3 plafonds au plus seraient calculables.

**Le label demande plus de prudence qu'annoncé.**
- La règle « plafond au-dessus de la mise à prix » ne trie rien au tribunal : elle retiendrait 92 % des ventes calculables.
- Aucun prix d'adjudication n'est encore rapproché d'une estimation (0 paire). On ne peut donc pas savoir aujourd'hui si le label aurait eu raison.
- Proposition : construire le label maintenant, le faire tourner sans l'afficher (« mode observation »), et ne l'ouvrir qu'après validation juridique et premiers résultats.

**Le nom.**
- `juridique-rgpd` et `gardien-marque` déconseillent tous deux « pépite », jugé promotionnel et contraire au ton du site et aux textes juridiques actuels.
- Ils divergent sur l'alternative. Arbitrage du chef d'orchestre : « Sélection Immojudis », accompagné de « N critères réunis » et de la mention « calcul automatique ». Le choix final revient au fondateur.

## Ce que les données disent (production, 26/10/2026)

1 510 ventes à venir publiées.

| Type | Ventes | Plafond calculable aujourd'hui | Mise à prix / valeur estimée (médiane) | Remarque |
|---|---|---|---|---|
| Tribunal | 1 194 | 464 (39 %) | 0,27 | Mise à prix volontairement basse |
| Notarial | 219 | 169 (77 %) | 0,71 | 185 ventes interactives (offres), 13 à la bougie |
| Domanial | 46 | 3 (7 %) | — | 42 sans prix, 18 appels d'offres, 22 terrains |
| Inconnu | 51 | 27 | 0,32 | 45 viennent d'avoventes, type à préciser |

Frais lus dans les annonces :

- **Frais préalables** : 0 vente sur 1 510 en a un montant chiffré. Le défaut s'applique partout.
- **Ventes notariales interactives** :
  - le taux d'honoraires de négociation est lu pour les 185 ventes ;
  - le redevable de ces honoraires est lu : l'acquéreur paie dans 131 ventes, le vendeur dans 54 ;
  - ces données ne sont pas encore utilisées par le calcul du plafond.
- **Ventes notariales à la bougie** : la consignation est lue pour les 13 ventes (`deposit_eur`).
- **Pièces** : 97 % des ventes notariales n'en ont aucune lue. Ne rien trouver dans les pièces ne prouve donc pas qu'il n'y a pas de risque.

Le `investment_score` du pipeline compare la mise à prix à des seuils de prix au m² codés en dur. Il n'utilise ni l'estimation DVF ni le type de vente. Les trois spécialistes concernés (`qualite-donnees`, `statisticien`, `architecte-logiciel`) déconseillent d'en faire une entrée du label.

## Points vérifiés par le chef d'orchestre

| Affirmation | Vérification |
|---|---|
| La fiabilité affiche « Solide » alors que les frais sont par défaut | Confirmé. `src/lib/bid-ceiling-engine.ts:680-706` : 40 + 20 + 20 + 8 = 88 points, pour un seuil de 75 |
| L'écart entre le plafond et la mise à prix n'est jamais affiché | Confirmé. `startingPriceGap` n'est lu par aucun composant |
| Deux valeurs de frais préalables par défaut | Confirmé. 3 000 € dans `src/lib/profitability.ts:60`, 5 000 € dans `src/lib/bid-ceiling-defaults.ts:22` |
| Taux d'honoraires de négociation calculé sans garde-fou | Confirmé. `services/data-pipeline/src/sources/notaires_extraction.py:497` produit un taux de 6 000 sur une vente à Narbonne |
| Le modèle d'issue ne produit aucune prévision | Confirmé. `src/lib/outcome-graph-repository.ts:390` renvoie `ceiling: null` |
| L'instantané des estimations ne couvre que le tribunal | Confirmé. `supabase/migrations/20261102110100_sale_market_estimate_snapshots.sql:107` |
| La restriction au tribunal n'existe que dans l'interface | Confirmé. `src/app/api/market-estimate/route.ts` ne lit pas le type de vente ; 16 occurrences de `isTribunalSale` dans `SimplifiedSaleDetailView.tsx` |
| Seuls les cabinets sponsorisés ont le bouton de mise en relation sur une vente | Confirmé. `src/app/avocats/lawyer-directory-page.tsx:538` |
| Le repère « Annonce bien renseignée » n'est affiché nulle part | Confirmé. `WellInformedBadge` n'est rendu par aucun écran (hors sujet, voir les constats annexes) |

## Arbitrages entre spécialistes

1. **Nom du label.**
   - `gardien-marque` recommande « Opportunité à étudier ». Il juge que « Sélection » suggère un choix humain.
   - `juridique-rgpd` déconseille le mot « opportunité » et préfère « Sélection Immojudis », décrite comme automatique.
   - Arbitrage : on suit le juridique, avec la réserve de la marque. Le libellé sera « Sélection Immojudis », toujours suivi de « N critères réunis » et accompagné de « calcul automatique ».
   - Formulations exclues : « pépite », « recommande », « bonne affaire », « intéressant jusqu'à X € ».

2. **Montant affiché.**
   - Le juridique remplace « intéressant jusqu'à X € » par « Enchère plafond estimée : X € (hypothèses par défaut : habiter, profil équilibré) ».
   - La marque et l'UX vont dans le même sens.
   - Arbitrage : formulation du juridique.

3. **Terme pour les ventes par offres.**
   - `ux-designer` et `synthese-recherche` proposent « offre maximale ». `juridique-rgpd` propose « offre plafond ».
   - Arbitrage : « offre plafond », parallèle au terme déjà fixé « enchère plafond », avec une seule entrée de plus dans le glossaire (`src/lib/vocabulary.test.ts`).
   - Point discutable, à confirmer par le fondateur.

4. **Hypothèses du label.**
   - L'architecte veut les mêmes hypothèses que la fiche, pour éviter deux vérités.
   - Le statisticien veut calculer sur la valeur basse de l'estimation (P10), pour limiter la sélection d'estimations trop hautes.
   - Arbitrage : le montant affiché reste le plafond par défaut de la fiche. La règle d'attribution du label exige en plus que le plafond recalculé sur la valeur P10 tienne. La règle est donc plus stricte, mais le chiffre affiché ne change pas.

5. **Ventes domaniales.**
   - Arbitrage : pas de plafond ni de label pour l'instant. Seule exception, plus tard : une adjudication dont le prix est lu.

## Propositions numérotées

Priorités : Critique, Haute, Moyenne, Basse. Efforts : S (moins d'une demi-journée), M (environ une journée), L (plusieurs jours).

### Lot 0 : corrections utiles dès aujourd'hui (tribunal compris)

| N° | Agent | Proposition | Priorité | Effort | Avis du chef |
|---|---|---|---|---|---|
| 1 | ux-designer | Plafonner la fiabilité à « À consolider » tant qu'un frais important est une valeur par défaut, avec le motif « frais à lire dans le cahier des conditions de vente » (`bid-ceiling-engine.ts:680-706`) | Haute | S | Garder |
| 2 | ux-designer | Faire de « plafond sous la mise à prix » un état à part entière, avec l'écart en euros et en pourcentage écrit en toutes lettres (`startingPriceGap`). Quand aucun prix ne tient, afficher « Aucun prix ne tient » et la raison, au lieu d'un hero vide | Haute | M | Garder |
| 3 | qualite-donnees | Garde-fou sur le taux d'honoraires de négociation : un taux hors de 1 % à 20 % est laissé absent (`notaires_extraction.py:497`) | Haute | S | Garder |
| 4 | qualite-donnees | `findConsignation` lit d'abord `sale_procedure.rules.guarantee` (quand le statut est `case_verified`), puis `deposit_eur` | Moyenne | S | Garder |
| 5 | synthese-recherche | Aligner les deux défauts de frais préalables (3 000 € et 5 000 €), ou documenter l'écart | Basse | S | Garder |
| 6 | architecte-logiciel | Tests de caractérisation du plafond tribunal et constante `CEILING_ENGINE_VERSION` avec un test de garde, avant tout déplacement de code | Haute | S à M | Garder (préalable aux lots A et B) |

### Lot A : plafond pour tous les types de vente

| N° | Agent | Proposition | Priorité | Effort | Avis du chef |
|---|---|---|---|---|---|
| 7 | architecte-logiciel | Créer le module pur `fee-regime.ts` (régime de frais par type de vente, régime tribunal seul au départ) et la fonction pure `computeSaleCeiling`, partagée par la fiche, le rapport et le futur traitement serveur. Remplacer `isTribunalSale` aux endroits qui décident du plafond. Ajouter un interrupteur par régime | Haute | M | Garder |
| 8 | synthese-recherche, qualite-donnees | Régimes notariaux. **Bougie** : barème notarial d'adjudication volontaire, frais d'organisation, consignation lue, surenchère si `overbid_allowed`, paiement sous 45 jours. **Interactive** : barème de gré à gré, honoraires de négociation selon le redevable, frais de publicité lus, ni consignation ni surenchère. Pas d'avocat. Calendrier de trésorerie adapté | Haute | L | Garder. Les barèmes viennent de sources secondaires et sont marqués « à confirmer sur Légifrance » |
| 9 | juridique-rgpd, ux-designer | Vocabulaire par mode : « enchère plafond » (tribunal, bougie, adjudication domaniale), « offre plafond » (interactive, appel d'offres), aucun plafond si le mode est inconnu. Mettre à jour `Terme.tsx` et le glossaire testé | Haute | M | Garder (terme à confirmer, arbitrage 3) |
| 10 | ux-designer | Frais estimés : une source par poste (lu dans les pièces ou par défaut), la mention « frais estimés, à confirmer », la case « je l'ai lu dans le cahier des charges » et la sensibilité (« +1 000 € de frais = −X € ») | Haute | M | Garder. La fourchette affichée est discutable, à juger sur maquette |
| 11 | architecte-logiciel, ux-designer | Textes qui promettent le plafond « au tribunal » : `sale-unlocks.ts`, `listing-text.ts`, `SalePublicPreview.tsx`, `offer-comparison.ts`, panneau de déblocage, offres. Ajouter à la confirmation du déblocage une ligne « frais estimés si l'annonce ne les donne pas » | Haute | S à M | Garder |
| 12 | qualite-donnees | Ventes domaniales : pas de plafond. Afficher « Prix non publié » pour les appels d'offres et les procédures à venir | Moyenne | S | Garder |
| 13 | redacteur-contenu (proposé par synthese-recherche) | Nuancer le guide et la fiche notariale : surenchère légale des créanciers inscrits (art. 2480-2482 C. civ.), dépôt d'un dixième exigé du surenchérisseur (R. 322-51), frais « en sus » selon la Chambre de Paris, R. 322-42 applicable à la licitation | Moyenne | S | Garder, après relecture par `juridique-rgpd` |
| 14 | synthese-recherche | Base des droits : le BOFiP (§ 50, solution de 1997) exclut les frais de poursuite taxés, alors que le code les inclut. L'écart est d'environ 190 € et va dans le sens de la prudence | Basse | S | Discutable : à trancher par un professionnel, sans urgence |

### Lot B : label « Sélection Immojudis »

| N° | Agent | Proposition | Priorité | Effort | Avis du chef |
|---|---|---|---|---|---|
| 15 | juridique-rgpd, gardien-marque | Nom et libellés (arbitrages 1 et 2) : badge « Sélection Immojudis », sous-titre « N critères réunis · calcul automatique », montant « Enchère plafond estimée : X € (hypothèses par défaut) ». Ajouter au glossaire testé les formulations interdites | Critique | S | Garder (décision du fondateur) |
| 16 | architecte-logiciel | Socle en mode observation : table privée, traitement TypeScript horaire (motif de la complétude), mode `off`, `shadow` ou `on`. Les fonctions publiques ne rendent qu'un booléen ou une liste d'identifiants, avec contrôle à la lecture (prix et estimation inchangés, évaluation de moins de 36 h). Tests pgTAP et invariants de sécurité | Haute | M | Garder |
| 17 | statisticien, qualite-donnees | Règle v1, calculée en observation : le plafond (régime adapté) tient même sur la valeur P10 ; l'estimation passe la porte publique de la bande de marché ; surface enregistrée ; occupation connue et libre ; aucun conflit, blocage IA, doublon ni risque non qualifié ; pas d'état dégradé documenté ; `investment_score` exclu. Stabilité : on entre au-dessus d'un seuil, on ne sort que sous un seuil plus bas, on affiche après deux évaluations favorables, le label est gelé à 7 jours de la vente. Les seuils sont calibrés pendant l'observation, par type de vente | Haute | M | Garder |
| 18 | statisticien | Étendre l'instantané des estimations (migration `20261102110100`) aux ventes notariales et aux entrées du label (occupation, état, plafond de référence), pour pouvoir le valider plus tard | Haute | S à M | Garder |
| 19 | statisticien | Critères d'ouverture et d'arrêt fixés avant de regarder les résultats : au moins 150 paires estimation/adjudication, précision mesurée avec une marge d'incertitude, arrêt automatique si elle se dégrade | Haute | S | Garder le principe. Le calendrier est à décider par le fondateur (voir plus bas) |
| 20 | juridique-rgpd | Avant tout affichage : page publique de méthode (critères, seuils, date, indépendance, limites, nombre de ventes retenues sur le total) ; mises à jour des CGU § 2, § 8 et § 10 (nouvelle version, préavis de 30 jours), des mentions légales et de `/classement-des-annonces` ; mention « l'absence de ce repère ne signifie pas… » | Critique | M | Garder (bloquant avant ouverture) |
| 21 | juridique-rgpd | Indépendance vis-à-vis de la publicité : aucune donnée d'avocat dans le calcul, aucun encart sponsorisé dans le bloc d'une vente sélectionnée, phrase d'indépendance, contrôle périodique de la part des ventes sélectionnées dont l'avocat poursuivant est sponsorisé | Critique | M | Garder |
| 22 | ux-designer, gardien-marque | Affichages après ouverture : pastille marine et or clair avec l'icône `ListChecks` (nouveau ton `selection` dans `Badge`) ; bloc « Pourquoi ce repère » sur la fiche (critères cochés, condition, hypothèses) ; version verrouillée sans montant (jamais de flou CSS) ; filtre et bascule sur la carte ; état vide qui propose une alerte ; emails sans montant | Haute | L | Garder, après les n° 16 à 21 |
| 23 | ux-designer | Retour « Utile / Pas pertinent » sur le label (nouveau signal dans `sale-signal-feedback.ts`, migration de la contrainte) | Moyenne | S | Garder |
| 24 | ux-designer | Après la vente : « Adjugée X € : au-dessus du plafond estimé », et email de résultat pour les ventes suivies | Moyenne | M | Discutable : utile pour la confiance, mais à faire après l'ouverture |
| 25 | juridique-rgpd | Faire valider par un avocat les 10 points listés par le juridique : qualification de comparateur en ligne (L111-7), absence de conseil en investissement, loi Hoguet, règles des avocats, clauses de responsabilité, vente interactive, P2B, prospection par email | Critique | — | Garder (action du fondateur) |

## Décision de calendrier pour le fondateur

Le label ne peut pas être validé statistiquement avant longtemps :

- 0 paire estimation/adjudication aujourd'hui ;
- au moins 150 paires demandées par le statisticien ;
- au rythme actuel, plusieurs mois au mieux.

Deux voies possibles :

- **A. Prudente (recommandée).** On construit les n° 16 à 18 maintenant, en observation. On ouvre quand les n° 19 à 21 et 25 sont réunis.
- **B. Plus rapide.** On ouvre après la validation juridique (n° 20, 21, 25), sans attendre les paires, avec un label strictement descriptif (« N critères réunis ») qui ne prétend pas prédire le prix d'adjudication. On mesure ensuite et on arrête si la précision est mauvaise.

Le risque est surtout statistique : le label peut retenir des estimations trop hautes. Il est réduit par la règle P10 et la porte de la bande de marché, mais pas supprimé.

## Points écartés

- **`investment_score` comme base ou entrée du label.** Seuils codés en dur sans estimation. Les trois spécialistes concernés le déconseillent.
- **Critère « plafond au-dessus de la mise à prix » seul.** Il retiendrait 92 % des ventes calculables au tribunal.
- **Critère « adjudication prévue » par le modèle d'issue.** Le modèle ne produit aucune prévision (`outcome-graph-repository.ts:390`). À réexaminer plus tard via les scénarios d'enchères, quand les statistiques seront ouvertes.
- **Rareté par quantile** (« les 5 % meilleures »). Elle fabrique des pépites chaque semaine, même sans affaire. On retient un seuil fixe et on surveille le taux obtenu.
- **Fusion du label et du score**, ou réécriture du moteur en Python ou en SQL. Cela crée deux vérités ou une dépendance circulaire.
- **Badge doré ou vert.** L'or est pris par les regroupements de la carte et par le badge « Débloquée », le vert signifie « donnée recoupée ». Le montant flouté en CSS est écarté aussi : il fuit et n'est pas accessible.
- **« Opportunité à étudier ».** Écarté par le juridique (arbitrage 1).
- **Plafond pour les ventes domaniales sans prix et pour le type inconnu.** Données absentes.

## Constats annexes (hors mission, pour mémoire)

- `WellInformedBadge` n'est rendu par aucun écran, alors que `RankingExplanation.tsx` décrit le repère comme affiché dans les listes.
- `ListingBadge` (`SearchResults.tsx:848-872`) est du code mort.
- Les badges « Débloquée » et « Vu » sont en 11 px, sous le minimum de 12 px fixé par `docs/design/fondations.md`.
- La capture `docs/design/sales-redesign/mobile-map.png` montre des regroupements marine, alors que le code les dessine en or.
- `precompute-valuations` est désactivé dans le dépôt mais actif en production : l'état voulu est à consigner avant que le label en dépende.

## Ordre de réalisation proposé

Lot 0 (n° 1 à 6), puis lot A (n° 7, 11, 12, puis 8 à 10), puis le socle en observation (n° 16 à 18).

En parallèle : relecture juridique (n° 20, 21, 25) et contenus (n° 13).

Ensuite, selon la voie choisie : affichage (n° 22, 23).

## Validation

Décision du fondateur, le 26/10/2026 : toutes les propositions sont validées, avec les changements ci-dessous, qui remplacent les arbitrages correspondants.

1. **Nom.** Le label s'appelle « Pépite ». Le badge porte un petit logo de pépite (pictogramme dessiné, en or) pour bien ressortir sur les vignettes. Cela remplace « Sélection Immojudis » (arbitrage 1 et n° 15).
   - Le montant reste formulé « Enchère plafond estimée : X € » (ou « Offre plafond estimée » pour une vente par offres), avec les hypothèses par défaut.
   - « Intéressant jusqu'à X € » reste exclu.
2. **Calendrier.** Mise en place immédiate, sans attendre une validation juridique ni des paires d'adjudication.
   - La définition d'une pépite est fixée par l'équipe dès maintenant, dans une règle versionnée.
   - Le calcul est livré en mode `shadow`. Une page d'administration liste les ventes qui seraient des pépites, avec leurs critères, pour contrôler la méthode sur le catalogue réel.
   - Le fondateur passe en mode `on` quand la méthode le satisfait.
   - Les critères d'arrêt (n° 19) servent de surveillance et de bouton d'arrêt, pas de condition d'ouverture.
   - La validation par un avocat (n° 25) reste recommandée, mais elle n'est plus un préalable.
3. Les points discutables (n° 14 et 24) sont retenus.

## Définition v1 d'une pépite (`pepite-v1`)

Validée par le fondateur le 26/10/2026, après correction : **une pépite est un potentiel d'investissement**, pas une fiche riche en informations. Elle combine deux tests :
- **B** : on a de bonnes chances de remporter la vente sans dépasser notre enchère plafond ;
- **C** : à ce prix, l'achat est nettement sous la valeur du bien.

Les seuils sont des valeurs de départ. Ils seront contrôlés sur le catalogue réel en mode `shadow`, depuis la page d'administration, avant le passage en `on`. Toute modification crée une nouvelle version.

### Notions

- **Plafond de référence.** Enchère plafond calculée avec les hypothèses par défaut de la fiche : habiter, profil équilibré, sans travaux, frais du type de vente, coût de libération inclus si le bien est occupé. Par prudence, on la calcule sur la valeur basse P10 de l'estimation.
- **Multiplicateur local.** Rapport prix d'adjudication / mise à prix des ventes comparables des trois dernières années : même tribunal, même tranche de mise à prix, même type de bien. Source : `getAuctionScenarios`. Le multiplicateur du tribunal est complété par le taux national quand le tribunal compte moins de 30 ventes, ou remplacé par lui sous 10 ventes. Le multiplicateur retenu est :
  - le médian (`q50`) dans le cas général ;
  - celui des trois quarts des ventes (`q75`) quand la mise à prix est inférieure à 30 % de la valeur estimée. Les enchérisseurs visent alors la valeur, et le médian sous-estimerait le prix.
- **Prix probable** = mise à prix × multiplicateur retenu.

### Test B : chances de l'emporter sous le plafond (tribunal)

- On calcule la part des ventes comparables adjugées à un prix inférieur au plafond de référence, avec `ceilingPosition` (`src/lib/ceiling-vs-court.ts`) appliquée à la distribution des scénarios.
- **Seuil : au moins 70 %.**
- Si cette part n'est qu'un plancher (« au moins », au-delà de 3 fois la mise à prix), le test est réussi.

### Test C : décote d'achat attendue

- Coût total au prix probable (prix + frais de la vente + libération) divisé par la valeur centrale estimée.
- **Seuil : au plus 75 %**, soit un achat probable à au moins 25 % sous le marché, frais compris.

### Par type de vente

| Type | Prix probable | Règle |
|---|---|---|
| Tribunal | mise à prix × multiplicateur local | B **et** C |
| Notarial à la bougie | mise à prix (aucun historique en base) | C seul, seuil plus strict : **65 %** au plus, et plafond de référence au moins égal à la mise à prix |
| Notarial interactif | première offre possible (prix de réserve caché) | C seul, seuil **65 %** au plus ; la mention « prix de réserve inconnu » est obligatoire |
| Domanial, inconnu | — | Pas de pépite |

Les résultats des ventes notariales (prix d'adjudication publié par la source) sont archivés dès maintenant (n° 18). Dès qu'il y en aura assez, ces ventes auront leur propre multiplicateur et passeront à la règle B et C.

### Garde-fous (pas une définition, une protection)

- Estimation `actionable`, de fiabilité « forte » ou « correcte », sur au moins 8 ventes comparables, surface enregistrée, sans écart aberrant (garde de `market-gap.ts`). Ni terrain seul ni actif mixte.
- Occupation connue : un bien libre comme un bien occupé est admis, puisque la libération est intégrée au plafond. Le squat et l'occupation inconnue sont exclus.
- Aucun signal bloquant : conflit de valorisation, champ critique bloqué par la relecture IA, vente en conflit de vérification, doublon probable, risques non qualifiés, état dégradé documenté.
- Au tribunal, la fiabilité des scénarios doit être d'au moins « medium ». Sinon, le test B n'est pas évaluable et il n'y a pas de pépite.

### Stabilité

- La vente n'apparaît qu'après deux évaluations favorables consécutives.
- Elle sort si B descend sous 65 % ou si C dépasse 80 % (on entre à un seuil et on ne sort qu'à un seuil moins exigeant), ou dès qu'un signal bloquant apparaît.
- Le label est gelé 7 jours avant la vente, sauf signal bloquant ou changement de prix.

### Affichage du prix probable (validé, « à prendre avec des pincettes »)

- Sur la fiche, pour les comptes qui ont accès au plafond (déblocage ou Analyse) :
  > « Prix probable : environ 90 000 € (fourchette 75 000 – 110 000 €) · Enchère plafond estimée : 118 000 € · 3 ventes comparables sur 4 adjugées sous ce plafond ».
- La fourchette va du multiplicateur du quart des ventes (`q25`) à celui des trois quarts (`q75`).
- Mention obligatoire juste à côté :
  > « Repère statistique tiré des ventes passées du tribunal (N ventes, fiabilité X). Ce n'est pas une prévision du prix final : les enchères peuvent dépasser ce montant. »
- En vente notariale : « Prix de départ : X € » et « Prix de réserve du vendeur inconnu ». Pas de prix probable tant qu'il n'y a pas d'historique.
- L'affichage du prix probable rend publics, pour ces comptes, des chiffres jusqu'ici fermés par `ADJUDICATION_PRICE_STATISTICS_ENABLED`. Le fondateur l'accepte pour ce repère. Le drapeau reste maître des autres statistiques.

### Exclusions et surveillance

- Ne servent pas d'entrée : `investment_score`, les données d'avocat ou de sponsoring, le profil de l'utilisateur.
- Cible : 5 à 10 % des ventes évaluables. On alerte si le taux sort de la plage 2 à 15 %.
- On peut revenir à tout moment en mode `shadow` ou `off`.

### Améliorations prévues (versions suivantes)

1. Pondérer les ventes récentes (les 12 derniers mois comptent davantage).
2. Une fois les estimations archivées au moment de chaque vente, prévoir le prix final à partir de la valeur et de la mise à prix, et plus seulement de la mise à prix. Ce modèle remplacera la règle du `q75`.
3. Vérifier chaque version sur les ventes adjugées : part des pépites réellement remportables sous le plafond.
4. Variantes du badge : « pépite locative » (rendement net au prix probable) et « pépite revente » (marge après travaux).

## Exécution

Ordre :
- Lot 0 (n° 1 à 6) ;
- lot A1 (n° 7, 11, 12) ;
- lot A2 (n° 8, 9, 10, 14) ;
- lot B1 (n° 16 à 19, 23) ;
- lot B2 (n° 15, 21, 22, 24) ;
- contenus (n° 13, 20).

Le suivi est complété ci-dessous à chaque lot.

### Suivi

- **Lot 0** : livré (commit `1167697`) après relecture par `code-reviewer`. CI verte sur la PR #312.
- **Lot A1** : livré (commit `87f9536`) après relecture. Aucun résultat du tribunal ne change.
- **Lot A2** : livré (commit `987eedb`), plus la correction d'une course dans `OfferOpeningRequest` (`b99c912`).
- **Contenus** (n° 13, 20, 21) : livrés (commit `e75605f`) après relecture par `juridique-rgpd`. Aucun point bloquant ne reste. Le préavis des CGU a été repoussé au 1er décembre 2026.
- **Lot B1** : livré (commits `28aecd2` et `a01d8a4`). Règle, calcul quotidien, table privée, mode `shadow`, page `/admin/pepites`.
  - Garde-fou d'écart aberrant : la borne de 70 % excluait la moitié des ventes au tribunal. Elle est remplacée par une borne de 10 % à 150 % de la valeur (`PEPITE_EXTREME_START_RATIO_MIN` et `_MAX`).
- **Lot B2** : livré (commit `a0c3f84`) après relecture par `code-reviewer` et `securite-applicative`. Rien de critique ; les 26 corrections demandées sont faites. Contenu :
  - badge, bloc, filtre, carte et alertes ;
  - détail réservé au droit `property.bidCeiling` ;
  - balayage borné et seau de débit propre au filtre ;
  - caches purgés à la suspension ;
  - invariant de sécurité durci par des tests de mutation.
  - Budgets relevés à la demande du fondateur : fiche 380 000, favoris 680 000, plus gros fichier 335 000, total inchangé à 6 220 000. Les marges restantes sont fines, environ 5 Ko chacune.
- **Points remis à `juridique-rgpd`** :
  - les prix d'adjudication notariaux sont conservés 36 mois dans les instantanés ;
  - le prix probable, tiré des données Licitor, est montré à un compte gratuit qui débloque une vente. L'accord écrit de Licitor est attendu avant le passage en `on`.

### Actions du fondateur

1. **Avant le 1er novembre 2026 : envoyer l'email d'information sur les CGU** à tous les comptes dont l'adresse est confirmée, et garder la trace de l'envoi.
   - Aucun outil du dépôt ne fait cet envoi. Celui de l'offre de lancement ne convient pas.
   - Passé le 1er novembre, repousser `PEPITE_TERMS_EFFECTIVE_DATE` dans `src/lib/legal-documents.ts` à la date d'envoi plus 30 jours.

   Texte proposé :

   > **Objet : Mise à jour de nos conditions générales au 1er décembre 2026**
   >
   > Bonjour,
   >
   > Nous mettons à jour les conditions générales d'utilisation et de vente d'Immojudis. La nouvelle version (2026-10-26.1) s'appliquera à votre compte à compter du **1er décembre 2026**. D'ici là, la version actuelle (2026-10-25.1) continue de s'appliquer ; elle vous est communiquée sur simple demande.
   >
   > Ce qui change :
   > - **Le repère « Pépite »** : un repère calculé automatiquement par Immojudis sur des critères publics. Ce n'est ni un conseil ni une recommandation d'acheter, ni une garantie de prix, de rendement ou d'adjudication. Le repère est visible par tous ; le montant de l'enchère plafond estimée et le détail du calcul restent réservés à l'offre Analyse ou à un déblocage.
   > - **Enchère plafond ou offre plafond, selon la vente** : pour les ventes par offres, on parle d'offre plafond. Une enchère ou une offre plafond est une hypothèse, pas un résultat.
   > - **Indépendance vis-à-vis de la publicité** : aucune rémunération ne peut obtenir ou améliorer une Pépite, ni améliorer le rang d'une annonce. Les encarts sponsorisés d'avocats restent séparés des annonces et sans lien avec ce repère.
   >
   > Lire la nouvelle version : https://immojudis.com/conditions-generales
   >
   > Si ces changements ne vous conviennent pas, vous pouvez fermer votre compte gratuitement, à tout moment avant le 1er décembre 2026, depuis la page Mes droits.
   >
   > L'équipe Immojudis

2. **Avant le passage du label en `on` : obtenir l'accord écrit de Licitor.**
   - Le test B et le prix probable dérivent des prix d'adjudication de Licitor.
   - Un badge public est un usage en accès libre, que l'accord téléphonique ne couvre pas (`docs/vercel_setup.md`, `docs/model-card-tribunal-statistics.md`).

3. **Recommandé : faire valider par un avocat** les points listés par `juridique-rgpd` :
   - qualification du repère ;
   - opposabilité des CGU ;
   - droit des bases de données ;
   - règles de la profession d'avocat ;
   - loi Hoguet.

**Décision du fondateur (26/10/2026).** Le chef d'orchestre mène le sujet jusqu'au bout :
- fusion de la PR #312 dans `main`, CI verte ;
- application des migrations par le workflow « Apply Supabase Migrations » (lancé depuis `main`, confirmation `production`) ;
- déploiement Vercel et contrôles de production.

Le calcul de la pépite est livré en mode `shadow`. Le passage en `on` se fait après contrôle de la liste sur le catalogue réel.
