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

## Rangement du code

Critère permanent pour qui écrit ou relit du code. Une seule question : « ces morceaux
doivent-ils changer ensemble ? » Ne pas introduire, et relever en relecture, les liens cachés,
les liens inutiles, le superflu et les cas particuliers non justifiés. Définitions et règles par
rôle : `docs/architecture/rangement-du-code.md` (seul texte de référence).

### Refonte complète : `/untangle-codebase`

Le skill est dans `.claude/skills/untangle-codebase/` (origine et licence dans son `NOTICE.md`).
Seul le propriétaire le lance (`disable-model-invocation: true`) ; le chef d'orchestre en
applique ensuite les étapes, avec les limites suivantes.

- **Une zone nommée à la fois**, donnée en argument. Sans zone en argument, on s'arrête et on
  demande. Jamais tout le dépôt d'un coup, ni pendant qu'un lot en cours touche la même zone.
- **Pas avant le lot R2** : la refonte par zone ne commence qu'après la mise en ligne du lot R2 du
  registre des pièces.
- **Étapes 2 et 3** (liste des problèmes, corrections proposées) : elles forment le compte-rendu
  numéroté à valider. Puis arrêt.
- **Étape 4** (corrections) : confiée à `developpeur`, sur les numéros validés seulement, puis
  relue par le circuit habituel.
- **Étape 5** (nouvelle recherche) : elle produit une nouvelle liste à valider. Jamais de boucle
  automatique.
- **Commentaires** : ceux qui répètent le code peuvent être supprimés. Ceux qui expliquent un
  pourquoi ne le sont que sur une liste validée par le propriétaire.
- **Tests** : aucune suppression sans liste nominative validée par le propriétaire, et en dernier.
  `npm run test:security-invariants` et `supabase/tests/` sont exclus, sauf accord explicite.
