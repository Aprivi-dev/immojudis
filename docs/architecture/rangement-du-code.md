# Rangement du code

Critère permanent de l'équipe, décidé par le propriétaire le 11/11/2026. Il vaut pour tout lot de
code, qu'on l'écrive ou qu'on le relise. Cette page est le seul texte de référence : `CLAUDE.md` et
les définitions d'agents de `.claude/agents/` y renvoient sans la recopier. Les principes viennent
du skill `untangle-codebase` (`.claude/skills/untangle-codebase/`), reformulés pour Immojudis.

## La question

Devant deux morceaux de code, une seule question : **« ces morceaux doivent-ils changer
ensemble ? »** Si oui, ils sont rangés ensemble et le code le montre. Si non, rien ne les lie. Et
chaque morceau ne dépend que de ce qui change moins souvent que lui.

## Trois défauts à ne pas introduire, et à signaler en relecture

- **Liens cachés** : des morceaux qui doivent changer ensemble sans que rien ne le dise. Une règle
  ou une valeur copiée à plusieurs endroits ; un ordre d'appel que l'appelant doit deviner ; une
  fonctionnalité éclatée par couche technique dans plusieurs dossiers.
- **Liens inutiles** : des morceaux attachés alors qu'ils changent pour des raisons différentes.
  Un module qui dépend des détails internes d'un autre ; du code stable qui importe du code plus
  changeant que lui ; un paramètre qui ne sert qu'à un seul appelant.
- **Superflu** : ce qui n'a aucune raison propre de changer. Un emballage qui ne fait que
  transmettre ; un point d'extension pour quelque chose qui ne varie jamais ; du code mort.

## Cas particuliers

Un cas particulier est du code écrit pour une seule situation au lieu de découler du
fonctionnement général : un `if` pour une seule valeur, un paramètre pour un seul appelant, une
exception avalée, une attente ou une nouvelle tentative, un test désactivé. Chacun signale un
besoin que la conception n'avait pas prévu. On n'en ajoute pas sans dire pourquoi la conception ne
peut pas l'absorber. En relecture, on les relève.

Les nouvelles tentatives et les attentes vers un service externe (Replicate, IGN, sources
collectées) sont légitimes : le service peut échouer sans que notre conception y soit pour rien.
Elles ne se relèvent pas comme un défaut.

## Ce que le critère ne remet pas en cause

Le rangement existant du dépôt prime : il est organisé par couche (`src/lib`, `src/components`,
fichiers `*.server.ts`). Le critère ne justifie pas de déplacer des fichiers. Un déplacement ne se
fait que dans une refonte validée.

Ranger une nouvelle fonctionnalité selon ces couches n'est donc pas un défaut et ne se relève pas.
Le lien caché « éclatée par couche » vise le cas où un lot disperse une fonctionnalité au-delà de
ce que ce rangement impose : un nouveau dossier ou une nouvelle couche que le dépôt n'avait pas.

## Selon le rôle

- **Qui écrit** (`developpeur`) : applique le critère dans le périmètre du lot seulement. Pas de
  refonte opportuniste : un défaut vu hors périmètre se signale dans le compte-rendu, il ne se
  corrige pas en passant. Un cas particulier ajouté est justifié dans le compte-rendu.
- **Qui relit ou audite** (`code-reviewer`, `archeologue-code`, `architecte-logiciel`) : relève
  les défauts décrits ci-dessus et ajoute à chaque point la mention « à corriger » quand le lot
  ou l'option examinés l'introduisent, « à noter » quand il préexiste.

« À corriger » et « à noter » ne sont pas des priorités : chaque agent garde son échelle
habituelle. Ces mentions ne déclenchent pas à elles seules le renvoi à l'auteur prévu pour un
point Critique.

## Refonte complète

Ce critère ne lance aucune refonte. La refonte d'une zone entière passe par le skill
`/untangle-codebase`, dont la règle d'usage est dans `CLAUDE.md` (section « Rangement du code »).
