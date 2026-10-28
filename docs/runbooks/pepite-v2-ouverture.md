# Ouverture de la règle `pepite-v2` (`PEPITE_RULE_V2_ENABLED`)

La règle `pepite-v2` ajoute à `pepite-v1` un critère éliminatoire : le risque d'inondation. Elle est livrée
derrière un interrupteur serveur, **fermé par défaut**. Tant qu'il est fermé, la règle appliquée est
`pepite-v1`, `/admin/pepites` affiche « Règle pepite-v1 » et le traitement d'inondation s'alimente sans rien
changer. Ce runbook dit quand et comment l'ouvrir, et comment revenir en arrière. La description complète de
la règle et de son déploiement en deux temps est dans `docs/operations/planification.md`.

Public : le propriétaire. L'ouverture **écrit en production** (variable Vercel, redéploiement, réévaluation de
toutes les ventes).

Dernier essai : jamais (à dater après un essai en préproduction ou à blanc).

## Prérequis, tous mesurés par SELECT

À vérifier dans l'éditeur SQL de Supabase (lecture seule) avant de décider.

1. **Couverture complète** : toutes les ventes à venir ont un verdict.

   ```sql
   select verdict, count(*) from public.auction_sale_flood_risk group by 1 order by 2 desc;
   ```

   Comparer le total au nombre de ventes à venir (`upcoming` dans le résumé du dernier passage de
   `sale-flood-risk`, `select summary->>'upcoming' from public.operational_job_runs where job_name =
'sale-flood-risk' and status = 'success' order by started_at desc limit 1;`).

2. **Presque aucun « inconnu » dû à une panne**, sur au moins 10 passages consécutifs :

   ```sql
   select count(*) as inconnus_par_panne
   from public.auction_sale_flood_risk
   where verdict = 'unknown'
     and (last_failure like 'network%' or last_failure like 'http\_%' or last_failure = 'timeout');
   ```

   Tant que les `network_*` persistent (voir `docs/runbooks/georisques-pannes-inondation.md`), ne pas ouvrir
   (décision du fondateur).

3. **Passages en succès** : les dix derniers passages de `sale-flood-risk` et de `sale-pepites` sont en
   `success`.

   ```sql
   select job_name, started_at, status from public.operational_job_runs
   where job_name in ('sale-flood-risk', 'sale-pepites') order by started_at desc limit 20;
   ```

4. **Calibration relue** à la main sur le catalogue réel (compte-rendu `docs/equipe/2026-10-26-pepite-v2-inondation-loyers.md`).
5. **Documents à jour** avant le premier appel réel : registre des traitements
   (`docs/rgpd-processing-register.md`), matrice de conservation (`docs/data-retention-matrix.md`), politique de
   confidentialité et mentions légales décrivent l'envoi des coordonnées d'une vente à Géorisques et à l'API
   Carto.
6. **Position « rue »** : la question du tampon de 100 m est à trancher (proposition n° 39 du compte-rendu du
   27/10/2026) avant l'ouverture.

## Test sans risque

- En local ou en préproduction : `PEPITE_RULE_V2_ENABLED=true`, puis
  `npx vitest run src/lib/pepite-policy src/lib/sale-pepites-batch`.
- En production, la lecture seule : `/admin/pepites` affiche « Règle pepite-v1 » tant que l'interrupteur est
  fermé, et les compteurs ne bougent pas.

## Ouverture (dans cet ordre)

1. **Pull request** : renseigner la constante `PEPITE_V2_EFFECTIVE_DATE` (c'est une constante TypeScript, pas
   une variable d'environnement) dans `src/app/methode-pepites/method.ts`, en toutes lettres (« 27 novembre
   2026 »), et mettre à jour `src/app/methode-pepites/page.test.tsx` dans la même PR. Fusionner.
2. **Vercel > Production** : poser `PEPITE_RULE_V2_ENABLED=true` (`true` ou `1` ouvrent ; toute autre valeur ou
   l'absence ferment).
3. **Redéployer** : Vercel n'applique une variable qu'à un nouveau déploiement.
4. Contrôler que `/admin/pepites` affiche « Règle pepite-v2 ».

Constantes qui ne sont pas des variables : `PEPITE_EXTREME_START_RATIO_MIN` (0,1) et
`PEPITE_EXTREME_START_RATIO_MAX` (1,5) sont dans `src/lib/pepite-policy.ts` ; les changer crée une nouvelle
version de règle.

## Ce qui change à l'ouverture

- Toutes les ventes sont réévaluées, les pépites déjà publiées en premier.
- Un risque **élevé** (`high`) fait sortir une pépite publiée immédiatement.
- Un verdict **inconnu** empêche l'entrée d'une nouvelle pépite, mais ne fait jamais sortir une pépite publiée.
- Un verdict « exposé » (périmètre d'un PPRi) n'exclut pas : la fiche affiche « zonage à vérifier ».
- La page `/methode-pepites` décrit la règle `pepite-v2`.

## Vérifier

```sql
select rule_version, status, count(*) from public.auction_sale_pepites group by 1, 2 order by 1, 2;
```

- Au fil des passages horaires (:35), les lignes passent de `pepite-v1` à `pepite-v2`.
- Le dernier passage de `sale-pepites` est en `success`.
- `/methode-pepites` décrit `pepite-v2` et la date d'entrée en vigueur.

## Retour arrière

- **Normal** : retirer la variable (ou la passer à `false`) et redéployer. La règle `pepite-v1` est rejouée
  telle quelle ; les pépites sorties pour risque élevé redeviennent éligibles à l'évaluation suivante. Le
  traitement d'inondation peut continuer à tourner.
- **Urgence** : tout retirer du public avec `docs/runbooks/pepites-arret-urgence.md`.
