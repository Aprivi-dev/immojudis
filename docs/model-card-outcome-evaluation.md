# Évaluation et promotion des modèles Outcome Graph

_Version 0.1 — 1er août 2026. Ce document décrit le garde-fou technique d'évaluation. Il ne constitue pas une validation statistique du modèle, une promesse de prix ni une autorisation d'ouverture commerciale._

## Objet

Le module `services/data-pipeline/src/outcome_evaluation/` mesure, sans écrire par défaut :

- la couverture des snapshots, labels A/B et prédictions;
- la calibration et la discrimination des quatre issues exclusives;
- l'erreur et la couverture des intervalles de prix définitif;
- les écarts par tribunal, région judiciaire, procédure, type de bien, occupation, source et horizon;
- la stabilité trimestrielle;
- la comparaison à des baselines choisies sur la validation, puis verrouillées avant le test.

Il ne transforme jamais un résultat `unknown` en annulation, report ou absence d'enchère. Il ne lit ni plafond utilisateur, ni identité de magistrat, ni texte de décision dans son rapport agrégé.

## Unité, chronologie et labels

L'unité est une audience, groupée par lot pour le découpage temporel. Si plusieurs audiences du même lot traversent deux blocs, le lot entier est déplacé vers le bloc le plus tardif. Les blocs sont ordonnés :

```text
entraînement → validation → test
```

Une prédiction évaluable doit avoir été générée et enregistrée avant l'audience depuis un snapshot construit, enregistré et gelé avant cette audience, avec contrôle anti-fuite réussi. Seuls les labels A/B admissibles et réellement disponibles au cutoff sont utilisés. La disponibilité effective retient de façon conservatrice la date la plus tardive du résultat canonique, de la décision d'éligibilité, des preuves liées et de leurs revues enregistrées. Le prix possède un cutoff de disponibilité distinct couvrant les claims `final_hammer_price_eur` et `finality_status`; un prix validé après la borne du split ne peut donc pas alimenter une baseline antérieure. Le prix évalué est le prix définitif soutenu par ces claims et une finalité procédurale définitive; le prix initial d'adjudication ne peut pas le remplacer.

## Métriques

Classification : Brier multiclasse, log loss, ECE/MCE sur dix bins, matrice de confusion, précision, rappel, F1 et support par classe.

Prix : pinball P10/P50/P90, erreur absolue médiane, erreur logarithmique, biais signé, couverture de l'intervalle 80 % et largeur de l'intervalle.

Couverture : univers mature, snapshots admissibles, labels A/B, prédictions prêtes, abstentions explicites, prédictions absentes et couverture de bout en bout.

Biais et stabilité : écarts de couverture/Brier/biais prix sur les segments publiables, PSI de confiance et dérives trimestrielles de couverture et de Brier. Les segments de moins de 30 labels ne sont pas publiés.

## Seuils commerciaux v1

La politique `outcome-commercial-v1` est codée et versionnée; elle ne peut pas être assouplie par un argument CLI :

- au moins 1 000 labels A/B au total;
- au moins 300 labels A/B et 300 prédictions scorées dans le test ou la période prospective;
- au moins 100 prix définitifs admissibles;
- au moins 80 % de couverture snapshot et prédiction;
- ECE au plus égale à 0,05;
- couverture de l'intervalle 80 % comprise entre 75 % et 85 %;
- au moins deux trimestres qualifiés de 30 labels;
- PSI strictement inférieur à 0,20;
- dérive absolue de couverture au plus égale à 10 points;
- dégradation trimestrielle de Brier au plus égale à 0,02;
- performance strictement meilleure que la baseline verrouillée.

Une métrique obligatoire absente ne passe jamais silencieusement.

## Statuts

| Statut | Interprétation |
| --- | --- |
| `invalid_input` | Chronologie, schéma, probabilité, quantile ou donnée non conforme |
| `insufficient_data` | Entrée valide, mais volume, couverture, segment ou stabilité insuffisant |
| `failed` | Métriques complètes mais au moins un seuil échoue |
| `passed` | Tous les contrôles obligatoires réussissent |

La priorité est fail-closed : `invalid_input`, puis `insufficient_data`, puis `failed`, puis `passed`.

