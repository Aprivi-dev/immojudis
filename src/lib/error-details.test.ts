import { describe, expect, it } from "vitest";
import { errorDetails, errorSummary } from "@/lib/error-details";

describe("errorDetails", () => {
  it("lit le message et le code d'un objet PostgrestError qui n'est pas une Error", () => {
    const error = {
      message: "canceling statement due to statement timeout",
      code: "57014",
      details: null,
      hint: null,
    };
    expect(errorDetails(error)).toEqual({
      message: "canceling statement due to statement timeout",
      code: "57014",
    });
    expect(errorSummary(error)).toBe("canceling statement due to statement timeout (57014)");
  });

  it("lit une Error et une chaîne", () => {
    expect(errorDetails(new Error("boom"))).toEqual({ message: "boom", code: null });
    expect(errorSummary("direct")).toBe("direct");
  });

  it("retombe sur le message de repli pour une valeur opaque", () => {
    expect(errorSummary({ unexpected: true }, "Évaluation impossible")).toBe(
      "Évaluation impossible",
    );
    expect(errorSummary(null)).toBe("Erreur inconnue");
  });

  it("borne la longueur du message", () => {
    expect(errorDetails({ message: "x".repeat(900) }).message.length).toBeLessThanOrEqual(301);
  });
});
