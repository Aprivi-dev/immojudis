@AGENTS.md

# Immojudis

Plateforme d'exploration des ventes immobilières aux enchères en France : application
Next.js (App Router, React 19, Tailwind v4, Supabase, Mapbox, hébergée sur Vercel) et
pipeline de données Python dans `services/data-pipeline/`. Détails dans `README.md`.

## Vérifications avant de livrer du code

`npm ci` d'abord si `node_modules/` est absent, puis :

- `npx tsc --noEmit`
- `npm run lint`
- `npm test`
- `npm run test:security-invariants`

## Équipe d'agents

- `/equipe <mission>` lance le chef d'orchestre (`.claude/skills/equipe/`), qui délègue
  aux spécialistes de `.claude/agents/` et rend un compte-rendu à valider.
- Dans ce mode, seuls `developpeur` (code) et `redacteur-contenu` (contenus) modifient des
  fichiers, uniquement sur les points validés par l'utilisateur. Aucun agent n'écrit dans
  la base de production.
- Les comptes-rendus vont dans `docs/equipe/` (voir son `README.md`).
