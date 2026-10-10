# Données de référence : risques environnementaux et historique météo

Mise à jour : 2026-10-10.

## Pourquoi

Les blocs « Risques environnementaux » et « Historique météo » d'une annonce ne
fonctionnaient pas :

- l'historique météo dépendait de Meteostat via RapidAPI (clé, quota de
  500 appels par mois). En production, le cache ne contenait que deux réponses,
  toutes deux en erreur (« Réponse Meteostat inexploitable ») : aucun visiteur n'a
  jamais vu de relevé ;
- les risques reposaient sur un widget tiers (ClimaScore) chargé dans une iframe,
  soumis à la CSP et à la disponibilité du script externe.

Les deux blocs lisent désormais des tables Supabase alimentées par des données
publiques officielles. Aucun service tiers n'est appelé pendant qu'un visiteur
attend, à deux exceptions bornées (2,5 s, avec repli local) : le code INSEE
d'une annonce géolocalisée est demandé à geo.api.gouv.fr (mis en cache 30 jours),
et la zone sismique et le potentiel radon d'une commune sont lus une fois sur
l'API Géorisques puis stockés.

## Sources

| Table | Source | Licence | Volume |
| --- | --- | --- | --- |
| `reference_communes` | geo.api.gouv.fr (communes, codes postaux, centre) | Licence Ouverte | ~35 000 |
| `commune_risk_profiles` | Base GASPAR, `files.georisques.fr/GASPAR/gaspar.zip` : risques du DDRM, arrêtés CatNat, PPRN/PPRT/PPRM opposables ou prescrits | Licence Ouverte | ~35 000 |
| `climate_stations`, `climate_station_months` | Météo-France, données climatologiques de base mensuelles (`object.files.data.gouv.fr/meteofrance/.../MENS/`), depuis janvier 2016 | Licence Ouverte Etalab 2.0 | ~2 000 stations actives |

Les mois incomplets (moins de 80 % des jours mesurés) et les valeurs marquées
« douteuses » (code qualité 2) sont écartés à l'import.

Les quatre tables sont privées : RLS active, aucun droit pour `anon` ni
`authenticated`, lecture par le serveur uniquement (`service_role`).

## Mise à jour

Workflow manuel **Reference data import** (`.github/workflows/reference-data-import.yml`) :

- `dataset` : `all`, `communes`, `risks` ou `climate` ;
- `dry_run` : télécharge et analyse sans écrire.

Fréquence conseillée : mensuelle (GASPAR est republié chaque semaine,
Météo-France chaque mois). L'import refuse d'écrire si la source paraît tronquée
(moins de 30 000 communes, moins de 90 départements météo).

En local : `cd services/data-pipeline && python -m src.reference_data all --dry-run`.

## Affichage

- **Risques** (gratuit, route publique `GET /api/sales/{id}/risks`) : commune
  résolue depuis les coordonnées, puis le code postal et le nom, puis le centre de
  commune le plus proche ; liste des risques par famille, zone sismique, potentiel
  radon, plans de prévention, arrêtés CatNat. Les coordonnées de l'annonce ne
  sortent jamais du serveur. Le texte rappelle que l'état des risques annexé au
  cahier des conditions de vente fait foi pour la parcelle.
- **Météo** (offre Analyse, route `GET /api/sales/{id}/weather`) : station
  Météo-France la plus proche pour chaque mesure (températures dans un rayon de
  40 km, pluie 30 km, ensoleillement 70 km), dernière année complète, comparaison
  avec la moyenne 2016 à l'année précédente. Sans coordonnées, le centre de la
  commune sert de point de départ, et la page le précise.

## Reste à faire

- La table `meteostat_monthly_cache`, la fonction `consume_meteostat_monthly_quota`
  et la variable Vercel `METEOSTAT_RAPIDAPI_KEY` ne servent plus ; elles peuvent
  être supprimées dans un lot ultérieur.
