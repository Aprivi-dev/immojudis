/**
 * Minimal iCalendar (RFC 5545) writer for ONE all-day or timed event. Pure functions, no
 * dependency: the escaping and folding rules are the part that breaks calendars when they are
 * wrong, so they live here, apart from the sale-specific wording, and are tested on their own.
 */

const CRLF = "\r\n";
/** RFC 5545 section 3.1: a content line is at most 75 octets long, CRLF excluded. */
const MAX_LINE_OCTETS = 75;

/** Everything below U+0020 and DEL, except the line feed (kept to become `\n`). */
function withoutControlCharacters(value: string): string {
  return [...value]
    .filter((character) => {
      const code = character.codePointAt(0)!;
      return character === "\n" || (code >= 0x20 && code !== 0x7f);
    })
    .join("");
}

/**
 * TEXT value escaping (RFC 5545 section 3.3.11): backslash, semicolon and comma are escaped, a
 * line break becomes `\n`. Other control characters have no representation and are dropped.
 */
export function escapeIcsText(value: string): string {
  return withoutControlCharacters(value.replace(/\r\n|\r|\n/g, "\n"))
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/**
 * Folds a content line at 75 octets (RFC 5545 section 3.1): the continuation lines start with one
 * space, which counts in their 75 octets. The cut never falls inside a UTF-8 sequence.
 */
export function foldIcsLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= MAX_LINE_OCTETS) return line;

  const lines: string[] = [];
  let current = "";
  let currentOctets = 0;
  for (const character of line) {
    const octets = encoder.encode(character).length;
    // The first line has 75 octets available, the following ones 74 (the leading space).
    const available = lines.length === 0 ? MAX_LINE_OCTETS : MAX_LINE_OCTETS - 1;
    if (currentOctets + octets > available) {
      lines.push(current);
      current = "";
      currentOctets = 0;
    }
    current += character;
    currentOctets += octets;
  }
  lines.push(current);
  return lines.join(`${CRLF} `);
}

/** `20261020T073000Z`: an instant in UTC, so no VTIMEZONE block is needed. */
export function formatIcsUtc(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

/** `20261023` from `2026-10-23`. */
export function formatIcsDate(isoDay: string): string {
  return isoDay.replaceAll("-", "");
}

/** The day after a `YYYY-MM-DD` day (DTEND of an all-day event is exclusive). */
export function nextIsoDay(isoDay: string): string {
  const [year, month, day] = isoDay.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

export type IcsEvent = {
  /** Globally unique and stable: the same sale always produces the same UID. */
  uid: string;
  /** Generation instant (DTSTAMP is mandatory). */
  stamp: Date;
  /** Last change of the underlying record, when known. */
  lastModified?: Date | null;
  /** Timed event (UTC) or all-day event (`YYYY-MM-DD`, Europe/Paris civil day). */
  start: { kind: "instant"; at: Date } | { kind: "day"; isoDay: string };
  summary: string;
  description?: string | null;
  location?: string | null;
  /** Absolute URL. */
  url?: string | null;
  /** TENTATIVE tells the calendar the date still has to be confirmed. */
  status?: "CONFIRMED" | "TENTATIVE";
};

export function buildIcsCalendar(event: IcsEvent, prodId: string): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${escapeIcsText(prodId)}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${escapeIcsText(event.uid)}`,
    `DTSTAMP:${formatIcsUtc(event.stamp)}`,
  ];
  if (event.lastModified && Number.isFinite(event.lastModified.getTime())) {
    lines.push(`LAST-MODIFIED:${formatIcsUtc(event.lastModified)}`);
  }
  if (event.start.kind === "day") {
    lines.push(
      `DTSTART;VALUE=DATE:${formatIcsDate(event.start.isoDay)}`,
      `DTEND;VALUE=DATE:${formatIcsDate(nextIsoDay(event.start.isoDay))}`,
    );
  } else {
    lines.push(`DTSTART:${formatIcsUtc(event.start.at)}`);
  }
  lines.push(`SUMMARY:${escapeIcsText(event.summary)}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
  if (event.location) lines.push(`LOCATION:${escapeIcsText(event.location)}`);
  // URI value type: not TEXT, so it is not escaped, but it can never carry a line break.
  if (event.url) lines.push(`URL:${event.url.replace(/[\r\n]/g, "")}`);
  lines.push(`STATUS:${event.status ?? "CONFIRMED"}`, "END:VEVENT", "END:VCALENDAR");
  return lines.map(foldIcsLine).join(CRLF) + CRLF;
}
