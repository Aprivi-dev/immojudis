import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_INFORMATION_AGENT_AI_PROVIDER_ID,
  informationAgentAiProvider,
} from "@/lib/information-agent-ai-provider";

const root = process.cwd();

describe("prestataire d'IA du pied de message", () => {
  it("tire le prestataire de la configuration LLM_PROVIDER, Replicate par défaut", () => {
    expect(informationAgentAiProvider({})).toEqual({
      id: "replicate",
      name: "Replicate",
      country: "États-Unis",
    });
    expect(informationAgentAiProvider({ LLM_PROVIDER: " Replicate " }).name).toBe("Replicate");
  });

  it("refuse un prestataire que le pied, la politique et le registre ne nomment pas", () => {
    expect(() => informationAgentAiProvider({ LLM_PROVIDER: "openai" })).toThrow(
      "Prestataire d’IA « openai » non identifié",
    );
  });

  it("reste aligné sur le pipeline qui lit réellement les réponses", () => {
    const config = readFileSync(path.join(root, "services/data-pipeline/src/config.py"), "utf8");
    const client = readFileSync(
      path.join(root, "services/data-pipeline/src/enrichment/llm_client.py"),
      "utf8",
    );
    const workflow = readFileSync(
      path.join(root, ".github/workflows/information-agent-evidence.yml"),
      "utf8",
    );
    // Valeur par défaut de LLM_PROVIDER côté pipeline, fournisseur configuré dans le workflow qui
    // analyse les pièces des réponses, et fournisseur unique accepté par le client.
    expect(config).toContain(
      `"llm_provider": os.getenv("LLM_PROVIDER", "${DEFAULT_INFORMATION_AGENT_AI_PROVIDER_ID}")`,
    );
    expect(workflow).toMatch(/LLM_PROVIDER:\s*replicate\b/);
    expect(client).toContain('settings["llm_provider"] != "replicate"');
  });
});
