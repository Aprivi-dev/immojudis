# Comptes-rendus de l'équipe d'agents

Ce dossier reçoit les rapports du chef d'orchestre, un fichier par mission :
`AAAA-MM-JJ-<sujet>.md`.

## Lancer une mission

Dans une session Claude Code ouverte sur ce dépôt :

```text
/equipe audit SEO de la page d'accueil
```

Le chef d'orchestre (`.claude/skills/equipe/SKILL.md`) délègue aux spécialistes de
`.claude/agents/`, relit leurs propositions et présente un tableau numéroté. Rien n'est
modifié dans le code tant que la validation n'est pas donnée, par exemple :
« Je valide 1, 2 et 4. »

## L'équipe

| Agent                    | Rôle                                                                        |
| ------------------------ | --------------------------------------------------------------------------- |
| `code-reviewer`          | Qualité, bugs, sécurité du code web (lecture seule)                         |
| `data-pipeline`          | Revue du pipeline Python de collecte (lecture seule)                        |
| `qualite-donnees`        | Exactitude des données affichées, SQL en lecture seule                      |
| `ux-designer`            | Parcours, ergonomie, mobile, parcours par profil type (lecture seule)       |
| `seo-expert`             | Référencement et visibilité dans les assistants IA (lecture seule)          |
| `juridique-rgpd`         | Mentions légales, CGU, RGPD, formulations à risque (lecture seule)          |
| `testeur-qa`             | Tests des parcours, bugs reproductibles (ne modifie rien)                   |
| `product-explorer`       | Nouvelles fonctionnalités, priorisation et feuille de route (lecture seule) |
| `veille-concurrentielle` | Ce que font les concurrents, idées à reprendre (lecture seule)              |
| `performance-web`        | Vitesse : temps de chargement et d'affichage, Core Web Vitals               |
| `redacteur-contenu`      | Propose des contenus ; les rédige seulement après validation                |
| `developpeur`            | Applique les points de code validés ; seul à modifier le code               |

### Renforts spécialisés (lecture seule)

Adaptés le 19/10/2026 de [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents)
(licence MIT, voir `docs/equipe/licences/agency-agents-MIT.txt`). Ils analysent et proposent ;
comme le reste de l'équipe, ils ne modifient aucun fichier et n'écrivent jamais en base.

| Domaine                | Agents                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Architecture et base   | `architecte-logiciel`, `expert-postgres`, `archeologue-code` (dont documentation périmée), `testeur-api` (dont API publique v1) |
| Exploitation           | `devops-ci`, `fiabilite-sre` (supervision, tâches planifiées et gestion des incidents)                                          |
| Sécurité               | `securite-applicative` (dont données personnelles côté technique et défauts typiques du code écrit par des agents)              |
| IA, modèles, chiffres  | `prompts-llm`, `qa-modeles`, `statisticien` (dont marché local DVF et graphiques)                                               |
| Carte et géographie    | `carte-web` (technique et lisibilité de la carte), `donnees-geographiques` (géocodage et contrôle des positions)                |
| Utilisateurs et design | `audit-accessibilite`, `optimisation-interface`, `gardien-marque`, `synthese-recherche`                                         |
| Produit et mesure      | `analyste-indicateurs` (dont expériences et mesures avant / après)                                                              |
| Paiements et prix      | `paiements-stripe`, `analyste-prix`                                                                                             |
| Croissance             | `directeur-marketing` (dont canaux, offre de lancement et acquisition), `strategie-email`                                       |

`optimisation-interface` (ajouté le 31/10/2026, écrit pour Immojudis) optimise chaque écran et
composant à partir de captures mesurées ; il complète `ux-designer` (parcours) et
`audit-accessibilite` (conformité).

`directeur-marketing` (ajouté le 06/11/2026, écrit pour Immojudis) prend de la hauteur sur le
discours commercial : il remet en question les formules, les accroches et l'ordre des arguments
selon leur effet sur la souscription de l'offre Analyse, avec les leviers psychologiques utilisés
honnêtement ; il couvre aussi les canaux d'acquisition et l'offre de lancement, et complète
`analyste-prix` (prix) et `gardien-marque` (ton).

### Allègement du 08/11/2026

L'équipe est passée de 58 à 33 agents. Les comptes-rendus montraient qu'une trentaine d'agents
n'étaient sollicités que lors des sessions où toute l'équipe était lancée, et que plusieurs se
recoupaient.

