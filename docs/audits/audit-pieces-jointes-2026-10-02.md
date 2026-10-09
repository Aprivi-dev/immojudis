# Audit de l’extraction des pièces jointes — 2 octobre 2026

Audit commencé le 2 octobre ; corrections et reprise ciblée de la base publiées le 3 octobre 2026. Les horaires ci-dessous sont en UTC.

L’audit suit les pièces depuis l’URL publiée jusqu’à leur affichage : téléchargement, identité des octets, lecture de chaque page, OCR, extraction de faits, provenance, enregistrement et projection sur l’annonce. Il distingue la récupération du texte, la couverture des pages et la vérification des faits. Aucun nombre de caractères ne prouve à lui seul qu’un dossier est complet.

## Corpus et méthode

Onze PDF réels de quatre sources accessibles : AGRASC/Agorastore, Avoventes, Cessions de l’État et Info-Enchères. Le corpus comprend du texte natif, des scans et des documents mixtes, des tableaux, des plans, un filigrane, des annexes et des diagnostics. Vingt-six captures ciblées ont été inspectées ; les métriques de toutes les pages et les SHA-256 des onze documents sont conservés dans le [manifeste](./pdf-2026-10-02/manifest.json).

Le [relevé visuel](./pdf-2026-10-02/ground-truth.md) conserve la portée de chaque valeur : unité, lot, parcelle, surface au sol ou Carrez, classe énergétique actuelle ou scénario de travaux. Les PDF et captures bruts restent locaux. Les URL et empreintes permettent de reproduire les observations sans publier les signatures et informations personnelles des dossiers.

Le [rejeu comparatif](./pdf-2026-10-02/comparison.md) porte sur 27 pages ciblées, avec Tesseract français/anglais, hors réseau et sans LLM. Les six pages qui produisaient un faux DPE A ne produisent plus cette classe. Quatre classes réellement visibles dans les graphiques restent non extraites : ce contrôle démontre la correction des faux positifs, sans prétendre résoudre la lecture sémantique des graphiques.

Les fiches publiques Licitor et Notaires échantillonnées ne fournissaient pas de PDF téléchargeable. Leur absence n’est pas comptée comme une panne du parseur. Les pièces inaccessibles, l’échantillon réduit et les changements ultérieurs des sources limitent la portée de ce contrôle.

## Défauts identifiés et corrections

| Défaut | Conséquence | Correction |
| --- | --- | --- |
| OCR déclenché seulement sous 80 caractères natifs | Un en-tête numérique pouvait masquer un corps scanné | Détection des grandes régions images, conservation du texte natif, version de cache renouvelée |
| Classes DPE/GES reconnues dans de la prose | « DPE à des fins… », catégories juridiques, sommaires et scénarios devenaient des classes actuelles | Contexte explicite de classement, rejet des recommandations et seuils, limites document/page |
| Valeurs documentaires de plusieurs lots ramenées à une seule annonce | Une surface, une occupation ou une classe pouvait être choisie sans correspondance démontrée | Candidats et preuves conservés ; valeurs scalaires suspendues en cas de portée ambiguë ; ensembles explicitement agrégés distingués |
| Surface et occupation déjà connues dispensant la passe de faits | Le reste des informations documentaires pouvait rester inexploité | Passe structurée requise jusqu’à obtention d’un manifeste de faits courant, sous les budgets existants |
| Contexte dédupliqué sur ses 300 premiers caractères | Des pages ayant le même en-tête perdaient leurs faits distincts | Empreinte du contenu complet ; agrégat plus riche conservé |
| Identité d’analyse ne comparant pas le nouveau SHA-256 | Un PDF remplacé à la même URL pouvait réutiliser une analyse ancienne | Comparaison des octets courants avec la preuve persistée, sans détruire les reprises partielles |
| Retrait incomplet des anciennes valeurs PDF | Pièces, chambres, occupation, dates ou surface affichée dérivée pouvaient survivre à un document remplacé ou retiré | Trace des projections et restauration sous contrôle de valeur ; retrait établi seulement par un manifeste source complet, avec préservation des informations source et corrections indépendantes |
| Ancien texte documentaire conservé quand le texte source était vide | Une pièce retirée ou remplacée restait utilisable comme contexte | Restauration du texte source, y compris vide, et suppression du suffixe documentaire périmé |
| Description, type, risques et statut dérivé sans trace de projection | Le contenu d’une ancienne pièce pouvait survivre à son remplacement, ou être réutilisé comme description source | Trace des champs dérivés et de leur valeur antérieure ; retrait du contexte documentaire périmé sans perdre le préfixe source |
| Réanalyse complète vide assimilée à une récupération échouée | Les faits périmés restaient présents, ou risquaient d’être effacés sans preuve | Nettoyage seulement avec lecture complète du dossier courant ; conservation des faits lors d’une passe partielle, bornée ou sans payload |
| Pièce devenue définitivement inaccessible conservée comme contexte | L’ancienne description et ses projections pouvaient alimenter une nouvelle analyse | Invalidation du contexte et des projections attribuables aux pièces concernées ; conservation des valeurs source, corrections indépendantes et preuves des autres pièces |
| Fuseau UTC explicite devenu implicite après passage en minuscules | Une date documentaire pouvait être décalée comme une heure locale Paris | Conservation des noms UTC/GMT reconnus, avec tests des offsets et heures locales |
| Unicité globale de l’URL documentaire | Deux annonces partageant un PDF pouvaient s’écraser | Rattachement et écriture par paire annonce source / URL de pièce |
| Anciennes pièces encore projetées après retrait | Des documents obsolètes restaient affichés | Retrait borné aux manifestes source explicitement complets ; préservation des sources partielles ou restreintes |
| Provenance documentaire étrangère au manifeste courant | Une citation pouvait pointer vers une pièce sans lien prouvé avec l’annonce | Validation du rattachement courant avant émission d’un fait documentaire |
| Même panier de pièces clés pour toutes les procédures | Les ventes notariales et cessions d’État étaient pénalisées par l’absence de PV d’huissier | Familles documentaires adaptées à la procédure vérifiée et au type de bien |
| États de récupération invisibles sur les liens des pièces | Texte récupéré et extraction partielle semblaient équivalents | Libellés distincts pour attente, récupération, extraction partielle et récupération indisponible, sans présenter une extraction comme une validation des faits |

