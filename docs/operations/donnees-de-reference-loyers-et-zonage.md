# Données de référence : carte des loyers de l'ANIL et zonage tendu (TLV)

Mise à jour : 2026-10-26.

## Pourquoi

- **Loyers.** Les rendements affichés (filtre « rendement minimal », alertes, simulateur, rapports,
  exports) reposaient sur une table de loyers codée en dur pour 24 départements
  (`src/lib/rent-reference.ts`). Ils lisent désormais la carte des loyers de l'ANIL, commune par
  commune, et ne retombent sur cette table que sans donnée ANIL.
- **Zonage tendu.** La liste des communes selon le zonage TLV est importée et stockée. Aucun écran ne
  l'affiche encore.

## Sources

| Table | Source | Licence | Volume (26/10/2026) |
| --- | --- | --- | --- |
| `anil_rents` | « Carte des loyers » — Indicateurs de loyers d'annonce par commune en 2025, data.gouv.fr, jeu `693aa2feed1bf4da603faa49` | Licence Ouverte 2.0 | 34 900 communes (dont 45 arrondissements) × 4 segments |
| `commune_housing_tension` | « Liste des communes selon le zonage TLV », data.gouv.fr (`liste-des-communes-selon-le-zonage-tlv-1`), décret n° 2025-1267 du 22/12/2025 | Licence Ouverte 2.0 | 34 875 communes |

Les deux sources sont enregistrées dans `data_sources` (`anil_rent_map`, `tlv_zoning`) avec leur
licence, leur fréquence de mise à jour et leur mention (colonnes `update_frequency` et
`attribution_notice`, ajoutées pour l'occasion). Elles sont déclarées `pending` (aucune relecture
juridique enregistrée), `allowed_manual` et inactives : l'import passe par le workflow de données de
référence, pas par l'ingestion des issues.

Les deux tables sont privées : RLS active, aucun droit pour `anon` ni `authenticated`, lecture par le
serveur uniquement (`service_role`).

### Carte des loyers de l'ANIL

- Quatre fichiers CSV, repérés par leur **titre** dans l'API `https://www.data.gouv.fr/api/1/datasets/<id>/`
  (jamais par un identifiant de ressource) :

  | Titre | Segment | Fichier |
  | --- | --- | --- |
  | Indicateurs de loyer appartement | `apt_all` | `pred-app-mef-dhup.csv` |
  | Indicateur de loyer appartement de 1 ou 2 pièces | `apt_1_2` | `pred-app12-mef-dhup.csv` |
  | Indicateur de loyer appartement de 3 pièces ou plus | `apt_3p` | `pred-app3-mef-dhup.csv` |
  | Indicateurs de loyer maison | `house` | `pred-mai-mef-dhup.csv` |

- Le millésime est lu dans le titre du jeu (« … par commune en 2025 ») ; la date de mise à jour est celle
  du fichier sur data.gouv.fr (11/12/2025). Les deux sont gardés sur chaque ligne (`vintage`,
  `source_updated_on`) avec l'adresse du fichier (`source_url`).
- Format observé le 26/10/2026 : séparateur `;`, virgule décimale, **Windows-1252** (pas UTF-8).
  L'import essaie UTF-8, puis Windows-1252, puis Latin-1.
- `TYPPRED` vaut `commune`, `maille` ou **`EPCI`** (en majuscules ; la graphie `maile` est aussi
  acceptée). Il est enregistré en minuscules : `commune`, `maille`, `epci`.
- Le loyer est un **loyer d'annonce, en €/m², charges comprises, non meublé**. Ce n'est ni un loyer
  constaté, ni un loyer garanti, ni un loyer hors charges.
- Paris, Lyon et Marseille sont par arrondissement (751xx, 6938x, 132xx) ; le code de la commune
  (75056, 69123, 13055) n'a **pas** de ligne. Mayotte est exclue.
- Colonnes gardées : loyer, bornes de l'intervalle à 95 % (`rent_low_per_m2`, `rent_high_per_m2`),
  `TYPPRED`, observations de la commune (`nbobs_com`) et de la maille (`nbobs_mail`), `R2_adj`,
  identifiant de zone, EPCI.

### Zonage tendu

