#!/bin/bash
# Inventaire en LECTURE SEULE des tâches planifiées de la session macOS courante.
#
# Écrit TACHES.md : chaque ligne de `crontab -l` et chaque tâche de `launchctl list`
# qui ne vient pas d'Apple, avec ce qu'elle lance et sa dernière exécution quand
# une trace existe.
#
# Ce script ne désactive, ne décharge et ne modifie rien. Il n'appelle que :
#   crontab -l, launchctl list, launchctl print, PlistBuddy -c Print, stat, log show.
#
# Usage (sur le Mac, dans le dossier du dépôt) :
#   bash scripts/lister-taches.sh              # écrit ./TACHES.md
#   bash scripts/lister-taches.sh --journal    # cherche aussi les lancements des
#                                              # 7 derniers jours dans le journal
#                                              # système (plus lent, ~1 min)
#   bash scripts/lister-taches.sh --sortie /chemin/TACHES.md
#
# Compatible avec le bash 3.2 livré avec macOS.

set -u

SORTIE="./TACHES.md"
JOURNAL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --journal) JOURNAL=1 ;;
    --sortie) shift; SORTIE="${1:?--sortie attend un chemin}" ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "Option inconnue : $1" >&2; exit 2 ;;
  esac
  shift
done

PLISTBUDDY="${PLISTBUDDY:-/usr/libexec/PlistBuddy}"
UID_COURANT="$(id -u)"
UTILISATEUR="$(id -un)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/lister-taches.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# --- Outils -----------------------------------------------------------------

# Masque les valeurs de variables qui ressemblent à des secrets.
masquer() {
  if command -v perl >/dev/null 2>&1; then
    perl -pe 's/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD)[A-Za-z0-9_]*=)("[^"]*"|\x27[^\x27]*\x27|\S+)/$1***/gi'
  else
    cat
  fi
}

# Rend une valeur sûre pour une cellule de tableau Markdown.
cellule() {
  local v="$1" tilde='~/'
  v="${v//"$HOME"\//$tilde}"
  printf '%s' "$v" | tr '\n\t' '  ' | sed -e 's/|/\\|/g' -e 's/`/'"'"'/g' -e 's/  */ /g' -e 's/^ //' -e 's/ $//'
}

# Date de dernière modification d'un fichier, ou rien.
date_fichier() {
  [ -e "$1" ] || return 0
  stat -f '%Sm' -t '%Y-%m-%d %H:%M' "$1" 2>/dev/null \
    || date -r "$1" '+%Y-%m-%d %H:%M' 2>/dev/null
}

developper_chemin() {
  case "$1" in
    "~/"*) printf '%s' "$HOME/${1#\~/}" ;;
    '$HOME/'*) printf '%s' "$HOME/${1#\$HOME/}" ;;
    '${HOME}/'*) printf '%s' "$HOME/${1#\$\{HOME\}/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

pb() { "$PLISTBUDDY" -c "Print :$1" "$2" 2>/dev/null; }

# Ce que lance un plist : Program ou ProgramArguments joints par des espaces.
commande_plist() {
  local f="$1" prog args="" i=0 a
  prog="$(pb Program "$f")"
  while a="$(pb "ProgramArguments:$i" "$f")"; do
    args="${args:+$args }$a"
    i=$((i + 1))
  done
  if [ -n "$prog" ] && [ -n "$args" ]; then
    printf '%s (arguments : %s)' "$prog" "$args"
  else
    printf '%s' "${prog:-$args}"
  fi
}

