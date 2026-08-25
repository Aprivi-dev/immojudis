# Procédure de vente — contrôle et publication

_Version 1.0 — 20 août 2026._

## Principe de publication

Immojudis publie le mode de vente sur chaque annonce, mais ne transforme jamais une inférence
d'adresse en fait vérifié. Les statuts autorisés sont :

- `cross_checked` : annonce ou pièce explicite, recoupée par une seconde référence officielle ;
- `verified` : mention explicite issue d'une source de la vente ;
- `pending` : information partielle, notamment tribunal seulement déduit de l'adresse ;
- `conflict` : indices explicites incompatibles, publication définitive bloquée.

Les statuts `pending` et `conflict` restent visibles afin de ne pas donner une fausse certitude. Les
règles avocat, consignation et délais restent alors à confirmer. Les références juridiques utilisent
un `ruleset_version` daté ; toute modification réglementaire impose une nouvelle version et une
requalification des annonces actives.

## Déploiement

1. Appliquer `20260820091401_sale_procedure_verification.sql` avec le workflow
   `Apply Supabase Migrations` et la confirmation explicite `production`.
2. Lancer `Recompute Existing Sales` sur `all`, avec `confirm_target=production`. Le workflow
   exécute toujours un précontrôle sans écriture avant tout upsert. Pour un contrôle isolé, activer
   l'option `dry_run`.

   L'équivalent local du précontrôle est :

   ```bash
   .venv/bin/python -m src.recompute_scoring --dry-run
   ```

3. Examiner `sale_procedure_statuses`, les conflits et un échantillon de chaque source.
4. En mode définitif, le workflow exécute ensuite l'upsert complet, vérifie que le nombre publié
   correspond au nombre calculé, reprend individuellement les éventuelles lignes incohérentes, puis
   relit toutes les lignes persistées avec `--verify-only`. Une procédure encore vide, incohérente,
   différente du recalcul attendu ou d'une version inattendue fait échouer le déploiement.
5. Vérifier dans le catalogue Découverte que le bloc procédural est présent sans fuite des analyses
   premium.
6. Vérifier dans l'offre Analyse que l'historique tribunal apparaît uniquement pour une vente
   qualifiée `tribunal` et un code de tribunal confirmé.

Le backfill réutilise l'upsert existant. Il ne supprime aucune annonce ni aucune preuve.

## Contrôles quotidiens

- suivre la métrique `Procédure de vente vérifiée` dans le rapport de qualité ;
- traiter d'abord les statuts `conflict`, puis les ventes proches dont le statut est `pending` ;
- vérifier que `verified_at`, l'URL de l'annonce et les références officielles sont présentes ;
- ne jamais copier une modalité notariale générique comme montant propre à une annonce ;
- ne jamais afficher une statistique locale supprimée pour échantillon insuffisant.

## Incident ou changement juridique

En cas de source indisponible, conflit ou doute réglementaire :

1. conserver la qualification mais la repasser à `pending` ou `conflict` ;
2. ne pas remplacer l'information par une valeur estimée ;
3. corriger le classifieur ou le ruleset avec tests ;
4. relancer d'abord le dry-run borné avec `--limit` ;
5. produire un nouveau contrôle horodaté, sans réécrire silencieusement la provenance.

Les statistiques de tribunal suivent en plus les seuils, preuves et règles de masquage décrits dans
`docs/runbooks/tribunal-statistics.md`.
