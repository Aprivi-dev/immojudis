import { describe, expect, it } from "vitest";
import { isBusyWriteError } from "./write-busy";

describe("isBusyWriteError", () => {
  it.each(["57014", "55P03", "40P01"])("%s : écriture bloquée par un verrou", (code) => {
    expect(isBusyWriteError({ code, message: "x" })).toBe(true);
  });

  it.each(["23514", "23503", "23502", "42P01", "PGRST205", "XX000"])(
    "%s : ligne invalide ou autre erreur, pas un verrou",
    (code) => {
      expect(isBusyWriteError({ code, message: "x" })).toBe(false);
    },
  );

  it("sans code lisible : pas un verrou", () => {
    expect(isBusyWriteError(null)).toBe(false);
    expect(isBusyWriteError(undefined)).toBe(false);
    expect(isBusyWriteError(new Error("boom"))).toBe(false);
    expect(isBusyWriteError({ code: 57014 })).toBe(false);
  });
});
