# Extraction par source et règle « informations suffisantes » — 2026-10-10

Demande du propriétaire : *revoir la manière dont on récupère les informations selon les sources (elles ne sont pas
aux mêmes endroits) ; si l'on n'obtient ni l'adresse ni la superficie et qu'il n'y a pas d'e-mail pour interroger
l'agent IA d'information, alors la vente n'a pas à être conservée.*

Ce document est le résultat des trois phases : diagnostic (lecture seule), correctifs d'extraction, règle de
rétention. **Aucune écriture en production n'a été faite** : toutes les mesures viennent de requêtes `SELECT` sur la base
de production le 2026-10-10 (la base bouge : le nombre de ventes sans adresse d'avoventes est passé de 14 à 1 pendant la
session, le total de 2 828 à 2 826).

> **Données personnelles.** Ce document ne contient ni e-mail, ni nom de personne, ni téléphone, ni adresse précise
> réelle. Il décrit des *structures* (clé JSON, motif de texte, position dans la page). Les exemples sont fictifs.

## 1. Résumé

1. **Le diagnostic confirme l'intuition du propriétaire pour deux sources seulement.**
   `encheres_immobilieres` (bug d'extraction : la valeur lue après le libellé « Adresse du bien » est le prix) et
   `avoventes` (la carte de liste, qui ne donne que « code postal + commune », écrase la rue trouvée dans la
   description). `cessions_etat` n'a *par construction* aucune adresse postale, mais une commune, une référence
   cadastrale et parfois une voie ou un lieu-dit dans le texte.
2. **Pour les autres sources l'information n'est pas sur la page publique.** `vench` : la page affiche *« Vous devez
   être abonné pour consulter le descriptif de cette vente »* (paywall) ; `petites_affiches` : détail « restricted »
   (réservé aux abonnés) pour la majorité des ventes, adresse limitée à la commune ; `licitor` : la superficie n'est
   jamais dans le descriptif de lot (elle est dans le cahier des charges, absent pour 151 des 157 ventes sans surface).
   Aucun correctif d'extraction ne peut y créer l'information : ce sont les ventes qui seront non conservées.
3. **La règle de rétention est implémentée mais son effet est très large** (voir §6) : avec la définition demandée de
   l'« adresse exploitable » (voie, lieu-dit ou parcelle, pas seulement la commune), **1 627 ventes sur 2 826 (58 %)**
   sont aujourd'hui insuffisantes, dont `vench` (535/538) et `petites_affiches` (849/969) presque entières, car ces deux
   sources ne donnent que la commune et n'ont aucun e-mail. Si la commune seule suffit, on tombe à **926 (33 %)**.
   **C'est la décision à prendre avant de laisser la porte active en production** (§8).
4. **Rien n'est supprimé.** La porte empêche seulement la publication de *nouvelles* ventes insuffisantes. Pour
   l'existant : rapport SQL (ids) + `recompute_scoring --drop-insufficient` (rapport par défaut, suppression explicite,
   sans tombstone, ventes liées à des utilisateurs protégées).

## 2. Où se trouve l'information, source par source

Légende « manquant » : ventes de la base de production au 2026-10-10 (tous statuts), colonne vide ou valeur sans voie.
« Lu aujourd'hui » : ce que l'extracteur renseignait avant ce travail.

### 2.1 Adresse

