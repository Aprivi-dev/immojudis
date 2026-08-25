import { describe, expect, it, vi } from "vitest";
import { extractInformationAgentFacts, findInboundToken } from "@/lib/information-agent-inbound";

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: vi.fn(), storage: { from: vi.fn() } },
}));

describe("information agent inbound parsing", () => {
  it("routes only the signed case address on the configured domain", () => {
    const token = "11111111-1111-4111-8111-111111111111";
    expect(
      findInboundToken(
        [`Assistant ImmoJudis <enquete+${token}@reponses.immojudis.com>`],
        "reponses.immojudis.com",
      ),
    ).toBe(token);
    expect(
      findInboundToken([`enquete+${token}@example.test`], "reponses.immojudis.com"),
    ).toBeNull();
  });

  it("extracts bounded candidates without treating them as verified facts", () => {
    const facts = extractInformationAgentFacts(
      "Le logement est libre. La surface habitable est de 84,5 m² et il comprend 4 pièces.",
    );

    expect(facts.map((fact) => fact.factKey)).toEqual([
      "surface_m2",
      "rooms_count",
      "occupancy_status",
    ]);
    expect(facts[0]?.proposedValue).toEqual({ value: 84.5, unit: "m2" });
    expect(facts[1]?.proposedValue).toEqual({ value: 4 });
    expect(facts[2]?.proposedValue).toEqual({ value: "vacant" });
  });

  it("rejects implausible numeric candidates", () => {
    expect(extractInformationAgentFacts("Surface annoncée : 9999999 m² et 999 pièces.")).toEqual(
      [],
    );
  });
});
