# Ménage des worktrees git — 2026-11-07

## Worktrees supprimés

Aucun.

## Constat

`git worktree list` ne montre qu'un seul worktree :

| Chemin | Branche | Commit | Fusionnée dans `origin/main` |
|---|---|---|---|
| `/home/user/immojudis` | `claude/cleanup-merged-worktrees-f6zr63` | `0f0ff87` | oui (même commit que `origin/main`, aucun commit propre) |

- C'est le **worktree principal** du dépôt : git refuse de le supprimer
  (`git worktree remove` ne s'applique qu'aux worktrees liés), et le supprimer
  reviendrait à effacer le dépôt lui-même. Il est donc conservé.
- Aucun worktree lié : le répertoire `.git/worktrees/` n'existe pas.
- Aucun worktree orphelin : `git worktree prune --dry-run -v` ne signale rien.

## Ce qui n'a pas été touché

- Aucune branche locale ou distante (`main`, `claude/cleanup-merged-worktrees-f6zr63`,
  `origin/*`) n'a été modifiée, supprimée ni déplacée.
- Aucun fichier non commité n'a été modifié : l'arbre de travail était propre avant
  l'opération ; seul ce fichier `MENAGE.md` a été ajouté.
- `MENAGE.md` est commité sur la branche de travail `claude/cleanup-merged-worktrees-f6zr63`
  (le flux normal de la session : commit, push, PR en brouillon). Ce commit est le seul
  changement apporté à une branche ; `main` et les autres branches sont intactes.
