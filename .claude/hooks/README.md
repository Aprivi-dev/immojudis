# Crochets du projet

Déclarés dans `.claude/settings.json` (`PreToolUse`) ; le premier l'est aussi dans l'en-tête de
l'agent `qualite-donnees`. Un crochet qui sort en code 2 bloque l'appel d'outil.

| Script                          | Outils visés                                                                                                                                                                                                                                  | Effet                                                                                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `supabase-lecture-seule.mjs`    | `mcp__Supabase__execute_sql`                                                                                                                                                                                                                  | N'autorise que SELECT / WITH / EXPLAIN sans mot-clé d'écriture et dont chaque appel de fonction figure dans une liste blanche de fonctions de lecture pure. |
| `bloquer-ecriture-supabase.mjs` | `apply_migration`, `deploy_edge_function`, `create_edge_function_secret`, `create_branch`, `delete_branch`, `merge_branch`, `reset_branch`, `rebase_branch`, `create_project`, `pause_project`, `restore_project` (préfixe `mcp__Supabase__`) | Bloque toujours : « interdit : aucun agent n'écrit dans la base ; passez par une migration et la CI ».                                                      |

Tests : `scripts/supabase-lecture-seule.test.mjs` et `scripts/bloquer-ecriture-supabase.test.mjs`.

## Échec fermé

Claude Code ne bloque un appel que pour le code de sortie 2 ; tout autre code non nul (crash du
script, `node` introuvable = 127, fichier absent = 1) est une erreur « non bloquante » et l'outil
s'exécute. Deux protections :

- les scripts attrapent toute erreur interne, toute entrée illisible et toute requête vide, et
  sortent en code 2 avec un message ;
- les commandes déclarées sont de la forme `node "…/script.mjs" || exit 2` : si `node` est absent
  ou si le script ne se lance pas, le shell sort quand même en code 2 et l'appel est bloqué. Le
  script ne peut pas traiter ce cas lui-même (il ne s'exécute pas) ; il faut donc conserver le
  `|| exit 2` si la commande est modifiée.

Le chemin utilise `${CLAUDE_PROJECT_DIR:-.}` pour ne pas dépendre du répertoire courant.

## Ajouter une fonction à la liste blanche SQL

Dans `supabase-lecture-seule.mjs` : fonction native de lecture pure dans `ALLOWED_FUNCTIONS` ;
fonction Immojudis dans `ALLOWED_PROJECT_FUNCTIONS`, qualifiée du schéma, seulement après avoir
vérifié dans les migrations qu'elle est `stable` ou `immutable`, qu'elle n'écrit pas et que les
fonctions qu'elle appelle sont de même nature. Ajouter un cas au test.

Limites connues : `EXPLAIN ANALYZE` est refusé (il exécute la requête) ; les listes de colonnes
d'alias ne sont acceptées qu'avec `AS` (`as t(a, b)`) et pour la première CTE
(`with recursive t(n) as …`) ; un identifiant entre guillemets suivi d'une parenthèse est refusé.
Ce garde-fou analyse du texte : la protection de fond reste de passer le connecteur MCP Supabase en
`read_only` (voir `docs/equipe/README.md`).