# Quand le plist se déclenche.
declencheur_plist() {
  local f="$1" out="" v
  v="$(pb StartInterval "$f")" && out="toutes les ${v} s"
  if v="$(pb StartCalendarInterval "$f")"; then
    v="$(printf '%s' "$v" | tr -s ' \n' ' ' | sed -e 's/Dict {//g' -e 's/Array {//g' -e 's/}//g' -e 's/ = /=/g')"
    out="${out:+$out ; }calendrier :$v"
  fi
  [ "$(pb RunAtLoad "$f")" = "true" ] && out="${out:+$out ; }au chargement"
  v="$(pb KeepAlive "$f")" && [ "$v" != "false" ] && out="${out:+$out ; }maintenue en vie"
  pb WatchPaths "$f" >/dev/null && out="${out:+$out ; }si un fichier surveillé change"
  pb QueueDirectories "$f" >/dev/null && out="${out:+$out ; }si un dossier se remplit"
  printf '%s' "${out:-non précisé}"
}

# --- Journal système (facultatif) ---------------------------------------------

if [ "$JOURNAL" = 1 ]; then
  echo "Lecture du journal système des 7 derniers jours (peut prendre une minute)..." >&2
  log show --last 7d --style syslog \
    --predicate 'process == "launchd" AND (eventMessage CONTAINS "spawned" OR eventMessage CONTAINS "exited")' \
    > "$TMP/launchd.log" 2>/dev/null || true
  log show --last 7d --style syslog --predicate 'process == "cron"' \
    > "$TMP/cron.log" 2>/dev/null || true
fi

dernier_journal_launchd() {
  [ -s "$TMP/launchd.log" ] || return 0
  grep -F "/$1 " "$TMP/launchd.log" | tail -n 1 | cut -c1-19
}

# --- crontab -l ---------------------------------------------------------------

{
  printf '## crontab -l (utilisateur %s)\n\n' "$UTILISATEUR"
  if ! crontab -l > "$TMP/crontab" 2>"$TMP/crontab.err"; then
    printf 'Aucune crontab pour cet utilisateur (%s).\n\n' "$(cellule "$(cat "$TMP/crontab.err")")"
  else
    printf '| # | Quand | Ce qu'"'"'elle lance | Dernière exécution trouvée |\n'
    printf '|---|---|---|---|\n'
    n=0
    variables=""
    while IFS= read -r ligne || [ -n "$ligne" ]; do
      ligne="$(printf '%s' "$ligne" | sed -e 's/^[[:space:]]*//')"
      case "$ligne" in ''|'#'*) continue ;; esac
      case "$ligne" in
        [A-Za-z_]*=*)
          variables="${variables:+$variables ; }$(printf '%s' "$ligne" | masquer)"
          continue ;;
      esac
      case "$ligne" in
        @*) read -r quand cmd <<EOF
$ligne
EOF
          ;;
        *) read -r m h j mo js cmd <<EOF
$ligne
EOF
          quand="$m $h $j $mo $js" ;;
      esac
      n=$((n + 1))

      derniere=""
      # 1. Fichier où la tâche écrit sa sortie (>> fichier ou > fichier).
      cible="$(printf '%s' "$cmd" | grep -oE '>>?[[:space:]]*[^[:space:];&|<>]+' | grep -v '&' | tail -n 1 | sed -E 's/^>>?[[:space:]]*//')"
      if [ -n "$cible" ] && [ "$cible" != "/dev/null" ]; then
        cible="$(developper_chemin "$cible")"
        d="$(date_fichier "$cible")"
        [ -n "$d" ] && derniere="$d (modification de $cible)"
      fi
      # 2. Courrier envoyé par cron quand la sortie n'est pas redirigée.
      if [ -z "$derniere" ] && [ -r "/var/mail/$UTILISATEUR" ]; then
        aiguille="$(printf '%s' "$cmd" | cut -c1-40)"
        d="$(awk -v a="$aiguille" '/^Date: /{dt=substr($0,7)} /^Subject: Cron </ && index($0,a){last=dt} END{print last}' "/var/mail/$UTILISATEUR")"
        [ -n "$d" ] && derniere="$d (courrier de cron)"
      fi
      # 3. Journal système (--journal).
      if [ -z "$derniere" ] && [ -s "$TMP/cron.log" ]; then
        d="$(grep -F "$(printf '%s' "$cmd" | cut -c1-40)" "$TMP/cron.log" | tail -n 1 | cut -c1-19)"
        [ -n "$d" ] && derniere="$d (journal système)"
      fi
      [ -z "$derniere" ] && derniere="introuvable (cron ne garde pas d'historique sur macOS)"

      printf '| %s | `%s` | `%s` | %s |\n' "$n" "$(cellule "$quand")" "$(cellule "$(printf '%s' "$cmd" | masquer)")" "$(cellule "$derniere")"
    done < "$TMP/crontab"
    [ "$n" = 0 ] && printf '| - | - | crontab vide | - |\n'
    printf '\n'
    [ -n "$variables" ] && printf 'Variables définies dans la crontab : `%s`\n\n' "$(cellule "$variables")"
  fi
} > "$TMP/section-cron.md"

