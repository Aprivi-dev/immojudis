# Tâches planifiées (crontab et launchd)

**Statut : pas encore rempli.** La liste doit être générée sur le Mac.

`crontab -l` et `launchctl list` ne lisent que la machine sur laquelle ils tournent. Cet
inventaire a été préparé depuis une session cloud (Linux, sans `launchctl`, sans accès
à votre Mac), et le dépôt ne déclare aucune tâche cron ni launchd. Aucune tâche n'est
donc listée ici pour l'instant : la liste n'a pas été inventée.

## Générer la liste

Sur le Mac, dans le dossier du dépôt :

```bash
bash scripts/lister-taches.sh            # remplace ce fichier par l'inventaire
bash scripts/lister-taches.sh --journal  # ajoute les lancements des 7 derniers jours (~1 min)
```

Le script est en lecture seule. Il n'appelle que `crontab -l`, `launchctl list`,
`launchctl print`, `PlistBuddy -c Print`, `stat` et `log show`. Il ne désactive, ne décharge
et ne modifie aucune tâche : c'est vous qui décidez ensuite.

## Ce que contiendra le fichier

- **crontab -l** : chaque ligne avec sa planification, la commande lancée, et la dernière
  exécution retrouvée (date du fichier où la tâche écrit, courrier local de cron, ou
  journal système avec `--journal`).
- **launchctl list, vos tâches** : celles dont le plist est dans `~/Library/LaunchAgents`,
  avec la commande (`Program` / `ProgramArguments`), le déclencheur (horaire, intervalle,
  au chargement...), la dernière exécution (en cours, date des fichiers de sortie,
  journal système, nombre de lancements depuis l'ouverture de session) et le dernier code
  de sortie.
- **launchctl list, autres tâches non Apple** : installées par une application ou dans
  `/Library`, séparées pour que vous puissiez trier ce qui vient de vous. Les entrées
  `com.apple.*` et les applications ouvertes (`application.*`) sont écartées.
- **Plists non chargés** de `~/Library/LaunchAgents`, à titre d'information.

Les valeurs qui ressemblent à des secrets (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`)
sont remplacées par `***`. Relisez quand même le fichier généré avant de le committer :
les commandes peuvent contenir des chemins ou des informations personnelles.
