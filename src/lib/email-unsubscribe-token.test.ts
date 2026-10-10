import { describe, expect, it } from "vitest";
import { createUnsubscribeToken, verifyUnsubscribeToken } from "./email-unsubscribe-token";

const env = { SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key" };
const userId = "7d335032-e935-4550-9347-ed22b0f63449";
const alertId = "11111111-2222-4333-8444-555555555555";
const now = new Date("2026-10-09T10:00:00Z");

describe("unsubscribe tokens", () => {
  it("identifie l'utilisateur et la portée", () => {
    const token = createUnsubscribeToken({ userId, now, env });
    expect(verifyUnsubscribeToken(token, { now, env })).toMatchObject({
      userId,
      scope: { kind: "alerts" },
    });
    const perAlert = createUnsubscribeToken({
      userId,
      scope: { kind: "alert", alertId },
      now,
      env,
    });
    expect(verifyUnsubscribeToken(perAlert, { now, env })?.scope).toEqual({
      kind: "alert",
      alertId,
    });
  });

  it("expire après 60 jours", () => {
    const token = createUnsubscribeToken({ userId, now, env });
    const later = new Date(now.getTime() + 61 * 86_400_000);
    expect(verifyUnsubscribeToken(token, { now: later, env })).toBeNull();
    const almost = new Date(now.getTime() + 59 * 86_400_000);
    expect(verifyUnsubscribeToken(token, { now: almost, env })).not.toBeNull();
  });

  it("refuse un jeton modifié ou signé avec un autre secret", () => {
    const token = createUnsubscribeToken({ userId, now, env });
    const [payload, signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ u: "99999999-2222-4333-8444-555555555555", s: "alerts", e: 9_999_999_999 }),
    ).toString("base64url");
    expect(verifyUnsubscribeToken(`${forged}.${signature}`, { now, env })).toBeNull();
    expect(verifyUnsubscribeToken(`${payload}.x${signature}`, { now, env })).toBeNull();
    expect(
      verifyUnsubscribeToken(token, { now, env: { SUPABASE_SERVICE_ROLE_KEY: "autre" } }),
    ).toBeNull();
    expect(verifyUnsubscribeToken(null, { now, env })).toBeNull();
    expect(verifyUnsubscribeToken("n'importe quoi", { now, env })).toBeNull();
  });
});
