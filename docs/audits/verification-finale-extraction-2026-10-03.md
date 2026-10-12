# Vérification finale de l’extraction — 3 octobre 2026

Cette repasse complète l’[audit des sources](./audit-sources-completude-2026-10-02.md), la [checklist de 130 critères](./checklist-completude-annonces-2026-10-02.md) et l’[audit des pièces jointes](./audit-pieces-jointes-2026-10-02.md). Les horaires sont en UTC.

## Corrections supplémentaires établies

| Cas reproduit | Effet avant correction | Résultat vérifié |
| --- | --- | --- |
| Un PDF devient définitivement indisponible alors qu’un autre reste lisible | Les surfaces et pièces issues du PDF retiré pouvaient survivre | Invalidation des projections attribuables à la pièce retirée, puis reprise des pièces lisibles ; valeurs corrigées indépendamment conservées. Un incident HTTP 503 temporaire conserve les preuves antérieures. |
| Complétude calculée à partir de preuves vides ou générées | Une simple URL PDF, un bloc de complétude produit précédemment ou une URL d’image comptaient comme preuve de lecture ou de photo exploitable | Une pièce doit avoir un état de récupération compatible et du texte réellement récupéré ; les blocs générés sont exclus ; le nombre de photos exploitables demande une observation explicite. |
| Recalcul d’un ensemble immobilier depuis une ancienne ligne en base | La première surface Carrez d’un composant remplaçait le total explicitement annoncé | Le total Carrez explicite prime entre candidats de même nature. Le test couvre une ancienne surface partielle, une surface arrondie et un total déjà exact, puis deux recalculs successifs. |
| Guide générique « Notaires de France » présent dans les blocs source | Le parseur produisait un faux nom d’étude « s de France » | Libellés textuels bornés et prioritisation de l’interlocuteur identifié dans les métadonnées notariales vérifiées ; les métadonnées non vérifiées ne suffisent pas. Ce champ ne certifie pas la qualité juridique de la personne. |
| Statut de détail absent, nul ou blanc dans une annonce | Une exception `.casefold()` interrompait la publication d’un lot entier | La publication continue et le retrait des anciennes pièces reste interdit sans manifeste explicitement complet. Huit cas couvrent les lots mixtes et deux révisions d’une même annonce. |

