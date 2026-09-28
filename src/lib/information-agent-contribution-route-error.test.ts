import { describe, expect, it } from "vitest";
import { readContributionJson } from "./information-agent-contribution-route-error";

describe("contribution request body", () => {
  it("parses a small JSON request", async () => {
    const request = new Request("https://immojudis.example/contribuer", {
      method: "POST",
      body: JSON.stringify({ token: "example" }),
    });
    await expect(readContributionJson(request)).resolves.toEqual({ token: "example" });
  });

  it("rejects an oversized streamed body before parsing it", async () => {
    const request = new Request("https://immojudis.example/contribuer", {
      method: "POST",
      body: JSON.stringify({ note: "x".repeat(70_000) }),
    });
    await expect(readContributionJson(request)).rejects.toMatchObject({ status: 413 });
  });

  it("reports malformed JSON as a client error", async () => {
    const request = new Request("https://immojudis.example/contribuer", {
      method: "POST",
      body: "{invalid-json",
    });
    await expect(readContributionJson(request)).rejects.toMatchObject({ status: 400 });
  });
});
