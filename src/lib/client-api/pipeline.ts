import { authHeaders, readJson } from "@/lib/client-api-core";
import type { PipelineControlSettings, PipelineStatus } from "@/lib/pipeline-status";

export async function fetchPipelineStatus(): Promise<PipelineStatus> {
  return readJson(
    await fetch("/api/admin/pipeline", {
      signal: AbortSignal.timeout(30_000),
      headers: await authHeaders(),
      cache: "no-store",
    }),
  );
}
export async function setPipelineSourceEnabled(source: string, enabled: boolean): Promise<void> {
  await readJson(
    await fetch("/api/admin/pipeline", {
      method: "PATCH",
      headers: await authHeaders(),
      body: JSON.stringify({ source, enabled }),
    }),
  );
}

export async function updatePipelineControl(
  changes: Partial<PipelineControlSettings>,
): Promise<PipelineStatus["control"]> {
  const response = await fetch("/api/admin/pipeline/control", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(changes),
    signal: AbortSignal.timeout(10_000),
  });

  return readJson<PipelineStatus["control"]>(response);
}
