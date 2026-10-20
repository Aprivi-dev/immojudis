import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const settings = JSON.parse(readFileSync(resolve(root, ".claude/settings.json"), "utf8"));

const WRITE_TOOLS = [
  "apply_migration",
  "deploy_edge_function",
  "create_edge_function_secret",
  "create_branch",
  "delete_branch",
  "merge_branch",
  "reset_branch",
  "rebase_branch",
  "create_project",
  "pause_project",
  "restore_project",
].map((tool) => `mcp__Supabase__${tool}`);

const entry = settings.hooks.PreToolUse.find((hookEntry) =>
  hookEntry.hooks.some((hook) => hook.command.includes("bloquer-ecriture-supabase.mjs")),
);

describe("blocage des outils Supabase qui écrivent", () => {
  it("déclare un crochet PreToolUse dont le matcher couvre exactement ces outils", () => {
    expect(entry).toBeDefined();
    expect(entry.matcher.split("|").sort()).toEqual([...WRITE_TOOLS].sort());
  });

  it("n'autorise aucun de ces outils dans permissions.allow", () => {
    for (const tool of WRITE_TOOLS) expect(settings.permissions.allow).not.toContain(tool);
  });

  it("garde la confirmation pour le déclenchement de workflows et la fusion de PR", () => {
    expect(settings.permissions.allow).not.toContain("mcp__github__actions_run_trigger");
    expect(settings.permissions.allow).not.toContain("mcp__github__merge_pull_request");
  });

  const command = entry?.hooks[0].command ?? "";
  const run = (env) =>
    spawnSync("/bin/sh", ["-c", command], {
      input: JSON.stringify({ tool_name: WRITE_TOOLS[0], tool_input: { query: "x" } }),
      encoding: "utf8",
      cwd: "/",
      env: { CLAUDE_PROJECT_DIR: root, ...env },
    });

  it("sort en 2 avec le message d'interdiction, quel que soit le répertoire courant", () => {
    const result = run({ PATH: dirname(process.execPath) });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "interdit : aucun agent n'écrit dans la base ; passez par une migration et la CI",
    );
  });

  it("sort en 2 sans entrée ni arguments", () => {
    const result = spawnSync(
      process.execPath,
      [resolve(root, ".claude/hooks/bloquer-ecriture-supabase.mjs")],
      { input: "", encoding: "utf8", cwd: "/" },
    );
    expect(result.status).toBe(2);
  });

  it("bloque aussi quand node est introuvable (`|| exit 2`)", () => {
    expect(command).toMatch(/\|\| exit 2$/);
    expect(run({ PATH: "/nonexistent" }).status).toBe(2);
  });
});
