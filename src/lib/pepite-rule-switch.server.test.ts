import { describe, expect, it } from "vitest";
import {
  PEPITE_RULE_V2_ENV,
  activePepiteRuleVersion,
  pepiteV2EnabledFromEnv,
} from "./pepite-rule-switch.server";

describe("interrupteur de la règle pepite-v2", () => {
  it("est fermé par défaut : variable absente, vide ou inconnue", () => {
    expect(pepiteV2EnabledFromEnv({})).toBe(false);
    expect(pepiteV2EnabledFromEnv({ [PEPITE_RULE_V2_ENV]: "" })).toBe(false);
    expect(pepiteV2EnabledFromEnv({ [PEPITE_RULE_V2_ENV]: "false" })).toBe(false);
    expect(pepiteV2EnabledFromEnv({ [PEPITE_RULE_V2_ENV]: "0" })).toBe(false);
    expect(pepiteV2EnabledFromEnv({ [PEPITE_RULE_V2_ENV]: "oui" })).toBe(false);
    expect(pepiteV2EnabledFromEnv({ [PEPITE_RULE_V2_ENV]: "yes" })).toBe(false);
  });

  it("s'ouvre avec PEPITE_RULE_V2_ENABLED=true ou 1, sans tenir compte de la casse ni des espaces", () => {
    expect(PEPITE_RULE_V2_ENV).toBe("PEPITE_RULE_V2_ENABLED");
    for (const value of ["true", "TRUE", " True ", "1"]) {
      expect(pepiteV2EnabledFromEnv({ [PEPITE_RULE_V2_ENV]: value }), value).toBe(true);
    }
  });

  it("la règle appliquée est pepite-v1 tant qu'il est fermé, pepite-v2 une fois ouvert", () => {
    expect(activePepiteRuleVersion({})).toBe("pepite-v1");
    expect(activePepiteRuleVersion({ [PEPITE_RULE_V2_ENV]: "true" })).toBe("pepite-v2");
  });
});