| Source | Où est l'adresse sur la page | Lu aujourd'hui | Manquant (colonne `address`) | Correctif |
| --- | --- | --- | --- | --- |
| `encheres_immobilieres` | Page détail, bloc « Adresse du bien ». Les **libellés sont rendus avant leurs valeurs** : `Mise à prix` / `Adresse du bien` / *prix* / *mentions de procédure* / *voie* / `,` / *code postal* / *commune* / `Date de mise en vente`… | La ligne qui suit le libellé : **le prix** (« 30 000 € »), rejeté ensuite comme valeur monétaire → `address` nul | 141/168 (84 %) | Ancrage sur la ligne `,` + code postal ; la ligne précédente doit ressembler à une voie. 82 ventes ont le bloc, **77 (+1 « montée ») récupérables** ; 59 autres sont des cartes de liste sans page détail (rien à lire) |
| `avoventes` | Début de la description : `à COMMUNE (CP) 13 rue X de 70,20 m²…`, `situés 119, Route X`, parfois `« Résidence » - 126-132 avenue X` | La carte de liste (`CP Commune, France`) ; la rue de la description n'était appliquée que « si la carte n'avait rien », donc jamais ; et elle était mal coupée (« …rue X de 70 », « …rue Haute Sur un terrain ») | 1/173 vide, **21 commune seule** | La rue de la description remplace la carte quand celle-ci est communale ; coupe avant la surface, les débuts de phrase et les plages de numéros ; recalcul sur l'existant par `normalize_sale`. ≈ 7 à 12 récupérables (21 → 9 à 14 communales) |
| `cessions_etat` | **Aucune adresse postale.** Commune (`.location-text`), code INSEE, **référence cadastrale** (tuile « Référence(s) cadastrale(s) », 188/237), voie ou lieu-dit parfois dans le titre/la description | Commune seulement ; `address` toujours nul | 237/237 | Pas d'adresse inventée : la *désignation du bien* (parcelle, lieu-dit, voie du texte) est lue par `information_sufficiency` et compte comme adresse exploitable (§4). 223/237 ont une désignation |
| `licitor` | Bloc `.AddressBlock .Location .Street` ; à défaut la ligne qui suit la commune | Idem, **mais la ligne suivant la commune peut être le bloc de l'avocat/commissaire de justice** (5 ventes avec un cabinet comme « adresse ») | 2/433 vides, 36 sans voie, dont 5 cabinets et une quinzaine de *lieux nommés* (« Le Hameau Exemple, Commune ») | Garde-fou sur la ligne ; un bloc cabinet/tribunal stocké comme adresse est rejeté au recalcul ; « lieu nommé, commune » reconnu comme lieu-dit |
| `petites_affiches` | **Commune seule** (page « restricted » pour la plupart) ; « Lieu de Vente » = adresse du **tribunal**, « Avocat Poursuivant » = cabinet | Commune | 34/969 vides, **740 communales** | Aucun : la rue du bien n'est pas publiée. Test négatif : l'adresse du tribunal n'est jamais prise |
| `vench` | **Commune seule** (code postal + commune) ; descriptif réservé aux abonnés | Idem | 0 vide, **537/538 communales** | Aucun (paywall) |
| `agrasc` | Pas d'adresse publique (vente par opérateurs) | — | 2/8 | Aucun |
| `notaires`, `info_encheres`, `encheres_publiques` | Champs structurés | Corrects | 0 vide ; quelques lieux nommés (« Les Prés Exemple, CP Commune ») | Lieu nommé reconnu comme lieu-dit |

### 2.2 Superficie

