import { describe, expect, it } from "vitest";
import { consentOffered } from "@/hooks/use-notification-preferences";

describe("case de consentement d'un envoi", () => {
  it("n'est proposée que si l'envoi est ouvert, ou à qui a déjà consenti (pour retirer son accord)", () => {
    expect(consentOffered(true, false)).toBe(true);
    expect(consentOffered(false, true)).toBe(true);
    expect(consentOffered(undefined, true)).toBe(true);
    expect(consentOffered(false, false)).toBe(false);
    expect(consentOffered(undefined, false)).toBe(false);
  });
});
