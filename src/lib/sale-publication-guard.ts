import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * A sale marked with publication_quarantine must never be used by a
 * user-facing server path that reads with the service role.  The service role
 * bypasses RLS, so those paths cannot rely on the authenticated table policy
 * or on a security-invoker view to hide the row.
 */
export const SALE_PUBLICATION_UNAVAILABLE_MESSAGE = "Vente introuvable ou inaccessible.";
const PUBLICATION_LOOKUP_BATCH_SIZE = 100;

export class SalePublicationUnavailableError extends Error {
  constructor(message = SALE_PUBLICATION_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = "SalePublicationUnavailableError";
  }
}

export function isPublicationQuarantined(rawPayload: unknown, status?: unknown): boolean {
  const marker =
    rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload)
      ? (rawPayload as Record<string, unknown>).publication_quarantine
      : null;
  return isPublicationQuarantinedMarker(marker, status);
}

export function isPublicationQuarantinedMarker(marker: unknown, status?: unknown): boolean {
  if (typeof status === "string" && status.trim().toLocaleLowerCase("fr-FR") === "quarantined") {
    return true;
  }
  if (marker === undefined || marker === null) return false;
  return String(marker).trim().length > 0;
}

export function assertPublicationVisiblePayload(rawPayload: unknown): void {
  if (isPublicationQuarantined(rawPayload)) {
    throw new SalePublicationUnavailableError();
  }
}

export function assertPublicationVisibleSaleRow(
  row: { id?: unknown; raw_payload?: unknown; status?: unknown } | null | undefined,
): asserts row is { id: string; raw_payload?: unknown; status?: unknown } {
  if (!row || typeof row.id !== "string" || row.id.length === 0) {
    throw new SalePublicationUnavailableError();
  }
  if (isPublicationQuarantined(row.raw_payload, row.status)) {
    throw new SalePublicationUnavailableError();
  }
}

/**
 * Explicitly checks a sale before a user-facing service-role read.  Database
 * errors are allowed to propagate so an unavailable guard fails closed.
 */
export async function assertSalePublicationVisible(saleId: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("auction_sales")
    .select("id,status,publication_quarantine:raw_payload->>publication_quarantine")
    .eq("id", saleId)
    .maybeSingle();

  if (error) throw error;
  if (
    !data ||
    typeof data.id !== "string" ||
    isPublicationQuarantinedMarker(data.publication_quarantine, data.status)
  ) {
    throw new SalePublicationUnavailableError();
  }
}

/**
 * Filters rows returned through a service-role query while retaining the
 * caller's row type.  Query errors must be handled by the caller before this
 * function is reached; an absent row is therefore simply not visible.
 */
export function publicationVisibleRows<T extends { raw_payload?: unknown; status?: unknown }>(
  rows: readonly T[],
): T[] {
  return rows.filter((row) => !isPublicationQuarantined(row.raw_payload, row.status));
}

export async function getPublicationVisibleSaleIds(
  saleIds: readonly string[],
): Promise<Set<string>> {
  const uniqueSaleIds = [...new Set(saleIds)];
  if (!uniqueSaleIds.length) return new Set();

  const visibleSaleIds = new Set<string>();
  // Exports can inspect 1,000 sales. Keep each PostgREST query URL bounded;
  // propagate any batch error before returning a partial visible set.
  for (let start = 0; start < uniqueSaleIds.length; start += PUBLICATION_LOOKUP_BATCH_SIZE) {
    const { data, error } = await supabaseAdmin
      .from("auction_sales")
      .select("id,status,publication_quarantine:raw_payload->>publication_quarantine")
      .in("id", uniqueSaleIds.slice(start, start + PUBLICATION_LOOKUP_BATCH_SIZE));

    if (error) throw error;
    for (const sale of data ?? []) {
      if (
        typeof sale.id === "string" &&
        !isPublicationQuarantinedMarker(sale.publication_quarantine, sale.status)
      ) {
        visibleSaleIds.add(sale.id);
      }
    }
  }
  return visibleSaleIds;
}