## Promotion SQL

La table `outcome_model_evaluations` conserve uniquement un résumé agrégé allowlisté et des hashes de manifestes. Elle est append-only, sous RLS, sans accès navigateur; le `service_role` possède seulement `SELECT` et `INSERT`.

Le cycle autorisé est :

```text
draft → validated → shadow → active → retired
```

- `validated → active` direct est interdit;
- `validated → shadow` exige que la dernière évaluation historique enregistrée soit `passed`;
- `shadow → active` exige que la dernière évaluation prospective soit `passed` avec au moins 300 prédictions scorées et reste fraîche au moment de l'activation (30 jours maximum);
- une évaluation plus récente en échec masque toujours une ancienne réussite.

Le résumé SQL prouve la structure et l'état déclaré du rapport, pas la vérité du calcul exécuté par le worker. Le worker et ses manifestes restent donc dans le périmètre d'audit.

Limite bloquante actuelle : le dépôt ne fournit pas encore de format/exécuteur audité capable de charger l'artefact exact d'un modèle `validated` et de rescorrer ses snapshots historiques. Les lignes `auction_predictions` existantes ne constituent pas ce replay : leurs gardes exigent un modèle `shadow` ou `active`. Par conséquent, `historical_replay --persist` est explicitement refusé. Le schéma SQL prépare la future preuve historique, mais le cycle de promotion ne peut pas honnêtement franchir `validated → shadow` avec le worker actuel.

## Commande de contrôle

Le CLI exige des bornes temporelles et `--max-records`. Le dry-run est le comportement par défaut : la lecture base utilise une transaction `REPEATABLE READ READ ONLY`, puis effectue un rollback explicite. Une entrée JSON locale peut être utilisée pour un test reproductible sans base.

La persistance prospective est une opération serveur/worker distincte. Elle exige simultanément `--persist`, une lecture depuis la base, un modèle `shadow` existant et la valeur exacte `OUTCOME_EVALUATION_ENABLED=true`. Elle est interdite pour `--input-json` et pour `historical_replay` tant que l'exécuteur d'artefact audité manque. Avant insertion, le worker recalcule le rapport depuis l'univers borné; l'écriture idempotente conserve seulement le résumé fermé et trois hashes de manifestes. Les identifiants individuels restent hors du rapport. Un rapport `invalid_input` ou un univers vide sans cutoff de features n'est jamais persisté.

```bash
cd services/data-pipeline
.venv/bin/python -m src.outcome_evaluation.cli \
  --mode prospective_shadow \
  --train-start 2024-01-01 \
  --train-end 2025-01-01 \
  --validation-end 2025-04-01 \
  --test-end 2025-10-01 \
  --label-cutoff-at 2025-12-01T00:00:00Z \
  --computed-at 2025-12-02T00:00:00Z \
  --max-records 20000 \
  --input-json /chemin/vers/observations.json
```

Codes de sortie : `0` pour `passed`, `1` pour `failed` ou `insufficient_data`, `2` pour `invalid_input`.

## État au 17 août 2026

Le package d'évaluation et la migration de garde sont présents dans le worktree. La migration a été appliquée le 1er août 2026 sur la branche Supabase de staging isolée et sans données, puis contrôlée : RLS active, aucun privilège `anon`/`authenticated`, `service_role` limité à `SELECT`/`INSERT`, et zéro modèle, résultat, snapshot ou évaluation. Le 17 août 2026, les 87 migrations ont été rejouées localement depuis zéro, le contrôle de dérive a confirmé leur conformité et les 15 fichiers pgTAP ont réussi leurs 485 assertions; les invariants statiques et les 840 tests Python sous Python 3.11.16 passent également. Aucun corpus satisfaisant les seuils n'a été évalué : le seul état justifié reste `insufficient_data`, avec `writes = 0` sur l'univers vide. `OUTCOME_EVALUATION_ENABLED=false`, `TRIBUNAL_STATISTICS_ENABLED=false` et `JUDILIBRE_ENABLED=false` restent les valeurs sûres. Aucun modèle n'a obtenu `passed`; aucune promotion en `shadow` ou `active`, et aucune ouverture commerciale fondée sur ces statistiques, n'est autorisée dans cet état.
