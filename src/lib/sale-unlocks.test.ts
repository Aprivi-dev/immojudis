import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PLAN_LIMITS } from "@/lib/plans";
import { parseSaleUnlockResult, parseSaleUnlockStatus } from "@/lib/sale-unlocks.server";
import {
  FREE_ACCESS_LINE,
  MONTHLY_SALE_UNLOCKS,
  remainingUnlocksLine,
  unlockConfirmationText,
  UNLOCK_HIGHLIGHTS_INLINE_TEXT,
  UNLOCK_HIGHLIGHTS_TEXT,
  unlockCallToActionLabel,
  unlockedItemsText,
  unlockQuotaReachedText,
  unlockQuotaResetLine,
  unlockUsageLine,
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

  it("builds the free-access line from the quota, not from a typed number", () => {
    expect(FREE_ACCESS_LINE).toBe(
      `Gratuit, sans carte bancaire · ${PLAN_LIMITS.decouverte.monthlyUnlocks} fiches détaillées par mois`,
    );
    expect(FREE_ACCESS_LINE).toBe("Gratuit, sans carte bancaire · 3 fiches détaillées par mois");
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

describe("migrations of the unlock follow-ups", () => {
  const read = (name: string) => readFileSync(resolve("supabase/migrations", name), "utf8");

  it("exposes `unlockable` through a definer helper and keeps get_sale_unlock_status invoker", () => {
    const migration = read("20261025130000_sale_unlock_status_unlockable.sql");
    expect(migration).toMatch(/'unlockable',\s*p_sale_id is null or/);
    expect(migration).toMatch(
      /function public\.get_sale_unlock_status\(p_sale_id uuid default null\)\s*returns jsonb\s*language plpgsql\s*stable\s*security invoker/,
    );
    expect(migration).toMatch(
      /function app_private\.current_user_can_unlock_sale\(p_sale_id uuid\)[\s\S]*?security definer\s*set search_path = ''/,
    );
    expect(migration).toMatch(
      /grant execute on function public\.get_sale_unlock_status\(uuid\) to authenticated, service_role/,
    );
  });

  it("applies the 24 months of the terms to an unlock, like the retention does", () => {
    const migration = read("20261025130100_sale_unlock_24_months_and_release.sql");
    expect(migration).toMatch(
      /function app_private\.current_user_unlocked_sale[\s\S]*?unlocked_at > pg_catalog\.now\(\) - interval '24 months'/,
    );
  });

  it("only lets the service role release an unlock", () => {
    const migration = read("20261025130100_sale_unlock_24_months_and_release.sql");
    expect(migration).toMatch(
      /revoke all on function app_private\.release_sale_unlock\(uuid, timestamptz\)\s*from public, anon, authenticated;\s*grant execute on function app_private\.release_sale_unlock\(uuid, timestamptz\) to service_role;/,
    );
  });
});

describe("unlock status parsing", () => {
  it("normalizes the database answer", () => {
    expect(parseSaleUnlockStatus(rpcStatus)).toEqual({
      saleId: "11111111-1111-4111-8111-111111111111",
      unlocked: false,
      unlockable: true,
      analysisAccess: false,
      limit: 3,
      used: 1,
      remaining: 2,
      periodStart: "2026-09-30T22:00:00.000Z",
      resetsAt: "2026-10-31T23:00:00.000Z",
    });
  });

  it("reads « unlockable » from the database, and assumes « yes » when it does not send it", () => {
    expect(parseSaleUnlockStatus({ ...rpcStatus, unlockable: false }).unlockable).toBe(false);
    expect(parseSaleUnlockStatus({ ...rpcStatus, unlockable: true }).unlockable).toBe(true);
    expect(parseSaleUnlockStatus(rpcStatus).unlockable).toBe(true);
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
      "Ce déblocage est définitif : il n’est restitué que si Immojudis retire elle-même la vente (conditions générales, article 2). Le compteur est remis à 3 le 1er novembre.",
    );
  });

  it("cites each highlight of the free account in the full list of what an unlock opens", () => {
    const full = unlockedItemsText({ ceiling: true, statistics: false });
    expect(UNLOCK_HIGHLIGHTS_TEXT).toBe(
      "enchère plafond (ventes au tribunal), lecture des pièces, historique, selon la vente",
    );
    expect(UNLOCK_HIGHLIGHTS_INLINE_TEXT).toBe(
      "enchère plafond, lecture des pièces, historique, selon la vente",
    );
    for (const word of ["plafond", "pièces", "historique"]) {
      expect(UNLOCK_HIGHLIGHTS_TEXT).toContain(word);
      expect(full).toContain(word);
    }
  });

  it("labels the main link of a paid preview with the remaining unlocks", () => {
    expect(unlockCallToActionLabel(status)).toBe("Débloquer cette vente (il vous reste 2 sur 3)");
    expect(unlockCallToActionLabel({ ...status, remaining: 1 })).toBe(
      "Débloquer cette vente (il vous reste 1 sur 3)",
    );
  });

  it("tells when the spent unlocks come back, with the elision of « octobre »", () => {
    expect(unlockQuotaResetLine(status)).toBe(
      "Vos 3 déblocages d’octobre reviennent le 1er novembre.",
    );
    expect(
      unlockQuotaResetLine({
        limit: 3,
        periodStart: "2026-10-31T23:00:00.000Z",
        resetsAt: "2026-11-30T23:00:00.000Z",
      }),
    ).toBe("Vos 3 déblocages de novembre reviennent le 1er décembre.");
  });

  it("sums up the month on the account page", () => {
    expect(unlockUsageLine(status)).toBe(
      "Déblocages ce mois-ci : 1 sur 3 utilisés. Remis à 3 le 1er novembre.",
    );
    expect(unlockUsageLine({ ...status, used: 5 })).toContain("3 sur 3 utilisés");
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
