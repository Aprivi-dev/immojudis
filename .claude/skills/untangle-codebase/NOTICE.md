# Skill `untangle-codebase` : origine et règle d'usage

## Origine

- Source : <https://github.com/caldoai/skills>, dossier `skills/untangle-codebase`.
- Licence : MIT, « Copyright (c) 2026 Maze » (voir `LICENSE` dans ce dossier).
- Copié le 11/11/2026. `SKILL.md` est la copie à l'identique du fichier d'origine : ne pas le
  reformater ni le traduire, pour pouvoir le comparer à sa source.

## Règle d'usage (décision du propriétaire, 11/11/2026)

`/untangle-codebase` lance une refonte complète du code. La règle ci-dessous est aussi écrite
dans `CLAUDE.md` à la racine du dépôt, qui fait foi si les deux textes divergent.

- Il ne se lance que sur demande explicite du propriétaire.
- Une zone nommée à la fois, donnée en argument du skill. Jamais tout le dépôt d'un coup, ni
  pendant qu'un lot en cours touche la même zone.
- Dans le mode `/equipe`, c'est le chef d'orchestre qui le déclenche après validation ; les
  changements passent par `developpeur` et par le circuit de relecture habituel.
- Les deux options que le skill propose au lancement : suppression des commentaires qui
  répètent le code, oui ; suppression des tests qui ne détecteraient aucun défaut, oui, mais
  en dernier et avec prudence.

## Ce qui s'applique dès maintenant, et ce qui attend

- Les principes du skill sont un critère permanent pour qui écrit ou relit du code : voir
  `docs/architecture/rangement-du-code.md`.
- La refonte complète n'est pas lancée. Elle le sera plus tard, zone par zone, une fois le lot R2
  du registre des pièces en ligne.
