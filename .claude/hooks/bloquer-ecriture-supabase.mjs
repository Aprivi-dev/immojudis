#!/usr/bin/env node
// Bloque les outils MCP Supabase qui écrivent (migrations, fonctions edge, secrets, branches,
// projets). Déclaré dans .claude/settings.json avec un matcher sur ces seuls outils, donc valable
// pour tous les agents. Code de sortie 2 = appel bloqué. Test : scripts/bloquer-ecriture-supabase.test.mjs.
//
// Une seule exception (décision du propriétaire du 09/11/2026) : la base de TEST, branche Supabase
// « outcome-statistics-staging » (projet STAGING_PROJECT_REF), utilisée par les déploiements Preview
// pour la recette des paiements. Y sont permis, et seulement là :
//  - `rebase_branch` de cette branche (applique les migrations déjà passées en production) ;
//  - `apply_migration` sur ce projet (une migration du dépôt pas encore en production).
// Tout le reste est bloqué, la production en tête. Échec fermé : entrée illisible, champ manquant,
// outil ou cible non listés, erreur du script : code 2.

import { pathToFileURL } from "node:url";

export const PRODUCTION_PROJECT_REF = "sgpakxtyvenlpeihuucm";
export const STAGING_PROJECT_REF = "sxhxzhogzccpdjxpgzuk";
export const STAGING_BRANCH_ID = "43b9dfd2-d530-408d-a7eb-b21b2bc9914f";

const BLOCKED_MESSAGE =
  "Bloqué : interdit : aucun agent n'écrit dans la base ; passez par une migration et la CI.";

/** L'appel vise-t-il uniquement la base de test ? Toute autre forme est refusée. */
export function isStagingWrite(payload) {
  if (!payload || typeof payload !== "object") return false;
  const { tool_name: toolName, tool_input: input } = payload;
  if (!input || typeof input !== "object") return false;
  if (toolName === "mcp__Supabase__rebase_branch") {
    return input.branch_id === STAGING_BRANCH_ID;
  }
  if (toolName === "mcp__Supabase__apply_migration") {
    return input.project_id === STAGING_PROJECT_REF;
  }
  return false;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

async function main() {
  let allowed = false;
  try {
    allowed = isStagingWrite(JSON.parse(await readStdin()));
  } catch {
    allowed = false;
  }
  if (allowed) process.exit(0);
  process.stderr.write(`${BLOCKED_MESSAGE}\n`);
  process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(() => {
    process.stderr.write(`${BLOCKED_MESSAGE}\n`);
    process.exit(2);
  });
}