- CSV UTF-8, séparateur `;`. Les colonnes « Code EPCI » et « Libellé EPCI » sont **inversées** dans le
  fichier publié (la première porte le nom, la seconde le code à 9 chiffres) : l'import détecte le code
  par sa forme.
- Trois colonnes de zonage conservées : 2013 (`tlv` ou `non_tlv`), 2023 et après le décret du
  22/12/2025 (`tendue`, `touristique_tendue` ou `non_tendue`), avec la référence et la date du décret
  (`decree_reference`, `decree_date`) et la date de mise à jour du fichier (30/12/2025).
- Paris, Lyon et Marseille ne figurent qu'une fois (75056, 69123, 13055), pas par arrondissement : un
  lecteur qui part d'un code d'arrondissement doit remonter à la commune.

## Mise à jour

Workflow manuel **Reference data import** (`.github/workflows/reference-data-import.yml`) :

- `dataset` : `rents`, `tension`, ou `all`, qui lance aussi `communes`, `risks` et `climate` (le climat
  télécharge 96 fichiers, jusqu'à 90 minutes) ; chaque jeu est isolé (la panne de l'un n'empêche pas les
  autres, le code de sortie est non nul s'il y en a une) et ouvre sa propre connexion, au moment d'écrire ;
- `dry_run` : télécharge et analyse sans écrire ;
- `check_new_vintage` : cherche seulement un millésime ANIL plus récent (aucune écriture). Le même
  contrôle tourne tout seul le 1er novembre, le 1er décembre et le 1er janvier à 07 h 15 UTC
  (`python -m src.reference_data rents --check-new-vintage`) : sortie non nulle et `::warning::` si un
  jeu plus récent que `ANIL_CURRENT_EDITION` est publié. La marche à suivre est dans
  `docs/runbooks/import-annuel-anil.md`.

Un échec ajoute un résumé à la page du run (étape « Summarize the failure ») et une annotation
`::error::` par jeu en échec.

Fréquence : la carte des loyers est publiée chaque année en décembre ; le zonage change à chaque décret.

En local : `cd services/data-pipeline && python -m src.reference_data rents --dry-run` (idem `tension`).

Hôtes autorisés pour le téléchargement : `www.data.gouv.fr` (API) et `static.data.gouv.fr` (fichiers).
Un texte lu est limité à 32 Mo, un fichier téléchargé à 1 Go (taille déclarée contrôlée d'abord).
Le jeu du zonage est épinglé par son identifiant (`657c88da2947e13be0597058`), pas par son nom.

Gardes contre un import partiel : au moins 34 800 communes par segment (ANIL) ou au total (zonage), un
fichier d'au moins 99 % du nombre de lignes que la table contient déjà (sinon l'import est refusé : une
troncature de quelques pour cent passerait un seuil fixe, puis la purge supprimerait les communes
perdues), les quatre segments présents, au plus 0,5 % de lignes rejetées (code, département, loyer hors de
1 à 100 €/m², type de prédiction ou zonage inconnu). Le téléchargement compare les octets reçus à
`Content-Length` (un écart est une erreur, reprise comme les coupures réseau) ; seuls les statuts 5xx et
429 sont réessayés, pas un 403 ou un 404. Le département de chaque ligne se déduit du code commune (pas
de la colonne `DEP`). Les segments des fichiers ANIL sont reconnus par leur nom de fichier d'abord, par
leur titre ensuite. Le zonage refuse l'import si la documentation du jeu n'identifie aucun décret (pas de
repli sur un décret connu), choisit le décret dont la date est celle de l'en-tête du CSV (et non le
dernier de la liste) et refuse un fichier dont la date ne correspond à aucun décret.

Tout est analysé et contrôlé avant la première écriture ; l'écriture de chaque table instantanée
(`anil_rents`, `commune_housing_tension`) tient dans **une seule transaction** : upsert, purge des lignes non
touchées (communes disparues du millésime) et contrôle (un seul millésime et le bon nombre de lignes pour
`anil_rents`, le bon nombre de lignes pour `commune_housing_tension`). Un échec, une coupure réseau ou un
contrôle en défaut annule tout : la table garde son édition précédente, l'application ne lit jamais un
mélange de deux millésimes. (Les jeux `communes`, `risks` et `climate` écrivent encore par paquets.)

