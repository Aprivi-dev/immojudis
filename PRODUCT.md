# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Public principal : l'investisseur particulier.** Il prépare souvent l'une de ses premières ventes
aux enchères immobilières. Il découvre la procédure (avocat obligatoire, audience, surenchère du
dixième, frais), repère des ventes, comprend un bien à partir de pièces juridiques peu lisibles et
doit arriver à l'audience avec un montant maximal qu'il ne dépassera pas. Chaque écran est pensé
d'abord pour lui.

Publics secondaires :

- **Marchands de biens** : ils étudient beaucoup de ventes et cherchent le volume, la vitesse, les
  alertes et l'export (offre Analyse).
- **Avocats** : ils portent les enchères pour le compte des acheteurs. Ils sont présents dans
  l'annuaire (`/avocats`) et peuvent être mis en avant contre paiement.

## Product Purpose

Immojudis réunit les ventes immobilières aux enchères de France (judiciaires, notariales et
domaniales), explique la procédure et aide l'investisseur à décider **jusqu'à combien enchérir**.

Le succès, c'est un investisseur qui arrive à l'audience avec une enchère plafond qu'il comprend et
qu'il croit, au lieu de surpayer ou de renoncer faute de repères.

## Positioning

C'est la combinaison qui distingue Immojudis, pas une brique isolée :

1. **Le catalogue** : les ventes à venir de toute la France, en un seul endroit (carte, recherche,
   tribunaux, pièces officielles).
2. **L'enchère plafond** : pour chaque bien, une mise plafond chiffrée à partir du marché local
   (DVF), des frais, des travaux et d'une marge de sécurité.
3. **La pédagogie** : la procédure expliquée (articles de `/ressources`, `/comment-ca-marche`,
   simulateur de frais) et des méthodes publiées (écart au marché, pépites, classement des
   annonces).

## Operating Context

- Parcours type : repérer une vente (carte `/sales`, recherche, alertes, tribunaux), ouvrir la fiche,
  lire les pièces (cahier des conditions de vente, procès-verbal descriptif), calculer l'enchère
  plafond, puis contacter un avocat inscrit au barreau du tribunal compétent.
- Les ventes ont une échéance ferme (date d'audience et date de visite) : l'urgence est un fait du
  produit.
- Les fiches viennent de sources tierces : la couverture varie selon les sources et certains champs
  manquent (tribunal, code postal, surface). Le produit le dit au lieu de le masquer.
- Usage fréquent sur mobile (repérage, visite), et sur ordinateur pour l'étude et le calcul.

## Capabilities and Constraints

- **Périmètre** : la France entière (décision du 09/10/2026, `docs/roadmaps/decision-perimetre-2026-10-09.md`).
- **Offres** : Découverte, gratuite et sans limite de durée, avec un quota mensuel de ventes
  débloquées. Analyse, au tarif prévu de 59 € TTC par mois, sans engagement : toutes les ventes
  ouvertes, alertes avancées, export PDF et CSV, estimation détaillée, ventes comparables. Un essai
  Analyse de 7 jours, sans carte bancaire, suit la confirmation de l'adresse email. **Au 13/11/2026,
  le paiement n'est pas encore ouvert** : tant que les conditions de lancement ne sont pas réunies
  (`docs/roadmaps/conditions-de-lancement-2026-10-10.md`), rien ne doit laisser croire qu'un
  abonnement se souscrit déjà.
- **Ni conseil juridique ni conseil financier.** Les informations sont indicatives ; seuls les
  documents officiels de chaque vente font foi. Aucune promesse de gain, aucune incitation à
  enchérir.
- **Indépendance** : Immojudis n'est ni un tribunal ni un avocat. Les annonces sont publiées par des
  tiers. Toute mise en avant payante (avocats, « Sponsorisé ») est signalée comme telle.
- **Vocabulaire du produit** : enchère plafond, mise à prix, adjudication, surenchère, débloquer une
  vente, repère « Pépite », repère « Annonce bien renseignée », écart au marché.
- **Données personnelles** : RGPD appliqué dans le produit (filtre des noms, minimisation,
  consentement à la mesure d'audience). Le juridique fait partie du produit.
- Stack existante : Next.js App Router, React 19, Tailwind v4, Supabase, Mapbox, hébergée sur Vercel
  (voir `README.md`).

## Brand Commitments

- Nom : **Immojudis**. Description unique du site : `src/lib/company-description.ts`. Elle seule
  sert partout (accueil, À propos, métadonnées, `llms.txt`).
- Langue : le français. Ton clair, factuel et sobre, sans superlatif ni jargon non expliqué. Les
  limites sont dites franchement (couverture, données manquantes, méthodes).
- L'identité visuelle existante et ses règles sont documentées dans `docs/design/fondations.md`,
  validées par le propriétaire le 24/10/2026 puis le 25/10/2026.

## Evidence on Hand

- **Chiffres réels du catalogue**, lus en base : nombre de ventes à venir, tribunaux, mises à prix
  médianes, statistiques d'adjudication. Ils peuvent être affichés, avec leur source et leur date.
- Méthodes publiées : `/methode-ecart-marche`, `/methode-pepites`, `/classement-des-annonces`.
- **Absences** : aucun témoignage, aucun client cité, aucun article de presse, aucune étude
  utilisateur menée à ce jour (les protocoles sont dans `docs/recherche/`). Les prochains travaux ne
  doivent jamais en inventer.

## Product Principles

1. **Le plafond avant l'annonce.** L'information sert la décision « jusqu'à combien enchérir ».
   Le reste en est le contexte.
2. **Dire d'où vient chaque chiffre.** Source, période, méthode et limites sont accessibles depuis
   le chiffre lui-même. Une donnée absente est affichée comme absente, jamais comblée par une
   valeur inventée.
3. **Expliquer sans conseiller.** Le produit rend la procédure compréhensible pour un débutant, mais
   ne recommande jamais d'enchérir sur une vente.
4. **L'échéance est réelle.** Les dates d'audience et de visite commandent l'attention : ce qui est
   urgent se voit, et le reste reste calme.
5. **Honnête sur ce qui est vendu.** Gratuit, payant, essai, sponsorisé : chaque statut est dit
   clairement et correspond à ce qui est réellement livré.

## Accessibility & Inclusion

- Cible : **RGAA 4.1 et WCAG 2.2 niveau AA**. Déclaration publique : `/accessibilite`. Elle indique
  « non évalué » et liste les défauts connus (contraste des bordures de champs, contraste du focus,
  galerie de photos non annoncée).
- La carte, la fiche vente, les simulateurs et les fenêtres modales doivent rester utilisables au
  clavier et au lecteur d'écran.
- Les débutants doivent pouvoir lire les termes juridiques : chaque terme technique est expliqué là
  où il apparaît.
