import { createInterface } from "node:readline/promises";

/**
 * Garde de `npm run release:prepare` : ce script ÉCRIT EN PRODUCTION (migrations Supabase,
 * planificateur de santé dans Vault, publication des modèles de valorisation). Il demande une
 * confirmation avant tout. Sans terminal interactif (CI, redirection), la confirmation doit être
 * donnée par `RELEASE_PREPARE_CONFIRM=production`.
 */
export const CONFIRMATION_WORD = "production";

const URL_VARIABLES = ["SUPABASE_DB_URL", "POSTGRES_URL_NON_POOLING", "POSTGRES_URL"];

/** Hôte de la base ciblée (jamais l'identifiant ni le mot de passe), ou null. */
export function targetDatabaseHost(env) {
  for (const name of URL_VARIABLES) {
    const value = env[name];
    if (!value) continue;
    try {
      return new URL(value).hostname || null;
    } catch {
      return null;
    }
  }
  return null;
}

export function warningText(env) {
  const host = targetDatabaseHost(env);
  return [
    "",
    "ATTENTION : `npm run release:prepare` écrit en PRODUCTION.",
    "  - applique les migrations Supabase en attente (db:migrate) ;",
    "  - reconfigure le contrôle de santé dans Vault (ops:health-scheduler:configure) ;",
    "  - publie les modèles de valorisation (valuation:publish).",
    host ? `Base ciblée : ${host}` : "Base ciblée : non déterminée (variables d'URL absentes).",
    "Une migration et le code qui en dépend partent ensemble : voir supabase/README.md.",
    "",
  ].join("\n");
}

/**
 * @returns {Promise<{ confirmed: boolean, reason: string }>}
 */
export async function confirmReleasePrepare({
  env = process.env,
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  ask = async (question) => {
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await readline.question(question);
    } finally {
      readline.close();
    }
  },
  write = (text) => process.stderr.write(`${text}\n`),
} = {}) {
  write(warningText(env));
  if (env.RELEASE_PREPARE_CONFIRM === CONFIRMATION_WORD) {
    write("Confirmation reçue par RELEASE_PREPARE_CONFIRM.");
    return { confirmed: true, reason: "env" };
  }
  if (!interactive) {
    write(
      `Pas de terminal interactif : relancer avec RELEASE_PREPARE_CONFIRM=${CONFIRMATION_WORD} pour confirmer.`,
    );
    return { confirmed: false, reason: "non-interactive" };
  }
  const answer = (await ask(`Tapez « ${CONFIRMATION_WORD} » pour continuer : `)).trim();
  if (answer !== CONFIRMATION_WORD) {
    write("Annulé : rien n'a été modifié.");
    return { confirmed: false, reason: "declined" };
  }
  return { confirmed: true, reason: "typed" };
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  const { confirmed } = await confirmReleasePrepare();
  if (!confirmed) process.exitCode = 1;
}
