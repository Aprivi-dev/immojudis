import { describe, expect, it } from "vitest";
import { SIGNUP_NAME_MAX_LENGTH, signupRefusalMessage, validateSignupName } from "./signup-name";

describe("validateSignupName", () => {
  it("compose « Prénom Nom » en retirant les espaces en trop", () => {
    expect(validateSignupName("  Jean   Marc ", " Dupont\t")).toEqual({
      ok: true,
      name: { firstName: "Jean Marc", lastName: "Dupont", fullName: "Jean Marc Dupont" },
    });
  });

  it("exige le prénom, puis le nom", () => {
    expect(validateSignupName("", "Dupont")).toMatchObject({ ok: false, field: "first_name" });
    expect(validateSignupName("   ", "Dupont")).toMatchObject({ ok: false, field: "first_name" });
    expect(validateSignupName("Claire", " ")).toMatchObject({ ok: false, field: "last_name" });
  });

  it("refuse un prénom ou un nom démesuré", () => {
    const long = "a".repeat(SIGNUP_NAME_MAX_LENGTH + 1);
    expect(validateSignupName(long, "Dupont")).toMatchObject({ ok: false, field: "first_name" });
    expect(validateSignupName("Claire", long)).toMatchObject({ ok: false, field: "last_name" });
    expect(validateSignupName("a".repeat(SIGNUP_NAME_MAX_LENGTH), "Dupont").ok).toBe(true);
  });
});

describe("signupRefusalMessage", () => {
  it("traduit la réponse générique de l'API quand le déclencheur refuse l'inscription", () => {
    expect(signupRefusalMessage(new Error("Database error saving new user"))).toContain(
      "Vérifiez votre prénom et votre nom",
    );
  });

  it("laisse les autres erreurs, dont le message détaillé du déclencheur, à userMessage", () => {
    expect(signupRefusalMessage(new Error("Password is too short"))).toBeNull();
    expect(
      signupRefusalMessage(
        new Error("Le prénom et le nom sont obligatoires pour créer un compte."),
      ),
    ).toBeNull();
    expect(signupRefusalMessage("Database error saving new user")).toBeNull();
  });
});
