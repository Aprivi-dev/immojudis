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

| Agent               | Rôle                                                               |
| ------------------- | ------------------------------------------------------------------ |
| `code-reviewer`     | Qualité, bugs, sécurité du code web (lecture seule)                |
| `data-pipeline`     | Revue du pipeline Python de collecte (lecture seule)               |
| `qualite-donnees`   | Exactitude des données affichées, SQL en lecture seule             |
| `ux-designer`       | Parcours, ergonomie, mobile, accessibilité (lecture seule)         |
| `seo-expert`        | Référencement (lecture seule)                                      |
| `juridique-rgpd`    | Mentions légales, CGU, RGPD, formulations à risque (lecture seule) |
| `testeur-qa`        | Tests des parcours, bugs reproductibles (ne modifie rien)          |
| `product-explorer`  | Nouvelles fonctionnalités (lecture seule)                          |
| `redacteur-contenu` | Propose des contenus ; les rédige seulement après validation       |
| `developpeur`       | Applique les points de code validés ; seul à modifier le code      |

Le garde-fou `.claude/hooks/supabase-lecture-seule.mjs` bloque toute requête SQL autre
qu'une lecture lancée par `qualite-donnees`.

Un spécialiste peut aussi être sollicité directement dans une session :
« Demande au seo-expert de vérifier la page /tribunaux. »
