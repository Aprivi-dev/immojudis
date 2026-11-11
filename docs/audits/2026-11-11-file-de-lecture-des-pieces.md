# File de lecture des pièces : lot R6, première série (11/11/2026)

Note courte. Procédure d'exploitation : [runbook du vidage des pièces](../runbooks/vidage-des-pieces.md).
Série précédente : [post-mortem du 04/11/2026](2026-11-04-post-mortem-vidage-pieces.md).

## Constat (production, 11/11/2026, lecture seule)

La file des tâches `pdf` gaspillait sa capacité : 3 ventes relues en boucle prenaient 104 des 200
lectures terminées en 48 heures ; 62 tâches étaient en échec avec « PDF document checkpoint was not
persisted », dont 57 sur une vente au manifeste déjà complet ; 4 échecs venaient d'une valeur brute
écrite sans normalisation.

## Causes reproduites et correctifs livrés

| #   | Cause                                                                                                                                                 | Correctif                                                                                                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | À chaque relecture complète, la valeur brute de l'instantané de la source (« libre », « 85,5 ») était remise sur la vente.                            | Valeur lue comme la collecte la lit : occupation normalisée, décimal par l'analyseur du champ, vide si illisible (`src/pdf_fact_scope.py`).       |
| B   | Chaque lecture terminée écrit une nouvelle empreinte, donc une tâche neuve que rien ne bornait.                                                       | Le vidage ne choisit pas une vente qui compte 2 lectures terminées en 24 heures (`src/document_backlog.py`).                                      |
| C   | La lecture en avance rafraîchit les fichiers de suivi locaux ; jugée sur eux, la passe ne reprenait aucune pièce d'un manifeste de plus de 24 heures. | La péremption se juge sur la vérification enregistrée en base (`src/pdf_progress.py`).                                                            |
| D   | Manifeste complet avec un lien mort, runner neuf : texte non restaurable, rien à lire, manifeste vide reconstruit, point d'étape refusé, échec.       | La tâche attend l'heure où la première vérification expire, sans essai consommé, et le manifeste n'est pas remplacé (`src/pdf_pass_outcomes.py`). |
| F   | Une vente sans aucun texte (pièces toutes écartées) n'avait jamais de version des faits : à relire à chaque vidage.                                   | La version est posée dès que le manifeste est complet (`src/pdf_enrichment.py`).                                                                  |
| G   | Le motif d'un point d'étape refusé n'existait que dans le journal du worker.                                                                          | Il suit le message dans `last_error` : `…retry required: no_progress_entries` (`src/storage/pdf_checkpoint_rules.py`).                            |
| H   | Une écriture de fin de passe écartée (admission, révision déplacée) laissait la tâche « terminée » sans lecture enregistrée.                          | La tâche pdf est reportée : 30 minutes si la vente a changé pendant la passe, un jour pour un refus d'admission.                                  |

Garde-fous vérifiés par des tests : une pièce nouvelle ou remplacée est lue, un texte perdu reste un échec
visible puis est relu à l'expiration de ses vérifications, une vente invalidée par une collecte repasse le
jour même.

## Non livré

- **N (annuler la tâche d'une vente dont toutes les sources sont retirées).** Écarté après lecture du
  code : à la levée du retrait, la publication remet la tâche en file avec la même empreinte, et
  l'insertion ne réveille pas une ligne annulée (`on conflict do nothing`). Seul le vidage la réveille, et
  seulement si la vente a encore une pièce à lire. Une vente entièrement lue ne serait donc plus
  revalidée tant que ses pièces ne changent pas. Le report de 24 heures reste en place (15 tâches). À
  reprendre avec un réveil à la levée du retrait (fonction SQL `set_catalogue_source_withdrawal`, donc
  une migration) ou à la publication.
- **Seconde série** : E (restaurer le texte malgré une URL écartée), I (ne pas créer de tâche pour un
  manifeste complet, frais et à la version courante), J (pièce d'une source retirée, liens morts au-delà
  de six pièces), K (statuts des pièces illisibles).
- **Décisions du propriétaire** : L (fraîcheur d'une pièce lue et inchangée, aujourd'hui 24 heures), M
  (migration : borner le bonus de 168 heures de la voie générale). Sans L, les tâches « sans travail »
  (140 sur 180 en attente) restent, par construction.
- H ne reporte que la tâche pdf. Une passe de faits dont l'écriture est écartée reste « terminée » : la
  reporter rappellerait le modèle à chaque essai (budget, hors périmètre).

## Mesures à refaire après mise en ligne (lecture seule)

```sql
-- 1. Concentration. Attendu : le vidage ne lit plus une vente plus de 2 fois par jour. Une vente encore
--    au-dessus est servie par la voie générale (correctif I, seconde série).
select lectures, count(*) as ventes
from (select source_url, count(*) as lectures from public.auction_enrichment_jobs
      where job_type = 'pdf' and status = 'completed' and completed_at >= now() - interval '24 hours'
      group by 1) t
group by 1 order by 1 desc limit 20;

-- 2. Fins de passe en 24 heures : échecs « checkpoint » par motif, tâches en attente (« PDF pass deferred »).
select status, coalesce(substring(last_error from 'retry required: ([a-z_ ]+)'),
                        left(coalesce(last_error, ''), 60)) as fin, count(*)
from public.auction_enrichment_jobs
where job_type = 'pdf' and updated_at >= now() - interval '24 hours'
group by 1, 2 order by 3 desc limit 40;

-- 3. Qui recrée la tâche des ventes encore relues (diagnostic révisé, sans identifiant).
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
```

Lecture de la troisième : un délai proche de 0 désigne l'écriture de fin de passe (correctif I), proche de
60 à 70 minutes le vidage suivant. Refaire aussi M1 (échecs pdf par famille) et M2 (tâches en attente) du
11/11 : les 62 échecs « checkpoint » doivent laisser place à des lectures terminées, à des tâches en
attente, ou à des échecs qui disent leur motif.
