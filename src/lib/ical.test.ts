import { describe, expect, it } from "vitest";
import { buildIcsCalendar, escapeIcsText, foldIcsLine, formatIcsUtc, nextIsoDay } from "./ical";

const octets = (value: string) => new TextEncoder().encode(value).length;
const unfold = (lines: string[]) =>
  lines.map((line, index) => (index === 0 ? line : line.slice(1))).join("");

describe("escapeIcsText", () => {
  it("escapes backslashes, semicolons, commas and line breaks (RFC 5545 section 3.3.11)", () => {
    expect(escapeIcsText("a,b;c\\d")).toBe("a\\,b\\;c\\\\d");
    expect(escapeIcsText("ligne 1\nligne 2\r\nligne 3\rligne 4")).toBe(
      "ligne 1\\nligne 2\\nligne 3\\nligne 4",
    );
  });

  it("drops control characters that have no representation", () => {
    expect(escapeIcsText("a\u0000b\u0007c\u007fd")).toBe("abcd");
  });

  it("cannot be used to inject a property through a line break", () => {
    const escaped = escapeIcsText("Audience\r\nEND:VEVENT\r\nBEGIN:VEVENT");
    expect(escaped).not.toMatch(/[\r\n]/);
  });
});

describe("foldIcsLine", () => {
  it("leaves a short line alone", () => {
    expect(foldIcsLine("SUMMARY:Audience")).toBe("SUMMARY:Audience");
  });

  it("folds at 75 octets with a leading space on continuation lines", () => {
    const text = `DESCRIPTION:${"a".repeat(200)}`;
    const lines = foldIcsLine(text).split("\r\n");
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) expect(octets(line)).toBeLessThanOrEqual(75);
    for (const line of lines.slice(1)) expect(line.startsWith(" ")).toBe(true);
    expect(unfold(lines)).toBe(text);
  });

  it("never cuts inside a multi-byte UTF-8 character", () => {
    const text = `SUMMARY:${"é–’".repeat(60)}`;
    const lines = foldIcsLine(text).split("\r\n");
    for (const line of lines) expect(octets(line)).toBeLessThanOrEqual(75);
    expect(unfold(lines)).toBe(text);
    expect(unfold(lines)).not.toContain("�");
  });
});

describe("dates", () => {
  it("formats an instant in UTC without separators or milliseconds", () => {
    expect(formatIcsUtc(new Date("2026-10-20T07:30:00.000Z"))).toBe("20261020T073000Z");
  });

  it("computes the exclusive end of an all-day event, across month and year ends", () => {
    expect(nextIsoDay("2026-10-23")).toBe("2026-10-24");
    expect(nextIsoDay("2026-10-31")).toBe("2026-11-01");
    expect(nextIsoDay("2026-12-31")).toBe("2027-01-01");
  });
});

describe("buildIcsCalendar", () => {
  const base = {
    uid: "sale-abc@immojudis.example",
    stamp: new Date("2026-10-15T10:00:00Z"),
    summary: "Audience d’adjudication – Appartement à Lyon, 3e",
    description: "Ligne 1\nLigne 2; avec, ponctuation",
    location: "Tribunal judiciaire de Lyon",
    url: "https://immojudis.example/sales/abc",
  } as const;

  it("writes a timed event in UTC with CRLF line endings", () => {
    const ics = buildIcsCalendar(
      { ...base, start: { kind: "instant", at: new Date("2026-10-20T07:30:00Z") } },
      "-//Test//FR",
    );
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//FR\r\n")).toBe(true);
    expect(ics.endsWith("END:VEVENT\r\nEND:VCALENDAR\r\n")).toBe(true);
    const unfolded = ics.replace(/\r\n /g, "");
    expect(unfolded).toContain("UID:sale-abc@immojudis.example\r\n");
    expect(unfolded).toContain("DTSTAMP:20261015T100000Z\r\n");
    expect(unfolded).toContain("DTSTART:20261020T073000Z\r\n");
    expect(unfolded).not.toContain("DTEND");
    expect(unfolded).toContain("SUMMARY:Audience d’adjudication – Appartement à Lyon\\, 3e\r\n");
    expect(unfolded).toContain("DESCRIPTION:Ligne 1\\nLigne 2\\; avec\\, ponctuation\r\n");
    expect(unfolded).toContain("LOCATION:Tribunal judiciaire de Lyon\r\n");
    expect(unfolded).toContain("URL:https://immojudis.example/sales/abc\r\n");
    // Every line ends with CRLF, and a bare LF or CR never appears.
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("writes an all-day event with VALUE=DATE and an exclusive end", () => {
    const ics = buildIcsCalendar(
      { ...base, start: { kind: "day", isoDay: "2026-10-23" } },
      "-//Test//FR",
    );
    expect(ics).toContain("DTSTART;VALUE=DATE:20261023\r\n");
    expect(ics).toContain("DTEND;VALUE=DATE:20261024\r\n");
    expect(ics).not.toMatch(/DTSTART:/);
  });

  it("omits the optional properties that are not provided and keeps every line within 75 octets", () => {
    const ics = buildIcsCalendar(
      {
        uid: "u@x",
        stamp: new Date("2026-10-15T10:00:00Z"),
        start: { kind: "day", isoDay: "2026-10-23" },
        summary: "S".repeat(300),
        status: "TENTATIVE",
      },
      "-//Test//FR",
    );
    expect(ics).not.toContain("LOCATION");
    expect(ics).not.toContain("DESCRIPTION");
    expect(ics).not.toContain("URL:");
    expect(ics).toContain("STATUS:TENTATIVE\r\n");
    for (const line of ics.split("\r\n")) expect(octets(line)).toBeLessThanOrEqual(75);
  });
});
