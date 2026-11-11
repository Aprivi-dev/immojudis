# File de lecture des pièces : lot R6, première série (11/11/2026)

Note courte. Procédure d'exploitation : [runbook du vidage des pièces](../runbooks/vidage-des-pieces.md).
Série précédente : [post-mortem du 04/11/2026](2026-11-04-post-mortem-vidage-pieces.md).

## Constat (production, 11/11/2026, lecture seule)

La file des tâches `pdf` gaspillait sa capacité : 3 ventes relues en boucle prenaient 104 des 200
lectures terminées en 48 heures ; 62 tâches étaient en échec avec « PDF document checkpoint was not
persisted », dont 57 sur une vente au manifeste déjà complet ; 4 échecs venaient d'une valeur brute
écrite sans normalisation.

## Causes reproduites et correctifs livrés

| #   | Cause                                                                                                                                              | Correctif                                                                                                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | À chaque relecture complète, la valeur brute de l'instantané de la source (« libre », « 85,5 », « Lot 12 », « 45.000 ») était remise sur la vente. | L'instantané est relu par `normalize_sale` avec le contexte de la collecte (lot, drapeaux, titre, blocs) ; sans lot désigné, seule sa valeur explicite du champ, sinon vide (`src/pdf_fact_scope.py`).                       |
| B   | Chaque lecture terminée écrit une nouvelle empreinte, donc une tâche neuve que rien ne bornait.                                                    | Le vidage ne choisit pas une vente pour laquelle il a déjà demandé 2 lectures terminées en 24 heures (priorité du vidage ; `src/document_backlog.py`).                                                                       |
| C   | La lecture en avance rafraîchit les fichiers de suivi locaux ; jugée sur eux, la passe ne reprenait aucune pièce d'un manifeste de plus de 24 h.   | La péremption se juge sur la vérification enregistrée en base (`src/pdf_progress.py`).                                                                                                                                       |
| D   | Manifeste complet avec un lien mort, runner neuf : texte non restaurable, rien à lire, manifeste vide reconstruit, point d'étape refusé, échec.    | Si le manifeste contient une URL écartée, la tâche attend l'heure où la première vérification expire, sans essai consommé ; tout autre cas reste un échec (`src/pdf_pass_outcomes.py`).                                      |
| F   | Une vente sans aucun texte (pièces toutes écartées) n'avait jamais de version des faits : à relire à chaque vidage.                                | La version est posée dès que le manifeste d'une vente à pièces est complet (`src/pdf_enrichment.py`).                                                                                                                        |
| G   | Le motif d'un point d'étape refusé n'existait que dans le journal du worker.                                                                       | Un code suit le message dans `last_error` : `…retry required: no_progress_entries` (`src/storage/pdf_checkpoint_rules.py`).                                                                                                  |
| H   | Une écriture de fin de passe écartée (admission, révision déplacée) laissait la tâche « terminée » sans lecture enregistrée.                       | La tâche pdf échoue avec son code, un essai consommé. Refus d'admission : un essai par jour, puis `cancelled` en `review_required`, que le vidage ne réveille pas pendant 7 jours (1 jour à 7 jours ou moins de l'audience). |

Garde-fous vérifiés par des tests : une pièce nouvelle ou remplacée est lue, un texte perdu reste un échec
visible puis est relu à l'expiration de ses vérifications, une vente invalidée par une collecte repasse le
jour même, une tâche de la voie générale terminée sans passe ne fait pas attendre une pièce nouvelle.

## Limites connues

- **A remet la valeur de la collecte, ou rien.** Règle : restaurer ne fait jamais apparaître une valeur que
  la collecte n'aurait pas écrite pour la vente. L'instantané ne porte que 22 champs : relu seul, son texte
  est celui de toute la page, et un lot Licitor recevait la mise à prix, la surface ou les pièces d'un autre
  lot. Il est donc relu avec le contexte de la collecte, repris du `raw_payload` de la vente. Ce contexte
  est présent après une lecture de la fiche. Il ne l'est plus quand la collecte republie une vente connue
  sans relire sa fiche : `source_lot_selection`, `sale_timezone` et `source_lots` ne sont ni dans la
  projection des ventes connues (`src/storage/known_sale_projection.py`) ni dans les champs reportés
  (`src/main.py`). Dans ce cas, sur une annonce Licitor à plusieurs lots, seul ce que l'instantané porte
  pour le champ est remis, sans relire le texte de la page. Restent : un type de bien remis `other` au lieu
  du type lu par la collecte (1 cas sur les 3 216 ventes brutes des tests), et un instantané pris avant la
  lecture lot par lot (03/11/2026), qui porte les valeurs du premier lot sans qu'on puisse le reconnaître.
