import { createHash } from "node:crypto";
import type { AuctionSale } from "../types";

// A capture timestamp or gallery reorder does not change the report's findings.
const ignoredKeys = new Set(["created_at", "updated_at", "media"]);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !ignoredKeys.has(key))
        // `sale_conditions` (conditions d'une vente notariale, migration 20261103110000) n'existe
        // que pour ces ventes : vide, elle ne change pas l'empreinte d'un rapport enregistré avant
        // la colonne (une vente au tribunal garde la sienne).
        .filter(([key, item]) => key !== "sale_conditions" || item != null)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value ?? null;
}

export function reportSourceFingerprint(sale: AuctionSale): string {
  return `v1:${createHash("sha256")
    .update(JSON.stringify(canonical(sale)))
    .digest("hex")}`;
}

export class ReportSourceChangedError extends Error {
  constructor() {
    super(
      "Les données de ce rapport doivent être actualisées. Ouvrez l’annonce et sauvegardez à nouveau votre analyse avant de l’exporter ou de la partager.",
    );
    this.name = "ReportSourceChangedError";
  }
}

export function assertReportSourceCurrent(snapshot: unknown, sale: AuctionSale): void {
  const fingerprint =
    snapshot && typeof snapshot === "object" && "sourceFingerprint" in snapshot
      ? snapshot.sourceFingerprint
      : null;
  if (fingerprint === reportSourceFingerprint(sale)) return;
  // Un rapport notarial enregistré avant la migration 20261103110000 a été empreint sans la colonne
  // `sale_conditions` (elle n'existait pas) : l'empreinte calculée avec `sale_conditions: null`
  // reste valide, pour qu'il ne demande pas d'être sauvegardé à nouveau à cause de la seule colonne.
  if (
    sale.sale_conditions != null &&
    fingerprint === reportSourceFingerprint({ ...sale, sale_conditions: null })
  ) {
    return;
  }
  throw new ReportSourceChangedError();
}
