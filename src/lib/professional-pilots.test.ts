import { describe, expect, it } from "vitest";
import {
  buildPilotPacket,
  emptyPilotDraft,
  pilotDraftSchema,
  pilotEconomics,
  pilotReadiness,
  type PilotDefinition,
} from "@/lib/professional-pilots";

const definition: PilotDefinition = {
  kind: "state",
  title: "Bureau de candidature",
  description: "Préparer une candidature",
  priceLabel: "Prix proposé",
  packetLabel: "Dossier de candidature",
  counterpartyLabel: "Service vendeur",
  counterparty: null,
  facts: [{ label: "Mode de cession", value: null }],
  milestones: [{ label: "Date limite", date: null }],
  checks: [
    { id: "mode", label: "Mode confirmé", reason: "Lire l'annonce" },
    { id: "deposit", label: "Canal de dépôt confirmé", reason: "Lire le cahier" },
  ],
};

describe("professional sale pilots", () => {
  it("does not invent a complete cost or margin when an assumption is missing", () => {
    const draft = { ...emptyPilotDraft("state"), priceEur: 200_000, worksEur: 20_000 };
    expect(pilotEconomics(draft)).toEqual({
      totalInvestment: null,
      marginEur: null,
      marginPct: null,
      cashNeededEur: null,
      maximumEntryPriceEur: null,
      headroomEur: null,
    });
  });

  it("calculates a transparent all-in scenario from user inputs", () => {
    const draft = {
      ...emptyPilotDraft("state"),
      priceEur: 200_000,
      acquisitionCostsEur: 15_000,
      worksEur: 20_000,
      carryingCostsEur: 5_000,
      exitValueEur: 300_000,
      financingEur: 180_000,
      targetProfitEur: 40_000,
    };
    expect(pilotEconomics(draft)).toEqual({
      totalInvestment: 240_000,
      marginEur: 60_000,
      marginPct: 25,
      cashNeededEur: 60_000,
      maximumEntryPriceEur: 220_000,
      headroomEur: 20_000,
    });
  });

  it("keeps an impossible profit target explicit", () => {
    const draft = {
      ...emptyPilotDraft("state"),
      acquisitionCostsEur: 20_000,
      worksEur: 30_000,
      carryingCostsEur: 10_000,
      exitValueEur: 50_000,
      targetProfitEur: 5_000,
    };
    expect(pilotEconomics(draft).maximumEntryPriceEur).toBe(-15_000);
    expect(buildPilotPacket({ definition, draft, saleTitle: "Terrain", saleUrl: null })).toContain(
      "Objectif irréalisable avec les coûts saisis",
    );
  });

  it("keeps missing facts and blocked checks visible in the exported packet", () => {
    const draft = {
      ...emptyPilotDraft("state"),
      checkStatuses: { mode: "verified" as const, deposit: "blocked" as const },
      documentStatuses: { "https://example.test/reglement.pdf": "question" as const },
      documentNotes: { "https://example.test/reglement.pdf": "Confirmer le dépôt" },
    };
    expect(pilotReadiness(definition, draft)).toMatchObject({
      verified: 1,
      remaining: 0,
      missingFacts: [{ label: "Mode de cession", value: null }],
    });
    const packet = buildPilotPacket({
      definition,
      draft,
      saleTitle: "Terrain public",
      saleUrl: null,
      documents: [{ label: "Règlement", url: "https://example.test/reglement.pdf" }],
    });
    expect(packet).toContain("Mode de cession : À confirmer");
    expect(packet).toContain("Canal de dépôt confirmé — Bloquant");
    expect(packet).toContain("Investissement total : À chiffrer");
    expect(packet).toContain("Règlement — Question ouverte");
    expect(packet).toContain("Confirmer le dépôt");
  });

  it("rejects negative amounts and unexpected check statuses", () => {
    expect(pilotDraftSchema.safeParse({ kind: "state", priceEur: -1 }).success).toBe(false);
    expect(
      pilotDraftSchema.safeParse({ kind: "state", checkStatuses: { deposit: "auto" } }).success,
    ).toBe(false);
  });
});
