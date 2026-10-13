import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PLAN_LIMITS } from "@/lib/plans";
import { parseSaleUnlockResult, parseSaleUnlockStatus } from "@/lib/sale-unlocks.server";
import {
  MONTHLY_SALE_UNLOCKS,
  remainingUnlocksLine,
  unlockConfirmationText,
  unlockedItemsText,
  unlockQuotaReachedText,
} from "@/lib/sale-unlocks";

const rpcStatus = {
  sale_id: "11111111-1111-4111-8111-111111111111",
  unlocked: false,
  analysis_access: false,
  limit: 3,
  used: 1,
  remaining: 2,
  period_start: "2026-09-30T22:00:00+00:00",
  period_end: "2026-10-31T23:00:00+00:00",
};

describe("single source of the monthly quota", () => {
  it("takes the number of unlocks from PLAN_LIMITS", () => {
    expect(MONTHLY_SALE_UNLOCKS).toBe(PLAN_LIMITS.decouverte.monthlyUnlocks);
    expect(MONTHLY_SALE_UNLOCKS).toBe(3);
  });

  it("matches the constant of the database migration", () => {
    const migration = readFileSync(
      resolve("supabase/migrations/20261023100000_discovery_sale_unlocks.sql"),
      "utf8",
    );
    const limit =
      /function app_private\.monthly_sale_unlock_limit\(\)[\s\S]*?select\s+(\d+)\s*;/.exec(
        migration,
      )?.[1];
    expect(Number(limit)).toBe(PLAN_LIMITS.decouverte.monthlyUnlocks);
  });

  it("keeps the Paris calendar month and the idempotent, serialized unlock in the database", () => {
    const migration = readFileSync(
      resolve("supabase/migrations/20261023100000_discovery_sale_unlocks.sql"),
      "utf8",
    );
    expect(migration).toMatch(/at time zone 'Europe\/Paris'/);
    expect(migration).toMatch(/pg_advisory_xact_lock/);
    expect(migration).toMatch(/security definer[\s\S]*?set search_path = ''/);
  });
});

describe("unlock status parsing", () => {
  it("normalizes the database answer", () => {
    expect(parseSaleUnlockStatus(rpcStatus)).toEqual({
      saleId: "11111111-1111-4111-8111-111111111111",
      unlocked: false,
      analysisAccess: false,
      limit: 3,
      used: 1,
      remaining: 2,
      periodStart: "2026-09-30T22:00:00.000Z",
      resetsAt: "2026-10-31T23:00:00.000Z",
    });
  });

  it("reads an unlock result", () => {
    const result = parseSaleUnlockResult({
      ...rpcStatus,
      unlocked: true,
      used: 2,
      remaining: 1,
      already_unlocked: false,
      consumed: true,
    });
    expect(result).toMatchObject({ unlocked: true, consumed: true, alreadyUnlocked: false });
  });

  it("shows no quota for an account that has nothing to unlock", () => {
    const status = parseSaleUnlockStatus({
      ...rpcStatus,
      analysis_access: true,
      limit: null,
      used: 0,
      remaining: null,
    });
    expect(status.limit).toBeNull();
    expect(remainingUnlocksLine(status)).toBeNull();
  });

  it("refuses a malformed answer", () => {
    expect(() => parseSaleUnlockStatus({ unlocked: "yes" })).toThrow();
    expect(() => parseSaleUnlockStatus({ ...rpcStatus, remaining: -1 })).toThrow();
  });
});

describe("texts of the unlock", () => {
  const status = parseSaleUnlockStatus(rpcStatus);

  it("lists what an unlock opens, without promising what the page does not show", () => {
    expect(unlockedItemsText({ ceiling: true, statistics: true })).toBe(
      "l’enchère plafond, la lecture des pièces, l’historique de la vente, les statistiques du tribunal et les pièces du dossier",
    );
    expect(unlockedItemsText({ ceiling: false, statistics: false })).toBe(
      "la lecture des pièces, l’historique de la vente et les pièces du dossier",
    );
    expect(unlockedItemsText({ ceiling: true, statistics: false })).not.toContain("statistiques");
  });

  it("states the remaining unlocks with the monthly total", () => {
    expect(remainingUnlocksLine(status)).toBe("Il vous reste 2 déblocages sur 3 ce mois-ci.");
    expect(remainingUnlocksLine({ ...status, remaining: 1 })).toBe(
      "Il vous reste 1 déblocage sur 3 ce mois-ci.",
    );
  });

  it("says before the click that the unlock is final and when the counter restarts", () => {
    expect(unlockConfirmationText(status)).toBe(
      "Ce déblocage est définitif et ne sera pas restitué. Le compteur est remis à 3 le 1er novembre.",
    );
  });

  it("explains an exhausted quota with the Paris month and the reset date", () => {
    expect(unlockQuotaReachedText(status)).toBe(
      "Vous avez utilisé vos 3 déblocages d’octobre. Ils reviennent le 1er novembre.",
    );
    expect(
      unlockQuotaReachedText({
        limit: 3,
        periodStart: "2026-10-31T23:00:00.000Z",
        resetsAt: "2026-11-30T23:00:00.000Z",
      }),
    ).toBe("Vous avez utilisé vos 3 déblocages de novembre. Ils reviennent le 1er décembre.");
  });
});
