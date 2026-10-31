import { describe, expect, it } from "vitest";
import { SIGNUP_NAME_MAX_LENGTH, validateSignupName } from "./signup-name";

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