- **Constat hors lot, à mesurer : la collecte elle-même perd le lot.** Sur une vente Licitor à plusieurs lots
  republiée sans relecture de sa fiche, `normalize_sale` lit alors toute la page. Reproduit hors production
  avec le vrai code et une carte de liste écrite à la main ; requête 8 ci-dessous pour compter les ventes
  concernées. Correction dans `src/main.py` et `src/storage/known_sale_projection.py`, hors de ce lot.
- **L'attente d'une revue** dure 7 jours seulement si l'audience est à plus de 7 jours, 1 jour sinon. Elle
  tombe si les règles de lecture changent (la version est dans le message de la tâche) ou si une génération
  plus récente, non annulée, existe. La base ne connaît pas l'empreinte courante d'une vente : « génération
  courante » veut dire ici « aucune tâche pdf plus récente qui ne soit pas annulée ».
- **B ne borne que le vidage.** Une vente qui recrée une tâche après chaque lecture reste servie par la
  voie générale, vite si elle est à moins de 7 jours (correctif I).
- **H ne traite que la tâche pdf.** Une passe de faits de la même prise reste « terminée » alors que son
  écriture est écartée : appel au modèle payé, résultat non enregistré. C'était déjà le cas ; un test le
  constate (`test_known_limit_…` dans `tests/test_pdf_pass_outcomes.py`). À décider : la faire échouer
  rappelle le modèle à chaque essai (budget), ou vérifier l'admission avant l'appel.
- **D retient les passes de faits** de la vente jusqu'à l'échéance, 24 heures au plus (garde de la prise).
  Une vérification de lien mort plus ancienne que celles des pièces lues échoue encore (réglé par E).
