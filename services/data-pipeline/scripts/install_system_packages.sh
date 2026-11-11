#!/usr/bin/env bash
# Install system packages with apt, resistant to a short network outage and quick to fail on a
# lasting one.
#
# Incident of 11/11/2026 (docs/audits/2026-11-11-collecte-echec-avant-demarrage.md): the runner could
# not resolve its apt mirror. `apt-get update` only printed warnings and returned 0, then
# `apt-get install` retried each archive for six minutes before failing: nine minutes lost, and the
# pipeline never started.
#
# What this script does instead:
#   1. network phase (`apt-get update`, then `apt-get install --download-only`): a few attempts with a
#      growing wait between them, every command under a hard `timeout`, and the whole phase under one
#      deadline (150 s by default). An index that cannot be fetched is an error that triggers a new
#      attempt, not a warning. On the last attempt only, the download is still tried with the indexes
#      at hand: a broken repository that these packages do not need (the runner image declares
#      several) must not stop the job, as it did not before.
#   2. local phase (`apt-get install --no-download`): unpacks what was downloaded, without network.
#      It is not retried and never interrupted by the network deadline, so dpkg is never killed in
#      the middle of a configuration because of a slow mirror.
# A lasting outage ends with a non-zero code and an explicit ::error:: annotation: nothing is
# swallowed.
#
# Usage: bash scripts/install_system_packages.sh PACKAGE [PACKAGE...]
#
# Settings (environment, whole seconds):
#   SYSTEM_PACKAGES_MAX_ATTEMPTS       attempts of the network phase            (default 3)
#   SYSTEM_PACKAGES_BACKOFF_SECONDS    wait before attempt n+1 = n x this value (default 10)
#   SYSTEM_PACKAGES_DEADLINE_SECONDS   budget of the whole network phase        (default 150)
#   SYSTEM_PACKAGES_UPDATE_TIMEOUT     one `apt-get update`                     (default 40)
#   SYSTEM_PACKAGES_DOWNLOAD_TIMEOUT   one `apt-get install --download-only`    (default 60)
#   SYSTEM_PACKAGES_INSTALL_TIMEOUT    the local `apt-get install`              (default 300)
#   SYSTEM_PACKAGES_APT_COMMAND        command used instead of apt-get, run without sudo (the tests
#                                      point it at a stand-in)
set -uo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: install_system_packages.sh PACKAGE [PACKAGE...]" >&2
  exit 64
fi

positive_integer() {
  # $1: name, $2: value, $3: smallest accepted value
  if ! [[ "$2" =~ ^[0-9]+$ ]] || [ "$2" -lt "$3" ]; then
    echo "install_system_packages.sh: $1 must be a whole number >= $3 (got '$2')" >&2
    exit 64
  fi
}

max_attempts="${SYSTEM_PACKAGES_MAX_ATTEMPTS:-3}"
backoff="${SYSTEM_PACKAGES_BACKOFF_SECONDS:-10}"
deadline="${SYSTEM_PACKAGES_DEADLINE_SECONDS:-150}"
update_timeout="${SYSTEM_PACKAGES_UPDATE_TIMEOUT:-40}"
download_timeout="${SYSTEM_PACKAGES_DOWNLOAD_TIMEOUT:-60}"
install_timeout="${SYSTEM_PACKAGES_INSTALL_TIMEOUT:-300}"
positive_integer SYSTEM_PACKAGES_MAX_ATTEMPTS "$max_attempts" 1
positive_integer SYSTEM_PACKAGES_BACKOFF_SECONDS "$backoff" 0
positive_integer SYSTEM_PACKAGES_DEADLINE_SECONDS "$deadline" 1
positive_integer SYSTEM_PACKAGES_UPDATE_TIMEOUT "$update_timeout" 1
positive_integer SYSTEM_PACKAGES_DOWNLOAD_TIMEOUT "$download_timeout" 1
positive_integer SYSTEM_PACKAGES_INSTALL_TIMEOUT "$install_timeout" 1

# `timeout` runs inside sudo, next to apt-get: it can then stop apt-get and its download helpers
# itself (sudo cannot relay a SIGKILL).
launcher=(env DEBIAN_FRONTEND=noninteractive)
if [ -n "${SYSTEM_PACKAGES_APT_COMMAND:-}" ]; then
  read -r -a apt_command <<< "$SYSTEM_PACKAGES_APT_COMMAND"
