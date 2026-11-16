# Migration des secrets vers l'environnement `Production`

Procédure ponctuelle (audit de sécurité du 16/11/2026, constat n° 3). À supprimer une fois la migration
vérifiée, avec le workflow `migrate-secrets-to-production-environment.yml`.

## Pourquoi

Les workflows qui touchent la production déclarent `environment: Production`, restreint à la branche
`main`. Tant que leurs secrets restent au niveau du dépôt, une branche peut encore les lire avec un
workflow qui ne déclare pas d'environnement. Ils doivent donc vivre dans l'environnement, et nulle part
ailleurs.

GitHub ne laisse lire la valeur d'un secret à personne : seul un job peut la recopier. C'est ce que fait le
workflow, sans afficher aucune valeur.

## Secrets recopiés

`CRON_SECRET`, `JUDILIBRE_KEY_ID`, `REPLICATE_API_TOKEN`, `SOURCE_FETCH_RELAY_TOKEN`,
`SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`.

`VITE_GOOGLE_MAPS_API_KEY` reste au niveau du dépôt : c'est une clé publique lue par la CI.

## Étapes

1. **Jeton temporaire** (propriétaire). GitHub → Settings du compte → Developer settings → Personal access
   tokens → Fine-grained tokens → Generate new token :
   - Repository access : « Only select repositories », `immojudis` seulement ;
   - Repository permissions : **Secrets** « Read and write », **Environments** « Read and write » ;
   - Expiration : 7 jours.

   L'enregistrer comme secret de dépôt `SECRETS_MIGRATION_TOKEN` (Settings du dépôt → Secrets and variables
   → Actions → New repository secret). Ne le coller nulle part ailleurs.

2. **Lancer le workflow** « Migrate secrets to the Production environment » sur `main`, avec
   `confirm_target` = `production`. Le journal liste les noms recopiés, jamais les valeurs.
3. **Vérifier** : Settings → Environments → Production liste les huit secrets, plus `SUPABASE_DB_SSL_CA`.
   Attendre qu'une collecte (`Immojudis Data Pipeline`) lancée après l'étape 2 réussisse.
4. **Supprimer les huit secrets au niveau du dépôt** (Settings → Secrets and variables → Actions). Vérifier
   qu'une nouvelle collecte réussit : elle lit désormais l'environnement seul.
5. **Nettoyer** : supprimer le secret `SECRETS_MIGRATION_TOKEN`, révoquer le jeton, puis supprimer le
   workflow et ce runbook par une PR.

## Retour arrière

Tant que l'étape 4 n'est pas faite, rien n'a changé pour les workflows : un secret d'environnement de même
valeur prend simplement le pas sur celui du dépôt. Après l'étape 4, un secret manquant se recrée dans
l'environnement `Production` avec sa valeur d'origine (Supabase, Replicate, Vercel, portail PISTE).

## Par la suite

Tout nouveau secret de production se crée dans l'environnement `Production`, jamais au niveau du dépôt.