- **N non livré** (annuler la tâche d'une vente dont toutes les sources sont retirées) : à la levée du
  retrait, la publication remet la même empreinte en file et l'insertion ne réveille pas une ligne annulée
  (`on conflict do nothing`). Une vente entièrement lue ne serait plus revalidée tant que ses pièces ne
  changent pas. Le report de 24 heures reste (15 tâches, sans téléchargement).

## Série suivante, dans l'ordre

1. **E** : restaurer le texte des pièces lues malgré une URL écartée. Supprime la plupart des attentes D.
2. **I** : ne pas créer de tâche pour un manifeste complet, frais et à la version courante. Sûr après E.
3. **K et J** ensemble : statuts des pièces illisibles, pièces d'une source retirée, liens morts au-delà de
   six pièces. K doit garder un chemin de revalidation pour les 404.
4. **N** par la fonction SQL `set_catalogue_source_withdrawal` (migration) : annuler, et réveiller à la levée.
5. **Décisions du propriétaire.** L : fraîcheur d'une pièce lue et inchangée à 7 jours, en gardant 24 heures
   pour les ventes à moins de 7 jours et pour les liens morts ou bloqués ; c'est ce qui vide les 140 tâches
   « sans travail ». Condition : **E avant L**, car l'attente D suit la même fenêtre et retiendrait les faits
   d'une vente jusqu'à 7 jours. M (migration) : vieillir plus vite les ventes lointaines dans la voie
   générale plutôt que supprimer le bonus de 168 heures ; à décider après les mesures.

## Mesures à refaire le lendemain de la mise en ligne (lecture seule)

```sql
-- 1. Lectures terminées par vente en 24 heures, par priorité. Attendu : 2 au plus à la priorité 40 (vidage) ;
--    une vente au-dessus à la priorité 30 est servie par la voie générale (correctif I).
select priority, lectures, count(*) as ventes
from (select source_url, priority, count(*) as lectures from public.auction_enrichment_jobs
      where job_type = 'pdf' and status = 'completed' and completed_at >= now() - interval '24 hours'
      group by 1, 2) t
group by 1, 2 order by 2 desc, 1 desc limit 30;

-- 2. Fins de passe en 24 heures, par code. Attendu : les 62 échecs « checkpoint » laissent place à des lectures,
--    à des attentes « PDF pass deferred » ou à des échecs qui disent leur code.
select status, left(coalesce(last_error, ''), 30) as debut,
       coalesce(substring(last_error from 'retry required: ([a-z_]+)'),
                substring(last_error from '\(([a-z_]+)[,)]')) as code, count(*)
from public.auction_enrichment_jobs
where job_type = 'pdf' and updated_at >= now() - interval '24 hours'
group by 1, 2, 3 order by 4 desc limit 40;

-- 3. Attentes « rien à lire » : aucune échéance ne doit dépasser 24 heures.
select count(*) as attentes, max(next_attempt_at - now()) as echeance_la_plus_lointaine
from public.auction_enrichment_jobs
where job_type = 'pdf' and status = 'queued' and last_error like 'PDF pass deferred:%';

-- 4. Écritures écartées : essais consommés, tâches passées en revue. Une même ligne ne doit pas dépasser 4 essais.
select status, attempt_count, substring(last_error from '\(([a-z_]+)[,)]') as code, count(*),
       min(created_at) as plus_ancienne, max(updated_at) as derniere_fin
from public.auction_enrichment_jobs
where job_type = 'pdf' and (last_error like 'PDF pass not recorded:%' or last_error like 'review_required:%')
group by 1, 2, 3 order by 4 desc limit 20;

-- 5. Passes de faits retenues par une tâche pdf (208 le 11/11).
select count(*) from public.auction_enrichment_jobs j
where j.job_type = 'fact_extraction' and j.status = 'queued'
  and exists (select 1 from public.auction_enrichment_jobs p
              where p.source_url = j.source_url and p.job_type = 'pdf' and p.status in ('queued', 'running', 'failed')
                and (p.status = 'running' or p.attempt_count < p.max_attempts));

-- 6. Ventes à venir au manifeste complet sans version des faits (45 le 11/11). Si le nombre remonte chaque jour,
--    une collecte efface la version : ces ventes reprennent des places du vidage.
select count(*) from public.auction_sales s
where s.status in ('active', 'upcoming', 'postponed', 'unknown') and (s.sale_date is null or s.sale_date >= now())
  and jsonb_array_length(s.documents) > 0
  and s.raw_payload->'document_analysis'->>'manifest_complete' = 'true'
  and s.raw_payload->>'document_facts_version' is null;

-- 7. Qui recrée la tâche des ventes encore relues (diagnostic révisé, sans identifiant).
with boucle as (
  select source_url from public.auction_enrichment_jobs
  where job_type = 'pdf' and status = 'completed' and completed_at >= now() - interval '48 hours'
  group by 1 having count(*) >= 5)
select (input_hash like 'pipeline_v2:%') as empreinte_python, priority, status, count(*) as taches,
       round(avg(extract(epoch from (created_at - fin_precedente)) / 60)) as minutes_apres_fin_precedente
from (select j.*, lag(completed_at) over (partition by source_url order by created_at) as fin_precedente
      from public.auction_enrichment_jobs j
      where job_type = 'pdf' and created_at >= now() - interval '48 hours'
        and source_url in (select source_url from boucle)) t
group by 1, 2, 3;

-- 8. Ventes Licitor à plusieurs lots dont le lot n'est plus désigné dans la vente brute enregistrée (lecture
--    seule). Pour elles, une valeur de pièce effacée n'est remplacée que par la valeur explicite de
--    l'instantané ; et la collecte, quand elle les republie sans relire la fiche, lit toute la page.
select count(*) as ventes_a_plusieurs_lots,
       count(*) filter (where not (s.raw_payload ? 'source_lot_selection')) as sans_lot_designe,
       count(*) filter (where not (s.raw_payload ? 'source_lot_selection')
                          and s.raw_payload ? 'source_factual_snapshot') as dont_avec_instantane
from public.auction_sales s
where s.source_name = 'licitor' and s.quality_flags ? 'multi_lot_sale'
  and s.status in ('active', 'upcoming', 'postponed', 'unknown') and (s.sale_date is null or s.sale_date >= now());
```

Lecture de la septième : un délai proche de 0 désigne l'écriture de fin de passe (correctif I), proche de
60 à 70 minutes le vidage suivant. Refaire aussi M1 (échecs pdf par famille) et M2 (tâches en attente) du
11/11. Ordre de grandeur attendu après un jour : 25 à 35 tâches pdf en échec au lieu de 86 (6 Vench et
9 Cessions de l'État qui échouent encore, tâches épuisées non candidates, 5 ventes sans manifeste).
