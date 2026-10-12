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

| Agent              | Rôle                                                       |
| ------------------ | ---------------------------------------------------------- |
| `code-reviewer`    | Qualité, bugs, sécurité du code (lecture seule)            |
| `ux-designer`      | Parcours, ergonomie, mobile, accessibilité (lecture seule) |
| `seo-expert`       | Référencement (lecture seule)                              |
| `product-explorer` | Nouvelles fonctionnalités (lecture seule)                  |
| `developpeur`      | Applique les points validés, le seul qui modifie le code   |

Un spécialiste peut aussi être sollicité directement dans une session :
« Demande au seo-expert de vérifier la page /tribunaux. »
