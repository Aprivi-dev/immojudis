<!-- Rapport du spécialiste `data-pipeline`, rendu le 11/11/2026 dans la mission « registre des pièces » : diagnostic révisé de la file de lecture des documents après les mesures, avec les correctifs A à N. Reproduit tel quel : c'est une analyse, pas une décision. Les décisions sont dans `docs/equipe/2026-11-11-registre-des-pieces.md`. -->

# R6, diagnostic révisé après les mesures M1 à M6

Légende : **[L]** lu dans le code, **[E]** exécuté hors dépôt (faux réseau, fausse base, vrai code), **[S]** supposé. Dépôt inchangé (`git status` vide), aucune base, aucun workflow.
Ce que je retire de mon premier rapport : « anciennes donc non dues » (faux, 115 sur 133 sont dues), « les 62 échecs masquent des téléchargements en échec » (faux pour 57 à 62), la cause (c) sur le budget (non déclenchée), et « une tâche par vente et par jour » (mal formulé, voir point 2).

## Point 3. Les 62 échecs « checkpoint » : deux causes reproduites [L + E]

Signature reproduite à l'identique (message nu, 0 erreur, 0 pièce en échec, manifeste complet en base écrit avant l'essai) dans deux cas :

- **T8, lecture en avance du vidage sur un manifeste de plus de 24 h.** La lecture en avance télécharge les pièces et écrit des fichiers de suivi `.http.json` frais (`document_prefetch.py:94`, `pdf_enrichment.py:560-566`) sans écrire le texte agrégé ni le manifeste (l.129-153). La passe sous verrou juge alors la péremption sur ce fichier local d'abord (`pdf_progress.py:562-575`) : rien n'est périmé, rien n'est choisi. La restauration depuis la base est refusée parce que la preuve persistée, elle, a plus de 24 h (`supabase_client.py:1861`). La passe n'a donc aucun texte, reconstruit un manifeste vide et le point d'étape est refusé `no_progress_entries` (`pdf_checkpoint_rules.py:196-198`, `queued_runner.py:702-718`). Le correctif #421 ne couvre que les URL déjà enregistrées « en attente » (`pdf_progress.py:577-590`), pas ce premier passage. Sans lecture en avance, la même vente se termine (T8, tick 4).
- **T3, manifeste complet contenant au moins une URL écartée** (404, robots, vide, lien non documentaire), sur un runner neuf, moins de 24 h après la dernière vérification : la restauration est interdite par principe (`supabase_client.py:1784-1785`), rien n'est périmé, même manifeste vide, même refus.
- **Lien avec `document_facts_version`** [L] : la version absente fait de la vente une candidate du vidage (`document_backlog.py:138`), seul chemin qui passe par la lecture en avance, et force la passe même quand les pièces sont à jour (`queued_runner.py:679`). La version n'est posée que s'il existe du texte (`pdf_fact_extraction.py:109-115, 307`, appelée seulement si `pdf_enrichment.py:306`). Pourquoi elle manque sur 45 ventes lues reste [S] : effacement par une collecte ou une fusion (`dedupe.py:272`, `freshness.py:158`, limites de `known_document_backfill.py:107-129`).
- Les 6 tâches Vench (familles 1 et 4, hôte `document.vench.fr`) sont mes anciens cas D et E, confirmés. Les 9 sur `cessions.immobilier-etat.gouv.fr` sont de vrais téléchargements en échec, à traiter à part.
- Correctif vérifié par substitution [E] : péremption jugée sur la preuve persistée et non sur le fichier local, T8 se termine, 0 téléchargement en plus.

## Point 1. La boucle de relecture [L + E, état exact des deux ventes Petites Affiches non reproduit]

