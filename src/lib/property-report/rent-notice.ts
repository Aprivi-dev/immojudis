import { asRecord } from "@/lib/guards";
import { ANIL_RENT_SOURCES, type RentReference } from "@/lib/rent-reference";

/**
 * Référence de loyer ANIL enregistrée dans un rapport (`opportunity.rentReference`), ou `null` : un
 * rapport ancien, un loyer départemental ou une valeur illisible n'ont pas de mention ANIL.
 */
export function reportRentReference(
  value: unknown,
): Pick<RentReference, "source" | "vintage" | "sourceUpdatedOn"> | null {
  const record = asRecord(value);
  const source = ANIL_RENT_SOURCES.find((item) => item === record.source);
  if (!source) return null;
  const reference = {
    source,
    vintage: typeof record.vintage === "number" ? record.vintage : null,
    sourceUpdatedOn: typeof record.sourceUpdatedOn === "string" ? record.sourceUpdatedOn : null,
  };
  return reference;
}
