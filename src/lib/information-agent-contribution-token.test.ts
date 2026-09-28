import { describe, expect, it } from "vitest";
import {
  createInformationAgentContributionToken,
  verifyInformationAgentContributionToken,
} from "./information-agent-contribution-token";

const missionId = "11111111-1111-4111-8111-111111111111";
const createdAt = "2026-09-28T10:00:00.000Z";
const secret = "a-long-private-test-secret";

describe("information agent contribution token", () => {
  it("accepts only the intended mission during its lifetime", () => {
    const token = createInformationAgentContributionToken(missionId, createdAt, secret);
    expect(
      verifyInformationAgentContributionToken({
        missionId,
        createdAt,
        token,
        secret,
        now: Date.parse(createdAt) + 24 * 60 * 60 * 1000,
      }),
    ).toBe(true);
    expect(
      verifyInformationAgentContributionToken({
        missionId: "22222222-2222-4222-8222-222222222222",
        createdAt,
        token,
        secret,
        now: Date.parse(createdAt),
      }),
    ).toBe(false);
  });

  it("rejects expired, malformed, and tampered tokens", () => {
    const token = createInformationAgentContributionToken(missionId, createdAt, secret);
    const common = { missionId, createdAt, secret };
    expect(
      verifyInformationAgentContributionToken({
        ...common,
        token,
        now: Date.parse(createdAt) + 46 * 24 * 60 * 60 * 1000,
      }),
    ).toBe(false);
    expect(
      verifyInformationAgentContributionToken({
        ...common,
        token: `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`,
        now: Date.parse(createdAt),
      }),
    ).toBe(false);
    expect(
      verifyInformationAgentContributionToken({
        ...common,
        token: "../../invalid",
        now: Date.parse(createdAt),
      }),
    ).toBe(false);
  });
});
