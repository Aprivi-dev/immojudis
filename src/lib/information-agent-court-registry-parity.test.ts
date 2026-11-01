import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  courtRegistryFallbackEmails,
  isCourtRegistryFallbackSale,
  type CourtRegistryFallbackSale,
} from "@/lib/information-agent/court-registry-fallback";
import { normalizedEmail } from "@/lib/information-agent/email-address";

/**
 * Cas partagés avec le miroir Python du greffe de secours (services/data-pipeline/src/
 * information_sufficiency.py : `is_court_sale`, `court_registry_fallback_emails`, tests/
 * test_information_sufficiency.py). La preuve `court_email` du minimum d'une annonce s'appuie sur
 * cette règle : si ce test change, le miroir Python doit changer avec lui.
 */
type ParityCase = {
  name: string;
  sale: CourtRegistryFallbackSale;
  blocked?: string[];
  court_sale: boolean;
  expected: string[];
};

const fixturePath = path.join(
  process.cwd(),
  "services/data-pipeline/tests/fixtures/court_registry_fallback_cases.json",
);
const { registry, cases } = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  registry: Record<string, string[]>;
  cases: ParityCase[];
};

describe("greffe de secours : cas partagés avec le miroir Python", () => {
  it("charge les cas", () => {
    expect(cases.length).toBeGreaterThan(15);
  });

  it.each(cases.map((testCase) => [testCase.name, testCase] as const))("%s", (_name, testCase) => {
    const blocked = new Set((testCase.blocked ?? []).map((email) => normalizedEmail(email)!));
    const registryEmails = registry[testCase.sale.tribunal_code ?? ""] ?? [];
    expect(isCourtRegistryFallbackSale(testCase.sale)).toBe(testCase.court_sale);
    expect(courtRegistryFallbackEmails(testCase.sale, registryEmails, blocked)).toEqual(
      testCase.expected,
    );
  });
});