Les textes et faits d’une pièce partielle restent des indices utiles. Ils ne permettent pas de certifier l’absence d’informations sur les pages non lues. Les candidats contradictoires doivent rester visibles sans choix arbitraire d’une valeur unique.

Le panier documentaire suit les trois profils de la [checklist de complétude](./publication-extraction-profils-2026-10-02.md). Les conditions de vente concernent les trois procédures ; le PV descriptif entre dans les familles clés du profil judiciaire, sans être imposé aux profils notarial et État. Les diagnostics sont attendus pour les biens concernés, avec exclusion des terrains et parkings de ce panier. Le cadre juridique vérifié prime sur le seul lieu de vente. Ce panier mesure la disponibilité des familles de pièces, sans constituer une certification juridique du dossier.

## Contrôle de la base existante

Le 2 octobre à 18 h 52, 154 annonces avaient un état `document_analysis` : 110 partiels, 21 riches, 12 limités à la source et 11 sans texte documentaire extrait. Le terme « riche » décrit des familles de documents disponibles ; il ne certifie pas les 130 critères de la fiche.

Le 2 octobre à 18 h 55, la table de pièces contenait 2 858 lignes : 2 667 en attente, 164 avec du texte récupéré et 27 incomplètes. Une pièce en attente n’est pas une erreur d’extraction ; elle n’a pas encore de résultat utilisable.

Le contrôle des rattachements du 2 octobre à 19 h 14 a trouvé 2 840 paires déclarées, dont 19 URL partagées par 41 paires, et 37 paires sans ligne documentaire correspondante. Une seconde vérification avant la reprise a trouvé six autres paires manquantes. Les 43 rattachements ont été restaurés après vérification que l’URL et le libellé étaient toujours déclarés sur l’annonce. Ils reprennent un état en attente, sans recopier l’analyse d’une autre annonce.

Le contrôle final du 3 octobre à 09 h 31 min 34 s confirme 2 740 paires déclarées et zéro rattachement manquant. Le nombre de paires évolue avec les inventaires source ; il ne faut pas comparer ces instantanés comme une cohorte fixe. La seule contrainte d’unicité documentaire est désormais `UNIQUE (source_url, document_url)`.

Les six anciens blocs `pdf_energy_diagnostics` initialement contrôlés contenaient des classes non justifiées par leurs citations. Le contrôle actualisé a trouvé sept blocs non étayés et un bloc D étayé. Les sept blocs non étayés ont été retirés avec sauvegarde privée et comparaison exacte de la valeur courante ; le bloc D valide a été conservé. Les sept annonces n’avaient ni claim énergétique dans `auction_fact_claims`, ni projection DPE dans `source_field_observations` ou `source_blocks`. Le retrait n’a pas modifié ces informations indépendantes. Les classes réellement lisibles visuellement dans les graphiques restent distinctes des faux résultats supprimés.

## Vérification et publication

