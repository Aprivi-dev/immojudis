import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^server-only$/, replacement: resolve(root, "src/test/server-only.ts") },
      { find: "@", replacement: resolve(root, "src") },
    ],
  },
  test: {
    environment: "node",
    // Domaines fictifs (.test, .example) des jeux d'essai : le contrôle DNS de l'agent est coupé. Ses propres
    // tests le rallument en passant `env` explicitement.
    env: { INFORMATION_AGENT_ADDRESS_CHECK: "off" },
    exclude: [...configDefaults.exclude, "e2e/**", ".claude/**"],
  },
});
