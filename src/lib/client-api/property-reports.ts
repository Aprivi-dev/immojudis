import { apiDownload, apiRequest } from "@/lib/client-api-core";
import type {
  PropertyReportListResponse,
  PropertyReportRequestInput,
  PropertyReportSaveResponse,
  PropertyReportShareResponse,
  PropertyReportUpdateInput,
} from "@/lib/property-reports";

export function fetchPropertyReports(
  args: {
    saleId?: string;
  } = {},
): Promise<PropertyReportListResponse> {
  const search = new URLSearchParams();
  if (args.saleId) search.set("saleId", args.saleId);
  return apiRequest<PropertyReportListResponse>(
    `/api/property-reports${search.size ? `?${search.toString()}` : ""}`,
  );
}

export function savePropertyReport(args: {
  data: PropertyReportRequestInput;
}): Promise<PropertyReportSaveResponse> {
  return apiRequest<PropertyReportSaveResponse>("/api/property-reports", {
    method: "POST",
    body: args.data,
  });
}

export function updatePropertyReport(args: {
  reportId: string;
  data: PropertyReportUpdateInput;
}): Promise<PropertyReportSaveResponse> {
  return apiRequest<PropertyReportSaveResponse>(`/api/property-reports/${args.reportId}`, {
    method: "PATCH",
    body: args.data,
  });
}

export async function exportPropertyReportPdf(args: {
  reportId: string;
}): Promise<{ blob: Blob; filename: string }> {
  const { blob, filename } = await apiDownload(
    `/api/property-reports/${args.reportId}/export`,
    { method: "POST" },
    "rapport-immojudis.pdf",
  );
  return { blob, filename };
}

export function enablePropertyReportShare(args: {
  reportId: string;
  expiresAt?: string | null;
}): Promise<PropertyReportShareResponse> {
  return apiRequest<PropertyReportShareResponse>(`/api/property-reports/${args.reportId}/share`, {
    method: "POST",
    body: { expiresAt: args.expiresAt ?? null },
  });
}

export function disablePropertyReportShare(args: {
  reportId: string;
}): Promise<PropertyReportShareResponse> {
  return apiRequest<PropertyReportShareResponse>(`/api/property-reports/${args.reportId}/share`, {
    method: "DELETE",
  });
}
