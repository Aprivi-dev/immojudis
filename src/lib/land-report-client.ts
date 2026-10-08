import { authHeaders, readJson } from "./client-api-core";
import type { LandReport } from "./land-report-types";

export async function fetchSaleLandReport(saleId: string, refresh = false): Promise<LandReport> {
  const response = await fetch(
    `/api/v1/sales/${encodeURIComponent(saleId)}/land-report${refresh ? "?refresh=1" : ""}`,
    {
      headers: await authHeaders(),
      cache: "no-store",
      signal: AbortSignal.timeout(175_000),
    },
  );
  return (await readJson<{ report: LandReport }>(response)).report;
}

export async function downloadSaleLandReport(saleId: string): Promise<void> {
  const response = await fetch(
    `/api/v1/sales/${encodeURIComponent(saleId)}/land-report?format=pdf`,
    {
      headers: await authHeaders(),
      cache: "no-store",
      signal: AbortSignal.timeout(175_000),
    },
  );
  if (!response.ok) await readJson(response);
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `immojudis-plu-risques-${saleId}.pdf`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