else
  apt_command=(apt-get)
  if [ "$(id -u)" -ne 0 ]; then
    launcher=(sudo env DEBIAN_FRONTEND=noninteractive)
  fi
fi

# One retry inside apt for a single lost connection; the loop below owns the real retry policy.
# Without Error-Mode=any, an index that cannot be fetched only prints a warning and the command
# returns 0.
network_options=(
  -o Acquire::Retries=1
  -o Acquire::http::Timeout=15
  -o Acquire::https::Timeout=15
  -o DPkg::Lock::Timeout=30
)

SECONDS=0

remaining() {
  echo $((deadline - SECONDS))
}

# Run one network command under the smaller of its own timeout and what is left of the deadline.
bounded() {
  local limit="$1"
  shift
  local left
  left="$(remaining)"
  if [ "$left" -le 0 ]; then
    return 124
  fi
  if [ "$limit" -gt "$left" ]; then
    limit="$left"
  fi
  "${launcher[@]}" timeout --kill-after=5 "$limit" "${apt_command[@]}" "$@"
}

index_incomplete=false

# $1: "true" on the last attempt, then the packages.
fetch_once() {
  local last_attempt="$1"
  shift
  local code=0
  index_incomplete=false
  bounded "$update_timeout" update "${network_options[@]}" -o APT::Update::Error-Mode=any || code=$?
  if [ "$code" -ne 0 ]; then
    if [ "$last_attempt" != "true" ]; then
      return "$code"
    fi
    index_incomplete=true
    echo "Paquets système : index apt incomplet (code ${code}), dernier essai de téléchargement avec les index disponibles."
  fi
  bounded "$download_timeout" install -y --download-only "${network_options[@]}" "$@"
}

attempt=1
fetched=false
last_code=0
while [ "$attempt" -le "$max_attempts" ]; do
  echo "Paquets système : téléchargement, tentative ${attempt}/${max_attempts} (${SECONDS} s écoulées sur ${deadline})."
  is_last=false
  if [ "$attempt" -ge "$max_attempts" ]; then
    is_last=true
  fi
  fetch_once "$is_last" "$@"
  last_code=$?
  if [ "$last_code" -eq 0 ]; then
    fetched=true
    break
  fi
  if [ "$last_code" -eq 124 ] || [ "$last_code" -eq 137 ]; then
    echo "Paquets système : tentative ${attempt} interrompue par le délai d'attente."
  else
    echo "Paquets système : tentative ${attempt} en échec (code ${last_code})."
  fi
  if [ "$attempt" -ge "$max_attempts" ]; then
    break
  fi
  wait_seconds=$((backoff * attempt))
  if [ $((SECONDS + wait_seconds)) -ge "$deadline" ]; then
    echo "Paquets système : plus assez de temps pour une nouvelle tentative."
    break
  fi
  echo "Paquets système : nouvelle tentative dans ${wait_seconds} s."
  sleep "$wait_seconds"
  attempt=$((attempt + 1))
done

if [ "$fetched" != "true" ]; then
  echo "::error title=Installation des paquets système impossible::Téléchargement des paquets ($*) en échec après ${attempt} tentative(s) et ${SECONDS} s (dernier code ${last_code}) : panne du réseau ou du miroir apt du runner. Rien n'a été installé, le pipeline ne démarre pas."
  if [ "$last_code" -eq 0 ]; then
    last_code=1
  fi
  exit "$last_code"
fi

if [ "$index_incomplete" = "true" ]; then
  echo "::warning title=Index apt incomplet::Un dépôt apt du runner ne répond pas ; les paquets ($*) ont été téléchargés avec les index disponibles."
fi
echo "Paquets système : installation locale (sans réseau)."
"${launcher[@]}" timeout --kill-after=10 "$install_timeout" "${apt_command[@]}" \
  install -y --no-download -o DPkg::Lock::Timeout=30 "$@"
code=$?
if [ "$code" -ne 0 ]; then
  echo "::error title=Installation des paquets système impossible::Les paquets ($*) sont téléchargés mais leur installation locale a échoué (code ${code})."
  exit "$code"
fi
echo "Paquets système installés en ${SECONDS} s (${attempt} tentative(s) de téléchargement)."
