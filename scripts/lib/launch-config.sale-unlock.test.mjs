import { describe, expect, it } from "vitest";
import {
  evaluateProductionLaunchConfig,
  LEGAL_ENV_NAMES,
  saleUnlockAdvisories,
} from "./launch-config.mjs";

const completeLaunch = {
  ...Object.fromEntries(LEGAL_ENV_NAMES.map((name) => [name, "renseigné"])),
  ADMIN_MFA_REQUIRED: "true",
  SITE_URL: "https://immojudis.com",
  VERCEL_ENV: "production",
};

describe("achat d'une vente à l'unité : jamais requis pour le build", () => {
  it("ne bloque ni n'avertit quand les variables sont absentes (l'achat reste fermé)", () => {
    expect(saleUnlockAdvisories({})).toEqual([]);
    expect(evaluateProductionLaunchConfig(completeLaunch)).toEqual({
      exitCode: 0,
      errors: [],
      warnings: [],
    });
  });

  it("n'avertit pas d'une configuration cohérente (ouverte avec Price, ou fermée)", () => {
    expect(
      saleUnlockAdvisories({
        STRIPE_SALE_UNLOCK_SALES_OPEN: "true",
        STRIPE_SALE_UNLOCK_PRICE_ID: "price_1Unit",
      }),
    ).toEqual([]);
    expect(saleUnlockAdvisories({ STRIPE_SALE_UNLOCK_SALES_OPEN: "false" })).toEqual([]);
  });

  it("avertit, sans bloquer, d'un interrupteur ouvert sans Price valide", () => {
    const result = evaluateProductionLaunchConfig({
      ...completeLaunch,
      STRIPE_SALE_UNLOCK_SALES_OPEN: "true",
    });
    expect(result.exitCode).toBe(0);
    expect(result.warnings.join("\n")).toMatch(/STRIPE_SALE_UNLOCK_PRICE_ID/);
  });

  it("avertit d'une valeur d'interrupteur que le site lit comme « fermé »", () => {
    expect(saleUnlockAdvisories({ STRIPE_SALE_UNLOCK_SALES_OPEN: "oui" })).toEqual([
      expect.stringMatching(/« oui ».*reste fermé/),
    ]);
  });
});
