import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXPECTED_DISPLAY_QUALITY_VERSION, EXPECTED_LLM_PROMPT_VERSION } from "@/lib/llm-versions";

function pipelineSource(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), "services/data-pipeline", relativePath), "utf8");
}

describe("versions expected from the data pipeline", () => {
  it("follow the prompt version of the pipeline configuration", () => {
    const match = /^DEFAULT_LLM_PROMPT_VERSION = "([^"]+)"/m.exec(pipelineSource("src/config.py"));

    expect(match?.[1]).toBe(EXPECTED_LLM_PROMPT_VERSION);
  });

  it("follow the prompt version pinned by the pipeline workflow and the audit script", () => {
    const workflow = readFileSync(
      path.join(process.cwd(), ".github/workflows/data-pipeline.yml"),
      "utf8",
    );
    const audit = readFileSync(
      path.join(process.cwd(), "scripts/audit-ai-descriptions.mjs"),
      "utf8",
    );

    expect(/^\s*LLM_PROMPT_VERSION: (\S+)/m.exec(workflow)?.[1]).toBe(EXPECTED_LLM_PROMPT_VERSION);
    expect(/DEFAULT_PROMPT_VERSION = "([^"]+)"/.exec(audit)?.[1]).toBe(EXPECTED_LLM_PROMPT_VERSION);
  });

  it("follow the display quality version of the pipeline", () => {
    const match = /^DISPLAY_QUALITY_VERSION = "([^"]+)"/m.exec(
      pipelineSource("src/enrichment/display_quality.py"),
    );

    expect(match?.[1]).toBe(EXPECTED_DISPLAY_QUALITY_VERSION);
  });
});
