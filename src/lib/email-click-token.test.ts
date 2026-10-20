import { describe, expect, it } from "vitest";
import {
  createEmailClickToken,
  EMAIL_CLICK_TOKEN_TTL_DAYS,
  emailClickPath,
  emailClickUrl,
  isEmailClickSaleId,
  readEmailClickToken,
} from "@/lib/email-click-token";
import { createUnsubscribeToken, verifyUnsubscribeToken } from "@/lib/email-unsubscribe-token";

const env = { SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key" };
const userId = "7d335032-e935-4550-9347-ed22b0f63449";
const saleId = "A1B2C3D4-0000-4000-8000-000000000001";
const now = new Date("2026-11-03T06:00:00Z");

const token = (overrides: Partial<Parameters<typeof createEmailClickToken>[0]> = {}) =>
  createEmailClickToken({ userId, kind: "alert", target: "sale", saleId, now, env, ...overrides });

function forge(payload: object, signatureFrom = token()) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${signatureFrom.split(".")[1]}`;
}

describe("jeton de lien suivi d'un email", () => {
  it("porte le compte, le type d'email, la destination et la vente (en minuscules)", () => {
    expect(
      readEmailClickToken(token({ kind: "reminder", target: "calendar" }), { now, env }),
    ).toEqual({
      claims: {
        userId,
        kind: "reminder",
        target: "calendar",
        saleId: "a1b2c3d4-0000-4000-8000-000000000001",
        expiresAt: Math.floor(now.getTime() / 1000) + EMAIL_CLICK_TOKEN_TTL_DAYS * 86_400,
      },
      expired: false,
    });
  });

  it("reste lisible mais périmé après 90 jours, pour mener quand même à la vente", () => {
    const later = new Date(now.getTime() + (EMAIL_CLICK_TOKEN_TTL_DAYS + 1) * 86_400_000);
    expect(readEmailClickToken(token(), { now: later, env })?.expired).toBe(true);
  });

  it("refuse un jeton absent, mal formé, trafiqué ou signé avec une autre clé", () => {
    expect(readEmailClickToken(null, { now, env })).toBeNull();
    expect(readEmailClickToken("", { now, env })).toBeNull();
    expect(readEmailClickToken("a.b.c", { now, env })).toBeNull();
    expect(readEmailClickToken(token().slice(0, -2), { now, env })).toBeNull();
    expect(readEmailClickToken("x".repeat(1_001), { now, env })).toBeNull();
    expect(
      readEmailClickToken(token(), { now, env: { SUPABASE_SERVICE_ROLE_KEY: "autre" } }),
    ).toBeNull();
    // Sans aucun secret : rien n'est cru.
    expect(readEmailClickToken(token(), { now, env: {} })).toBeNull();
  });

  it("refuse un jeton dont le contenu a été changé sous la même signature", () => {
    const base = { u: userId, k: "alert", t: "sale", s: saleId, e: 4_000_000_000 };
    expect(readEmailClickToken(forge(base), { now, env })).toBeNull();
    for (const changed of [
      { ...base, u: "7d335032-e935-4550-9347-ed22b0f63450" },
      { ...base, s: "a1b2c3d4-0000-4000-8000-000000000002" },
      { ...base, t: "calendar" },
    ]) {
      expect(readEmailClickToken(forge(changed), { now, env })).toBeNull();
    }
  });

  it("accepte les types du récapitulatif hebdomadaire et de l'alerte de résultat", () => {
    for (const kind of ["weekly", "result"] as const) {
      expect(readEmailClickToken(token({ kind }), { now, env })?.claims.kind).toBe(kind);
    }
    // Un type de plus se paie d'un changement de la contrainte SQL (migration 20261030120400) : la
    // liste fermée ne s'ouvre pas par un jeton forgé.
    expect(readEmailClickToken(token({ kind: "digest" as never }), { now, env })).toBeNull();
  });

  it("n'accepte ni un type, ni une destination, ni une vente hors liste, même signés", () => {
    // Signés avec la bonne clé mais hors des valeurs fermées : refusés à la lecture.
    const good = token();
    expect(readEmailClickToken(good, { now, env })).not.toBeNull();
    for (const bad of [
      { kind: "promo" },
      { target: "https://example.test" },
      { saleId: "../../etc/passwd" },
      { userId: "not-a-uuid" },
    ]) {
      expect(readEmailClickToken(token(bad as never), { now, env })).toBeNull();
    }
  });

  it("n'est pas interchangeable avec un jeton de désinscription", () => {
    const unsubscribe = createUnsubscribeToken({ userId, now, env });
    expect(readEmailClickToken(unsubscribe, { now, env })).toBeNull();
    expect(verifyUnsubscribeToken(token(), { now, env })).toBeNull();
  });
});

describe("destination d'un lien suivi", () => {
  it("est un chemin du site construit à partir de valeurs fermées", () => {
    const sale = "a1b2c3d4-0000-4000-8000-000000000001";
    expect(emailClickPath({ target: "sale", saleId: sale })).toBe(`/sales/${sale}`);
    expect(emailClickPath({ target: "calendar", saleId: sale })).toBe(
      `/api/sales/${sale}/calendar`,
    );
    for (const target of ["sale", "calendar"] as const) {
      expect(emailClickPath({ target, saleId: sale })).toMatch(/^\/(?!\/)/);
    }
  });

  it("l'adresse du lien n'a qu'un paramètre, le jeton", () => {
    const url = new URL(
      emailClickUrl({
        appUrl: "https://immojudis.com",
        userId,
        kind: "alert",
        target: "sale",
        saleId,
        now,
        env,
      }),
    );
    expect(url.origin + url.pathname).toBe("https://immojudis.com/api/email/click");
    expect([...url.searchParams.keys()]).toEqual(["token"]);
  });

  it("n'utilise un lien suivi que pour un identifiant de vente valide", () => {
    expect(isEmailClickSaleId(saleId)).toBe(true);
    expect(isEmailClickSaleId("sale-1")).toBe(false);
    expect(isEmailClickSaleId(null)).toBe(false);
  });
});
