# Extraction et complétude par procédure — publication du 2 octobre 2026

Ce document complète l’audit initial : ses 13 écarts stricts étaient l’état avant correction. Ils sont désormais corrigés et couverts par des tests de régression. Les journaux et captures initiaux restent des preuves historiques, avec leurs limites d’accès.

## Comportement livré

- Trois familles de procédure : judiciaire au tribunal, notariale et cession d’État. Le cadre juridique vérifié prime sur le lieu de vente : une cession d’État administrée par un notaire conserve les exigences d’une cession d’État.
- 130 critères pondérés sur les fiches, avec valeurs, preuves, lacunes prioritaires, conditions critiques et détails par catégorie. Une information est observée, inférée, inconnue, explicitement absente, non applicable ou contradictoire. Les données inapplicables sortent du dénominateur avec une raison ; une donnée non publiée reste inconnue.
- Extraction structurée des surfaces et de leur portée, pièces/chambres/étage, chauffage, diagnostics, charges, taxes, copropriété, cadastre, contacts, documents et médias. Les faits d’un cabinet, d’un autre lot ou de la navigation sont écartés.
- Les projections de complétude ne servent jamais de preuve pour leur propre extraction ni pour les enrichisseurs suivants.

Le [contrat exhaustif](./checklist-completude-annonces-2026-10-02.md) et son [catalogue JSON](./completude-annonces-2026-10-02.json) définissent types, unités, applicabilité et règles de calcul. La richesse du dossier reste distincte du rappel de l’extracteur parmi les faits effectivement publiés par une source.

## Reprise des annonces existantes

Une sauvegarde privée et des plans vérifiés précèdent chaque application. Les mises à jour utilisent un contrôle sur l’identifiant et la date de dernière modification ; toute annonce modifiée entre-temps est relue avant de recevoir une nouvelle projection.

Sept annonces auditées ont reçu leur projection, avec six corrections de champs canoniques prouvées : département conservé, code postal du cabinet retiré, chambres froides écartées, terrain de 13 037 m², immeuble de bureaux correctement classé, contact avocat distinct du contact de visite et total Carrez de 117,58 m² pour les deux logements d’Arcachon. Le terrain contradictoire de Ceyreste reste inconnu. Le total et les surfaces de chaque logement restent distincts.

Le reste du catalogue reçoit uniquement les métadonnées d’extraction et de complétude. Les prix, dates, statuts, descriptions, images et scores existants ne sont pas réécrits par cette reprise générale. Les sauvegardes et plans de base de données restent privés et ne sont pas ajoutés au dépôt public.

Vérification finale : **3 272 / 3 272 annonces projetées**, et **2 872 / 2 872 lignes visibles dans `v_auction_sales_app`** exposent la projection à la fiche. Aucun framework juridique ne contient une famille générique `judicial`, `notarial` ou `state`. Les onze valeurs canoniques du plan ciblé ont été relues après reprise : zéro écart.

La première application a écarté les lignes modifiées depuis la sauvegarde. La reprise a relu les données fraîches et appliqué 1 239 projections sans aucun skip CAS. Un ancien worker, lancé avant l’activation du nouveau tag, avait réécrit six annonces sans leur projection ; il s’est achevé avec succès avant la demande d’arrêt. Ces six annonces ont été relues et replanifiées séparément, puis appliquées 6 / 6 après sa fin. Aucune exécution ancienne n’a été interrompue. Le contrôle final a lieu après cette dernière reprise.

## État de publication et validation

Version activée sur **https://immojudis.com** : déploiement `dpl_8t3G2D1aLL13oHMJJU7SXyupb9CD`, construit depuis le workspace actuel afin de conserver les fonctionnalités déjà en production. Le worker utilise le tag protégé et immuable `immojudis-workers-9ab51e69`, commit `9ab51e698348d8d23a1c75c327a8ff287788bf9d`.

L’implémentation est conservée dans la [PR 185](https://github.com/Aprivi-dev/immojudis/pull/185). Les [contrôles CI finaux](https://github.com/Aprivi-dev/immojudis/actions/runs/37046234733) sont tous verts : web, Python 3.11/3.12, migrations et pgTAP, parcours multi-navigateurs et accessibilité, dépendances et invariant d’un seul ordonnanceur. [CodeQL](https://github.com/Aprivi-dev/immojudis/actions/runs/37046234725) passe également.

- Worker isolé : 2 153 tests réussis, 105 ignorés selon les services disponibles localement ; Ruff passe. Le workspace actuel passe 2 158 tests Python, avec 101 ignorés.
- Web du workspace : 1 548 tests réussis, 3 ignorés ; TypeScript et ESLint passent. Le build Vercel final réussit.
- Budget JavaScript de la release : 4 395 411 octets, sous le seuil existant de 4 400 000 ; baisse de 20 055 octets face à la première version de la fonctionnalité. Les budgets par route passent. Le workspace incluait déjà un dépassement global lié à des modifications antérieures hors périmètre ; le seuil n’a pas été augmenté pour faire passer ce travail.
- Le [test réel Notaires](https://github.com/Aprivi-dev/immojudis/actions/runs/37041654039) réussit. Sa limite de publication d’une annonce ne borne pas la découverte de la source, qui parcourt d’abord son inventaire.
- Le [contrôle de publication du worker final](https://github.com/Aprivi-dev/immojudis/actions/runs/37046318549) réussit et vérifie les transactions avec rollback obligatoire.
- Test public sur ordinateur et Pixel 7 : ouverture des détails, 130 critères et 130 états, aucun débordement horizontal, aucune erreur applicative. Les annulations normales de tuiles cartographiques IGN pendant le déplacement de la carte sont enregistrées séparément. Accueil, catalogue et annonce exemple répondent HTTP 200.

Captures de production : [ordinateur](./completude-production-2026-10-02/desktop.png), [mobile](./completude-production-2026-10-02/mobile.png), [résultat machine](./completude-production-2026-10-02/verification.json).

Retour arrière web disponible vers le déploiement précédent `dpl_HmFqxTWP8vUQZgPSAqE2iiJxY4J4`. L’ancien tag worker `immojudis-workers-e5ec4b7f` reste immuable et disponible. La reprise DB dispose de sauvegardes privées des valeurs antérieures ; aucun export du catalogue n’est publié dans cette PR.

## Limites conservées

L’audit porte sur dix connecteurs et 27 visites ou tentatives documentées, avec 16 fiches accessibles, parfois seulement en partie. Il ne fournit pas un taux de précision représentatif de l’ensemble du catalogue.

Enchères Publiques a renvoyé un refus 403, Enchères Immobilières a dépassé les délais réseau et l’opérateur AGRASC d’Évry a renvoyé 410. Ces trois chemins restent à recontrôler lorsque l’accès sera rétabli. Vench et Petites Affiches réservent une partie des informations aux abonnés. La couverture porte sur les données publiques effectivement obtenues ; les pièces PDF/OCR et l’utilisabilité de chaque photo demandent une validation documentaire séparée.

Les [captures, URL et inventaires](./sources-2026-10-02/captures.md) documentent l’accès réel. Les rapports initiaux annonçant 13 `xfail` ou une UI exclue du périmètre décrivent la phase d’audit, avant les corrections et l’intégration produit consignées ici.
