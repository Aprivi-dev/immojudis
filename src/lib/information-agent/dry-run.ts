import "server-only";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { loadInformationAgentContactSales } from "@/lib/admin-information-agent-sale";
import { informationAgentAddressCheckEnabled } from "@/lib/information-agent/address-deliverability";
import { informationAgentAddressHygieneIssue } from "@/lib/information-agent/address-hygiene";
import {
  resolveInformationAgentListingContacts,
  selectInformationAgentContact,
  type InformationAgentContactCandidate,
  type InformationAgentContactProvenance,
  type InformationAgentContactRefusal,
  type InformationAgentContactRole,
} from "@/lib/information-agent/contact-resolution";
import {
  informationAgentAddressKind,
  isInformationAgentStructureKey,
  type InformationAgentAddressKind,
  type InformationAgentStructureKind,
} from "@/lib/information-agent/contact-structure";
import {
  isInformationAgentContactBlocked,
  loadInformationAgentContactRegistry,
  loadOpposedInformationAgentIdentityKeys,
} from "@/lib/information-agent/contacts";
import type { InformationAgentOrganizerType } from "@/lib/information-agent/listing-contacts";
import { saleIdentityPlace } from "@/lib/information-agent/mission-identity";
import { requireInformationAgentAdmin } from "@/lib/information-agent/mission-store";
import { recipientOppositionKeys } from "@/lib/information-agent/opposition-keys";
import {
  informationAgentQuestionAudience,
  type InformationAgentQuestionAudience,
} from "@/lib/information-agent/recipient-questions";
import { informationAgentRecipientRoleLabel } from "@/lib/information-agent/recipient-profile";

/**
 * MESURE À BLANC des destinataires de l'agent d'information.
 *
 * Pour une liste de ventes, rend le destinataire que l'outil retiendrait, son rôle et l'origine de son
 * adresse, avec le même résolveur et les mêmes clés d'opposition que la préparation d'un brouillon. LECTURE
 * SEULE : aucune écriture au registre, aucun brouillon, aucun envoi, aucun appel réseau hors la base. Réservée
 * à un administrateur ; aucune route ne l'expose (un test l'interdit) : elle se lance par le test manuel
 * `src/lib/information-agent-dry-run.manual.test.ts`, qui n'affiche que des comptages.
 *
 * Les lignes (`rows`) contiennent des adresses : elles ne doivent JAMAIS être journalisées. Seul `summary`
 * (comptages, sans adresse ni nom) peut l'être.
 *
 * Écarts connus avec la préparation réelle d'un brouillon : le délai de 30 jours par destinataire, la vente
 * déjà sollicitée, le statut de la vente et la résolution DNS de l'adresse ne sont pas contrôlés ici.
 */
export type InformationAgentDryRunOutcome =
  /** Un destinataire que l'outil choisit seul. */
  | "selected"
  /** Plusieurs adresses possibles : l'administrateur tranche. */
  | "ambiguous"
  /** Aucune adresse utilisable dans l'annonce ni au registre. */
  | "none"
  /** Le destinataire que l'outil choisirait est en opposition ou en rebond définitif. */
  | "blocked"
  /** Vente absente de la base. */
  | "not_found";

export type InformationAgentDryRunBlock =
  | "address_opposed_or_bounced"
  | "identity_opposed"
  | "structure_opposed";

export type InformationAgentDryRunRecipient = {
  email: string;
  role: InformationAgentContactRole;
  roleLabel: string | null;
  structureKind: InformationAgentStructureKind | null;
  addressKind: InformationAgentAddressKind;
  confidence: InformationAgentContactCandidate["confidence"];
  /** Liste de questions et texte de message qui s'appliqueraient (`recipient-questions.ts`). */
  questionAudience: InformationAgentQuestionAudience;
  /** Où l'adresse a été lue : champ, source et URL de l'annonce. */
  origin: InformationAgentContactProvenance;
};

export type InformationAgentDryRunRow = {
  saleId: string;
  sourceName: string | null;
  organizerType: InformationAgentOrganizerType;
  outcome: InformationAgentDryRunOutcome;
  recipient: InformationAgentDryRunRecipient | null;
  blockedBy: InformationAgentDryRunBlock | null;
  /** Nombre d'adresses candidates (après hygiène et oppositions par identité ou structure). */
  candidateCount: number;
  refused: Partial<Record<InformationAgentContactRefusal | "address_hygiene", number>>;
};

export type InformationAgentDryRunSummary = {
  total: number;
  byOutcome: Record<string, number>;
  /** Destinataires retenus, par rôle (`lawyer`, `notary`, `organizer:state_service`…). */
  selectedByRole: Record<string, number>;
  selectedByAddressKind: Record<string, number>;
  /** Issue par source d'annonce : `{ notaires: { selected: 12, none: 1 } }`. */
  bySource: Record<string, Record<string, number>>;
  blockedBy: Record<string, number>;
  refused: Record<string, number>;
  /** Faux si le registre interne n'a pas pu être lu pour au moins un lot (adresses du pipeline absentes). */
  registryReadable: boolean;
};

export type InformationAgentDryRunReport = {
  rows: InformationAgentDryRunRow[];
  summary: InformationAgentDryRunSummary;
};

const CHUNK = 50;

