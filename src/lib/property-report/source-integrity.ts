import { createHash } from "node:crypto";
import type { AuctionSale } from "../types";

// A capture timestamp or gallery reorder does not change the report's findings.
const ignoredKeys = new Set(["created_at", "updated_at", "media"]);

/**
 * Mise en production de la colonne `sale_conditions` (migration 20261103110000). Une empreinte `v1:`
 * enregistrée avant cet instant a été calculée sans la colonne ; après, une valeur nulle ne doit
 * plus être acceptée comme « inchangée » quand les conditions se remplissent.
 */
const SALE_CONDITIONS_COLUMN_SINCE = Date.parse("2026-11-03T11:00:00Z");

/**
 * `legacy` (empreinte `v1:`) laisse de côté `sale_conditions` quand elle est vide. `v2:` l'inclut
 * toujours, même nulle : un rapport enregistré conditions vides n'est plus « à jour » une fois
 * les conditions remplies.
 */
function canonical(value: unknown, legacy: boolean, root = true): unknown {
  if (Array.isArray(value)) {
    return value
      .map((item) => canonical(item, legacy, false))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([key]) => !ignoredKeys.has(key))
      .filter(([key, item]) => !legacy || key !== "sale_conditions" || item != null);
    if (!legacy && root && !entries.some(([key]) => key === "sale_conditions")) {
      entries.push(["sale_conditions", null]);
    }
    return Object.fromEntries(
      entries
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item, legacy, false)]),
    );
  }
  return value ?? null;
}

function digest(sale: AuctionSale, legacy: boolean): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(sale, legacy)))
    .digest("hex");
}

export function reportSourceFingerprint(sale: AuctionSale): string {
  return `v2:${digest(sale, false)}`;
}

/** Empreinte `v1:` (avant la migration 20261103110000) : uniquement pour les tests de repli. */
export function legacyFingerprint(sale: AuctionSale): string {
  return `v1:${digest(sale, true)}`;
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
  const record =
    snapshot && typeof snapshot === "object" ? (snapshot as Record<string, unknown>) : {};
  const fingerprint = record.sourceFingerprint;
  if (fingerprint === reportSourceFingerprint(sale)) return;
  if (typeof fingerprint === "string" && fingerprint.startsWith("v1:")) {
    if (fingerprint === legacyFingerprint(sale)) return;
    // Un rapport notarial enregistré avant la migration 20261103110000 a été empreint sans la
    // colonne `sale_conditions` (elle n'existait pas) : l'empreinte calculée avec
    // `sale_conditions: null` reste valide, pour qu'il ne demande pas d'être sauvegardé à nouveau
    // à cause de la seule colonne. Ce repli ne vaut que pour ces rapports antérieurs : ensuite,
    // des conditions ajoutées après l'enregistrement rendent le rapport périmé.
    const generatedAt = Date.parse(String(record.generatedAt ?? ""));
    if (
      sale.sale_conditions != null &&
      Number.isFinite(generatedAt) &&
      generatedAt < SALE_CONDITIONS_COLUMN_SINCE &&
      fingerprint === legacyFingerprint({ ...sale, sale_conditions: null })
    ) {
      return;
    }
  }
  throw new ReportSourceChangedError();
}
