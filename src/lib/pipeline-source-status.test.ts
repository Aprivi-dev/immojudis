import { describe, expect, it } from "vitest";
import { pipelineSourceStatus } from "./pipeline-source-status";
import type { PipelineSourceState } from "./pipeline-status";

const source: PipelineSourceState = {
  source_name: "notaires",
  enabled: true,
  availability: "available",
  last_inventory_complete_at: null,
  last_publication_complete_at: null,
  next_inventory_at: "2026-09-20T00:00:00Z",
  suspended_until: null,
  suspension_reason: null,
  last_error: null,
};

describe("pipeline source status", () => {
  it("does not describe failed publication as available", () => {
    expect(pipelineSourceStatus({ ...source, last_error: "immutable source_name" }).label).toBe(
      "Publication partielle",
    );
    expect(
      pipelineSourceStatus({
        ...source,
        coverage: { publication_status: "failed", publication_failed: 1 },
      }).label,
    ).toBe("Publication partielle");
    expect(
      pipelineSourceStatus({ ...source, coverage: { stop_reason: "source_budget_exhausted" } })
        .label,
    ).toBe("Collecte à reprendre");
  });
  it("shows durable partial progress even after a runner timeout", () => {
    expect(
      pipelineSourceStatus({
        ...source,
        availability: "unavailable",
        last_error: "Execution budget exceeded",
        coverage: { publication_published: 343, publication_pending: 12 },
      }).label,
    ).toBe("Collecte à reprendre");
  });
  it("keeps access refusals visible even with older successful scope evidence", () => {
    expect(
      pipelineSourceStatus({
        ...source,
        availability: "access_denied",
        coverage: { scoped_inventory_complete: true },
      }).label,
    ).toBe("Accès refusé");
  });
  it("does not call addressable scope global completeness", () => {
    expect(
      pipelineSourceStatus({ ...source, coverage: { scoped_inventory_complete: true } }).label,
    ).toBe("Catalogue accessible vérifié");
    expect(
      pipelineSourceStatus({
        ...source,
        coverage: { scoped_inventory_complete: true, publication_pending: 1 },
      }).label,
    ).toBe("Publication partielle");
  });
});
