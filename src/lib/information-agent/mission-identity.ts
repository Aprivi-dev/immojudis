import type { Database, Json } from "@/integrations/supabase/types";
import {
  informationAgentAddressKind,
  informationAgentStructureKeys,
} from "@/lib/information-agent/contact-structure";
import { informationAgentIdentityKeys } from "@/lib/information-agent/identity";
import { tribunalBarAssociation } from "@/lib/lawyer-bar";
import type { AuctionSale } from "@/lib/types";

type MissionRow = Database["public"]["Tables"]["information_agent_missions"]["Row"];

function asRecord(value: Json): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** Barreau du tribunal de la vente, à défaut sa ville : le lieu de l'identité du professionnel. */
export function saleIdentityPlace(sale: Pick<AuctionSale, "tribunal" | "city">): {
  bar: string | null;
  city: string | null;
} {
  return { bar: tribunalBarAssociation(sale.tribunal), city: sale.city?.trim() || null };
}

export function metadataText(value: Json | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Clés de la structure du destinataire (opposition au niveau du cabinet, de l'office ou du service). Le code
 * d'office du brouillon (`metadata.contact_identity.office_code`) ne vaut que si l'adresse est restée celle
 * que le brouillon a choisie ; le domaine propre se lit dans l'adresse elle-même.
 */
export function missionStructureKeys(mission: MissionRow, recipientEmail: string): string[] {
  const metadata = asRecord(mission.metadata);
  const identity = asRecord(metadata.contact_identity ?? {});
  const selected = metadataText(asRecord(metadata.contact_discovery ?? {}).selected_email);
  const email = recipientEmail.trim().toLowerCase();
  return informationAgentStructureKeys({
    email,
    officeCode: selected?.toLowerCase() === email ? metadataText(identity.office_code) : null,
  });
}

/**
 * Clés d'identité du destinataire d'une mission, recalculées avec le nom éventuellement corrigé par
 * l'administrateur. Rôle et lieu viennent du brouillon (`metadata.contact_identity`).
 *
 * Avec `recipientEmail`, une adresse GÉNÉRIQUE porte aussi les clés de sa structure : si cette adresse
 * s'oppose, l'opposition vaut pour la structure. Une adresse nominative ne les porte pas : l'opposition
 * d'une personne ne vaut que pour elle.
 */
export function missionIdentityKeys(
  mission: MissionRow,
  recipientName?: string | null,
  recipientEmail?: string | null,
): string[] {
  const identity = asRecord(asRecord(mission.metadata).contact_identity ?? {});
  const keys = informationAgentIdentityKeys({
    role:
      metadataText(identity.role) ?? (mission.recipient_kind === "source_lawyer" ? "lawyer" : null),
    name: recipientName?.trim() || mission.recipient_name,
    bar: metadataText(identity.bar),
    city: metadataText(identity.city),
    siren: metadataText(identity.siren),
  });
  if (recipientEmail && informationAgentAddressKind(recipientEmail) === "generic") {
    return [...new Set([...keys, ...missionStructureKeys(mission, recipientEmail)])];
  }
  return keys;
}

/** Référence de la vente pour le pied du message : titre, lieu et tribunal du brouillon. */
export function missionSaleReference(mission: MissionRow): string | null {
  const snapshot = asRecord(mission.sale_snapshot);
  const parts = [snapshot.title, snapshot.city, snapshot.tribunal]
    .map(metadataText)
    .filter((part): part is string => Boolean(part));
  return parts.length ? [...new Set(parts)].join(" — ") : null;
}
