import { describe, expect, it, vi } from "vitest";

const rows = [
  {
    signal_key: "servitude_pdf",
    signal_kind: "servitude",
    source_kind: "pdf",
    excerpt: "Servitude de passage.",
  },
  {
    signal_key: "zoning_risk",
    signal_kind: "zoning",
    source_kind: "risk",
    excerpt: "Risques physiques: risk_type: x",
  },
];

vi.mock("server-only", () => ({}));
vi.mock("@/integrations/supabase/client.server", () => {
  const query = {
    select: () => query,
    eq: () => query,
    order: () => query,
    limit: async () => ({ data: rows, error: null }),
  };
  return { supabaseAdmin: { from: () => query } };
});

describe("getUrbanPlanningSignals", () => {
  it("leaves out the signals built from the pipeline's risk notes", async () => {
    const { getUrbanPlanningSignals } = await import("@/lib/property-report/repository");

    const signals = await getUrbanPlanningSignals("https://example.test/vente");

    expect(signals.map((signal) => signal.signalKey)).toEqual(["servitude_pdf"]);
  });
});
