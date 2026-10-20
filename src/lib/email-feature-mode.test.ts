import { describe, expect, it } from "vitest";
import {
  saleResultsMode,
  saleResultsOfferedTo,
  weeklyDigestMode,
  weeklyDigestOfferedTo,
} from "./email-feature-mode";

describe("weeklyDigestMode et saleResultsMode", () => {
  it("valent off par défaut, chacun avec sa propre variable", () => {
    expect(weeklyDigestMode({})).toBe("off");
    expect(saleResultsMode({})).toBe("off");
    expect(weeklyDigestMode({ WEEKLY_DIGEST_MODE: "" })).toBe("off");
    expect(saleResultsMode({ SALE_RESULTS_MODE: "" })).toBe("off");
  });

  it("n'ouvrent pas l'un avec la variable de l'autre ni avec celle des rappels", () => {
    expect(weeklyDigestMode({ SALE_RESULTS_MODE: "on", SALE_REMINDERS_MODE: "on" })).toBe("off");
    expect(saleResultsMode({ WEEKLY_DIGEST_MODE: "on", SALE_REMINDERS_MODE: "on" })).toBe("off");
  });

  it("reconnaissent internal et on, sans tenir compte de la casse ni des espaces", () => {
    expect(weeklyDigestMode({ WEEKLY_DIGEST_MODE: "internal" })).toBe("internal");
    expect(weeklyDigestMode({ WEEKLY_DIGEST_MODE: " ON " })).toBe("on");
    expect(saleResultsMode({ SALE_RESULTS_MODE: "Internal" })).toBe("internal");
    expect(saleResultsMode({ SALE_RESULTS_MODE: " on" })).toBe("on");
  });

  it("ferment l'envoi sur toute valeur inconnue (une faute de frappe n'ouvre rien)", () => {
    for (const value of ["true", "1", "oui", "enabled", "onn", "internal-only"]) {
      expect(weeklyDigestMode({ WEEKLY_DIGEST_MODE: value }), value).toBe("off");
      expect(saleResultsMode({ SALE_RESULTS_MODE: value }), value).toBe("off");
    }
  });
});

describe("weeklyDigestOfferedTo et saleResultsOfferedTo", () => {
  it("ne proposent la case à personne en mode off", () => {
    expect(weeklyDigestOfferedTo({ isAdmin: true, env: {} })).toBe(false);
    expect(saleResultsOfferedTo({ isAdmin: true, env: {} })).toBe(false);
  });

  it("ne la proposent qu'aux administrateurs en mode internal", () => {
    expect(weeklyDigestOfferedTo({ isAdmin: true, env: { WEEKLY_DIGEST_MODE: "internal" } })).toBe(
      true,
    );
    expect(weeklyDigestOfferedTo({ isAdmin: false, env: { WEEKLY_DIGEST_MODE: "internal" } })).toBe(
      false,
    );
    expect(saleResultsOfferedTo({ isAdmin: true, env: { SALE_RESULTS_MODE: "internal" } })).toBe(
      true,
    );
    expect(saleResultsOfferedTo({ isAdmin: false, env: { SALE_RESULTS_MODE: "internal" } })).toBe(
      false,
    );
  });

  it("la proposent à tout le monde en mode on", () => {
    expect(weeklyDigestOfferedTo({ isAdmin: false, env: { WEEKLY_DIGEST_MODE: "on" } })).toBe(true);
    expect(saleResultsOfferedTo({ isAdmin: false, env: { SALE_RESULTS_MODE: "on" } })).toBe(true);
  });
});