- **Fusionnés** (leurs contrôles utiles ont été repris par l'agent indiqué) : `audit-code-ia` et
  `protection-donnees-code` → `securite-applicative` ; `api-publique` → `testeur-api` ;
  `gestion-incidents` → `fiabilite-sre` ; `cartographe` → `carte-web` ; `qa-geographique` →
  `donnees-geographiques` ; `analyste-spatial` et `visualisation-donnees` → `statisticien` ;
  `chef-de-produit` et `strategie-entreprise` → `product-explorer` ; `croissance` et
  `offres-acquisition` → `directeur-marketing` ; `aeo-fondations` et `visibilite-ia` →
  `seo-expert` ; `suivi-experiences` → `analyste-indicateurs` ; `parcours-persona` et
  `recherche-utilisateurs` → `ux-designer` ; `rapports-pdf` → `code-reviewer` et `testeur-qa`.
- **Retirés** (canal ou activité pas encore ouverts) : `linkedin`, `relations-presse`,
  `publicite-search`, `prospection-avocats`, `support-client`, `synthese-retours`,
  `redacteur-technique` (la documentation périmée revient à `archeologue-code`).

Un agent retiré se restaure depuis l'historique git quand son sujet redevient actif, par exemple :
`git checkout <commit de retrait>^ -- .claude/agents/linkedin.md`
(`git log --diff-filter=D --oneline -- .claude/agents/linkedin.md` donne le commit).

### Départements

Pour les grosses missions (plus de 8 spécialistes), les rapports sont d'abord consolidés par
département avant d'arriver au chef d'orchestre. Les chefs de département sont des spécialistes
existants : `architecte-logiciel` (Technique), `qualite-donnees` (Données), `product-explorer`
(Produit et expérience) et `directeur-marketing` (Commercial et contenus). `juridique-rgpd`
rend compte directement au chef d'orchestre, qui continue de vérifier lui-même chaque
proposition Critique ou Haute. Répartition des membres et consignes : section « Départements et
chefs de département » et phase 1 bis de `.claude/skills/equipe/SKILL.md`.

## Modèles des agents

Chaque agent choisit son modèle dans son en-tête (`model:`). Répartition décidée le 06/11/2026 :

- **`opus`** pour les agents de jugement : stratégie et arbitrages, sécurité et argent, code et
  contenus produits, synthèse de sources. Ce sont `directeur-marketing`, `product-explorer`,
  `analyste-prix`, `strategie-email`, `architecte-logiciel`, `securite-applicative`,
  `juridique-rgpd`, `code-reviewer`, `developpeur`, `redacteur-contenu`, `archeologue-code`,
  `expert-postgres`, `paiements-stripe`, `statisticien`, `qa-modeles`, `prompts-llm`,
  `ux-designer`, `synthese-recherche` et `veille-concurrentielle` ;
- **`sonnet`** pour les autres, qui appliquent une liste de contrôles bien définie (audits
  techniques, tests, cohérence, brouillons sur un format connu). Ils coûtent moins cher.

Un nouvel agent suit la même règle. Un agent sur `sonnet` dont les rapports manquent de recul
peut passer sur `opus` : une seule ligne à changer.

## Garde-fou base de données

Aucun agent n'écrit dans la base de production. Trois protections dans `.claude/settings.json`
(détail et limites dans `.claude/hooks/README.md`) :

- `.claude/hooks/supabase-lecture-seule.mjs` (aussi dans l'en-tête de `qualite-donnees`) : sur
  `mcp__Supabase__execute_sql`, n'autorise que SELECT / WITH / EXPLAIN, sans mot-clé d'écriture, et
  seulement des appels de fonctions d'une liste blanche de fonctions de lecture pure. Toute
  erreur du script ou entrée illisible bloque ;
- `.claude/hooks/bloquer-ecriture-supabase.mjs` : bloque pour tous les agents les outils MCP
  Supabase qui écrivent (`apply_migration`, `deploy_edge_function`, branches, projets…) : passer
  par une migration et la CI ;
- `mcp__github__actions_run_trigger` et `mcp__github__merge_pull_request` ne sont plus
  pré-autorisés : ils demandent une confirmation.

**Recommandation au propriétaire (réglage hors dépôt) :** passer le connecteur MCP Supabase en
mode `read_only` (réglage du connecteur ou de l'URL du serveur MCP ; à vérifier dans la
documentation Supabase MCP). Les écritures sont alors refusées côté serveur, ce qui ne dépend plus
d'une analyse du texte SQL. À défaut, un rôle Postgres en lecture seule dédié aux agents donne la
même garantie. Le garde-fou du dépôt reste utile en défense en profondeur, mais un filtre sur du
texte n'est jamais exhaustif.

## Clore une action de supervision

Une action de supervision (relancer une source, corriger un test de fumée, ouvrir une alerte,
désactiver une collecte…) **n'est close que sur preuve** : la mesure qui l'avait déclenchée est
relue après l'action, et sa nouvelle valeur et sa date sont notées dans le compte-rendu ou l'incident
(par exemple `/api/health` à `ok`, `collection.ageHours` sous le seuil, un passage vert du test de
fumée). Une action « faite » dont la mesure n'a pas bougé reste ouverte : l'action Licitor du 23/10
(#293) n'avait pas résolu le retard de collecte.

Un spécialiste peut aussi être sollicité directement dans une session :
« Demande au seo-expert de vérifier la page /tribunaux. »
