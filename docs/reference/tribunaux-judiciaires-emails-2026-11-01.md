# Tribunaux judiciaires et adresses email (fichier du 01/11/2026)

## Provenance

`tribunaux-judiciaires-emails-2026-11-01.csv` : **fourni par le propriétaire d'Immojudis le 01/11/2026**, tiré de
l'annuaire officiel de l'administration (Annuaire de l'administration, `lannuaire.service-public.gouv.fr`), d'après le
propriétaire (précision du 01/11/2026). C'est là qu'il faut revérifier une adresse avant de la corriger. Le fichier est
conservé tel quel (168 lignes, colonnes `ville`, `nom`, `emails`, `adresse`). Plusieurs adresses d'un même tribunal sont séparées par un point-virgule (Cayenne en a deux).

Contenu : 168 juridictions, 162 avec au moins une adresse (toutes en `@justice.fr`), 6 sans adresse (Angoulême, Argentan,
Béziers, Sarreguemines, Verdun, Saint-Pierre-et-Miquelon).

## Usage

Contact de **secours** d'une vente au tribunal (saisie immobilière ou autre vente judiciaire, jamais les notaires, les
cessions de l'État ni l'AGRASC) dont l'annonce ne donne aucun email d'avocat ou de cabinet exploitable :

- le pipeline n'écarte plus l'annonce faute d'email (preuve `court_email` de `services/data-pipeline/src/listing_minimum.py`) ;
- l'agent d'information peut écrire au greffe, dans ce seul cas (`src/lib/information-agent/court-registry.ts`).

Les adresses `@justice.fr` lues **dans une annonce** restent exclues : seule l'adresse de ce référentiel sert de secours.

## Chargement

Migration `supabase/migrations/20261110190000_court_registry_contacts.sql` : table privée `public.court_registry_contacts`
(RLS, aucun droit pour `anon` ni `authenticated`). Chaque ligne est rattachée au code de juridiction que le dépôt écrit dans
`auction_sales.tribunal_code` (code historique de l'application pour Agen, Bayonne, Bergerac, Bordeaux, Dax, Libourne,
Mont-de-Marsan, Pau et Périgueux ; `justice_tj_<origine>_<srj>` pour les autres), par le nom officiel du tribunal.
Le fichier a une seule désignation plus courte que le référentiel officiel : « Tribunal judiciaire de Saint-Denis » est
le tribunal de Saint-Denis de La Réunion (`justice_tj_1_217`), alias déjà connu de `court_competence.py`.

Pour corriger une adresse : mettre à jour ce fichier et ajouter une migration qui met à jour la ligne (jamais d'écriture
directe en production).
