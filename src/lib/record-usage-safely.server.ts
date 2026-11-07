import "server-only";
import { recordFeatureUsageEvent } from "@/lib/usage";

export function recordUsageSafely(input: Parameters<typeof recordFeatureUsageEvent>[0]): void {
  try {
    void recordFeatureUsageEvent(input).catch(() => undefined);
  } catch {
    // Telemetry must never delay or fail a Premium statistics read.
  }
}
