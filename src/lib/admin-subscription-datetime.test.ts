import { describe, expect, it } from "vitest";
import { dateTimeLocalToUtcIso, formatDateTimeLocalInput } from "@/lib/admin-subscription-datetime";

describe("admin subscription datetime conversion", () => {
  it("keeps a local datetime-local value local for display and converts it to UTC on submit", () => {
    const utcValue = "2026-08-01T12:30:00.000Z";

    expect(formatDateTimeLocalInput(new Date(utcValue), -120)).toBe("2026-08-01T14:30");
    expect(dateTimeLocalToUtcIso("2026-08-01T14:30", -120)).toBe(utcValue);
  });

  it("leaves an empty optional value unset", () => {
    expect(dateTimeLocalToUtcIso("", -120)).toBeUndefined();
  });
});
