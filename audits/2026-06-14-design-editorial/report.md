# Audit design et editorial - Immojudis

Date : 14 juin 2026  
Base auditee : production `https://immojudis-dezt.vercel.app` + branche `main` locale alignee avec `origin/main`.

## Nouveautes constatees

- La branche locale est propre et synchronisee avec GitHub.
- Les derniers commits ajoutent ou consolident : comptes investisseur/pro, demandes de publication B2B avec validation admin, dashboard admin, suppression d'anciens artefacts DB, optimisations du pipeline de collecte, cache d'extraction, lecture DVF plus precise, et premiere version du logo maison/bouclier/marteau.
- La page detail annonce a deja bascule vers la bonne logique produit : le score n'est plus mis en avant, la mise plafond devient le coeur de la lecture.
- La homepage a ete fortement simplifiee : hero video, promesse courte, bloc de demonstration, CTA investisseur/pro.

Captures conservees :

- `01-home-desktop.png`
- `02-login-desktop.png`
- `03-sales-access-desktop.png`
- `04-publish-access-desktop.png`
- `05-home-mobile.png`

## Audit design

### Ce qui fonctionne

- L'identite noir/champagne/creme installe une perception premium et plus serieuse que les precedentes directions tres illustrees.
- La homepage est maintenant beaucoup plus lisible : un message, deux CTA, trois indicateurs. La reduction des blocs secondaires etait une bonne decision.
- La distinction B2C/B2B sur la page login est claire : investisseur, professionnel, admin. On comprend rapidement pourquoi il existe plusieurs parcours.
- Les pages applicatives partagent un langage visuel coherent : surfaces liquid glass, radius contenu, typographies display/sans, accents or.
- La page detail annonce est mieux structuree : ce que l'on sait du bien, mise plafond, preuves, marche local, documents.
- Le chargement progressif de la page annonces est coherent avec le volume de donnees et reduit le ressenti de lourdeur.

### Ce qui merite amelioration

- **Homepage : demonstration encore trop technique.** Le bloc anime "Dossier TJ Bordeaux" donne une bonne impression produit, mais il ressemble encore a un journal d'extraction. Il gagnerait a montrer un resultat final tres simple : "Mise plafond : X", "Pourquoi : marche local + frais + points a verifier".
- **Terminologie visuelle trop dashboard par endroits.** Les cartes "score", "risques", "surveillance" etaient encore visibles dans certains textes. Correction appliquee sur les zones les plus exposees.
- **Page annonces : les vignettes restent fonctionnelles mais peu seduisantes.** Les cartes s'appuient surtout sur la carte/localisation. Pour une experience premium, il faudra un systeme de visuel de bien plus editorial : photo source quand disponible, facade approximative uniquement si fiable, sinon carte stylisee propre.
- **Page detail : trop de profondeur visible.** La section "Informations techniques" expose identifiant, latitude, longitude, timestamps. Utile pour admin/debug, mais trop technique pour un investisseur novice. Recommandation : la replier ou la reserver aux admins.
- **Assistant de mise plafond : bon coeur produit, mais certains mots restent experts.** "DVF", "FPT", "p25/p75", "mediane" doivent rester accessibles en niveau 2. Le premier niveau doit dire : prix local retenu, marge de securite, frais/travaux deduits, mise maximale.
- **Mobile : la hero fonctionne, mais le module d'analyse prend beaucoup de hauteur.** Sur petit ecran, il faudrait afficher directement le verdict ou un resume compact avant de derouler les etapes.
- **Logo precedent : idee bonne, execution trop fine.** A petite taille, maison/bouclier/marteau se confondaient. Correction appliquee : contours plus francs, gavel plus lisible, couleurs explicites.

## Audit editorial

### Ce qui est clair pour l'utilisateur

- "Analyser. Decider. Encherir." est memorable et explique bien le moment d'usage.
- "Mise plafond" est le meilleur angle produit : concret, actionnable, positif, compatible avec des annonces imparfaites.
- La page login explique bien les deux marches : investisseurs qui consultent, professionnels qui referencent.
- "Points a verifier" est meilleur que "risques" pour garder une posture constructive, surtout si l'offre s'ouvre aux avocats, notaires, commissaires de justice et tribunaux.
- "Conditions pour rester gagnant" est une bonne formulation : elle transforme les defauts du dossier en hypotheses a integrer.

### Ce qui doit encore etre clarifie

- **Eviter le mot score en facade.** Le score peut rester un moteur interne de tri, mais il ne doit plus structurer la comprehension utilisateur.
- **Reformuler les alertes negatives.** "Risque detecte" ou "aucun risque" installe une lecture anxiogene. Preferer "point a verifier", "point integre au plafond", "aucun point bloquant detecte".
- **Expliquer la mise plafond en une phrase constante.** Proposition : "On part du prix du marche local, on garde une marge de securite, puis on retire frais et travaux pour obtenir l'enchere maximale."
- **Rendre les preuves plus humaines.** La bonne structure pour chaque element : "Ce que dit le document", "Pourquoi cela change le prix", "Ce que vous devez verifier avant l'audience".
- **Clarifier les sources marche.** DVF est fiable mais peu connu. L'utilisateur doit lire "ventes comparables publiees par l'administration", avec DVF en precision secondaire.
- **Mettre le manque de donnees en action.** "Prix local insuffisant" est juste mais frustrant. Preferer : "Pas assez de ventes comparables. Saisissez un prix au m2 prudent pour obtenir un plafond provisoire."
- **Aligner les alertes avec la nouvelle strategie.** Les anciens filtres de score/rendement locatif doivent devenir des criteres plus simples : zone, budget, surface, type, occupation, mise a prix sous marche.

## Corrections appliquees pendant cet audit

- Logo remplace par une version plus nette : maison + bouclier + marteau, palette creme/or/noir.
- Favicon SVG aligne sur le nouveau logo.
- Homepage : suppression de la formulation "score, risques, prix plafond" au profit de "limite d'enchere, points a verifier, preuves a relire".
- Homepage : "Risque detecte" remplace par "Point a verifier".
- Page annonces : "Annonces sous surveillance" remplace par "Annonces analysees".
- Page annonces : description recentree sur la mise plafond.
- Cartes annonces : "risque" remplace par "point a verifier" et "aucun point bloquant detecte".
- Alertes : suppression de l'incitation "score minimal" dans l'etat vide.

## Priorites recommandees

1. Replier ou masquer les "Informations techniques" sur les pages detail pour les utilisateurs non admin.
2. Transformer le bloc de demonstration homepage en verdict visuel tres simple : mise plafond, marche local, marge, action suivante.
3. Simplifier le premier niveau de l'assistant de mise plafond et deplacer DVF/FPT/p25/p75 dans le detail.
4. Revoir les visuels de cartes annonces pour sortir du rendu "carte + texte" repetitif.
5. Remplacer les derniers filtres exposes autour du score/rendement par des criteres utilisateur : budget, zone, surface, occupation, marche local.
6. Ajouter un micro-resume en haut de page detail : "Ce dossier peut rester interessant si vous ne depassez pas X".
7. Sur mobile, reduire la hauteur des modules techniques et privilegier un resume decisionnel avant les details.
