#!/usr/bin/env node
// Bloque sans condition les outils MCP Supabase qui écrivent (migrations, fonctions edge, secrets,
// branches, projets). Déclaré dans .claude/settings.json avec un matcher sur ces seuls outils, donc
// valable pour tous les agents. Code de sortie 2 = appel bloqué. Test :
// scripts/bloquer-ecriture-supabase.test.mjs.

process.stderr.write(
  "Bloqué : interdit : aucun agent n'écrit dans la base ; passez par une migration et la CI.\n",
);
process.exit(2);
