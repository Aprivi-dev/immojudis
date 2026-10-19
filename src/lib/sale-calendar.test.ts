import { describe, expect, it } from "vitest";
import { escapeIcsText } from "./ical";
import {
  SALE_CALENDAR_DISCLAIMER,
  SALE_HEARING_DEFAULT_DURATION_HOURS,
  buildSaleCalendarFile,
  saleCalendarSequence,
  saleCalendarUid,
  type SaleCalendarRow,
} from "./sale-calendar";

const origin = "https://www.immojudis.example";
const now = new Date("2026-10-15T10:00:00Z");
const saleId = "A1B2C3D4-0000-4000-8000-1234567890AB";
const lowerId = saleId.toLowerCase();

function row(overrides: Partial<SaleCalendarRow> = {}): SaleCalendarRow {
  return {
    id: saleId,
    exportable: true,
    // 9 h 30 in Paris (CEST, UTC+2).
    sale_date: "2026-10-20T07:30:00+00:00",
    date_only: false,
    property_type: "apartment",
    city: "Bordeaux",
    tribunal_name: "TJ Bordeaux",
    tribunal_city: "Bordeaux",
    updated_at: "2026-10-14T08:00:00+00:00",
    ...overrides,
  };
}

function unfolded(overrides: Partial<SaleCalendarRow> = {}): string {
  const file = buildSaleCalendarFile(row(overrides), { origin, now });
  expect(file).not.toBeNull();
  return file!.body.replace(/\r\n /g, "");
}

describe("saleCalendarUid", () => {
  it("is stable, lower-cased and tied to the site domain", () => {
    expect(saleCalendarUid(saleId, origin)).toBe(`sale-${lowerId}@www.immojudis.example`);
    expect(saleCalendarUid(lowerId, origin)).toBe(saleCalendarUid(saleId, origin));
  });
});

