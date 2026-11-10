import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectPossiblePromptInjection } from "@/lib/information-agent-inbound/prompt-injection";

/** Les 20 cas d'injection de la relecture du 10/11/2026, communs avec le worker Python. */
const { injection } = JSON.parse(
  readFileSync(
    join(
      process.cwd(),
      "services/data-pipeline/tests/fixtures/information_agent_extraction_attack.json",
    ),
    "utf8",
  ),
) as { injection: Array<{ id: string; expected: boolean; text: string }> };

describe("détecteur de consignes : cas de la relecture", () => {
  it("compte les 20 cas", () => expect(injection).toHaveLength(20));

  it.each(injection.map((testCase) => [testCase.id, testCase]))("%s", (_id, testCase) => {
    expect(detectPossiblePromptInjection(testCase.text)).toBe(testCase.expected);
  });
});
