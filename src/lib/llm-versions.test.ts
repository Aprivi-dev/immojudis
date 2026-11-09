import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXPECTED_LLM_PROMPT_VERSION } from "@/lib/llm-versions";

function pipelineSource(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), "services/data-pipeline", relativePath), "utf8");
}

describe("versions expected from the data pipeline", () => {
  it("follow the prompt version of the pipeline configuration", () => {
    const match = /^DEFAULT_LLM_PROMPT_VERSION = "([^"]+)"/m.exec(pipelineSource("src/config.py"));

    expect(match?.[1]).toBe(EXPECTED_LLM_PROMPT_VERSION);
  });

  it("follow the prompt version pinned by the pipeline workflow", () => {
    const workflow = readFileSync(
      path.join(process.cwd(), ".github/workflows/data-pipeline.yml"),
      "utf8",
    );

    expect(/^\s*LLM_PROMPT_VERSION: (\S+)/m.exec(workflow)?.[1]).toBe(EXPECTED_LLM_PROMPT_VERSION);
  });
});
