/**
 * Ce que l'administrateur voit du destinataire proposé par l'agent : son rôle, l'origine de l'adresse et si
 * elle est générique ou nominative. MODULE PUR. Calculé côté serveur avec la mission (`mission-store.ts`) :
 * l'écran d'administration n'en reçoit que les libellés et n'importe aucun module de l'agent pour cela.
 * Lu dans le brouillon (`metadata.contact_discovery`), jamais recalculé à partir de la vente.
 */
import { INFORMATION_AGENT_REGISTRY_PROVENANCE_FIELD } from "@/lib/information-agent/contact-resolution";
import { asRecord } from "@/lib/guards";
import {
  INFORMATION_AGENT_ADDRESS_KIND_LABELS,
  informationAgentAddressKind,
  type InformationAgentAddressKind,
} from "@/lib/information-agent/contact-structure";

export type InformationAgentRecipientProfile = {
  /** « Avocat », « Notaire », « Service de l'État »… */
  roleLabel: string;
  addressKind: InformationAgentAddressKind;
  /** « Adresse générique de la structure » ou « Adresse nominative ». */
  addressKindLabel: string;
  /** « Adresse publiée dans l'annonce »… */
  originLabel: string;
  originSourceName: string | null;
  /** URL de l'annonce (ou de la page) où l'adresse figure. */
  originUrl: string | null;
};

const ROLE_LABELS: Record<string, string> = {
  lawyer: "Avocat",
  notary: "Notaire",
  organizer: "Organisateur de la vente",
  source_contact: "Contact de l’annonce",
  court_registry: "Greffe du tribunal",
};

/** Libellé du rôle : la structure précise l'organisateur (service de l'État). */
export function informationAgentRecipientRoleLabel(
  role: string | null,
  structureKind: string | null,
): string | null {
  if (role === "organizer" && structureKind === "state_service") return "Service de l’État";
  return role ? (ROLE_LABELS[role] ?? null) : null;
}

const ORIGIN_LABELS: Record<string, string> = {
  sale_field: "Adresse publiée dans l’annonce",
  source_block: "Adresse publiée dans l’annonce",
  source_text: "Adresse publiée dans l’annonce",
  agent_search: "Adresse retrouvée par recherche",
  court_registry: "Adresse du référentiel des tribunaux",
};

/**
 * Adresse du registre interne : relevée par la collecte dans une annonce qui la masque. Elle n'est pas
 * « publiée » en clair, l'écran ne le dit donc pas.
 */
const REGISTRY_ORIGIN_LABEL = "Adresse relevée à la collecte de l’annonce (masquée sur la page)";

/** Libellé d'une provenance, ou `null` si son type n'est pas connu. */
function originLabel(provenance: Record<string, unknown>): string | null {
  if (text(provenance.field) === INFORMATION_AGENT_REGISTRY_PROVENANCE_FIELD) {
    return REGISTRY_ORIGIN_LABEL;
  }
  return ORIGIN_LABELS[text(provenance.kind) ?? ""] ?? null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function httpUrl(value: unknown): string | null {
  const url = text(value);
  return url && /^https?:\/\//i.test(url) ? url : null;
}

/**
 * Profil du destinataire d'une mission, ou `null` quand l'adresse n'est pas l'une de celles que le brouillon
 * a proposées (saisie de l'administrateur, mission antérieure sans instantané) : rien n'est alors affiché.
 */
export function informationAgentRecipientProfile(
  metadata: unknown,
  recipientEmail: string,
): InformationAgentRecipientProfile | null {
  const email = recipientEmail.trim().toLowerCase();
  const candidates = asRecord(asRecord(metadata).contact_discovery).candidates;
  if (!email || !Array.isArray(candidates)) return null;
  const candidate = candidates
    .map(asRecord)
    .find((entry) => text(entry.email)?.toLowerCase() === email);
  if (!candidate) return null;
  const provenance = (Array.isArray(candidate.provenance) ? candidate.provenance : []).map(
    asRecord,
  );
  // Libellé, source et lien viennent de la MÊME provenance : jamais le lien d'une page et le libellé d'une autre.
  const origin = provenance.find((item) => originLabel(item));
  const label = origin ? originLabel(origin) : null;
  if (!origin || !label) return null;
  // Le greffe se reconnaît à l'origine de son adresse, pas au rôle de l'instantané.
  const roleLabel =
    text(origin.kind) === "court_registry"
      ? ROLE_LABELS.court_registry
      : informationAgentRecipientRoleLabel(text(candidate.role), text(candidate.structure_kind));
  if (!roleLabel) return null;
  const storedKind = text(candidate.address_kind);
  // Les brouillons antérieurs n'enregistraient pas la nature de l'adresse : elle se lit dans l'adresse.
  const addressKind: InformationAgentAddressKind =
    storedKind === "generic" || storedKind === "nominative"
      ? storedKind
      : informationAgentAddressKind(email);
  return {
    roleLabel,
    addressKind,
    addressKindLabel: INFORMATION_AGENT_ADDRESS_KIND_LABELS[addressKind],
    originLabel: label,
    originSourceName: text(origin.source_name),
    originUrl: httpUrl(origin.source_url),
  };
}