function increment(counts: Record<string, number>, key: string, by = 1) {
  counts[key] = (counts[key] ?? 0) + by;
}

export async function measureInformationAgentRecipients({
  auth,
  saleIds,
}: {
  auth: SupabaseAuthContext;
  saleIds: readonly string[];
}): Promise<InformationAgentDryRunReport> {
  requireInformationAgentAdmin(auth);
  const ids = [...new Set(saleIds)];
  const rows: InformationAgentDryRunRow[] = [];
  let registryReadable = true;
  const checkAddresses = informationAgentAddressCheckEnabled();

  for (let index = 0; index < ids.length; index += CHUNK) {
    const chunk = ids.slice(index, index + CHUNK);
    const loaded = await loadInformationAgentContactSales({ auth, saleIds: chunk });
    registryReadable &&= loaded.registryReadable;
    for (const saleId of chunk) {
      const sale = loaded.sales.get(saleId);
      if (!sale) {
        rows.push({
          saleId,
          sourceName: null,
          organizerType: "unknown",
          outcome: "not_found",
          recipient: null,
          blockedBy: null,
          candidateCount: 0,
          refused: {},
        });
        continue;
      }
      const resolution = resolveInformationAgentListingContacts(sale);
      const refused: InformationAgentDryRunRow["refused"] = { ...resolution.refused };
      const clean = resolution.candidates.filter((candidate) => {
        if (!checkAddresses || !informationAgentAddressHygieneIssue(candidate.email)) return true;
        refused.address_hygiene = (refused.address_hygiene ?? 0) + 1;
        return false;
      });
      // Oppositions par identité et par structure, comme à la préparation du brouillon (draft.ts).
      const place = saleIdentityPlace(sale);
      const checkKeysOf = (candidate: InformationAgentContactCandidate) =>
        recipientOppositionKeys({
          role: candidate.role,
          name: candidate.name ?? (candidate.role === "lawyer" ? sale.lawyer_name : null),
          place,
          email: candidate.email,
          officeCode: candidate.officeCode,
          addressKind: candidate.addressKind,
        }).checkKeys;
      const opposed = new Set(
        await loadOpposedInformationAgentIdentityKeys(clean.flatMap(checkKeysOf)),
      );
      const candidates = clean.filter(
        (candidate) => !checkKeysOf(candidate).some((key) => opposed.has(key)),
      );
      const selected = selectInformationAgentContact(candidates);
      const base = {
        saleId,
        sourceName: sale.source_name ?? sale.primary_source ?? null,
        organizerType: resolution.organizerType,
        candidateCount: candidates.length,
        refused,
      };
      if (!selected) {
        const allOpposed = clean.length > 0 && candidates.length === 0;
        rows.push({
          ...base,
          outcome: candidates.length ? "ambiguous" : allOpposed ? "blocked" : "none",
          recipient: null,
          blockedBy: !allOpposed
            ? null
            : [...opposed].some(isInformationAgentStructureKey)
              ? "structure_opposed"
              : "identity_opposed",
        });
        continue;
      }
      const registry = await loadInformationAgentContactRegistry(selected.email, saleId);
      const blocked = registry.some((row) => isInformationAgentContactBlocked(row, saleId));
      rows.push({
        ...base,
        outcome: blocked ? "blocked" : "selected",
        blockedBy: blocked ? "address_opposed_or_bounced" : null,
        recipient: {
          email: selected.email,
          role: selected.role,
          roleLabel: informationAgentRecipientRoleLabel(
            selected.role,
            selected.structureKind ?? null,
          ),
          structureKind: selected.structureKind ?? null,
          addressKind: selected.addressKind ?? informationAgentAddressKind(selected.email),
          confidence: selected.confidence,
          questionAudience: informationAgentQuestionAudience({
            role: selected.role,
            structureKind: selected.structureKind,
            organizerType: resolution.organizerType,
          }),
          origin: selected.provenance[0],
        },
      });
    }
  }
  return { rows, summary: summarizeInformationAgentDryRun(rows, registryReadable) };
}

/** Comptages de la mesure : aucune adresse, aucun nom, aucun identifiant de vente. Journalisable. */
export function summarizeInformationAgentDryRun(
  rows: readonly InformationAgentDryRunRow[],
  registryReadable: boolean,
): InformationAgentDryRunSummary {
  const summary: InformationAgentDryRunSummary = {
    total: rows.length,
    byOutcome: {},
    selectedByRole: {},
    selectedByAddressKind: {},
    bySource: {},
    blockedBy: {},
    refused: {},
    registryReadable,
  };
  for (const row of rows) {
    increment(summary.byOutcome, row.outcome);
    const source = row.sourceName ?? "unknown";
    summary.bySource[source] ??= {};
    increment(summary.bySource[source], row.outcome);
    if (row.blockedBy) increment(summary.blockedBy, row.blockedBy);
    for (const [reason, count] of Object.entries(row.refused)) {
      increment(summary.refused, reason, count);
    }
    if (row.outcome === "selected" && row.recipient) {
      increment(
        summary.selectedByRole,
        row.recipient.structureKind && row.recipient.role === "organizer"
          ? `${row.recipient.role}:${row.recipient.structureKind}`
          : row.recipient.role,
      );
      increment(summary.selectedByAddressKind, row.recipient.addressKind);
    }
  }
  return summary;
}
