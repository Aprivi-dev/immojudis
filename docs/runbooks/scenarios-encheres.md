# Scénarios d'enchères : cliché des lots et rattrapage

Les « Scénarios d'enchères » (offre Analyse : fiche d'une vente, onglet Statistiques) et le tableau de
comparaison des tribunaux lisent un **cliché** des lots Licitor attestés, pas la vue source. Ce runbook dit
d'où vient le cliché, comment vérifier qu'il est à jour et comment le rattraper. Toute écriture en base
décrite ici est une action du propriétaire (`service_role`), jamais d'un agent.

## Chaîne de lecture

1. `src/lib/auction-scenarios.server.ts` appelle, avec la clé `service_role`, les fonctions
   `public.get_court_auction_scenarios(p_court_code, p_starting_price)` (une vente) et
   `public.get_court_auction_summaries()` (tous les tribunaux). Le plan est contrôlé par l'appelant.
2. Ces fonctions lisent `app_private.auction_scenario_observation_snapshot` (migration
   `20261031100800`) : code du tribunal, type de bien, mise à prix, adjudication, date de vente, toutes
   années confondues. La fenêtre de trois ans est appliquée à la lecture. Aucune donnée personnelle.
3. Le cliché est une copie de la vue `app_private.auction_scenario_observations` (qui passe par la porte
   statistique et le rattachement des tribunaux). Sans cliché, la vue coûtait 3,5 à 6 s par appel pour un
   délai de 8 s : c'est la cause de l'ancien « Les statistiques du tribunal n'ont pas pu être chargées ».
4. L'état du cliché est dans `app_private.auction_scenario_snapshot_state` (une ligne : `refreshed_at`,
   `observation_count`).

## Qui remplit le cliché

`app_private.refresh_auction_scenario_observations(p_force boolean default true)` recopie la vue en entier
sous un verrou exclusif (les lectures voient l'ancienne copie jusqu'au `commit`). Elle est appelée :

- **par la collecte Licitor**, après chaque attestation
  (`services/data-pipeline/src/sources/licitor_history_refresh.py`, lancée par le planificateur après la file
  d'enrichissement) : forcée quand de nouveaux lots ont été attestés, sinon au plus une fois par jour (sans
  `p_force`, la fonction ne fait rien si la copie a moins d'un jour et renvoie `null`) ;
- **une fois par la migration `20261031100800`** elle-même, pour la première copie.

Le compte rendu de la collecte (`scenario_snapshot`) vaut `refreshed` (avec le nombre de lots), `skipped`
(copie de moins d'un jour) ou `error` : en cas d'erreur, l'ancienne copie est conservée et le code de sortie
de la collecte Licitor est noté dans `auction_runs.summary` (`licitor_history_exit_code`).

## Vérifier

En lecture seule (SQL Editor de Supabase, ou connexion `service_role`) :

```sql
select refreshed_at, observation_count, now() - refreshed_at as age
from app_private.auction_scenario_snapshot_state;

select count(*), min(sale_date), max(sale_date)
from app_private.auction_scenario_observation_snapshot;
```

- Pas de ligne dans `auction_scenario_snapshot_state` ou `observation_count = 0` : le cliché n'a jamais été
  rempli (ou la vue est vide) ; voir « Rattraper ».
- `age` de plus de quelques jours alors que la collecte tourne : la collecte Licitor est bloquée ou la copie
  échoue ; voir `docs/runbooks/licitor-collecte-bloquee.md`.
- Le nombre de lots du cliché doit rester proche de celui de la vue (même requête sur
  `app_private.auction_scenario_observations`, qui prend plusieurs secondes : hors heures de pointe).

## Symptômes

| Symptôme                                                              | Cause probable                                                                                                     | Où regarder                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| « Les statistiques du tribunal n'ont pas pu être chargées »           | erreur de la fonction RPC : `permission denied for function …`, délai dépassé, cliché absent                       | journaux Vercel de la route (`PostgrestError` : message et `code`) |
| `permission denied for function starting_price_band`                  | droit `service_role` manquant sur une fonction `app_private` appelée par une fonction non `security definer`       | migration `20261031100600` ; `npm run test:security-invariants`    |
| Scénarios vides pour un tribunal, tableau des tribunaux sans lignes   | cliché vide, ou moins de 10 lots pour ce tribunal (seuil du tableau)                                               | requêtes ci-dessus                                                 |
| Chiffres qui ne bougent plus alors que des adjudications sont tombées | copie de plus d'un jour non rafraîchie : collecte Licitor arrêtée, ou nouvelles adjudications pas encore attestées | `auction_runs.summary`, `licitor_history_exit_code`                |

Une fonction appelée par `service_role` qui n'est pas `security definer` s'exécute avec les droits de
l'appelant : chaque fonction `app_private` qu'elle appelle doit être accordée à `service_role` dans la
migration qui la crée (règle 8 de `supabase/README.md`).

## Rattraper (propriétaire)

Recopier la vue, immédiatement et sans attendre la collecte :

```sql
select app_private.refresh_auction_scenario_observations(true);
```

La fonction renvoie le nombre de lots copiés. Elle prend un verrou exclusif sur la table du cliché
pendant la copie mais ne bloque pas les lectures. Revérifier ensuite l'état (`refreshed_at`,
`observation_count`). Ne jamais éditer le cliché à la main : il se reconstruit toujours depuis la vue.

Après le rattrapage, ouvrir la fiche d'une vente d'un tribunal connu (`/sales/<id>`, onglet Statistiques) : les
scénarios doivent s'afficher.

## Fermeture

Le cliché est à jour (`age` de moins d'un jour, ou la collecte Licitor récente sans nouvelle attestation) et
les scénarios s'affichent. Si la cause était un défaut de migration ou de droit, la corriger par une nouvelle
migration (jamais en modifiant une migration appliquée) et la signaler au propriétaire.
