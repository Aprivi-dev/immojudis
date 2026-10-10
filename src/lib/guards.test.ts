import { describe, expect, it } from "vitest";
import {
  asRecord,
  asRecordOrNull,
  clamp,
  decimalCommaNumberValue,
  escapeHtml,
  numberValue,
  parsedNumberValue,
  stringOrNumberValue,
  stringValue,
  stringValueOr,
  textValue,
  trimmedStringValue,
} from "./guards";

describe("asRecord / asRecordOrNull", () => {
  it("keeps plain objects", () => {
    const value = { a: 1 };
    expect(asRecord(value)).toBe(value);
    expect(asRecordOrNull(value)).toBe(value);
  });

  it("rejects null, arrays and primitives", () => {
    for (const value of [null, undefined, [], [{ a: 1 }], "text", 12, true]) {
      expect(asRecord(value)).toEqual({});
      expect(asRecordOrNull(value)).toBeNull();
    }
  });
});

describe("string guards", () => {
  it("stringValue keeps non-blank strings untouched", () => {
    expect(stringValue("  a ")).toBe("  a ");
    expect(stringValue("   ")).toBeNull();
    expect(stringValue("")).toBeNull();
    expect(stringValue(12)).toBeNull();
    expect(stringValue(null)).toBeNull();
  });

  it("trimmedStringValue trims and rejects blanks and non-strings", () => {
    expect(trimmedStringValue("  a ")).toBe("a");
    expect(trimmedStringValue("  ")).toBeNull();
    expect(trimmedStringValue(12)).toBeNull();
  });

  it("stringValueOr returns the untouched string or the fallback", () => {
    expect(stringValueOr(" a ", "x")).toBe(" a ");
    expect(stringValueOr("  ", "x")).toBe("x");
    expect(stringValueOr(undefined, "x")).toBe("x");
  });

  it("stringOrNumberValue stringifies finite numbers and honours the fallback", () => {
    expect(stringOrNumberValue("a", "x")).toBe("a");
    expect(stringOrNumberValue(12.5, "x")).toBe("12.5");
    expect(stringOrNumberValue(Number.NaN, "x")).toBe("x");
    expect(stringOrNumberValue(" ", null)).toBe("");
    expect(stringOrNumberValue({}, null)).toBe("");
  });

  it("textValue trims strings and stringifies finite numbers", () => {
    expect(textValue("  a ")).toBe("a");
    expect(textValue(7)).toBe("7");
    expect(textValue(Number.POSITIVE_INFINITY)).toBeNull();
    expect(textValue("  ")).toBeNull();
    expect(textValue(null)).toBeNull();
  });
});

describe("number guards", () => {
  it("numberValue accepts finite numbers only", () => {
    expect(numberValue(0)).toBe(0);
    expect(numberValue(-3.5)).toBe(-3.5);
    expect(numberValue(Number.NaN)).toBeNull();
    expect(numberValue(Number.POSITIVE_INFINITY)).toBeNull();
    expect(numberValue("12")).toBeNull();
    expect(numberValue(null)).toBeNull();
  });

  it("parsedNumberValue also parses numeric strings", () => {
    expect(parsedNumberValue(" 12.5 ")).toBe(12.5);
    expect(parsedNumberValue("12,5")).toBeNull();
    expect(parsedNumberValue("abc")).toBeNull();
    expect(parsedNumberValue("  ")).toBeNull();
    expect(parsedNumberValue(4)).toBe(4);
    expect(parsedNumberValue(Number.NaN)).toBeNull();
  });

  it("decimalCommaNumberValue reads the first comma as a decimal point", () => {
    expect(decimalCommaNumberValue("12,5")).toBe(12.5);
    expect(decimalCommaNumberValue("12.5")).toBe(12.5);
    expect(decimalCommaNumberValue("1,2,3")).toBeNull();
    expect(decimalCommaNumberValue("")).toBeNull();
    expect(decimalCommaNumberValue(8)).toBe(8);
  });
});

describe("clamp", () => {
  it("bounds a value to the interval", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
    expect(clamp(0.5, 0.5, 0.99)).toBe(0.5);
  });

  it("propagates NaN instead of hiding it", () => {
    expect(clamp(Number.NaN, 0, 10)).toBeNaN();
  });
});

describe("escapeHtml", () => {
  it("escapes the five significant characters", () => {
    expect(escapeHtml(`<a href="x">Tom & 'Jerry'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;",
    );
  });

  it("does not double-escape in a single pass and leaves safe text alone", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
    expect(escapeHtml("Maître Dupont, 12 rue de la Paix")).toBe("Maître Dupont, 12 rue de la Paix");
    expect(escapeHtml("")).toBe("");
  });
});
