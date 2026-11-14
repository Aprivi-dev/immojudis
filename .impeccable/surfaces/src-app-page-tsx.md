---
version: 1
slug: "src-app-page-tsx"
primary_target: "src/app/page.tsx"
related_targets: []
---

# Accueil (/)

Mode : Persuade. Visiteur : l'investisseur particulier qui découvre Immojudis. Action : créer un compte gratuit (essai Analyse de 7 jours). Preuve : la démonstration de l'enchère plafond sur l'exemple fictif de Bordeaux (scénarios calculés par `computeCeilingPlan`). À éviter (propriétaire, 14/11/2026) : ton promotionnel, look administratif, page surchargée. Imposés : nom, logo, marine et or.

## Direction contract

THESIS: L'accueil est une affiche de vente aux enchères, celle que le visiteur trouvera au tribunal, et Immojudis y colle ce que l'affiche ne dit jamais : l'enchère plafond. Refuse le titre + capture + rangée de cartes du secteur.

OWN-WORLD: Papier d'affiche or clair (le papier de couleur des affiches privées), encre marine en typographie de bois condensée, filets typographiques et cadres de l'affichage légal. Un bandeau marine collé en biais, texte or, porte chaque ajout d'Immojudis. Le mur d'affichage marine entoure la feuille.

STORY: Le visiteur reconnaît l'affiche, comprend qu'Immojudis réunit ces ventes et calcule le plafond, essaie le calcul en changeant de projet, puis crée son compte.

FIRST VIEWPORT: Une feuille d'affiche centrée sur le mur marine : en-tête Immojudis et navigation sur la première ligne, « VENTES AUX ENCHÈRES IMMOBILIÈRES » en très grand, la vente exemple (mise à prix 95 000 €) barrée du bandeau « ENCHÈRE PLAFOND 136 000 € », le cartouche « S'adresser à » avec le bouton d'inscription.

FORM: Affiche de vente judiciaire (placard légal), rang 1 de la liste ordonnée, choisie par le propriétaire en carte « choix IA ». seed:526ef2abb9a5f38c

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

Signature : le bandeau se recolle quand le visiteur change de projet, d'occupation ou de travaux ; le montant suit les 18 scénarios réels. Mouvement : un seul geste, la pose du bandeau ; rien ne bouge si le visiteur réduit les animations.

## Décisions ouvertes

- La refonte est d'abord un artefact de proposition ; l'implémentation dans `src/components/home/` suit la validation.
- DESIGN.md sera écrit à partir de la version construite dans le code.
