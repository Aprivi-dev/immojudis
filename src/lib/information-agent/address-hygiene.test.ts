import { describe, expect, it } from "vitest";
import {
  informationAgentAddressHygieneIssue,
  isConsumerMailAddress,
} from "@/lib/information-agent/address-hygiene";

describe("hygiène des adresses de l'agent", () => {
  it.each([
    ["me.dupont@cabinet-dupont.fr", null],
    ["contact@avocats-bordeaux.com", null],
    ["a".repeat(65) + "@cabinet.fr", "too_long"],
    ["x@" + "a".repeat(64) + ".fr", "too_long"],
    ["x@" + "abcdefgh.".repeat(30) + "fr", "too_long"],
    ["logo@2x.png", "artifact"],
    ["contact@cabinet.fr.", "artifact"],
    ["mailto:contact@cabinet.fr", "artifact"],
    ["contact%20@cabinet.fr", "artifact"],
    ["u003econtact@cabinet.fr", "artifact"],
    ["contact..cabinet@cabinet.fr", "artifact"],
    [".contact@cabinet.fr", "artifact"],
    ["contact@-cabinet.fr", "artifact"],
    ["contact@cabinet.pdf", "artifact"],
    ["contact@cabinet.test", "reserved_domain"],
    ["contact@cabinet.example", "reserved_domain"],
    ["contact@example.com", "reserved_domain"],
    ["contact@serveur.invalid", "reserved_domain"],
    ["contact@machine.local", "reserved_domain"],
    ["contact@localhost", "invalid_domain"],
    ["sans-arobase", "invalid_domain"],
    ["@cabinet.fr", "invalid_domain"],
  ])("%s -> %s", (email, expected) => {
    expect(informationAgentAddressHygieneIssue(email)).toBe(expected);
  });

  it.each([
    ["x@gmail.com", true],
    ["x@googlemail.com", true],
    ["x@outlook.fr", true],
    ["x@hotmail.com", true],
    ["x@live.fr", true],
    ["x@msn.com", true],
    ["x@yahoo.fr", true],
    ["x@yahoo.co.uk", true],
    ["x@orange.fr", true],
    ["x@wanadoo.fr", true],
    ["x@free.fr", true],
    ["x@sfr.fr", true],
    ["x@neuf.fr", true],
    ["x@laposte.net", true],
    ["x@icloud.com", true],
    ["x@me.com", true],
    ["x@aol.com", true],
    ["x@proton.me", true],
    ["x@protonmail.com", true],
    ["x@gmx.fr", true],
    ["x@bbox.fr", true],
    ["X@GMAIL.COM", true],
    ["x@cabinet-dupont.fr", false],
    ["x@avocats-orange.fr", false],
    ["x@mail.cabinet.fr", false],
    ["x@free-avocats.fr", false],
  ])("messagerie grand public : %s -> %s", (email, expected) => {
    expect(isConsumerMailAddress(email)).toBe(expected);
  });
});
