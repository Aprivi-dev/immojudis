import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { discoverInformationAgentContacts } from "@/lib/information-agent";
import type { AuctionSale } from "@/lib/market";

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: vi.fn() },
}));

/**
 * Cas partagés avec le miroir Python du résolveur (services/data-pipeline/src/
 * information_sufficiency.py, tests/test_information_sufficiency.py). La règle de
 * rétention « informations suffisantes » du pipeline s'appuie sur ce résolveur :
 * si ce test change, le miroir Python doit changer avec lui.
 */
type ParityCase = {
  name: string;
  lawyer_contact?: string;
  description?: string;
  source_description?: string;
  source_blocks?: Record<string, unknown>;
  observation_source_blocks?: unknown[];
  expected: string[];
};

const fixturePath = path.join(
  process.cwd(),
  "services/data-pipeline/tests/fixtures/information_agent_contact_cases.json",
);
const { cases } = JSON.parse(readFileSync(fixturePath, "utf8")) as { cases: ParityCase[] };

function saleFor(testCase: ParityCase): AuctionSale {
  const blocksBySource: Record<string, unknown> = {};
  if (testCase.source_blocks) blocksBySource["source:primary"] = testCase.source_blocks;
  (testCase.observation_source_blocks ?? []).forEach((blocks, index) => {
    if (blocks && typeof blocks === "object" && !Array.isArray(blocks)) {
      blocksBySource[`source:${index + 1}`] = blocks;
    }
  });
  return {
    id: "sale-fixture",
    source_name: "fixture",
    primary_source: "fixture",
    source_url: "https://example.test/vente",
    lawyer_contact: testCase.lawyer_contact ?? null,
    description: testCase.description ?? null,
    source_description: testCase.source_description ?? null,
    source_blocks: testCase.source_blocks ?? null,
    source_blocks_by_source: blocksBySource,
  } as unknown as AuctionSale;
}

describe("discoverInformationAgentContacts : cas partagés avec le miroir Python", () => {
  it("charge au moins un cas", () => {
    expect(cases.length).toBeGreaterThan(5);
  });

  it.each(cases.map((testCase) => [testCase.name, testCase] as const))("%s", (_name, testCase) => {
    const emails = discoverInformationAgentContacts(saleFor(testCase))
      .map((candidate) => candidate.email)
      .sort();
    expect(emails).toEqual([...testCase.expected].sort());
  });
});
