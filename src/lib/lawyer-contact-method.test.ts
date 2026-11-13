import { describe, expect, it } from "vitest";
import { contactMethodLabel } from "@/lib/lawyer-contact-method";

describe("moyen de contact préféré d'une demande de mise en relation", () => {
  it("se lit de la même façon dans l'administration et dans l'email à l'avocat", () => {
    expect(contactMethodLabel("phone")).toBe("Téléphone");
    expect(contactMethodLabel("either")).toBe("Email ou téléphone");
    expect(contactMethodLabel("email")).toBe("Email");
    expect(contactMethodLabel(null)).toBe("Email");
  });
});
