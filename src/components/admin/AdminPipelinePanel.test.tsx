// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PipelineSourceState, PipelineStatus } from "@/lib/pipeline-status";

const mocks = vi.hoisted(() => ({ fetchStatus: vi.fn(), setEnabled: vi.fn() }));

vi.mock("@/lib/client-api", () => ({
  fetchPipelineStatus: mocks.fetchStatus,
  setPipelineSourceEnabled: mocks.setEnabled,
}));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AdminPipelinePanel } from "./AdminPipelinePanel";

function source(overrides: Partial<PipelineSourceState>): PipelineSourceState {
  return {
    source_name: "encheres_immobilieres",
    enabled: true,
    availability: "available",
    last_inventory_complete_at: null,
    last_publication_complete_at: "2026-10-08T05:30:00Z",
    next_inventory_at: "2026-10-23T12:00:00Z",
    suspended_until: null,
    suspension_reason: null,
    last_error: null,
    ...overrides,
  };
}

function status(sources: PipelineSourceState[]): PipelineStatus {
  return {
    usage: {
      ai_requests: 0,
      ai_estimated_usd: 0,
      ai_unpriced_requests: 0,
      daily_ai_budget_usd: 5,
      runner_seconds: 0,
    },
    sources,
    control: {
      enabled: true,
      source_details_enabled: true,
      max_ai_predictions_per_run: 10,
      daily_ai_budget_usd: 5,
      observation_started_at: null,
      updated_at: "2026-10-23T00:00:00Z",
    },
    observations: [],
    alerts: [],
  };
}

function renderPanel() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      <AdminPipelinePanel />
    </QueryClientProvider>,
  );
}

describe("AdminPipelinePanel", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("names what blocks the complete publication of a source", async () => {
    mocks.fetchStatus.mockResolvedValue(
      status([
        source({
          coverage: {
            publication_published: 190,
            publication_pending: 3,
            publication_blockers: ["inventory_incomplete", "run_not_succeeded"],
          },
        }),
      ]),
    );

    renderPanel();

    expect(
      await screen.findByText("Bloquée par : inventory_incomplete, run_not_succeeded."),
    ).toBeTruthy();
  });

  it("shows nothing when no blocker is recorded", async () => {
    mocks.fetchStatus.mockResolvedValue(
      status([
        source({
          source_name: "agrasc",
          coverage: { publication_published: 12, publication_pending: 0, publication_blockers: [] },
        }),
      ]),
    );

    renderPanel();

    await screen.findByText("agrasc");
    expect(screen.queryByText(/Bloquée par/)).toBeNull();
  });
});
