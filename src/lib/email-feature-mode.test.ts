import { describe, expect, it } from "vitest";
import {
  alertNotificationsMode,
  saleResultsMode,
  saleResultsOfferedTo,
  trialEndEmailMode,
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

describe("trialEndEmailMode", () => {
  it("vaut off par défaut, et ne s'ouvre pas avec la variable d'un autre email", () => {
    expect(trialEndEmailMode({})).toBe("off");
    expect(trialEndEmailMode({ TRIAL_END_EMAIL_MODE: "" })).toBe("off");
    expect(
      trialEndEmailMode({
        WEEKLY_DIGEST_MODE: "on",
        SALE_RESULTS_MODE: "on",
        SALE_REMINDERS_MODE: "on",
      }),
    ).toBe("off");
  });

  it("reconnaît internal et on, et ferme l'envoi sur toute valeur inconnue", () => {
    expect(trialEndEmailMode({ TRIAL_END_EMAIL_MODE: " Internal " })).toBe("internal");
    expect(trialEndEmailMode({ TRIAL_END_EMAIL_MODE: "ON" })).toBe("on");
    for (const value of ["true", "1", "oui", "onn", "internal-only"]) {
      expect(trialEndEmailMode({ TRIAL_END_EMAIL_MODE: value }), value).toBe("off");
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

describe("alertNotificationsMode", () => {
  it("vaut on quand la variable est absente ou vide : l'existant ne change pas", () => {
    expect(alertNotificationsMode({})).toBe("on");
    expect(alertNotificationsMode({ ALERT_NOTIFICATIONS_MODE: "" })).toBe("on");
    expect(alertNotificationsMode({ ALERT_NOTIFICATIONS_MODE: "   " })).toBe("on");
  });

  it("reconnaît off, internal et on, sans tenir compte de la casse ni des espaces", () => {
    expect(alertNotificationsMode({ ALERT_NOTIFICATIONS_MODE: "off" })).toBe("off");
    expect(alertNotificationsMode({ ALERT_NOTIFICATIONS_MODE: " Internal " })).toBe("internal");
    expect(alertNotificationsMode({ ALERT_NOTIFICATIONS_MODE: "ON" })).toBe("on");
  });

  it("ferme l'envoi sur une valeur présente mais inconnue (une faute de frappe ne rouvre rien)", () => {
    for (const value of ["of", "false", "0", "non", "disabled", "internal-only"]) {
      expect(alertNotificationsMode({ ALERT_NOTIFICATIONS_MODE: value }), value).toBe("off");
    }
  });

  it("ne lit aucune des variables des autres emails", () => {
    expect(
      alertNotificationsMode({
        WEEKLY_DIGEST_MODE: "off",
        SALE_RESULTS_MODE: "off",
        SALE_REMINDERS_MODE: "off",
      }),
    ).toBe("on");
  });
});
