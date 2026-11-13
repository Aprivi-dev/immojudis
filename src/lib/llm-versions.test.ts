import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function repositoryFile(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("prompt version of the data pipeline", () => {
  it("is the same in the pipeline configuration and in the workflow that pins it", () => {
    const configured = /^DEFAULT_LLM_PROMPT_VERSION = "([^"]+)"/m.exec(
      repositoryFile("services/data-pipeline/src/config.py"),
    )?.[1];
    const pinned = /^\s*LLM_PROMPT_VERSION: (\S+)/m.exec(
      repositoryFile(".github/workflows/data-pipeline.yml"),
    )?.[1];

    expect(configured).toMatch(/\S/);
    expect(pinned).toBe(configured);
  });
});
