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

| Agent                    | Rôle                                                               |
| ------------------------ | ------------------------------------------------------------------ |
| `code-reviewer`          | Qualité, bugs, sécurité du code web (lecture seule)                |
| `data-pipeline`          | Revue du pipeline Python de collecte (lecture seule)               |
| `qualite-donnees`        | Exactitude des données affichées, SQL en lecture seule             |
| `ux-designer`            | Parcours, ergonomie, mobile, accessibilité (lecture seule)         |
| `seo-expert`             | Référencement (lecture seule)                                      |
| `juridique-rgpd`         | Mentions légales, CGU, RGPD, formulations à risque (lecture seule) |
| `testeur-qa`             | Tests des parcours, bugs reproductibles (ne modifie rien)          |
| `product-explorer`       | Nouvelles fonctionnalités à partir du produit (lecture seule)      |
| `veille-concurrentielle` | Ce que font les concurrents, idées à reprendre (lecture seule)     |
| `performance-web`        | Vitesse : temps de chargement et d'affichage, Core Web Vitals      |
| `redacteur-contenu`      | Propose des contenus ; les rédige seulement après validation       |
| `developpeur`            | Applique les points de code validés ; seul à modifier le code      |

### Renforts spécialisés (lecture seule)

Adaptés le 19/10/2026 de [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents)
(licence MIT, voir `docs/equipe/licences/agency-agents-MIT.txt`). Ils analysent et proposent ;
comme le reste de l'équipe, ils ne modifient aucun fichier et n'écrivent jamais en base.

| Domaine                | Agents                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture et base   | `architecte-logiciel`, `expert-postgres`, `archeologue-code`, `api-publique`, `testeur-api`                                                  |
| Exploitation           | `devops-ci`, `fiabilite-sre`, `gestion-incidents`, `redacteur-technique`                                                                     |
| Sécurité et données    | `securite-applicative`, `audit-code-ia`, `protection-donnees-code` (technique ; le juridique reste à `juridique-rgpd`)                       |
| IA, modèles, chiffres  | `prompts-llm`, `qa-modeles`, `statisticien`, `analyste-spatial`, `visualisation-donnees`, `rapports-pdf`                                     |
| Carte et géographie    | `carte-web`, `cartographe`, `donnees-geographiques`, `qa-geographique`                                                                       |
| Utilisateurs et design | `recherche-utilisateurs`, `parcours-persona`, `audit-accessibilite`, `gardien-marque`, `synthese-retours`, `synthese-recherche`              |
| Produit et mesure      | `chef-de-produit`, `analyste-indicateurs`, `suivi-experiences`                                                                               |
| Paiements et prix      | `paiements-stripe`, `analyste-prix`                                                                                                          |
| Croissance             | `croissance`, `offres-acquisition`, `strategie-email`, `linkedin`, `relations-presse`, `publicite-search`, `aeo-fondations`, `visibilite-ia` |
| Entreprise et clients  | `strategie-entreprise`, `prospection-avocats`, `support-client`                                                                              |

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
