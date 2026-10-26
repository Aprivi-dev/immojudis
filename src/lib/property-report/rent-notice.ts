import { asRecord } from "@/lib/guards";
import type { RentReference, RentReferenceSource } from "@/lib/rent-reference";

const ANIL_SOURCES: readonly RentReferenceSource[] = ["anil_commune", "anil_maille", "anil_epci"];

/**
 * Référence de loyer ANIL enregistrée dans un rapport (`opportunity.rentReference`), ou `null` : un
 * rapport ancien, un loyer départemental ou une valeur illisible n'ont pas de mention ANIL.
 */
export function reportRentReference(
  value: unknown,
): Pick<RentReference, "source" | "vintage" | "sourceUpdatedOn"> | null {
  const record = asRecord(value);
  const source = ANIL_SOURCES.find((item) => item === record.source);
  if (!source) return null;
  const reference = {
    source,
    vintage: typeof record.vintage === "number" ? record.vintage : null,
    sourceUpdatedOn: typeof record.sourceUpdatedOn === "string" ? record.sourceUpdatedOn : null,
  };
  return reference;
}
