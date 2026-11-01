# Retour arrière : Vercel, migrations et interrupteurs

Objet : revenir à un état sain après un déploiement ou une migration qui pose problème, sans aggraver la
situation. Public : le propriétaire. Aucun agent n'écrit en production : le retour arrière sur Vercel, le
lancement du workflow de migration et le changement de variables sont faits par le propriétaire.

Dernier essai : jamais (à dater après un exercice sur un déploiement de préproduction).

## Par où commencer

| Symptôme                                                                          | Premier geste                                                                     |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Le dernier déploiement casse le site (erreur 500, page blanche, build cassé)      | **Instant Rollback** Vercel vers le déploiement sain précédent (section suivante) |
| Une fonctionnalité précise se comporte mal, le reste va bien                      | Son **interrupteur** (dernière section), sans revenir sur le déploiement          |
| Le site fonctionne mais une **migration** vient d'être appliquée et pose problème | Section « Migrations » : pas de retour automatique, on corrige en avant           |
| Des données sont fausses ou perdues                                               | Ne rien réécrire à chaud ; voir « Dernier recours : restauration de la base »     |
| Un secret ou des données ont fuité                                                | `docs/runbooks/fuite-secret-ou-donnees.md` d'abord                                |

## Instant Rollback Vercel

Un retour arrière Vercel ne change **que le code et le contenu servis** : il rebranche le domaine de production
sur un déploiement antérieur, en quelques secondes, sans reconstruire. Il ne touche ni à la base Supabase, ni aux
secrets GitHub, ni aux planifications `pg_cron`.

1. Tableau de bord Vercel, projet Immojudis, onglet **Deployments**.
2. Repérer le dernier déploiement de production **sain** (celui d'avant le problème, état « Ready »).
3. Menu du déploiement, **Instant Rollback**, confirmer. (En ligne de commande : `vercel rollback
<url-ou-identifiant-du-déploiement>`.) Sur le plan Hobby, le retour est limité au déploiement de production
   précédent ; vérifier ce que le plan actuel permet dans le tableau de bord.
4. Vérifier : la page d'accueil, une fiche, `/api/health` (`status` à `ok`), et le test de fumée
   `npm run ops:smoke -- --origin https://immojudis.com` (lecture seule).
5. **Après un retour arrière, Vercel arrête d'attribuer automatiquement le domaine aux nouveaux déploiements** :
   les prochains `push` sur `main` ne seront plus mis en production tout seuls. Une fois le correctif prêt,
   le promouvoir explicitement (**Promote**) ou réactiver l'attribution automatique ; ne pas laisser le site sur
   l'ancien déploiement par oubli. À vérifier dans le tableau de bord après l'opération.

À savoir avant de revenir en arrière :

- **Les variables d'environnement restent celles du déploiement restauré** (un déploiement restauré garde les
  variables avec lesquelles il a été créé, voir `docs/vercel_setup.md`). Une variable ajoutée depuis (un
  interrupteur ouvert, un nouveau secret) ne s'applique donc pas à l'ancien déploiement.
- **Le code ancien doit fonctionner avec la base actuelle.** C'est la règle « migration additive avant le code »
  ci-dessous : si la dernière migration était additive, le retour est sûr ; si elle a supprimé ou renommé
  quelque chose que le code ancien lit, l'ancien déploiement échouera aussi, et il faut corriger en avant.
- **Les tâches planifiées** (`pg_cron` qui appelle les routes `/api/cron/*`) appellent maintenant l'ancien code.
  Vérifier `operational_job_runs` après le retour (voir `docs/operations/planification.md`).
- Un retour arrière n'annule pas les e-mails déjà envoyés ni les écritures de la collecte.

## Migrations : additive ou destructive

Il n'existe **pas de migration « down »**. Une migration publiée n'est jamais modifiée (voir
`supabase/README.md`) : on en écrit une nouvelle. Revenir en arrière sur la base, c'est donc **corriger en
avant** par une nouvelle migration, appliquée par le workflow « Apply Supabase Migrations » (jamais à la main).

| Type            | Exemples                                                                                                                                                         | Retour arrière du code                             | Quand l'appliquer                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------- |
| **Additive**    | Nouvelle table, nouvelle colonne nulle ou avec valeur par défaut, nouvel index, nouvelle fonction, nouvelle politique qui n'ôte aucun droit                      | Sûr : l'ancien code ignore ce qu'il ne connaît pas | **Avant** le code qui s'en sert                                            |
| **Destructive** | Supprimer ou renommer une colonne ou une table, changer le type ou la signature d'une fonction, resserrer une contrainte ou un droit, changer la forme d'une vue | Dangereux : l'ancien code lit ce qui n'existe plus | **Après** que plus aucun code déployé n'en dépend, dans une release à part |

### Règle : migration additive avant le code

1. **Étape 1, additive** : la migration ajoute ce dont le nouveau code a besoin, sans rien retirer. Les deux
   versions du code (ancienne et nouvelle) fonctionnent avec la base obtenue. Appliquer le workflow « Apply
   Supabase Migrations » dès la fusion sur `main`, comme l'exige `docs/vercel_setup.md` (le code que Vercel
   déploie à la fusion suppose que les migrations de la même demande sont en production).
