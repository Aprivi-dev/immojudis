import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_INFORMATION_AGENT_AI_PROVIDER_ID,
  informationAgentAiProvider,
} from "@/lib/information-agent-ai-provider";

const root = process.cwd();

function read(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

describe("prestataire d'IA du pied de message", () => {
  it("tire le prestataire de la configuration LLM_PROVIDER, Anthropic par défaut", () => {
    // Le libellé du pays n'est écrit qu'une fois, dans l'entrée de information-agent-ai-provider.ts.
    const anthropic = informationAgentAiProvider({ LLM_PROVIDER: "anthropic" });
    expect(anthropic).toMatchObject({ id: "anthropic", name: "Anthropic" });
    expect(informationAgentAiProvider({})).toEqual(anthropic);
    expect(informationAgentAiProvider({ LLM_PROVIDER: "" })).toEqual(anthropic);
    expect(informationAgentAiProvider({ LLM_PROVIDER: "  " })).toEqual(anthropic);
    expect(informationAgentAiProvider({ LLM_PROVIDER: " Anthropic " }).name).toBe("Anthropic");
  });

  it("nomme Replicate quand le retour arrière est configuré", () => {
    expect(informationAgentAiProvider({ LLM_PROVIDER: " Replicate " })).toEqual({
      id: "replicate",
      name: "Replicate",
      country: "États-Unis",
    });
  });

  it("nomme Anthropic, prestataire de la politique 2026-11-22.1, quand LLM_PROVIDER le désigne", () => {
    const provider = informationAgentAiProvider({ LLM_PROVIDER: "anthropic" });
    expect(provider).toEqual({
      id: "anthropic",
      name: "Anthropic",
      country: "Anthropic Ireland, Limited, Irlande ; données stockées aux États-Unis",
    });
  });

  it("refuse un prestataire que le pied, la politique et le registre ne nomment pas", () => {
    expect(() => informationAgentAiProvider({ LLM_PROVIDER: "openai" })).toThrow(
      "Prestataire d’IA « openai » non identifié",
    );
  });

  it("reste aligné sur le pipeline qui lit réellement les réponses", () => {
    const config = read("services/data-pipeline/src/config.py");
    const client = read("services/data-pipeline/src/enrichment/llm_client.py");
    // Même valeur par défaut et même lecture (espaces retirés, minuscules, vide = défaut) côté pipeline.
    expect(config).toContain(
      `DEFAULT_LLM_PROVIDER = ${DEFAULT_INFORMATION_AGENT_AI_PROVIDER_ID.toUpperCase()}_PROVIDER`,
    );
    expect(config).toContain(
      'return (os.getenv(LLM_PROVIDER_ENV) or "").strip().lower() or DEFAULT_LLM_PROVIDER',
    );
    // Chaque fournisseur que le pipeline accepte est nommé par le pied.
    const providers = /^LLM_PROVIDERS = \(([^)]*)\)$/m.exec(config)?.[1] ?? "";
    const ids = [...providers.matchAll(/([A-Z]+)_PROVIDER/g)].map((match) => {
      const constant = new RegExp(`^${match[1]}_PROVIDER = "([a-z]+)"$`, "m").exec(config);
      return constant?.[1];
    });
    expect(ids).toEqual(["anthropic", "replicate"]);
    for (const id of ids) {
      expect(informationAgentAiProvider({ LLM_PROVIDER: id }).id).toBe(id);
    }
    expect(client).toContain("if provider == ANTHROPIC_PROVIDER:");
    expect(client).toContain("if provider == REPLICATE_PROVIDER:");
  });

  it("tombe sur le même fournisseur que chaque workflow sans réglage manuel", () => {
    // Le pied lit LLM_PROVIDER sur Vercel ; le traitement réel le lit dans les workflows. Sans variable posée
    // d'un côté ni de l'autre, les deux doivent désigner le même fournisseur.
    const directory = path.join(root, ".github/workflows");
    const settings = readdirSync(directory)
      .filter((name) => name.endsWith(".yml"))
      .flatMap((name) =>
        [...read(`.github/workflows/${name}`).matchAll(/^\s+LLM_PROVIDER:\s*(.+?)\s*$/gm)].map(
          (match) => [name, match[1]] as const,
        ),
      );
    expect(settings.map(([name]) => name).sort()).toEqual([
      "data-pipeline.yml",
      "document-reading-trial.yml",
      "fact-chunk-trial.yml",
      "information-agent-evaluation-trial.yml",
      "information-agent-evidence.yml",
    ]);
    for (const [name, value] of settings) {
      expect([name, value]).toEqual([
        name,
        `\${{ vars.LLM_PROVIDER || '${DEFAULT_INFORMATION_AGENT_AI_PROVIDER_ID}' }}`,
      ]);
    }
    expect(informationAgentAiProvider({}).id).toBe("anthropic");
  });
});
