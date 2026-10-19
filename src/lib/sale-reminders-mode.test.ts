import { describe, expect, it } from "vitest";
import { saleRemindersMode, saleRemindersOfferedTo } from "./sale-reminders-mode";

describe("saleRemindersMode", () => {
  it("vaut off par défaut", () => {
    expect(saleRemindersMode({})).toBe("off");
    expect(saleRemindersMode({ SALE_REMINDERS_MODE: "" })).toBe("off");
  });

  it("reconnaît internal et on, sans tenir compte de la casse ni des espaces", () => {
    expect(saleRemindersMode({ SALE_REMINDERS_MODE: "internal" })).toBe("internal");
    expect(saleRemindersMode({ SALE_REMINDERS_MODE: " ON " })).toBe("on");
  });

  it("ferme l'envoi sur toute valeur inconnue (une faute de frappe n'ouvre rien)", () => {
    for (const value of ["true", "1", "oui", "enabled", "onn", "internal-only"]) {
      expect(saleRemindersMode({ SALE_REMINDERS_MODE: value }), value).toBe("off");
    }
  });
});

describe("saleRemindersOfferedTo", () => {
  it("ne propose la case à personne en mode off", () => {
    expect(saleRemindersOfferedTo({ isAdmin: true, env: {} })).toBe(false);
    expect(saleRemindersOfferedTo({ isAdmin: false, env: {} })).toBe(false);
  });

  it("ne la propose qu'aux administrateurs en mode internal", () => {
    const env = { SALE_REMINDERS_MODE: "internal" };
    expect(saleRemindersOfferedTo({ isAdmin: true, env })).toBe(true);
    expect(saleRemindersOfferedTo({ isAdmin: false, env })).toBe(false);
  });

  it("la propose à tout le monde en mode on", () => {
    const env = { SALE_REMINDERS_MODE: "on" };
    expect(saleRemindersOfferedTo({ isAdmin: false, env })).toBe(true);
  });
});
