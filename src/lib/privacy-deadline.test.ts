import { describe, expect, it } from "vitest";
import { privacyDeadlineLabel, privacyDeadlineStatus } from "./privacy-deadline";

const NOW = new Date("2026-11-14T12:00:00.000Z");

describe("privacyDeadlineLabel", () => {
  it("never says « En retard de 0 jour » on the day the deadline passed", () => {
    const deadline = privacyDeadlineStatus("2026-11-14T09:00:00.000Z", "received", NOW);
    expect(deadline.overdue).toBe(true);
    expect(privacyDeadlineLabel(deadline)).toBe("Échéance dépassée aujourd'hui");
  });

  it("counts the days late, and the days left", () => {
    expect(
      privacyDeadlineLabel(privacyDeadlineStatus("2026-11-12T09:00:00.000Z", "in_review", NOW)),
    ).toBe("En retard de 2 jours");
    expect(
      privacyDeadlineLabel(privacyDeadlineStatus("2026-11-13T09:00:00.000Z", "in_review", NOW)),
    ).toBe("En retard de 1 jour");
    expect(
      privacyDeadlineLabel(privacyDeadlineStatus("2026-11-20T09:00:00.000Z", "received", NOW)),
    ).toBe("6 jours restants");
    expect(
      privacyDeadlineLabel(privacyDeadlineStatus("2026-11-20T09:00:00.000Z", "completed", NOW)),
    ).toBe("Clôturée");
  });
});
