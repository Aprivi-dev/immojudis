/**
 * Prestataire d'IA qui lit les réponses reçues par l'agent d'information (art. 14(1)(e) RGPD).
 *
 * La lecture des réponses et pièces (texte, PDF, photos) est faite par le pipeline Python
 * (`services/data-pipeline/src/enrichment/llm_client.py`, `create_llm_client`), qui choisit son
 * fournisseur avec `LLM_PROVIDER` : `anthropic` par défaut (Claude Haiku 5.5, modèle
 * `ANTHROPIC_TEXT_MODEL`), `replicate` pour le retour arrière (modèle `REPLICATE_MODEL`). Aucun
 * appel au modèle n'est fait par l'application. Le pied du message tire le nom du prestataire de
 * cette même variable, lue de la même façon (espaces retirés, minuscules, vide = défaut) : elle doit
 * avoir la même valeur sur Vercel et dans les workflows du pipeline. Si elle désigne un fournisseur
 * absent de la liste ci-dessous, l'envoi est refusé tant que le pied, la politique de
 * confidentialité et le registre ne l'ont pas nommé.
 */
import { ConfigurationError } from "@/lib/api-errors";

export type InformationAgentAiProvider = {
  /** Identifiant de configuration (`LLM_PROVIDER`). */
  id: string;
  /** Nom du prestataire tel qu'il apparaît dans le pied du message. */
  name: string;
  /** Pays d'établissement, pour l'information sur les transferts. */
  country: string;
};

// Anthropic : cocontractant Anthropic Ireland, Limited, données stockées aux États-Unis (politique de
// confidentialité 2026-11-22.1, qui garde Replicate en secours).
const KNOWN_AI_PROVIDERS: Readonly<Record<string, InformationAgentAiProvider>> = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    country: "Irlande, données stockées aux États-Unis",
  },
  replicate: { id: "replicate", name: "Replicate", country: "États-Unis" },
};

export const DEFAULT_INFORMATION_AGENT_AI_PROVIDER_ID = "anthropic";

export function informationAgentAiProvider(
  env: Readonly<Record<string, string | undefined>> = process.env,
): InformationAgentAiProvider {
  const id = env.LLM_PROVIDER?.trim().toLowerCase() || DEFAULT_INFORMATION_AGENT_AI_PROVIDER_ID;
  const provider = KNOWN_AI_PROVIDERS[id];
  if (!provider) {
    throw new ConfigurationError(
      `Prestataire d’IA « ${id} » non identifié : nommez-le dans le pied du message (information-agent-ai-provider.ts), la politique de confidentialité et le registre avant tout envoi.`,
    );
  }
  return provider;
}
