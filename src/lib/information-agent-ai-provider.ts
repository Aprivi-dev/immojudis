/**
 * Prestataire d'IA qui lit les réponses reçues par l'agent d'information (art. 14(1)(e) RGPD).
 *
 * La lecture des réponses et pièces (texte, PDF, photos) est faite par le pipeline Python
 * (`services/data-pipeline/src/enrichment/llm_client.py`), qui n'accepte que le fournisseur
 * `LLM_PROVIDER` (défaut `replicate`, modèle `REPLICATE_MODEL`, défaut `qwen/qwen3-7-plus`).
 * Le pied du message tire le nom du fournisseur de cette même variable : si elle désigne un
 * fournisseur absent de la liste ci-dessous, l'envoi est refusé tant que le pied, la politique de
 * confidentialité et le registre ne l'ont pas nommé.
 */
export type InformationAgentAiProvider = {
  /** Identifiant de configuration (`LLM_PROVIDER`). */
  id: string;
  /** Nom du prestataire tel qu'il apparaît dans le pied du message. */
  name: string;
  /** Pays d'établissement, pour l'information sur les transferts. */
  country: string;
};

const KNOWN_AI_PROVIDERS: Readonly<Record<string, InformationAgentAiProvider>> = {
  replicate: { id: "replicate", name: "Replicate", country: "États-Unis" },
};

export const DEFAULT_INFORMATION_AGENT_AI_PROVIDER_ID = "replicate";

export function informationAgentAiProvider(
  env: Readonly<Record<string, string | undefined>> = process.env,
): InformationAgentAiProvider {
  const id = env.LLM_PROVIDER?.trim().toLowerCase() || DEFAULT_INFORMATION_AGENT_AI_PROVIDER_ID;
  const provider = KNOWN_AI_PROVIDERS[id];
  if (!provider) {
    throw new Error(
      `Prestataire d’IA « ${id} » non identifié : nommez-le dans le pied du message (information-agent-ai-provider.ts), la politique de confidentialité et le registre avant tout envoi.`,
    );
  }
  return provider;
}
