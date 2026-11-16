import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTRACT_WITHDRAWAL_RESPONSE_DAYS,
  PRIVACY_DEADLINE_WARNING_DAYS,
  privacyDeadlineLabel,
  privacyDeadlineStatus,
  privacyResponseDelayLabel,
  withinWithdrawalPeriod,
} from "./privacy-deadline";

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

describe("délais tenus par la base (migration 20261202100000)", () => {
  const migration = readFileSync(
    join(process.cwd(), "supabase/migrations/20261202100000_privacy_requests_follow_up.sql"),
    "utf8",
  );

  it("même seuil d'alerte « échéance proche » que l'alerte compliance.privacy_requests.due_soon", () => {
    expect(migration).toContain(
      `warning_days constant integer := ${PRIVACY_DEADLINE_WARNING_DAYS};`,
    );
  });

  it("même échéance d'une rétractation que le déclencheur de due_at", () => {
    expect(migration).toContain(
      `new.due_at := new.submitted_at + interval '${CONTRACT_WITHDRAWAL_RESPONSE_DAYS} days';`,
    );
    expect(privacyResponseDelayLabel("contract_withdrawal")).toBe("délai de 14 jours");
    expect(privacyResponseDelayLabel("erasure")).toBe("délai d’un mois");
  });

  it("délai de rétractation : 14 jours à compter du paiement", () => {
    expect(withinWithdrawalPeriod("2026-11-01T12:00:01.000Z", NOW)).toBe(true);
    expect(withinWithdrawalPeriod("2026-10-31T12:00:00.000Z", NOW)).toBe(false);
    expect(withinWithdrawalPeriod(null, NOW)).toBe(false);
  });
});