| Source | Où est la surface | Manquant | Constat / correctif |
| --- | --- | --- | --- |
| `petites_affiches` | Texte du détail, seulement quand la page n'est pas « restricted » | 496/969 (51 %) | Détail restreint pour la majorité ; 9 textes contiennent un « m² » mais ce sont des **bandeaux d'actualités** du site (« local commercial de 1 273 m² à… ») : volontairement exclus. **0 récupérable** |
| `vench` | Descriptif (paywall) | 244/538 | « Vous devez être abonné… ». **0 récupérable** |
| `licitor` | Cahier des charges (PDF) ; presque jamais dans le descriptif de lot | 157/433 | 6 ventes avec document. 2 formulations récupérables (« surface globale d'environ… »). Le reste n'est pas sur la page |
| `avoventes` | Description (`(55,31 m²)` après le nombre de pièces), PDF | 27/173 | 27 ont un document mais seuls 15 sont analysés : **12 PDF à analyser** (réseau). 1 à 2 récupérables dans le texte |
| `encheres_immobilieres` | Titre/description (« CHALET de 180 m² », « certificat de mesurage… superficie de 58,04 m² ») | 23/168 | 2 récupérables. Plusieurs ventes n'ont que des *contenances cadastrales* (a/ca) : c'est la parcelle, pas la surface du bien |
| `info_encheres` | Description / PDF | 12/53 | 10 avec document, 2 analysés : **8 PDF à analyser** ; 8 ont une contenance cadastrale (non comptée) |
| `notaires`, `cessions_etat`, `agrasc`, `encheres_publiques` | Champs structurés | ≤ 3 | Rien à faire |

Les formulations ajoutées n'acceptent qu'**une valeur distincte** dans le texte (sinon : lot multiple, on s'abstient)
et ignorent `petites_affiches` et `vench`.

### 2.3 Contact e-mail (pour l'agent IA d'information)

| Source | Où est l'e-mail | Ventes avec e-mail exploitable |
| --- | --- | --- |
| `cessions_etat` | `source_blocks.gestionnaire_email` (bouton « contact » de l'annonce, `data-contacts`) | 235/237 |
| `notaires` | colonne `lawyer_contact` | 218/224 |
| `encheres_immobilieres` | texte de la page (`source_blocks.page_text`, bloc de l'avocat) | 104/168 |
| `info_encheres` | blocs de l'avocat | 16/53 |
| `avoventes`, `agrasc`, `encheres_publiques`, `licitor` | rarement | 3, 1, 1, 1 |
| `petites_affiches`, `vench` | **jamais** (téléphone seulement / rien) | 0 |

Aucune adresse de site (bandeau, pied de page) n'est ramassée : les adresses partagées par plusieurs ventes sont celles
d'un même cabinet, d'une même étude ou d'un même service gestionnaire.

## 3. Correctifs d'extraction (Phase 2)

| Correctif | Fichiers | Tests (fixtures fictives) |
| --- | --- | --- |
| `encheres_immobilieres` : adresse du bien (libellé avant valeur), sans repli sur le texte libre quand le bloc existe (il contient l'adresse de l'avocat et du tribunal) ; ancien gabarit « valeur sur la ligne suivante » conservé | `listing_location.extract_adresse_du_bien`, `sources/encheres_immobilieres.py` | `tests/test_listing_location.py` |
| Recalcul de l'existant sans re-scraper : `normalize_sale` relit `source_blocks.page_text` | `listing_location.recover_listing_address`, `normalize.py` | idem |
| `avoventes` : rue de la description > carte « CP Commune » ; coupe propre (surface, début de phrase, plage `126-132`, `119, Route`) | `sources/avoventes.py` | idem |
| Prix ou bloc cabinet/tribunal dans le champ adresse → rejeté avec preuve (`invalid_address_evidence`), coordonnées déduites retirées | `listing_location.reject_monetary_address`, `sources/licitor.py` | idem |
| Superficies du texte libre : `(55,31 m²)` après les pièces, `CHALET de 180 m²`, `certificat de mesurage… superficie de`, `surface globale d'environ` | `surface_text_recovery.py`, `normalize.py` | `tests/test_surface_text_recovery.py` |

### Gain estimé (ventes sans adresse exploitable / sans superficie récupérables)

Mesuré par requêtes SQL sur les textes stockés (le Python n'a pas pu être rejoué sur la production : pas d'accès
direct à la base, réseau fermé) ; statuts terminés exclus. Le gain *Python* est du même ordre, parfois un peu supérieur.

| Source | Ventes actives | Sans adresse exploitable avant | Récupérées | Sans surface avant | Récupérées |
| --- | ---: | ---: | ---: | ---: | ---: |
| encheres_immobilieres | 146 | 145 | **64 à 78** | 26 | 2 |
| avoventes | 141 | 21 | **7 à 12** | 35 | 1 |
| cessions_etat | 64 | 64 (par construction) | **62** (désignation) | 0 | 0 |
| licitor | 422 | 36 (dont 5 cabinets, ≈ 15 lieux nommés) | 0 (5 cabinets écartés, ≈ 15 lieux nommés reconnus) | 159 | 2 |
| petites_affiches | 968 | 787 | 0 | 495 | 0 |
| vench | 536 | 536 | 0 | 247 | 0 |
| info_encheres / notaires / encheres_publiques / agrasc | 38 / 222 / 22 / 7 | 6 / 5 / 4 / 2 | 0 | 14 / 2 / 1 / 0 | 0 |

## 4. Règle de rétention (Phase 3)

Une vente est **conservée** si (adresse exploitable **et** superficie) **ou** un e-mail exploitable existe.
Elle est **non conservée** si (adresse exploitable manquante **ou** superficie manquante) **et** aucun e-mail exploitable.

* **Adresse exploitable** : une commune ou un code postal **et** une désignation du bien : voie (avec ou sans numéro),
  lieu-dit / lieu nommé, ou parcelle cadastrale. La commune seule n'est pas exploitable. Réglage
  `IMMOJUDIS_SUFFICIENCY_MIN_ADDRESS=commune` pour l'accepter. Pour `cessions_etat` : référence cadastrale, ou voie /
  lieu-dit / section cadastrale citée dans le titre ou la description. Le texte libre n'est lu que pour les sources
  dont le texte est propre au bien (`cessions_etat`, `avoventes`, `licitor`, `notaires`, `agrasc`,
  `encheres_publiques`, `info_encheres`) : jamais pour `encheres_immobilieres` (description = avocat), `petites_affiches`
  (tribunal, actualités) ni `vench`.
* **Superficie** : surface bâtie, habitable, Carrez ou de l'application ; pour un terrain (`land`, et `mixed`/`other`
  inconnus) la surface du terrain compte ; **un parking n'a pas besoin de superficie** ; une maison avec seulement une
  surface de terrain n'est pas jugée suffisante.
* **E-mail exploitable** : une adresse que `discoverInformationAgentContacts` (`src/lib/information-agent.ts`) trouve
  dans la vente — `lawyer_contact`, valeurs de clés d'objet de `source_blocks` (une chaîne directement dans un tableau
  est ignorée par le résolveur), `source_blocks` de chaque observation, `raw_payload.source_description`, `description` —
  avec la même extraction et la même validation (zod 3.25), **moins** les adresses du registre
  `information_agent_contacts` en opposition ou en rebond permanent (portée globale ou propre à la vente). Il n'existe
  pas de liste de domaines interdits dans le code de l'agent (seule la boîte de test `delivered@resend.dev` est
  encadrée). Un e-mail de confiance « faible » (texte libre) compte : l'agent le propose à l'administrateur, qui choisit.
* **Réutilisation du même résolveur.** Il n'existe qu'en TypeScript. Le miroir Python
  (`information_sufficiency.contact_emails`) est gardé identique par des **cas partagés**
  (`tests/fixtures/information_agent_contact_cases.json`) exécutés par pytest *et* par vitest
  (`src/lib/information-agent-contact-parity.test.ts`). Ce test a d'ailleurs détecté une divergence pendant le travail
  (les chaînes d'un tableau sont ignorées par le résolveur).
* **Exemptions** (jamais jugées) : `past`, `adjudicated`, `cancelled`, `withdrawn` (conservées pour les statistiques,
  comme aujourd'hui : la rétention existante les archive dans le graphe de résultats puis les supprime à l'échéance) et
  `quarantined` (en revue). La rétention existante, les tombstones et le calcul d'échéance ne sont pas modifiés.

### Branchement dans le pipeline

`admission.publication_rejection / admit_sales / split_insufficient` sont appelées par la publication précoce, l'admission
finale, la publication progressive, le point de reprise d'enrichissement et le garde des LLM payants. Une vente rejetée :
n'est pas écrite dans `auction_sales`, est journalisée avec un **code** de motif (`insufficient_information:missing_address`,
`…missing_surface`, `…missing_address+missing_surface`) sans aucune donnée de la vente, et apparaît dans le résumé du run :
`admission_rejected_insufficient_information = {total, by_reason, by_source}`.
Interrupteurs : `IMMOJUDIS_INFORMATION_SUFFICIENCY_GATE=off`, `IMMOJUDIS_SUFFICIENCY_MIN_ADDRESS=commune`.
Le registre de refus est lu une fois par run (échec **ouvert** : une panne du registre ne fait pas perdre de vente).

Conséquence à connaître : une vente déjà publiée qui devient insuffisante n'est plus rafraîchie par le run (elle reste
en place, non mise à jour, jusqu'à son échéance ou à la suppression contrôlée).

## 5. Rapport SQL (lecture seule) — ids par source

Fichier : `services/data-pipeline/sql/insufficient_information_report.sql` (un seul `SELECT`, aucune écriture, testé
contre PostgreSQL 16 : `tests/test_insufficient_report_sql.py` compare ses verdicts à ceux de la règle Python sur 14
ventes fictives). La dernière colonne `insufficient_ids` liste les identifiants par source. C'est une **approximation
volontairement permissive** (elle sous-liste plutôt qu'elle ne sur-liste) ; la référence est la commande ci-dessous.

```text
python -m src.recompute_scoring --drop-insufficient [--source licitor] [--drop-report rapport.json]
```

Elle rejoue les extracteurs sur les lignes stockées, applique la règle, écrit un JSON d'identifiants et de compteurs
(sans donnée personnelle) et **ne supprime rien**. Pour supprimer : relire le rapport puis ajouter `--execute-drop`
(plafond `--max-deletions`, 100 par défaut ; `--include-user-linked` pour lever la protection).

Suppression (`src/insufficient_sales.py`), par lots de 25 dans une transaction, sous le verrou de rétention : pont du
graphe de résultats (un trigger l'exige avant tout `DELETE`), file de nettoyage du stockage, `valuation_estimates`,
`information_agent_missions`, `lawyer_placement_events`, `lawyer_referral_requests`, `auction_observations`, puis
`auction_sales` (les autres tables cascadent ou passent à `NULL`). **Aucun tombstone** : l'URL reste réimportable dès que
la vente devient suffisante. Une vente modifiée depuis l'évaluation est ignorée. Les ventes liées à des favoris,
rapports, espaces de travail, annotations, analyses, dossiers/missions de l'agent ou demandes d'avocat sont protégées.

## 6. Effet par source (production 2026-10-10, estimé)

« Insuffisantes » = non conservées par la règle, hors statuts exemptés. *Avant* = règle appliquée aux données stockées
sans les correctifs ; *après* = avec les correctifs d'extraction.

| Source | Total | Exemptées | Conservées (après) | **Insuffisantes — voie/lieu-dit/parcelle exigé** avant → après | **Insuffisantes — commune suffit** avant → après |
| --- | ---: | ---: | ---: | ---: | ---: |
| agrasc | 8 | 1 | 6 | 2 → 1 | 0 → 0 |
| avoventes | 173 | 32 | 109 | 49 → 32 | 33 → 32 |
| cessions_etat | 237 | 173 | 64 | 1 → 0 | 0 → 0 |
| encheres_immobilieres | 168 | 22 | 106 | 57 → 40 | 13 → 12 |
| encheres_publiques | 23 | 1 | 21 | 4 → 1 | 1 → 1 |
| info_encheres | 53 | 15 | 27 | 11 → 11 | 10 → 10 |
| licitor | 433 | 11 | 264 | 164 → 158 | 154 → 152 |
| notaires | 224 | 2 | 222 | 0 → 0 | 0 → 0 |
| petites_affiches | 969 | 1 | 119 | 850 → 849 | 488 → 488 |
| vench | 538 | 2 | 1 | 535 → 535 | 231 → 231 |
| **Total** | **2 826** | **260** | **939** | **1 673 → 1 627** | **930 → 926** |

Lecture :

* Les correctifs d'extraction sauvent **peu de ventes au sens de la règle** (≈ 46) : la plupart des adresses
  récupérées d'`encheres_immobilieres` concernaient des ventes déjà sauvées par leur e-mail (104/168). Leur intérêt est
  la qualité de la donnée affichée et géocodée, pas la rétention.
* L'écart entre les deux colonnes de droite est l'effet de l'exigence « voie / lieu-dit / parcelle » : 700 ventes,
  presque toutes `petites_affiches` (361) et `vench` (304).
* Dans les deux colonnes, **la cause dominante est l'absence de superficie sans e-mail** : `licitor` (≈ 150),
  `petites_affiches` (≈ 480), `vench` (≈ 230), `avoventes` (32, dont 12 avec PDF à analyser), `info_encheres` (10, dont 8
  avec PDF à analyser).
* Toutes les ventes insuffisantes sont aujourd'hui `upcoming/unknown/postponed` : aucune n'est « passée ».

## 7. Effet sur le catalogue, les favoris et les alertes

* **Catalogue public** : les ventes supprimées disparaissent du site (liste, carte, fiche, sitemap) ; leur URL de fiche
  répond 404. Avec la porte active, les *nouvelles* ventes insuffisantes n'apparaissent pas.
* **Favoris** : `user_favorites.sale_id` est en `ON DELETE CASCADE` : le favori disparaît **sans aucune information** pour
  l'utilisateur. À la date de mesure : 0 favori, 1 alerte (27 correspondances), 2 rapports enregistrés, 0 espace de
  travail. C'est pourquoi les ventes liées sont **protégées** par défaut dans la suppression contrôlée.
* **Alertes** : `user_alert_matches` / `user_alert_notifications` partent en cascade ; une alerte déjà notifiée ne peut
  plus pointer vers la fiche.
* **Proposition (non implémentée)** : avant toute suppression, écrire pour chaque utilisateur concerné une ligne
  `user_sale_removal_notices` *sans clé étrangère* vers `auction_sales` (titre, commune, motif « informations
  insuffisantes », date), l'afficher dans le centre de notifications et la mentionner dans le prochain e-mail
  d'alerte ; `user_sale_change_events` ne convient pas (clé étrangère en cascade, pas de type d'événement « retirée »).
  Alternative sans suppression : masquer la vente du catalogue (`catalogue_quarantined`) tout en la gardant pour ses
  suiveurs, jusqu'à la date de vente.

## 8. Décisions à prendre et risques

1. **Niveau d'adresse exigé** (§1.3, §6). Avec « voie / lieu-dit / parcelle » (défaut, conforme à la demande),
   `vench` et `petites_affiches` n'alimentent plus le catalogue ; avec `…MIN_ADDRESS=commune`, seules les ventes sans
   superficie *et* sans e-mail sont écartées. **À arbitrer avec le propriétaire avant déploiement**, ou couper la porte
   (`IMMOJUDIS_INFORMATION_SUFFICIENCY_GATE=off`) le temps de décider. Le propriétaire a relevé que
   `vench` n'avait « aucune adresse manquante » : il comptait probablement la commune comme adresse.
2. **Superficies.** La perte la plus lourde vient de sources qui ne publient pas la surface (`licitor` ≈ 150). Leviers :
   analyser les PDF (`avoventes` 12, `info_encheres` 8, `licitor` 6), ou accepter de garder `licitor` avec adresse sans
   superficie (changement de règle).
3. **Surveillance des e-mails.** Le résolveur compte aussi les e-mails de faible confiance du texte libre ; un e-mail
   qui ne désigne pas l'interlocuteur de la vente suffit alors à conserver. Le test de parité protège la cohérence avec
   l'agent, pas la pertinence de l'adresse.
4. **Ventes déjà publiées qui deviennent insuffisantes** : plus rafraîchies (§4).
5. **Non testé** : rejeu des extracteurs sur la base réelle (pas d'accès direct, un script de simulation aurait exigé
   d'exfiltrer ~100 Mo de payloads) ; scraping réel (réseau fermé) ; la suppression contre la vraie base (le test PostgreSQL
   jetable utilise un schéma minimal et un pont simulé — le trigger réel `require_outcome_bridge_before_auction_sale_delete`
   et `bridge_auction_sales_to_outcome_graph_batch` n'ont pas pu être exécutés) ; `npx vitest run` complet.
6. **Taille des fichiers** : `normalize.py` et `main.py` sont exactement à leur plafond du budget P6-05 ; toute la
   logique neuve est dans des modules neufs (`listing_location`, `surface_text_recovery`, `information_sufficiency`,
   `insufficient_sales`).
