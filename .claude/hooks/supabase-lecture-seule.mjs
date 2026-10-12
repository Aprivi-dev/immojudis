#!/usr/bin/env node
// Garde-fou de l'agent qualite-donnees : n'autorise que des requêtes SQL en lecture
// sur l'outil MCP Supabase execute_sql. Code de sortie 2 = requête bloquée.

const WRITE_KEYWORDS =
  /\b(insert|update|delete|merge|upsert|drop|create|alter|truncate|grant|revoke|comment|copy|vacuum|analyze|reindex|cluster|refresh|call|do|lock|set|reset|listen|notify)\b/i;
const READ_START = /^\s*(select|with|explain|show|table|values)\b/i;

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  let query = "";
  try {
    query = String(JSON.parse(input)?.tool_input?.query ?? "");
  } catch {
    process.stderr.write("Bloqué : entrée du hook illisible.\n");
    process.exit(2);
  }
  // Retire les commentaires SQL avant l'analyse.
  const sql = query.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  const statements = sql.split(";").filter((part) => part.trim() !== "");
  const readOnly =
    statements.length > 0 &&
    statements.every((part) => READ_START.test(part) && !WRITE_KEYWORDS.test(part));
  if (!readOnly) {
    process.stderr.write(
      "Bloqué : l'agent qualite-donnees n'exécute que des requêtes en lecture (SELECT, WITH, EXPLAIN).\n",
    );
    process.exit(2);
  }
  process.exit(0);
});