- **Pourquoi l'empreinte change** [L] : chaque passe au manifeste complet écrit un nouveau `last_successful_check_at` (`pdf_document_selection.py:795-797`), qui entre dans l'empreinte (`supabase_client.py:304, 327`). La tâche suivante est donc une ligne neuve : ni les 4 essais ni la règle « essayée depuis moins d'un jour » ne s'appliquent.
- **Pourquoi la vente repasse à chaque tick** [L] : elle reste candidate tant qu'elle a une ligne de pièce non lue ou une version de faits différente (`document_backlog.py:103-114, 136-139`), et une tâche terminée ne la bloque plus dès qu'une tâche plus récente existe (l.171-179), même jamais essayée (l.160-170). L'insertion du vidage porte la priorité à 40 (l.193-213).
- **Qui recrée la tâche** : deux chemins, tous deux reproduits. (a) Le vidage lui-même (`document_backlog.py:580`) : cas T4, vente sans aucun texte (toutes pièces 404), la passe « réussit », la version n'est jamais posée, une tâche neuve terminée par tick, sans fin. (b) L'écriture qui clôt la passe (`supabase_client.py:441-450`, appelée l.605) quand `documents_are_current` est faux juste après une passe acceptée par `manifest_is_complete`. L'attente mesurée de 1,1 h et les 2 tâches Petites Affiches « dues, jamais prises » entre deux ticks désignent (b) [S]. J'ai essayé 8 états mixtes (pièce Vench jamais tentée, 404 puis retrait, lue puis retrait, runner froid ou tiède, avec ou sans lecture en avance) : ils échouent ou restent partiels, aucun ne se termine en boucle. Le prédicat exact reste à mesurer (requête en fin de rapport).
- **Vente Enchères Immobilières sans `document_analysis`** [S] : deux défauts lus peuvent l'expliquer, non départagés. L'écriture de fin de passe est écartée en silence (refus d'admission `supabase_client.py:491`, garde de révision l.901-903) et la tâche est quand même marquée terminée (`queued_runner.py:820, 1025`) ; ou une collecte retire le manifeste à chaque liste de pièces jugée changée (`main.py:1274-1284`).

## Point 2. Les 140 tâches « sans travail » et l'attente de 146 h [L + E]

- **Création** : à chaque publication, dès que `documents_are_current` est faux (`supabase_client.py:441-450`), c'est-à-dire 24 h après la dernière vérification (`freshness.py:199-203, 319`), ou tout de suite sur un runner qui ne peut pas restaurer le texte (T3). **Conservation** : rien n'annule une tâche pdf en attente quand la vente redevient à jour, seule une génération plus récente la remplace (474 annulations en 8 jours).
- Ces tâches ne sont pas vides quand elles sont enfin prises : après 24 h, un runner neuf retélécharge et relit tout (T1, tick 4 : 3 téléchargements, 3 extractions pour 3 pièces déjà lues).
- **Pourquoi elles attendent** [L, chiffres mesurés] : le vidage ne les sert jamais (elles n'ont ni pièce en attente ni version différente). La voie générale sert par score = priorité + âge + 24 (pdf) + 168 (vente sous 7 jours) : une tâche de vente lointaine ne passe devant une tâche de vente proche que si elle a 168 h de plus. L'attente mesurée (146 h, maximum 155 h) correspond à ce bonus. La priorité 40 ne pèse pas dans la voie générale (10 points) : la concentration vient du vidage, où 3 ventes prennent 57 des 114 places par jour.
- **Lecture d'ensemble** : 322 ventes à pièces, 39 à 61 servies par jour, soit une revisite tous les 6 jours environ pour une fraîcheur exigée de 24 h. Le stock de 180 est l'état d'équilibre de ce rapport, pas un retard qui se résorbe. Le cycle 3 pour 1 n'est pas départageable avec les mesures (il faut `handled_enrichment` de la ligne « Enrichment worker summary » du journal).

## Budget IA [L]

- Garde-fou SQL (`reserve_pipeline_prediction`, migration `20260921110000`) : il additionne `coalesce(estimated_usd, reserved_usd)` du jour UTC, donc l'**estimation** dès que la prédiction est soldée avec ses jetons (`pipeline_usage.py:296-300`) et la **réservation** seulement pour les lignes non soldées. Les 5,1 à 5,3 USD de réservations ne sont donc pas ce qui est comparé au plafond de 6 : environ 1,6 USD plus les réservations en cours.
- Garde-fou Python (`pipeline_usage.py:205-231`) : autre registre (`llm_usage_events`), jetons estimés plus 0,01 par requête non mesurée, plafond de 5 par défaut (l.32, le workflow ne pose pas `LLM_DAILY_BUDGET_EUR`). C'est l'origine de mon « 5 par jour » ; deux plafonds coexistent (5 et 6).
- Conclusion : la fermeture de la voie générale (`queued_runner.py:945-950, 1162-1168`) existe dans le code mais ne s'est pas produite les 09, 10 et 11/11. Cause retirée, gardée comme risque latent.

## Correctifs révisés, dans l'ordre

| #   | État                      | Priorité   | Fichier, fonction                                                   | Correctif                                                                                                            | Effort | Test                                                                                    | Risque                                                  |
| --- | ------------------------- | ---------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| A   | reste (ancien 1)          | Critique   | `pdf_fact_scope.py`, `_pdf_set_projected_value`                     | Normaliser la valeur restaurée                                                                                       | S      | « libre » rend `vacant`, « 85,5 » rend un décimal                                       | Faible                                                  |
| B   | nouveau                   | Critique   | `document_backlog.py:171-179`, `CANDIDATES_SQL`                     | Plafond : pas plus de 2 lectures pdf terminées par vente en 24 h, quelle que soit l'empreinte                        | S      | T4 : 1 tâche puis plus rien ; la relecture après invalidation (#415, #416) passe encore | Une vente réellement modifiée 3 fois en 24 h attend     |
| C   | nouveau                   | Critique   | `pdf_progress.py:562-575`, `stale_complete_document_urls`           | Péremption jugée sur la preuve persistée, le fichier local ne sert qu'à la requête                                   | S      | T8 se termine (vérifié par substitution)                                                | Faible                                                  |
| D   | nouveau                   | Critique   | `queued_runner.py:702-718`                                          | Passe sans rien de neuf sur un manifeste persisté complet : ne pas remplacer le manifeste ni échouer, reporter       | S      | T3, tick 2 : pas d'échec                                                                | Masque un texte réellement perdu si mal borné           |
| E   | nouveau                   | Important  | `supabase_client.py:1784-1785`, `_validated_persisted_pdf_manifest` | Restaurer le texte des pièces attendues même si le manifeste a des URL écartées (pour la passe de file seulement)    | M      | T3 : restauration, passe sans téléchargement                                            | Règle volontairement stricte, à garder pour l'affichage |
| F   | nouveau                   | Important  | `pdf_fact_extraction.py:109-115`, `pdf_enrichment.py:306-337`       | Poser la version des faits dès que le manifeste est complet, même sans texte                                         | S      | T4 : « à jour » après la première passe                                                 | Faible                                                  |
| G   | modifié (ancien 2)        | Important  | `queued_runner.py:430-433`, `pdf_checkpoint_rules.py:252`           | Écrire la raison du refus dans `last_error`                                                                          | S      | Message porte `no_progress_entries`                                                     | Texte lu par `is_refused_checkpoint`                    |
| H   | reste (ancien 6)          | Important  | `queued_runner.py:820, 1025`                                        | Écriture écartée (retour 0) : ne pas marquer la tâche terminée                                                       | S      | Retour 0, tâche reportée                                                                | Faible                                                  |
| I   | nouveau                   | Important  | `supabase_client.py:441-450`, `_enqueue_due_enrichment`             | Ne pas créer de tâche quand le manifeste persisté est complet, frais et à la version courante, même sans cache local | M      | T3 : aucune tâche à la publication                                                      | Texte perdu non relu avant 24 h                         |
| J   | reste (anciens 3 et 4)    | Important  | `pdf_enrichment.py:449-453`, `pdf_checkpoint_rules.py:196-200`      | Pièce d'une source retirée écartée avec motif ; URL définitives enregistrées même sans texte                         | M      | Cas D, E, F                                                                             | 6 tâches Vench, 12 ventes sans texte                    |
| K   | reste (ancien 7)          | Important  | `supabase_client.py:4082-4321`, `_document_rows_for_sale`           | Statuts des pièces illisibles (`not_found`, `blocked`, `unavailable`), exclus du compte « en attente » du vidage     | M      | Une vente aux seules pièces illisibles n'est plus candidate                             | Lecteurs TS déjà compatibles                            |
| L   | reste (ancien 8), central | Décision   | `freshness.py:44, 199-203`                                          | Fraîcheur d'une pièce lue et inchangée : 7 jours                                                                     | M      | T1 à 25 h reste à jour                                                                  | Changement de pièce vu plus tard                        |
| M   | nouveau                   | Décision   | migration SQL de `claim_auction_enrichment_jobs_family`             | Borner le bonus de 168 h ou vieillir plus vite les ventes lointaines                                                 | S      | Ordre de prise                                                                          | Migration du propriétaire                               |
| N   | reste (ancien 9)          | Suggestion | `queued_runner.py:629-635`                                          | Vente entièrement retirée : annuler au lieu de reporter 24 h (15 tâches)                                             | S      |                                                                                         | Faible                                                  |

- **Tombent** : ancien 5 (budget, non déclenché ; garder l'alignement des deux plafonds en suggestion) et ancien 10 (20 tâches Enchères Publiques garées, effet négligeable).
- **Sans décision du propriétaire** : A à K, N. **Avec décision** : L (fraîcheur contre charge sur les sites), M (migration), fermeture en base des 138 descriptions libres, des 20 `source_detail` garées et des 140 tâches sans travail si l'on veut un effet immédiat.

## Effet attendu, avec les mesures

- **B (boucle)** : 104 lectures en 48 h, soit 52 par jour sur 129 (40 %), et 57 des 114 places quotidiennes du vidage (50 %), tombent à 3 ou 6 par jour. Environ 50 créations de tâches en moins par jour sur 107 à 152.
- **C, D, E (point d'étape)** : les 62 échecs disparaissent (57 sûrs, 5 sans manifeste à vérifier). Aujourd'hui chacun consomme jusqu'à 4 prises, puis un réarmement quotidien où la lecture en avance télécharge et lit ses pièces pour rien (280 pièces par cycle). Une partie des 190 descriptions et 208 passes de faits retenues derrière une tâche pdf se libère (part non mesurée).
- **Retard réel** : 40 tâches (18 avec une pièce à lire, 11 à relire pour la version, 11 sans ligne de pièce). Avec les places rendues par B, 1 à 2 jours, sans vidage manuel.
- **Les 140 tâches sans travail** : sans la décision L elles restent, par construction (revisite tous les 6 jours pour une exigence de 24 h). Avec L à 7 jours : arrivées de l'ordre de 322 / 7 = 46 par jour, sous la capacité (environ 77 lectures hors boucle aujourd'hui, plus 52 rendues) ; les 140 se terminent sans passe quand elles sont prises (T1, tick 2 : 0 téléchargement), soit 2 à 3 jours. Ces délais sont des estimations [S] à partir des débits mesurés sur 24 h.

## Mesures ciblées restantes (lecture seule, sans identifiant)

```sql
with boucle as (
  select source_url from public.auction_enrichment_jobs
  where job_type = 'pdf' and status = 'completed' and completed_at >= now() - interval '48 hours'
  group by 1 having count(*) >= 10)
select s.source_name, jsonb_array_length(s.documents) as pieces,
  (a is not null) as manifeste, (s.raw_payload->>'document_facts_version' is not null) as version,
  jsonb_array_length(coalesce(a->'pending_document_urls', '[]'::jsonb)) as en_attente,
  jsonb_array_length(coalesce(a->'blocked_document_urls', '[]'::jsonb)) as bloquees,
  jsonb_array_length(coalesce(a->'skipped_document_urls', '[]'::jsonb)) as ecartees,
  jsonb_array_length(coalesce(a->'terminal_document_urls', '[]'::jsonb)) as terminales,
  jsonb_array_length(coalesce(a->'http_revalidation_pending_urls', '[]'::jsonb)) as revalidation,
  (select count(*) from jsonb_array_elements(coalesce(a->'cache_proof'->'documents', '[]'::jsonb)) p
    where p->>'http_checked_at' is null) as preuves_sans_date,
  (select count(*) from jsonb_array_elements(coalesce(a->'cache_proof'->'documents', '[]'::jsonb)) p
    where not exists (select 1 from jsonb_array_elements(s.documents) d where d->>'url' = p->>'url')) as preuves_hors_liste,
  (select count(*) from jsonb_array_elements(s.documents) d
    join jsonb_array_elements(coalesce(a->'cache_proof'->'documents', '[]'::jsonb)) p on p->>'url' = d->>'url'
    where d->>'sha256' is not null and d->>'sha256' <> p->>'sha256') as empreintes_differentes
from boucle b join public.auction_sales s on s.source_url = b.source_url
cross join lateral (select s.raw_payload->'document_analysis' as a) x;

with boucle as (
  select source_url from public.auction_enrichment_jobs
  where job_type = 'pdf' and status = 'completed' and completed_at >= now() - interval '48 hours'
  group by 1 having count(*) >= 10)
select (input_hash like 'pipeline_v2:%') as empreinte_python, priority, status, count(*) as taches,
       round(avg(extract(epoch from (created_at - fin_precedente)) / 60)) as minutes_apres_fin_precedente
from (select j.*, lag(completed_at) over (partition by source_url order by created_at) as fin_precedente
      from public.auction_enrichment_jobs j
      where job_type = 'pdf' and created_at >= now() - interval '48 hours'
        and source_url in (select source_url from boucle)) t
group by 1, 2, 3;
```

Lecture : `minutes_apres_fin_precedente` proche de 0 désigne l'écriture de fin de passe (`supabase_client.py:441-450`), proche de 60 à 70 le vidage suivant (`document_backlog.py:580`), une empreinte non Python le déclencheur SQL `auction_sales_enqueue_surface_enrichment`. `preuves_hors_liste`, `preuves_sans_date` ou `empreintes_differentes` au-dessus de 0 désignent l'écart entre `manifest_is_complete` (`pdf_progress.py:618-706`) et `documents_are_current` (`freshness.py:266, 319, 329-334`). Dans le journal d'un tick : les lignes « PDF checkpoint refused for » doivent montrer `no_local_text_cache` puis `no_progress_entries`.

## Fichiers

- Essais hors dépôt : `/tmp/claude-0/-home-user-immojudis/b7491545-da88-513a-b162-0678bf40ae93/scratchpad/r6-documents/test_sim_ticks.py` (T1 à T12), `/tmp/claude-0/-home-user-immojudis/b7491545-da88-513a-b162-0678bf40ae93/scratchpad/r6-documents/sim-ticks.log` (résultats), `/tmp/claude-0/-home-user-immojudis/b7491545-da88-513a-b162-0678bf40ae93/scratchpad/r6-documents/test_sim_correctif_n4.py` (correctif C par substitution), `/tmp/claude-0/-home-user-immojudis/b7491545-da88-513a-b162-0678bf40ae93/scratchpad/r6-documents/test_sim_checkpoint.py` (cas A à H), `/tmp/claude-0/-home-user-immojudis/b7491545-da88-513a-b162-0678bf40ae93/scratchpad/r6-documents/repro_restauration.py`.
- Mesures lues : `/tmp/claude-0/-home-user-immojudis/b7491545-da88-513a-b162-0678bf40ae93/scratchpad/r6-documents/rapport-mesures.md`.
- Code : `/home/user/immojudis/services/data-pipeline/src/document_backlog.py`, `/home/user/immojudis/services/data-pipeline/src/document_prefetch.py`, `/home/user/immojudis/services/data-pipeline/src/pdf_progress.py`, `/home/user/immojudis/services/data-pipeline/src/pdf_document_selection.py`, `/home/user/immojudis/services/data-pipeline/src/pdf_enrichment.py`, `/home/user/immojudis/services/data-pipeline/src/pdf_fact_extraction.py`, `/home/user/immojudis/services/data-pipeline/src/pdf_fact_scope.py`, `/home/user/immojudis/services/data-pipeline/src/freshness.py`, `/home/user/immojudis/services/data-pipeline/src/queued_runner.py`, `/home/user/immojudis/services/data-pipeline/src/pipeline_usage.py`, `/home/user/immojudis/services/data-pipeline/src/storage/supabase_client.py`, `/home/user/immojudis/services/data-pipeline/src/storage/pdf_checkpoint_rules.py`, `/home/user/immojudis/supabase/migrations/20260921110000_pipeline_token_pricing.sql`, `/home/user/immojudis/supabase/migrations/20261111050000_enrichment_claim_pdf_first.sql`, `/home/user/immojudis/supabase/migrations/20261001083619_enrichment_general_finite_urgency_bonus.sql`.