Le dernier défaut a été confirmé dans les exécutions réelles [de 09:30](https://github.com/Aprivi-dev/immojudis/actions/runs/37113254922) et [de 10:15](https://github.com/Aprivi-dev/immojudis/actions/runs/37115793010). Le canari de publication a été étendu : il republie également une annonce dont le statut de détail est absent, dans une transaction systématiquement annulée. Les précédents canaris ne couvraient pas ce cas.

## Contrôles sur les sources réelles

Les fixtures des dix connecteurs sont rejouées par les suites automatisées existantes. Cette dernière repasse comprend trois nouvelles visites publiques, avec captures inspectées, et une réponse API actuelle :

- [Avoventes, Saint-Cloud](https://avoventes.fr/enchere/une-piece-a-saint-cloud) : 18 000 €, 10,10 m² Carrez, chauffage collectif, DPE F, galerie et douze liens PDF. La fiche publique reste accessible ; aucune ligne ne correspondait à cette URL exacte dans le catalogue au moment du contrôle. Cette visite ne prouve donc pas son ingestion actuelle.
- [Immo-interactif, Arcachon](https://www.immo-interactif.fr/encheres-en-ligne/appartement/arcachon-33/2083008) : le bandeau arrondit à 117 m² ; la description dépliée annonce 83,21 + 34,37 = 117,58 m² Carrez. La réponse API du 3 octobre a été reparsée et les résultats repassés dans la normalisation. Une erreur d’hydratation du site tiers a été relevée ; elle n’empêche pas la lecture de la description.
- [Cessions de l’État, Saint-Junien](https://cessions.immobilier-etat.gouv.fr/biens/parcelle-br-ndeg104-saint-junien-87200) : parcelle BR 104, 13 037 m², zone A et appel d’offres ; concordance avec le terrain enregistré.

Les captures sont conservées localement dans `output/playwright/final-audit-2026-10-03/`. Il ne s’agit pas d’une nouvelle navigation exhaustive sur chaque annonce de chaque source. Le corpus documentaire précédent reste constitué de 11 PDF réels et de 27 pages ciblées rejouées ; tous les PDF historiques n’ont pas été réanalysés.

## Reprise ciblée des données

Les écritures ont été préparées depuis des sauvegardes privées. Chaque correction vérifie l’identité de la ligne et sa version ; les retraits documentaires vérifient aussi le contenu exact, le manifeste complet et l’absence de l’URL dans les pièces courantes.

- **87 rattachements documentaires obsolètes retirés**, tous encore en attente de traitement, dont 62 rattachés à des annonces visibles. Aucun texte extrait n’a été supprimé par cette reprise.
- **99 faux libellés notariaux corrigés**, à partir des interlocuteurs déjà identifiés dans les métadonnées vérifiées. La projection de complétude a été mise à jour avec la même preuve.
- **Une annonce corrigée à 117,58 m²** parmi les 11 annonces examinées qui mentionnent explicitement un total Carrez. La surface canonique, la surface affichée, les observations et l’analyse dérivée ont été recalculées ensemble. Le score de cette annonce passe de 33 à 41 avec les règles en vigueur ; ce score reste un indicateur produit.

Contrôle à **10:29:12 UTC** : 2 740 paires annonce/pièce déclarées, **aucun rattachement manquant**, **aucun rattachement obsolète après manifeste complet**, **aucun faux libellé « s de France »**, **aucune projection de complétude absente**. La surface et l’observation Carrez d’Arcachon sont toutes deux à 117,58 m². Ces mesures décrivent l’état contrôlé à cet instant, pas une certification de tous les faits du catalogue.

Les sauvegardes, requêtes de correction et comparaisons détaillées sont privées dans `/private/tmp/immojudis-final-audit-2026-10-03/`. Aucun jeu de données de production complet n’est committé.

## Qualification et publication

- Checkout de livraison : **2 229 tests Python réussis**, 105 ignorés ; Ruff réussi. Les tests ignorés ne sont pas présentés comme validés.
- Web utilisé pour le déploiement : **1 568 tests réussis**, trois ignorés ; TypeScript, lint ciblé, build et budgets réussis. Les correctifs ajoutés après cette suite portent uniquement sur Python.
- [CI finale](https://github.com/Aprivi-dev/immojudis/actions/runs/37116760995) : réussie sur `cf54645949d06b961656875025bed93100089a75` ; Python 3.11/3.12, web, migrations/pgTAP, parcours navigateur et invariant de collecteur unique.
- [CodeQL](https://github.com/Aprivi-dev/immojudis/actions/runs/37116760973) réussi.
- [Canari final étendu](https://github.com/Aprivi-dev/immojudis/actions/runs/37116793832) réussi, avec annulation de la transaction.
- Référence du collecteur : `immojudis-workers-cf546459`, commit `cf54645949d06b961656875025bed93100089a75`, protégé par la règle immuable `24414021`.
- Un [essai Vench complémentaire](https://github.com/Aprivi-dev/immojudis/actions/runs/37116802947), demandé avec `limit=3`, a été annulé avant son démarrage : cette option borne le traitement final mais pas la collecte amont, et l’exécution attendait la collecte automatique en cours. Il ne compte pas comme test réussi. Le défaut de publication sur statut absent est validé par les huit tests de lots mixtes et par le canari final sur une annonce réelle, sans statut de détail, en transaction annulée.

Le déploiement final **`dpl_Da792qSoKJfGdE6FWgRqbEkoYSSM`** est actif sur [immojudis.com](https://immojudis.com). Le contrôle public terminé à **10:39:29 UTC** vérifie six réponses HTTP 200 (accueil, liste et annonce exemple sur ordinateur et mobile), sans erreur JavaScript ni débordement horizontal. Les captures ont été inspectées. La checklist dépliée expose 130 critères, dont 117 applicables et 13 non applicables sur l’exemple judiciaire. La [preuve de publication](./final-extraction-2026-10-03/verification.json) conserve les identités, contrôles et empreintes des captures.

Une collecte notariale suivante a republié Arcachon à 10:33:48 UTC : la ligne canonique et la table `properties` conservent toutes deux 117,58 m². Le correctif persiste donc après un nouveau passage réel du collecteur. L’observation brute de l’API conserve son arrondi à 117 m² ; `source_carrez_aggregate_precision` enregistre explicitement cet arrondi comme alternative au total de 117,58 m² cité dans la description.

Le contrôle répété à **10:46:30 UTC** retrouve les mêmes 2 740 paires et zéro anomalie pour les rattachements manquants/obsolètes, les faux libellés notariaux et les projections absentes. La surface affichée demeure à 117,58 m².

## Limites conservées

La lecture sémantique des graphiques DPE n’est pas considérée comme résolue : quatre classes visibles dans le corpus précédent restent inconnues automatiquement. Les scans, tableaux et documents partiels gardent leurs marqueurs de couverture et leurs preuves. Une récupération de texte ne valide ni la portée au bon lot ni la complétude juridique d’un dossier. Les profils tribunal, notaire et État et les critères non applicables restent distincts.
