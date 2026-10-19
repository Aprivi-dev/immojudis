import type { Database, Json } from "@/integrations/supabase/types";
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
 * Clés d'identité du destinataire d'une mission, recalculées avec le nom éventuellement corrigé par
 * l'administrateur. Rôle et lieu viennent du brouillon (`metadata.contact_identity`).
 */
export function missionIdentityKeys(mission: MissionRow, recipientName?: string | null): string[] {
  const identity = asRecord(asRecord(mission.metadata).contact_identity ?? {});
  return informationAgentIdentityKeys({
    role:
      metadataText(identity.role) ?? (mission.recipient_kind === "source_lawyer" ? "lawyer" : null),
    name: recipientName?.trim() || mission.recipient_name,
    bar: metadataText(identity.bar),
    city: metadataText(identity.city),
    siren: metadataText(identity.siren),
  });
}

/** Référence de la vente pour le pied du message : titre, lieu et tribunal du brouillon. */
export function missionSaleReference(mission: MissionRow): string | null {
  const snapshot = asRecord(mission.sale_snapshot);
  const parts = [snapshot.title, snapshot.city, snapshot.tribunal]
    .map(metadataText)
    .filter((part): part is string => Boolean(part));
  return parts.length ? [...new Set(parts)].join(" — ") : null;
}
