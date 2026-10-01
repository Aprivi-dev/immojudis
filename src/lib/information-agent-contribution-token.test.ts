import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createInformationAgentContributionToken,
  verifyInformationAgentContributionToken,
} from "./information-agent-contribution-token";

const missionId = "11111111-1111-4111-8111-111111111111";
const caseId = "33333333-3333-4333-8333-333333333333";
const recipientEmail = "contact@example.test";
const createdAt = "2026-09-28T10:00:00.000Z";
const secret = "a-long-private-test-secret";
const contributionTokenVersion = 1;

describe("information agent contribution token", () => {
  it("accepts only the intended mission during its lifetime", () => {
    const token = createInformationAgentContributionToken(
      missionId,
      createdAt,
      caseId,
      recipientEmail,
      contributionTokenVersion,
      secret,
    );
    expect(
      verifyInformationAgentContributionToken({
        missionId,
        createdAt,
        caseId,
        recipientEmail,
        contributionTokenVersion,
        token,
        secret,
        now: Date.parse(createdAt) + 24 * 60 * 60 * 1000,
      }),
    ).toBe(true);
    expect(
      verifyInformationAgentContributionToken({
        missionId: "22222222-2222-4222-8222-222222222222",
        createdAt,
        caseId,
        recipientEmail,
        contributionTokenVersion,
        token,
        secret,
        now: Date.parse(createdAt),
      }),
    ).toBe(false);
  });

  it("rejects expired, malformed, and tampered tokens", () => {
    const token = createInformationAgentContributionToken(
      missionId,
      createdAt,
      caseId,
      recipientEmail,
      contributionTokenVersion,
      secret,
    );
    const common = {
      missionId,
      createdAt,
      caseId,
      recipientEmail,
      contributionTokenVersion,
      secret,
    };
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

  it("binds a token to its case, recipient, and rotation version", () => {
    const token = createInformationAgentContributionToken(
      missionId,
      createdAt,
      caseId,
      recipientEmail,
      contributionTokenVersion,
      secret,
    );
    const common = { missionId, createdAt, token, secret, now: Date.parse(createdAt) };

    expect(
      verifyInformationAgentContributionToken({
        ...common,
        caseId,
        recipientEmail,
        contributionTokenVersion,
      }),
    ).toBe(true);
    expect(
      verifyInformationAgentContributionToken({
        ...common,
        caseId: "44444444-4444-4444-8444-444444444444",
        recipientEmail,
        contributionTokenVersion,
      }),
    ).toBe(false);
    expect(
      verifyInformationAgentContributionToken({
        ...common,
        caseId,
        recipientEmail: "other@example.test",
        contributionTokenVersion,
      }),
    ).toBe(false);
    expect(
      verifyInformationAgentContributionToken({
        ...common,
        caseId,
        recipientEmail,
        contributionTokenVersion: contributionTokenVersion + 1,
      }),
    ).toBe(false);
  });

  it("does not accept contribution links issued with the v1 payload", () => {
    const legacyToken = createHmac("sha256", secret)
      .update(`v1:${missionId}:${createdAt}`)
      .digest("hex");

    expect(
      verifyInformationAgentContributionToken({
        missionId,
        createdAt,
        caseId,
        recipientEmail,
        contributionTokenVersion,
        token: legacyToken,
        secret,
        now: Date.parse(createdAt),
      }),
    ).toBe(false);
  });
});
