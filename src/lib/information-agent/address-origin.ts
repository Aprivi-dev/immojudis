import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  informationAgentAddressOrigin,
  isInformationAgentAddressSourceKind,
  type InformationAgentAddressObserver,
  type InformationAgentAddressOrigin,
  type InformationAgentAddressSourceKind,
} from "@/lib/information-agent-compliance";
import { normalizedEmail } from "@/lib/information-agent/contacts";
import {
  INFORMATION_AGENT_EXCLUDED_SOURCE_MESSAGE,
  isInformationAgentExcludedSourceUrl,
} from "@/lib/information-agent/excluded-addresses";

/**
 * Une adresse saisie par un administrateur ne peut venir ni d'un réseau social, ni d'un moteur de
 * recherche, ni d'un annuaire exclu (notaires.fr, barreaux de Paris et de Marseille…).
 */
export function assertInformationAgentSourceAllowed(addressOrigin: {
  origin: InformationAgentAddressOrigin;
  kind: InformationAgentAddressSourceKind | null;
}): void {
  if (
    addressOrigin.kind === "admin_entry" &&
    addressOrigin.origin.url &&
    isInformationAgentExcludedSourceUrl(addressOrigin.origin.url)
  ) {
    throw new Error(INFORMATION_AGENT_EXCLUDED_SOURCE_MESSAGE);
  }
}

function matchRuleOf(metadata: unknown): string | null {
  const rule = (metadata as { match_rule?: unknown } | null)?.match_rule;
  return typeof rule === "string" ? rule : null;
}

export const INFORMATION_AGENT_ORIGIN_REQUIRED_MESSAGE =
  "Origine de l’adresse inconnue : elle ne figure pas dans l’annonce de cette vente. Indiquez la page publique où vous l’avez trouvée avant l’envoi.";

/**
 * Origine de l'adresse pour cette vente (art. 14 RGPD). Le registre des contacts de la même vente
 * fait foi : il porte le type de la source, l'URL, la date de relevé et l'auteur, et le libellé du
 * message suit ce type (annonce, autre annonce, annuaire officiel, site du cabinet). À défaut, ou
 * pour une saisie d'administrateur, la page publique citée par l'administrateur est obligatoire.
 * Une adresse sans origine connue n'est jamais sollicitée.
 */
export async function resolveInformationAgentAddressOrigin({
  email,
  saleId,
  manualOriginUrl,
  fallbackObservedAt = null,
}: {
  email: string;
  saleId: string | null;
  manualOriginUrl: string | null;
  /** Date de relevé d'une saisie d'administrateur sans ligne de registre : création du brouillon. */
  fallbackObservedAt?: string | null;
}): Promise<{
  origin: InformationAgentAddressOrigin;
  known: boolean;
  kind: InformationAgentAddressSourceKind | null;
}> {
  const normalized = normalizedEmail(email);
  if (!normalized) throw new Error("Adresse email du contact invalide.");
  const manual = manualOriginUrl?.trim();
  const manualUrl = manual && /^https?:\/\//i.test(manual) ? manual : null;
  let observedAt = fallbackObservedAt;
  let adminEntryUrl: string | null = null;
  if (saleId) {
    const { data, error } = await supabaseAdmin
      .from("information_agent_contacts")
      .select(
        "source_kind,source_directory_name,source_name,source_url,observed_at,observed_by,metadata",
      )
      .eq("normalized_email", normalized)
      .eq("scope_sale_id", saleId)
      .limit(1);
    if (error) throw error;
    const row = data?.[0];
    const kind =
      row && isInformationAgentAddressSourceKind(row.source_kind) ? row.source_kind : null;
    const observedBy: InformationAgentAddressObserver | null =
      row?.observed_by === "admin" || row?.observed_by === "agent" ? row.observed_by : null;
    if (row && kind && kind !== "admin_entry") {
      const origin = informationAgentAddressOrigin({
        sourceKind: kind,
        sourceName: row.source_name,
        sourceUrl: row.source_url,
        directoryName: row.source_directory_name,
        observedAt: row.observed_at,
        observedBy,
        matchRule: matchRuleOf(row.metadata),
      });
      // Un annuaire, un site ou une autre annonce sans lien exact ne prouvent rien.
      const known =
        kind === "sale_listing" ? Boolean(row.source_name || row.source_url) : Boolean(origin.url);
      if (known) return { origin, known, kind };
    }
    if (row && kind === "admin_entry") {
      observedAt = row.observed_at ?? observedAt;
      adminEntryUrl = row.source_url;
    }
  }
  const url = manualUrl ?? adminEntryUrl;
  const origin = informationAgentAddressOrigin({
    sourceKind: "admin_entry",
    sourceUrl: url,
    observedAt,
    observedBy: "admin",
  });
  if (origin.url) return { origin, known: true, kind: "admin_entry" };
  return {
    origin: informationAgentAddressOrigin({}),
    known: false,
    kind: null,
  };
}
