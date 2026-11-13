import { apiRequest } from "@/lib/client-api-core";
import type { PipelineControlSettings, PipelineStatus } from "@/lib/pipeline-status";

export function fetchPipelineStatus(): Promise<PipelineStatus> {
  return apiRequest<PipelineStatus>("/api/admin/pipeline");
}

export async function setPipelineSourceEnabled(source: string, enabled: boolean): Promise<void> {
  await apiRequest("/api/admin/pipeline", { method: "PATCH", body: { source, enabled } });
}

export function updatePipelineControl(
  changes: Partial<PipelineControlSettings>,
): Promise<PipelineStatus["control"]> {
  return apiRequest<PipelineStatus["control"]>("/api/admin/pipeline/control", {
    method: "PATCH",
    body: changes,
  });
}