2. **Étape 2, le code** : il passe en production (déploiement Vercel). Il doit tolérer une migration pas encore
   appliquée quand la fenêtre est courte (les routes planifiées répondent `skipped: not_migrated` plutôt que
   d'échouer).
3. **Étape 3, nettoyage** : une migration **destructive** ne vient que dans une release ultérieure, une fois que
   l'ancien code ne tourne plus nulle part (aucun déploiement restaurable ne l'utilise, aucune route planifiée,
   aucun workflow de collecte). Un changement de signature de fonction se fait par une **nouvelle** fonction à
   côté de l'ancienne, puis retrait de l'ancienne plus tard.
4. Une migration qui touche `auction_sales` se prend un verrou : l'appliquer hors collecte (voir
   `supabase/README.md`, règle 3).
5. Une réparation de données n'est jamais dans une migration : script de `supabase/repairs/`, comptage d'abord
   (`docs/runbooks/chantier-f-reparations-donnees.md`).

### Une migration appliquée pose problème

1. **Constater** sans aggraver : lire l'erreur du workflow, `operational_job_runs`, les journaux Vercel. Ne pas
   relancer le workflow en boucle ; le message de l'étape de dérive dit s'il s'agit d'une vraie dérive ou d'un
   outil injoignable (tableau de `docs/vercel_setup.md`).
2. **Si le code actuel casse à cause de la migration** : Instant Rollback vers un déploiement qui s'accorde avec la
   base (voir ci-dessus), le temps d'écrire la correction.
3. **Corriger en avant** : une nouvelle migration (horodatage plus récent que `main`), relue, avec son test
   pgTAP, appliquée par le workflow. Si la migration fautive a laissé la base dans un état à moitié fait,
   la nouvelle migration doit être idempotente et refuser de deviner (gardes `if not exists`).
4. **Couper l'usage** en attendant, si un interrupteur existe (dernière section).

## Dernier recours : restauration de la base

À ne considérer que si des **données** sont perdues ou corrompues et qu'aucune correction en avant ne les
rétablit. La restauration remplace l'état actuel par un état passé : tout ce qui a été écrit depuis (comptes,
alertes, favoris, collecte) est perdu et doit être rejoué ou ressaisi.

- Vérifier d'abord ce que le plan Supabase offre (sauvegardes quotidiennes ou restauration à un instant donné,
  selon le plan) et jusqu'à quelle date : tableau de bord Supabase, sauvegardes.
- Décision du propriétaire uniquement, après avoir mesuré ce qui serait perdu. Restaurer vers un **nouveau**
  projet de contrôle plutôt que sur le projet en production quand c'est possible, pour comparer avant de
  basculer.
- Ne jamais lancer `supabase db reset --linked` : il viserait la production.

## Interrupteurs : couper sans revenir en arrière

Quand le problème est une fonctionnalité, la couper est plus sûr qu'un retour arrière.

| Fonctionnalité                                         | Interrupteur                                                                         | Procédure                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Pépites visibles du public                             | Bouton « Suspendre les pépites » (`/admin/pepites`)                                  | `docs/runbooks/pepites-arret-urgence.md`                |
| Règle `pepite-v2.1`                                    | `PEPITE_RULE_V2_ENABLED` retirée ou à `false`, redéployer                            | `docs/runbooks/pepite-v2-ouverture.md`                  |
| Rappels d'audience, récapitulatif, alertes de résultat | `SALE_REMINDERS_MODE`, `WEEKLY_DIGEST_MODE`, `SALE_RESULTS_MODE` à `off`, redéployer | `docs/runbooks/activation-rappels-audience.md`          |
| Essai gratuit de 7 jours                               | Réglage de l'offre de lancement                                                      | `docs/runbooks/offre-de-lancement.md`                   |
| Santé opérationnelle (alertes)                         | Arrêt de la tâche                                                                    | `docs/runbooks/operational-health-arret.md`             |
| Indexation par les moteurs                             | `SEO_INDEXING_ENABLED` retirée ou à `false`, redéployer                              | `docs/vercel_setup.md`, « Indexation et référencement » |
| Agent d'information                                    | `INFORMATION_AGENT_OUTBOUND_ENABLED=false`                                           | `docs/runbooks/information-agent.md`                    |
| Collecte d'une source                                  | Interrupteur de retrait de source                                                    | `docs/runbooks/catalogue-source-absence.md`             |

Les alertes par e-mail n'ont pas d'interrupteur de coupure propre à ce jour : seules la limite
`ALERT_NOTIFICATION_CRON_LIMIT` (notifications libérées par passage) et l'arrêt de la clé d'envoi
(`RESEND_API_KEY`) les freinent. Un redéploiement est nécessaire après tout changement de variable Vercel.

## Après le retour à la normale

- Écrire ce qui s'est passé (cause, durée, correction) dans le compte-rendu de la session ou du jour.
- Ajouter le test ou la garde qui aurait évité l'incident.
- Vérifier que les prochains déploiements partent de nouveau en production (point 5 de l'Instant Rollback).