describe("buildSaleCalendarFile", () => {
  it("builds a timed event in UTC for a hearing whose hour is known", () => {
    const file = buildSaleCalendarFile(row(), { origin, now });
    expect(file!.filename).toBe("immojudis-audience-a1b2c3d4.ics");
    const ics = unfolded();
    expect(ics).toContain(`UID:sale-${lowerId}@www.immojudis.example`);
    expect(ics).toContain("DTSTAMP:20261015T100000Z");
    expect(ics).toContain("LAST-MODIFIED:20261014T080000Z");
    expect(ics).toContain("DTSTART:20261020T073000Z");
    expect(ics).not.toContain("VALUE=DATE");
    expect(ics).toContain("SUMMARY:Audience d’adjudication – Appartement à Bordeaux");
    expect(ics).toContain("LOCATION:Tribunal judiciaire de Bordeaux");
    expect(ics).toContain(`URL:${origin}/sales/${lowerId}`);
    expect(ics).toContain("STATUS:TENTATIVE");
  });

  it("writes the hour correctly in winter time (UTC+1)", () => {
    expect(unfolded({ sale_date: "2026-12-15T09:00:00+01:00" })).toContain(
      "DTSTART:20261215T080000Z",
    );
  });

  it("makes an all-day event when the hour is unknown, on the Paris civil day", () => {
    // A date-only hearing stored at Paris midnight (22:00 UTC the day before).
    const ics = unfolded({ sale_date: "2026-10-22T22:00:00+00:00", date_only: true });
    expect(ics).toContain("DTSTART;VALUE=DATE:20261023");
    expect(ics).toContain("DTEND;VALUE=DATE:20261024");
    expect(ics).not.toMatch(/DTSTART:/);
  });

  it("makes an all-day event for a date stored at UTC midnight", () => {
    const ics = unfolded({ sale_date: "2026-10-23T00:00:00+00:00", date_only: true });
    expect(ics).toContain("DTSTART;VALUE=DATE:20261023");
  });

  it("never invents an hour: a stored midnight is an all-day event even if date_only is false", () => {
    const ics = unfolded({ sale_date: "2026-10-23T00:00:00+00:00", date_only: false });
    expect(ics).toContain("DTSTART;VALUE=DATE:20261023");
    expect(ics).not.toMatch(/DTSTART:/);
  });

  it("treats an unknown date_only flag as an all-day event", () => {
    expect(unfolded({ date_only: null })).toContain("DTSTART;VALUE=DATE:20261020");
  });

  it("exports nothing when the database does not consider the date reliable", () => {
    const refused = row({
      exportable: false,
      sale_date: null,
      date_only: null,
      property_type: null,
      city: null,
      tribunal_name: null,
      tribunal_city: null,
      updated_at: null,
    });
    expect(buildSaleCalendarFile(refused, { origin, now })).toBeNull();
    // Even if a date were present, the flag wins.
    expect(
      buildSaleCalendarFile(
        { ...refused, sale_date: "2026-10-20T07:30:00+00:00" },
        { origin, now },
      ),
    ).toBeNull();
  });

  it("exports nothing when the date is missing or invalid, whatever the flag says", () => {
    expect(buildSaleCalendarFile(row({ sale_date: null }), { origin, now })).toBeNull();
    expect(buildSaleCalendarFile(row({ sale_date: "pas une date" }), { origin, now })).toBeNull();
  });

  it("keeps the court as the only place, and carries the verification notice", () => {
    const ics = unfolded();
    expect(ics).toContain(`DESCRIPTION:${escapeIcsText(SALE_CALENDAR_DISCLAIMER)}`);
    expect(ics).toContain("à vérifier auprès de l’avocat poursuivant");
    expect((ics.match(/^LOCATION:/gm) ?? []).length).toBe(1);
    // The row type has no address: nothing but the court can reach LOCATION.
    expect(ics).not.toMatch(/GEO:|ATTENDEE|ORGANIZER/);
  });

  it("falls back to a generic label without city, and omits LOCATION without court", () => {
    const ics = unfolded({
      city: null,
      property_type: null,
      tribunal_name: null,
      tribunal_city: null,
    });
    expect(ics).toContain("SUMMARY:Audience d’adjudication – Bien immobilier\r\n");
    expect(ics).not.toContain("LOCATION:");
  });

  it("escapes the punctuation of the city and folds long lines at 75 octets", () => {
    const file = buildSaleCalendarFile(row({ city: "Saint-Étienne, Loire; centre" }), {
      origin,
      now,
    });
    expect(file!.body.replace(/\r\n /g, "")).toContain("à Saint-Étienne\\, Loire\\; centre");
    for (const line of file!.body.split("\r\n")) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
  });

  it("carries the link to the sale in the description, on its own line", () => {
    const ics = unfolded();
    expect(ics).toContain(
      `DESCRIPTION:${escapeIcsText(SALE_CALENDAR_DISCLAIMER)}\\nFiche de la vente : ${origin}/sales/${lowerId}`,
    );
  });

  it("ends a timed hearing after the default duration of 2 h, and says so", () => {
    expect(SALE_HEARING_DEFAULT_DURATION_HOURS).toBe(2);
    const ics = unfolded();
    expect(ics).toContain("DTSTART:20261020T073000Z\r\nDTEND:20261020T093000Z\r\n");
    expect(ics).toContain("Durée indicative : 2 h");
  });

  it("gives an all-day hearing no DTEND other than the next day, and no duration", () => {
    const ics = unfolded({ sale_date: "2026-10-22T22:00:00+00:00", date_only: true });
    expect(ics.match(/DTEND/g)).toHaveLength(1);
    expect(ics).toContain("DTEND;VALUE=DATE:20261024");
    expect(ics).not.toContain("Durée indicative");
  });

  it("reminds 7 days and 1 day before a timed hearing, at its hour", () => {
    const ics = unfolded();
    expect(ics.match(/BEGIN:VALARM/g)).toHaveLength(2);
    expect(ics).toContain("TRIGGER:-P7D\r\n");
    expect(ics).toContain("TRIGGER:-P1D\r\n");
    expect(ics).toContain("ACTION:DISPLAY");
    expect(ics).toContain("Audience d’adjudication – Appartement à Bordeaux (demain)");
  });

  it("moves the reminders of an all-day hearing to 9 h instead of midnight", () => {
    const ics = unfolded({ sale_date: "2026-10-22T22:00:00+00:00", date_only: true });
    expect(ics).toContain("TRIGGER:-P6DT15H\r\n");
    expect(ics).toContain("TRIGGER:-PT15H\r\n");
    expect(ics).not.toContain("TRIGGER:-P7D");
  });

  it("numbers the revisions so that a changed sale replaces the event already in a calendar", () => {
    expect(saleCalendarSequence(null)).toBe(0);
    expect(saleCalendarSequence(new Date("2025-12-31T00:00:00Z"))).toBe(0);
    expect(saleCalendarSequence(new Date("2026-01-01T01:00:00Z"))).toBe(60);
    const before = saleCalendarSequence(new Date("2026-10-14T08:00:00Z"));
    const after = saleCalendarSequence(new Date("2026-10-16T09:30:00Z"));
    expect(after).toBeGreaterThan(before);
    expect(unfolded()).toContain(`SEQUENCE:${before}\r\n`);
    expect(unfolded({ updated_at: null })).toContain("SEQUENCE:0\r\n");
  });
});
