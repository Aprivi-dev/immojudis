import { describe, expect, it } from "vitest";
import { allowedFactClaimDecisionActions, isFinalFactClaimDecision } from "./fact-claim-decisions";

describe("actions permises selon la dernière décision d'une observation", () => {
  it.each([
    ["aucune décision", null, ["accept", "reject", "oppose"]],
    ["acceptée", { decision: "accepted", reasonCode: null }, ["reject", "withdraw", "oppose"]],
    ["rejetée", { decision: "rejected", reasonCode: "other" }, ["accept", "oppose"]],
    ["retirée", { decision: "withdrawn", reasonCode: "entry_error" }, ["accept", "oppose"]],
    [
      "contredite",
      { decision: "contradicted", reasonCode: "by_listing" },
      ["accept", "reject", "oppose"],
    ],
    [
      "autorisation retirée (définitif)",
      { decision: "withdrawn", reasonCode: "authorization_withdrawn" },
      ["oppose"],
    ],
    ["opposition (définitif)", { decision: "opposed", reasonCode: "professional_opposition" }, []],
    ["décision inconnue", { decision: "autre", reasonCode: null }, []],
  ])("%s", (_name, latest, expected) => {
    expect(allowedFactClaimDecisionActions(latest)).toEqual(expected);
  });

  it("ne propose jamais d'accepter après une décision définitive", () => {
    for (const latest of [
      { decision: "opposed", reasonCode: "professional_opposition" },
      { decision: "withdrawn", reasonCode: "authorization_withdrawn" },
    ]) {
      expect(isFinalFactClaimDecision(latest)).toBe(true);
      expect(allowedFactClaimDecisionActions(latest)).not.toContain("accept");
    }
    expect(isFinalFactClaimDecision({ decision: "withdrawn", reasonCode: "other" })).toBe(false);
    expect(isFinalFactClaimDecision(null)).toBe(false);
  });
});
