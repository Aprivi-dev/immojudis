import { apiDownload, apiRequest } from "./client-api-core";
import { downloadBlob } from "@/lib/download-blob";
import type { LandReport } from "./land-report-types";

/** Juste sous la durée maximale de la route du rapport (`maxDuration = 180`). */
const LAND_REPORT_TIMEOUT_MS = 175_000;

export async function fetchSaleLandReport(saleId: string, refresh = false): Promise<LandReport> {
  const path = `/api/v1/sales/${encodeURIComponent(saleId)}/land-report${refresh ? "?refresh=1" : ""}`;
  return (await apiRequest<{ report: LandReport }>(path, { timeoutMs: LAND_REPORT_TIMEOUT_MS }))
    .report;
}

export async function downloadSaleLandReport(saleId: string): Promise<void> {
  const { blob, filename } = await apiDownload(
    `/api/v1/sales/${encodeURIComponent(saleId)}/land-report?format=pdf`,
    { timeoutMs: LAND_REPORT_TIMEOUT_MS },
    `immojudis-plu-risques-${saleId}.pdf`,
  );
  downloadBlob(blob, filename);
}