# --- launchctl list -------------------------------------------------------------

# Index des plists : label -> fichier, pour les dossiers où l'on installe des tâches.
: > "$TMP/plists"
for dossier in "$HOME/Library/LaunchAgents" /Library/LaunchAgents /Library/LaunchDaemons; do
  for f in "$dossier"/*.plist; do
    [ -f "$f" ] || continue
    l="$(pb Label "$f")" || continue
    printf '%s\t%s\n' "$l" "$f" >> "$TMP/plists"
  done
done

launchctl list > "$TMP/launchctl" 2>/dev/null || true

ligne_launchd() {
  local pid="$1" statut="$2" label="$3" f="$4" cmd quand derniere d info runs code sortie
  if [ -n "$f" ]; then
    cmd="$(commande_plist "$f")"
    quand="$(declencheur_plist "$f")"
  else
    cmd="(aucun plist trouvé ; voir launchctl print gui/$UID_COURANT/$label)"
    quand="-"
  fi

  derniere=""
  if [ "$pid" != "-" ]; then
    derniere="en cours maintenant (PID $pid)"
  fi
  info="$(launchctl print "gui/$UID_COURANT/$label" 2>/dev/null)"
  runs="$(printf '%s\n' "$info" | sed -n 's/^[[:space:]]*runs = //p' | head -n 1)"
  code="$(printf '%s\n' "$info" | sed -n 's/^[[:space:]]*last exit code = //p' | head -n 1)"
  d="$(dernier_journal_launchd "$label")"
  [ -n "$d" ] && derniere="${derniere:+$derniere ; }dernier lancement journalisé : $d"
  if [ -n "$f" ]; then
    for cle in StandardOutPath StandardErrorPath; do
      sortie="$(pb "$cle" "$f")" || continue
      d="$(date_fichier "$(developper_chemin "$sortie")")"
      [ -n "$d" ] && derniere="${derniere:+$derniere ; }$d (modification de $sortie)"
    done
  fi
  [ -n "$runs" ] && derniere="${derniere:+$derniere ; }$runs lancement(s) depuis l'ouverture de session"
  [ -z "$derniere" ] && derniere="introuvable"
  [ -z "$code" ] && code="$statut"

  printf '| `%s` | `%s` | %s | %s | %s | %s |\n' \
    "$(cellule "$label")" "$(cellule "$(printf '%s' "$cmd" | masquer)")" "$(cellule "$quand")" \
    "$(cellule "$derniere")" "$(cellule "$code")" "$(cellule "${f:-?}")"
}

ENTETE='| Label | Ce qu'"'"'elle lance | Quand | Dernière exécution trouvée | Dernier code de sortie | Fichier |\n|---|---|---|---|---|---|\n'

: > "$TMP/vous.md"; : > "$TMP/autres.md"; : > "$TMP/charges"
while IFS="$(printf '\t')" read -r pid statut label; do
  [ "$label" = "Label" ] && continue
  [ -n "$label" ] || continue
  case "$label" in
    com.apple.*|application.*|0x*|[0-9]*) continue ;;  # Apple, applis ouvertes, entrées anonymes
  esac
  printf '%s\n' "$label" >> "$TMP/charges"
  f="$(awk -F '\t' -v l="$label" '$1==l{print $2; exit}' "$TMP/plists")"
  case "$f" in
    "$HOME/Library/LaunchAgents/"*) ligne_launchd "$pid" "$statut" "$label" "$f" >> "$TMP/vous.md" ;;
    *) ligne_launchd "$pid" "$statut" "$label" "$f" >> "$TMP/autres.md" ;;
  esac
done < "$TMP/launchctl"

# Plists de ~/Library/LaunchAgents présents mais absents de launchctl list.
: > "$TMP/non-charges.md"
awk -F '\t' -v h="$HOME/Library/LaunchAgents/" 'index($2,h)==1' "$TMP/plists" | while IFS="$(printf '\t')" read -r l f; do
  grep -qxF "$l" "$TMP/charges" && continue
  printf '| `%s` | `%s` | %s | %s |\n' "$(cellule "$l")" "$(cellule "$(commande_plist "$f" | masquer)")" "$(cellule "$(declencheur_plist "$f")")" "$(cellule "$f")" >> "$TMP/non-charges.md"
done

# --- Écriture de TACHES.md ------------------------------------------------------

{
  printf '# Tâches planifiées de %s sur %s\n\n' "$UTILISATEUR" "$(scutil --get ComputerName 2>/dev/null || hostname)"
  printf 'Inventaire généré le %s par `scripts/lister-taches.sh`, en lecture seule : rien n'"'"'a été désactivé ni modifié.\n' "$(date '+%Y-%m-%d %H:%M')"
  [ "$JOURNAL" = 1 ] && printf 'Le journal système des 7 derniers jours a été consulté.\n'
  printf '\nLes valeurs qui ressemblent à des secrets (KEY, TOKEN, SECRET, PASSWORD...) sont masquées par `***`.\n\n'
  cat "$TMP/section-cron.md"
  printf '## launchctl list : vos tâches (plist dans ~/Library/LaunchAgents)\n\n'
  if [ -s "$TMP/vous.md" ]; then printf "$ENTETE"; cat "$TMP/vous.md"; else printf 'Aucune.\n'; fi
  printf '\n## launchctl list : autres tâches non Apple\n\n'
  printf 'Installées par une application ou un administrateur (/Library) ou sans plist retrouvé. À vérifier : certaines peuvent venir de vous.\n\n'
  if [ -s "$TMP/autres.md" ]; then printf "$ENTETE"; cat "$TMP/autres.md"; else printf 'Aucune.\n'; fi
  if [ -s "$TMP/non-charges.md" ]; then
    printf '\n## Plists de ~/Library/LaunchAgents absents de launchctl list\n\n'
    printf 'Présents sur le disque mais pas chargés dans la session : ils ne tournent pas actuellement.\n\n'
    printf '| Label | Ce qu'"'"'il lancerait | Quand | Fichier |\n|---|---|---|---|\n'
    cat "$TMP/non-charges.md"
  fi
  printf '\n## Comment lire la dernière exécution\n\n'
  printf -- '- cron sur macOS ne garde pas d'"'"'historique : la date vient du fichier où la tâche écrit, du courrier local de cron ou, avec `--journal`, du journal système.\n'
  printf -- '- launchd donne le nombre de lancements depuis l'"'"'ouverture de session et le dernier code de sortie (0 = succès), pas la date : la date vient des fichiers de sortie déclarés dans le plist ou, avec `--journal`, du journal système.\n'
} > "$SORTIE"

echo "Écrit : $SORTIE" >&2
echo "Relisez-le avant de le partager ou de le committer : les commandes peuvent contenir des chemins ou des informations personnelles." >&2
