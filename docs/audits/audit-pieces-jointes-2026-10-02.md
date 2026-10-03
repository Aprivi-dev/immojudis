# Audit de l’extraction des pièces jointes — 2 octobre 2026

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
| Fuseau UTC explicite devenu implicite après passage en minuscules | Une date documentaire pouvait être décalée comme une heure locale Paris | Conservation des noms UTC/GMT reconnus, avec tests des offsets et heures locales |
| Unicité globale de l’URL documentaire | Deux annonces partageant un PDF pouvaient s’écraser | Rattachement et écriture par paire annonce source / URL de pièce |
| Anciennes pièces encore projetées après retrait | Des documents obsolètes restaient affichés | Retrait borné aux manifestes source explicitement complets ; préservation des sources partielles ou restreintes |
| Provenance documentaire étrangère au manifeste courant | Une citation pouvait pointer vers une pièce sans lien prouvé avec l’annonce | Validation du rattachement courant avant émission d’un fait documentaire |
| Même panier de pièces clés pour toutes les procédures | Les ventes notariales et cessions d’État étaient pénalisées par l’absence de PV d’huissier | Familles documentaires adaptées à la procédure vérifiée et au type de bien |
| États de récupération invisibles sur les liens des pièces | Texte récupéré et extraction partielle semblaient équivalents | Libellés distincts dans la liste des pièces, sans présenter une extraction comme une validation des faits |

Les textes et faits d’une pièce partielle restent des indices utiles. Ils ne permettent pas de certifier l’absence d’informations sur les pages non lues. Les candidats contradictoires doivent rester visibles sans choix arbitraire d’une valeur unique.

## Contrôle de la base existante

À 18 h 52 UTC, 154 annonces avaient un état `document_analysis` : 110 partiels, 21 riches, 12 limités à la source et 11 sans texte documentaire extrait. Le terme « riche » décrit des familles de documents disponibles ; il ne certifie pas les 130 critères de la fiche.

À 18 h 55 UTC, la table de pièces contenait 2 858 lignes : 2 667 en attente, 164 avec du texte récupéré et 27 incomplètes. Une pièce en attente n’est pas une erreur d’extraction ; elle n’a pas encore de résultat utilisable.

Le contrôle des rattachements à 19 h 14 UTC a trouvé 2 840 paires déclarées, dont 19 URL partagées par 41 paires, et 37 paires sans ligne documentaire correspondante. La correction de l’unicité ne doit pas recopier une analyse ancienne d’une autre annonce : les liens restaurés sans preuve propre reprennent un état en attente.

Les six anciens blocs `pdf_energy_diagnostics` contrôlés contenaient des classes non justifiées par leurs citations. Ils n’avaient ni claim énergétique dans `auction_fact_claims`, ni projection DPE dans `source_field_observations` ou `source_blocks`. Leur retrait est prévu avec sauvegarde privée et comparaison de la valeur actuelle afin de préserver une éventuelle correction concurrente. La classe réelle lisible visuellement dans un encadré reste distincte de ces faux résultats.

## Vérification et publication

Les résultats de rejeu, validations finales, reprise ciblée de la base et identifiants de publication sont ajoutés après leur achèvement. Les corpus privés, sauvegardes et plans de reprise ne sont pas committés dans le dépôt public.

## Limites techniques qui restent à distinguer

L’OCR transforme les pixels en texte ; il ne constitue pas une interprétation fiable des plans, photos ou graphiques. Une classe lisible dans un encadré graphique peut rester inconnue dans les champs automatiques lorsqu’aucune preuve textuelle fiable n’est extraite. Les petites régions images, l’écriture manuscrite, les filigranes et les tableaux complexes restent des cas exigeant une relecture.

Le schéma de la passe LLM structure notamment surfaces, composition, occupation, copropriété, travaux et risques. Les caractéristiques supplémentaires peuvent être conservées comme faits d’investissement avec preuves ; tous les champs de la checklist ne disposent pas encore d’une projection documentaire typée dédiée. Les champs sans preuve restent inconnus.

La vue des pièces expose actuellement leur URL, nature, statut et quantité de texte. Les pages, méthodes, empreintes et erreurs détaillées restent dans les preuves internes du pipeline. Un état public « texte récupéré » ne garantit donc ni l’exactitude de l’OCR, ni l’applicabilité au lot, ni la complétude de l’annonce.

La production dispose d’une connexion Postgres directe pour les checkpoints différés. Le mode de publication REST seul ne fournit pas encore la même garantie de reprise après interruption ; il ne doit pas être présenté comme équivalent.

La stratégie OCR mixte s’appuie sur l’API officielle [PyMuPDF de récupération texte/OCR](https://pymupdf.readthedocs.io/en/latest/page.html#Page.get_textpage_ocr). Les contrôles de fraîcheur et de rattachement sont vérifiés sur les données et le code de ce dépôt, et non déduits de la documentation de la bibliothèque.
