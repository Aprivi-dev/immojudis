import { describe, expect, it, vi } from "vitest";
import {
  confirmReleasePrepare,
  targetDatabaseHost,
  warningText,
} from "./confirm-release-prepare.mjs";

const quiet = () => undefined;

describe("garde de release:prepare", () => {
  it("avertit que le script écrit en production, avec l'hôte seulement", () => {
    const text = warningText({
      SUPABASE_DB_URL: "postgresql://postgres.abc:secret-pass@db.example.supabase.co:5432/postgres",
    });
    expect(text).toContain("écrit en PRODUCTION");
    expect(text).toContain("db:migrate");
    expect(text).toContain("db.example.supabase.co");
    expect(text).not.toContain("secret-pass");
    expect(text).not.toContain("postgres.abc");
  });

  it("ne trouve pas d'hôte sans URL exploitable", () => {
    expect(targetDatabaseHost({})).toBeNull();
    expect(targetDatabaseHost({ POSTGRES_URL: "pas une url" })).toBeNull();
  });

  it("refuse sans terminal interactif et sans confirmation explicite", async () => {
    const result = await confirmReleasePrepare({ env: {}, interactive: false, write: quiet });
    expect(result).toEqual({ confirmed: false, reason: "non-interactive" });
  });

  it("accepte la confirmation explicite par variable d'environnement", async () => {
    const result = await confirmReleasePrepare({
      env: { RELEASE_PREPARE_CONFIRM: "production" },
      interactive: false,
      write: quiet,
    });
    expect(result).toEqual({ confirmed: true, reason: "env" });
    // Une autre valeur ne confirme rien.
    expect(
      (
        await confirmReleasePrepare({
          env: { RELEASE_PREPARE_CONFIRM: "yes" },
          interactive: false,
          write: quiet,
        })
      ).confirmed,
    ).toBe(false);
  });

  it("demande de taper « production » dans un terminal, et annule sinon", async () => {
    const yes = vi.fn().mockResolvedValue(" production ");
    expect(
      await confirmReleasePrepare({ env: {}, interactive: true, ask: yes, write: quiet }),
    ).toEqual({
      confirmed: true,
      reason: "typed",
    });
    const no = vi.fn().mockResolvedValue("oui");
    expect(
      await confirmReleasePrepare({ env: {}, interactive: true, ask: no, write: quiet }),
    ).toEqual({
      confirmed: false,
      reason: "declined",
    });
  });
});
