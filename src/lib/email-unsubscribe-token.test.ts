import { describe, expect, it } from "vitest";
import {
  REMINDERS_UNSUBSCRIBE_TOKEN_TTL_DAYS,
  UNSUBSCRIBE_TOKEN_TTL_DAYS,
  createUnsubscribeToken,
  unsubscribeTokenScopeKind,
  verifyUnsubscribeToken,
} from "./email-unsubscribe-token";

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

  it("porte la portée « rappels d'audience », distincte de celle des alertes", () => {
    const token = createUnsubscribeToken({ userId, scope: { kind: "reminders" }, now, env });
    expect(verifyUnsubscribeToken(token, { now, env })).toMatchObject({
      userId,
      scope: { kind: "reminders" },
    });
    const alerts = createUnsubscribeToken({ userId, now, env });
    expect(token).not.toBe(alerts);
    // La signature couvre la portée : un jeton d'alertes ne devient pas un jeton de rappels.
    const [payload, signature] = alerts.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, "base64url").toString()),
        s: "reminders",
      }),
    ).toString("base64url");
    expect(verifyUnsubscribeToken(`${forged}.${signature}`, { now, env })).toBeNull();
  });

  it("porte la portée « ouverture de l'offre », signée et distincte des autres", () => {
    const token = createUnsubscribeToken({ userId, scope: { kind: "offer-opening" }, now, env });
    expect(verifyUnsubscribeToken(token, { now, env })).toMatchObject({
      userId,
      scope: { kind: "offer-opening" },
    });
    const reminders = createUnsubscribeToken({ userId, scope: { kind: "reminders" }, now, env });
    expect(token).not.toBe(reminders);
    const [payload, signature] = reminders.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, "base64url").toString()),
        s: "offer-opening",
      }),
    ).toString("base64url");
    expect(verifyUnsubscribeToken(`${forged}.${signature}`, { now, env })).toBeNull();
  });

  it("expire après 60 jours", () => {
    const token = createUnsubscribeToken({ userId, now, env });
    const later = new Date(now.getTime() + 61 * 86_400_000);
    expect(verifyUnsubscribeToken(token, { now: later, env })).toBeNull();
    const almost = new Date(now.getTime() + 59 * 86_400_000);
    expect(verifyUnsubscribeToken(token, { now: almost, env })).not.toBeNull();
  });

  it("garde un lien « rappels d'audience » valable un an, contre 60 jours pour les alertes", () => {
    const reminders = createUnsubscribeToken({ userId, scope: { kind: "reminders" }, now, env });
    const day = (count: number) => new Date(now.getTime() + count * 86_400_000);
    expect(verifyUnsubscribeToken(reminders, { now: day(61), env })).not.toBeNull();
    expect(verifyUnsubscribeToken(reminders, { now: day(364), env })).not.toBeNull();
    expect(verifyUnsubscribeToken(reminders, { now: day(366), env })).toBeNull();
    // Les autres portées gardent leurs 60 jours.
    const alerts = createUnsubscribeToken({ userId, now, env });
    const perAlert = createUnsubscribeToken({
      userId,
      scope: { kind: "alert", alertId },
      now,
      env,
    });
    for (const token of [alerts, perAlert]) {
      expect(verifyUnsubscribeToken(token, { now: day(59), env })).not.toBeNull();
      expect(verifyUnsubscribeToken(token, { now: day(61), env })).toBeNull();
    }
    expect(REMINDERS_UNSUBSCRIBE_TOKEN_TTL_DAYS).toBe(365);
    expect(UNSUBSCRIBE_TOKEN_TTL_DAYS).toBe(60);
  });

  it("reconnaît la portée d'un jeton expiré (signature valide) sans lui donner de droit", () => {
    const reminders = createUnsubscribeToken({ userId, scope: { kind: "reminders" }, now, env });
    const alerts = createUnsubscribeToken({ userId, now, env });
    const much = new Date(now.getTime() + 400 * 86_400_000);
    expect(verifyUnsubscribeToken(reminders, { now: much, env })).toBeNull();
    expect(unsubscribeTokenScopeKind(reminders, { env })).toBe("reminders");
    expect(unsubscribeTokenScopeKind(alerts, { env })).toBe("alerts");
    // Un jeton falsifié ou signé avec un autre secret n'a pas de portée.
    expect(unsubscribeTokenScopeKind(`${reminders}x`, { env })).toBeNull();
    expect(
      unsubscribeTokenScopeKind(reminders, { env: { SUPABASE_SERVICE_ROLE_KEY: "autre" } }),
    ).toBeNull();
    expect(unsubscribeTokenScopeKind(null, { env })).toBeNull();
    expect(unsubscribeTokenScopeKind("n'importe quoi", { env })).toBeNull();
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

  it("choisit la clé dans l'ordre EMAIL_UNSUBSCRIBE_SECRET, SERVICE_ROLE_KEY, SECRET_KEY", () => {
    const sign = (e: Record<string, string>) => createUnsubscribeToken({ userId, now, env: e });
    const allThree = {
      EMAIL_UNSUBSCRIBE_SECRET: "dedie",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key",
      SUPABASE_SECRET_KEY: "sb_secret_test",
    };
    expect(sign(allThree)).toBe(sign({ EMAIL_UNSUBSCRIBE_SECRET: "dedie" }));
    expect(sign({ ...allThree, EMAIL_UNSUBSCRIBE_SECRET: "" })).toBe(
      sign({ SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key" }),
    );
    // Les liens déjà envoyés (clé service-role seule) restent valides.
    expect(verifyUnsubscribeToken(sign(env), { now, env: allThree })).toBeNull();
    expect(
      verifyUnsubscribeToken(sign(env), {
        now,
        env: { ...env, SUPABASE_SECRET_KEY: "sb_secret_test" },
      }),
    ).not.toBeNull();
  });

  it("signe avec SUPABASE_SECRET_KEY quand elle est la seule clé définie", () => {
    const only = { SUPABASE_SECRET_KEY: "sb_secret_test" };
    const token = createUnsubscribeToken({ userId, now, env: only });
    expect(verifyUnsubscribeToken(token, { now, env: only })).toMatchObject({ userId });
    expect(
      verifyUnsubscribeToken(token, { now, env: { SUPABASE_SECRET_KEY: "autre" } }),
    ).toBeNull();
    expect(() => createUnsubscribeToken({ userId, now, env: {} })).toThrow(/Aucun secret/);
  });
});