**À chaque nouvel import de la carte des loyers**, mettre à jour `ANIL_CURRENT_EDITION`
(`src/lib/rent-source-notice.ts`) : il sert aux mentions qui ne portent pas sur une vente (emails d'alerte).
Les écrans qui portent sur une vente affichent le millésime et la date de la ligne réellement utilisée.
L'import compare cette constante au millésime lu et **échoue avant toute écriture** en cas d'écart
(`web_edition_gap`, y compris en `--dry-run`) : la pull request qui met à jour la constante précède
l'import. Attention : le test du pipeline qui compare la constante au jeu (`test_the_real_web_edition_…`)
fige le couple 2025 / 2025-12-11 ; il se met à jour avec la constante, il ne lit pas le jeu réel.

## Lecture par l'application

- `src/lib/rent-reference.ts` (pur, partagé avec le navigateur) : segment selon le type et le nombre de
  pièces (maison ; appartement jusqu'à 2 pièces, 3 et plus ; tous appartements sinon), fiabilité, repli
  départemental.
- `src/lib/rent-source-notice.ts` : le texte de la mention. Le navigateur ne le charge que par
  `RentSourceNotice` (à la demande, `LazyRentSourceNotice`) : l'importer ailleurs côté navigateur en
  embarquerait une copie par écran. Le budget de JavaScript client est dépassé de 2 375 octets avec ce lot
  seul (mesuré le 26/10/2026 : 6 252 375 octets pour 6 250 000, contre 6 245 651 sans lui) ; le plafond n'a
  pas été relevé, à mesurer après la fusion qui dédoublonne `queryKeys`.
- `src/lib/rent-reference.server.ts` (`server-only`, seul fichier avec les types générés à nommer
  `anil_rents`, vérifié par `check-security-invariants.mjs`) : lecture de `anil_rents` par code commune et
  segment. Il ne lève jamais : sans configuration ou en cas d'erreur, le repli départemental s'applique.
  - Les lignes ANIL (et leur absence) sont mémorisées 6 heures, comme les codes commune ; les lots sont lus
    en parallèle (`Promise.all`, par vagues de 4).
  - Une **session** (`createRentLookupSession`) partage les chargements : le cron des alertes en ouvre une par
    exécution pour tous les comptes et toutes les alertes, une exportation ou une statistique une par
    requête.
  - Un appartement T1-T2 ou T3 et plus sans ligne pour son segment prend la ligne « tous appartements » de la
    **même commune** avant le repli départemental ; jamais de repli entre maison et appartement.
  - Un bien qui n'est pas un logement (terrain, parking, garage, local, bureau, immeuble…) n'a aucune
    référence de loyer, ni ANIL ni départementale : « Loyer de référence indisponible », aucun rendement.
- `source` d'une référence : `anil_commune`, `anil_maille`, `anil_epci` ou `department_estimate`.
- Fiabilité : `reliable` seulement pour une estimation `commune` avec au moins 30 observations et un
  `R2_adj` d'au moins 0,5 ; `indicative` sinon (maille, EPCI, repli départemental).
- **Point de raccord du code commune** : `src/lib/sale-commune-code.ts` (`saleCommuneCode`). Ordre de
  lecture : `raw_payload.commune.arrondissement_insee`, puis `raw_payload.commune.insee` (ce que le lot
  « code commune » écrira), puis `raw_payload.geocode.citycode` (géocodage accepté). Pour 75056, 69123 et
  13055 sans arrondissement, il se déduit du code postal (75008 donne 75108, 69003 donne 69383, 13008 donne
  13208). Brancher `auction_sale_communes` : le lire en premier dans cette fonction, rien d'autre.
  `raw_payload` n'est exposé ni au navigateur ni aux vues de liste : le serveur relit donc, par identifiant,
  seulement `postal_code`, `raw_payload->geocode->>citycode`, `->>accepted` et `raw_payload->commune` (jamais
  l'objet entier), par lots de 100 en parallèle, au plus 2 000 ventes par appel, mémorisé 6 heures. La
  relecture ne portera plus que sur les ventes sans code quand il sera stocké.
- **Taxe foncière par défaut du plafond** : elle reste calculée sur la base historique (loyer départemental
  ou surface), quel que soit le loyer ANIL affiché. Le plafond des projets « habiter » et « revendre » (donc
  celui de la pépite, qui n'a pas de référence de loyer) ne dépend pas du loyer ; seul « louer » le suit.
- **Charges** : le loyer d'annonce ANIL est charges comprises. Le panneau propose « Charges récupérables
  comprises dans le loyer (€/mois) », vide par défaut, sans valeur inventée : saisies, elles sont retirées du
  loyer estimé. Tant qu'elles sont vides avec un loyer ANIL, le rendement est dit « brut, charges
  comprises » (jamais « net ») dans le panneau, le plan, les rapports (page partagée, PDF) et
  `opportunity.rentReference.chargesIncluded` de l'export.

## Où la mention de l'ANIL s'affiche

Mention exacte : « Estimations ANIL, à partir des données du Groupe SeLoger et de leboncoin. », suivie du
complément (carte des loyers, millésime, date de mise à jour, Licence Ouverte 2.0, rendement calculé par
Immojudis sous sa seule responsabilité) et du lien vers la source.

- Fiche de la vente, panneau des hypothèses du plafond (projet « louer ») : `CeilingHypothesesPanel`.
- Le filtre « rendement minimal » (`AdvancedFiltersPanel`) n'affiche **pas** la mention : il dit « Ce filtre
  s'appuie sur un repère de loyer départemental ; les alertes, exports et statistiques utilisent la carte
  des loyers de l'ANIL (par commune). » La mention ne figure qu'à côté de ce qui vient de l'ANIL.
- Pied des emails d'alerte dont un motif est « rendement » (`email-alerts.ts`).
- Rapports : page de partage (`/reports/shared/[token]`) et PDF.
- Export API des ventes : `opportunity.rentReference` (crédit, détail, lien, `chargesIncluded`) et
  `meta.rentAttribution`, `meta.rentSourceUrl`, `meta.rentBasis`.
- Statistiques : `meta.rentAttribution` et `meta.rentBasis`.
- `rentBasis` dit de quoi sont faits les rendements de l'échantillon : `anil` (tous), `department` (aucun
  ANIL) ou `mixed`. Les biens sans loyer de référence ne comptent pas.

Les documents légaux (`legal`, `privacy`, `conditions-generales`, `legal-documents`, registre des
traitements) sont traités à part.

## Alertes : base silencieuse du changement de loyers

Le passage à l'ANIL fait entrer des ventes dans les alertes à critère de rendement sans qu'elles aient
changé. La déduplication existante n'évite pas la rafale à elle seule : une correspondance est unique par
alerte et vente, une notification unique par correspondance, mais le pipeline réécrit `updated_at` à chaque
collecte, donc la fenêtre incrémentale (ventes modifiées depuis la dernière évaluation) relit presque tout le
catalogue et trouverait d'un coup toutes les ventes devenues rentables.

Mécanisme (`isRentBasisSilentPass`, `alert-matches.ts`) :

- Au déploiement, poser `ALERT_RENT_BASIS_SWITCH_AT` (date ISO du déploiement, voir `.env.example`). Absente,
  rien n'est tu.
- Pendant les 48 heures suivantes, la première évaluation de chaque alerte à critère de rendement déjà
  évaluée avant ce moment (`last_evaluated_at` renseigné et antérieur) enregistre SANS notification les
  correspondances qui n'existaient pas avec le loyer départemental. Les ventes qui correspondaient déjà, les
  alertes sans rendement et les alertes créées ou modifiées depuis (`last_evaluated_at` nul) notifient comme
  avant. Les correspondances tues restent visibles dans la liste des correspondances de l'alerte.
- Retirer la variable ensuite.

## Reste à faire

- Le filtre « rendement minimal » de la page de recherche s'exécute dans le navigateur, sur des lignes
  qui n'ont ni le code commune ni accès à `anil_rents` : il utilise encore le loyer départemental. Les
  alertes, statistiques et exports, eux, utilisent la commune. Pour l'aligner : une colonne de loyer de
  référence dans la vue des ventes (après le stockage du code commune), ou un filtrage côté serveur.
- Le zonage tendu n'est lu par aucun écran. S'il est affiché, la mention est : « Source : ministère de la
  Transition écologique, liste des communes selon le zonage TLV (article 232 du code général des impôts),
  mise à jour du 30 décembre 2025 ; Licence Ouverte 2.0. »
- Les sources restent `pending` dans `data_sources` tant qu'une relecture juridique n'est pas enregistrée.