La version est active sur [immojudis.com](https://immojudis.com) depuis le 3 octobre. Déploiement web `dpl_9H1a1DqL9ZJ7nJSBS8JzRY9QC1og`, URL de version [immojudis-dezt-dum8csrk8-antoine-s-projects7.vercel.app](https://immojudis-dezt-dum8csrk8-antoine-s-projects7.vercel.app). Le collecteur utilise le tag immuable `immojudis-workers-ef8000ee`, commit `ef8000eef78cb74d707fd3defe337c6107f654c6`, protégé contre modification et suppression par la règle GitHub `24412127`.

La migration a été appliquée en deux phases : [ajout de la clé composite](../../supabase/migrations/20261002193158_document_source_key.sql) le 2 octobre, puis [adaptation de la fonction de revue et retrait de la clé globale](../../supabase/migrations/20261003091424_drop_document_url_global_key.sql) le 3 octobre à 09 h 14 min 24 s, après activation du nouveau collecteur et fin de l’ancien traitement. Le traitement Licitor de l’ancienne version a été arrêté avec son mécanisme de finalisation et de conservation des checkpoints. La migration impose d’utiliser un collecteur compatible avec la clé composite ; un retour à l’ancien tag exige une migration de compatibilité.

Les validations portent sur la version exécutée, avec les limites suivantes :

- Corpus : 11 PDF, 26 captures inspectées, 27 pages rejouées ; six faux DPE A supprimés par les nouvelles règles, quatre classes graphiques encore inconnues.
- Checkout de publication : 2 210 tests Python réussis, 105 ignorés ; Ruff, TypeScript, lint ciblé, build et budgets réussis. Le plus grand module métier compte 1 487 lignes, sous le plafond de 1 500.
- Workspace utilisé pour le déploiement web : 2 215 tests Python réussis, 101 ignorés ; 1 563 tests web réussis, trois ignorés ; contrôle TypeScript et build de production réussis. Les corrections de compilation et de cohérence des exemples statistiques nécessaires à ce build sont incluses.
- [CI de la version du collecteur](https://github.com/Aprivi-dev/immojudis/actions/runs/37111231281) réussie : web, Python 3.11/3.12, migrations et pgTAP, parcours Playwright, dépendances et invariant de collecteur unique. [CodeQL](https://github.com/Aprivi-dev/immojudis/actions/runs/37111231254) réussi.
- Canaris de publication [avant](https://github.com/Aprivi-dev/immojudis/actions/runs/37111269830) et [après](https://github.com/Aprivi-dev/immojudis/actions/runs/37112541858) la seconde migration réussis. Le second confirme le schéma à 09 h 18 min 19 s ; les transactions de vérification sont annulées sans écriture persistée.
- Premier [traitement automatique](https://github.com/Aprivi-dev/immojudis/actions/runs/37112407045) de la nouvelle version, démarré à 09 h 15 min 04 s : terminé avec succès sur le commit exact du tag publié.
- [Contrôle public après publication](./pdf-production-2026-10-03/verification.json), terminé à 09 h 25 min 27 s : accueil, liste et annonce exemple en HTTP 200 sur ordinateur et mobile, sans erreur JavaScript ni débordement horizontal. Les captures ont été prises après affichage de l’annonce. L’annonce exemple ne contient pas de véritable pièce jointe ; les nouveaux états documentaires sont couverts par les tests de composant, sans être présentés comme un contrôle visuel de tous les PDF en production.

La reprise de la base est ciblée sur les anomalies établies ; tous les PDF historiques n’ont pas été réanalysés. Les nouvelles règles et versions de cache s’appliquent aux prochaines passes du collecteur, sous ses budgets existants. Les corpus privés, sauvegardes et plans de reprise restent locaux et ne sont pas committés dans le dépôt public.

## Limites techniques qui restent à distinguer

L’OCR transforme les pixels en texte ; il ne constitue pas une interprétation fiable des plans, photos ou graphiques. Une classe lisible dans un encadré graphique peut rester inconnue dans les champs automatiques lorsqu’aucune preuve textuelle fiable n’est extraite. Les petites régions images, l’écriture manuscrite, les filigranes et les tableaux complexes restent des cas exigeant une relecture.

Le schéma de la passe LLM structure notamment surfaces, composition, occupation, copropriété, travaux et risques. Les caractéristiques supplémentaires peuvent être conservées comme faits d’investissement avec preuves ; tous les champs de la checklist ne disposent pas encore d’une projection documentaire typée dédiée. Les champs sans preuve restent inconnus.

La vue des pièces expose actuellement leur URL, nature, statut et quantité de texte. Les pages, méthodes, empreintes et erreurs détaillées restent dans les preuves internes du pipeline. Un état public « texte récupéré » ne garantit donc ni l’exactitude de l’OCR, ni l’applicabilité au lot, ni la complétude de l’annonce.

La production dispose d’une connexion Postgres directe pour les checkpoints différés. Le mode de publication REST seul ne fournit pas encore la même garantie de reprise après interruption ; il ne doit pas être présenté comme équivalent.

La stratégie OCR mixte s’appuie sur l’API officielle [PyMuPDF de récupération texte/OCR](https://pymupdf.readthedocs.io/en/latest/page.html#Page.get_textpage_ocr). Les contrôles de fraîcheur et de rattachement sont vérifiés sur les données et le code de ce dépôt, et non déduits de la documentation de la bibliothèque.
