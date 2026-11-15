import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PLAN_LIMITS } from "@/lib/plans";
import { parseSaleUnlockResult, parseSaleUnlockStatus } from "@/lib/sale-unlocks.server";
import { ceilingTermWithArticleText } from "@/lib/fee-regime-labels";
import {
  FREE_ACCESS_LINE,
  FREE_SALE_UNLOCKS,
  FREE_UNLOCK_LABEL,
  FREE_UNLOCK_TEXT,
  UNLOCK_CALL_TO_ACTION_LABEL,
  UNLOCK_CHOICE_TEXT,
  UNLOCK_CONFIRMATION_TEXT,
  UNLOCK_HIGHLIGHTS_INLINE_TEXT,
  UNLOCK_HIGHLIGHTS_TEXT,
  UNLOCK_QUOTA_REACHED_TITLE,
  unlockHighlightsInlineText,
  unlockHighlightsText,
  unlockedItemsText,
  unlockQuotaReachedText,
  unlockUsageLine,
} from "@/lib/sale-unlocks";
import { SALE_UNLOCK_QUOTA_MESSAGE } from "@/lib/sale-unlock-quota-message";

const rpcStatus = {
  sale_id: "11111111-1111-4111-8111-111111111111",
  unlocked: false,
  analysis_access: false,
  limit: 1,
  used: 0,
  remaining: 1,
};

const SINGLE_UNLOCK_MIGRATION = "20261120100000_free_account_single_sale_unlock.sql";

describe("single source of the free unlock", () => {
  it("takes the number of unlocks from PLAN_LIMITS", () => {
    expect(FREE_SALE_UNLOCKS).toBe(PLAN_LIMITS.decouverte.saleUnlocks);
  });

  it("writes « une vente » in full words only while the free account unlocks one sale", () => {
    // The visible texts say « une vente », « n’en comprend qu’un » : a new number needs new texts.
    expect(FREE_SALE_UNLOCKS).toBe(1);
    expect(FREE_UNLOCK_TEXT).toBe("une vente à débloquer");
    expect(FREE_UNLOCK_LABEL).toBe("Une vente à débloquer");
  });

  it("builds the free-access line from the same words", () => {
    expect(FREE_ACCESS_LINE).toBe(`Gratuit, sans carte bancaire · ${FREE_UNLOCK_TEXT}`);
    expect(FREE_ACCESS_LINE).toBe("Gratuit, sans carte bancaire · une vente à débloquer");
  });

  it("matches the limit of the database migration", () => {
    const migration = readFileSync(resolve("supabase/migrations", SINGLE_UNLOCK_MIGRATION), "utf8");
    const limit = /function app_private\.free_sale_unlock_limit\(\)[\s\S]*?select\s+(\d+)\s*;/.exec(
      migration,
    )?.[1];
    expect(Number(limit)).toBe(PLAN_LIMITS.decouverte.saleUnlocks);
  });

  it("keeps the idempotent, serialized unlock in the database", () => {
    const migration = readFileSync(resolve("supabase/migrations", SINGLE_UNLOCK_MIGRATION), "utf8");
    expect(migration).toMatch(/pg_advisory_xact_lock/);
    expect(migration).toMatch(
      /function app_private\.unlock_sale_at\([\s\S]*?security definer\s*set search_path = ''/,
    );
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

  it("only lets the service role release an unlock, which no longer takes a date", () => {
    const migration = read(SINGLE_UNLOCK_MIGRATION);
    expect(migration).toMatch(
      /revoke all on function app_private\.release_sale_unlock\(uuid\)\s*from public, anon, authenticated;\s*grant execute on function app_private\.release_sale_unlock\(uuid\) to service_role;/,
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
      limit: 1,
      used: 0,
      remaining: 1,
    });
  });

  it("ignores the monthly period keys a database not yet migrated still sends", () => {
    const legacy = {
      ...rpcStatus,
      period_start: "2026-09-30T22:00:00+00:00",
      period_end: "2026-10-31T23:00:00+00:00",
    };
    expect(parseSaleUnlockStatus(legacy)).toEqual(parseSaleUnlockStatus(rpcStatus));
    expect(parseSaleUnlockStatus(legacy)).not.toHaveProperty("periodStart");
    expect(parseSaleUnlockStatus(legacy)).not.toHaveProperty("resetsAt");
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
      used: 1,
      remaining: 0,
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
    expect(status.remaining).toBeNull();
  });

  it("refuses a malformed answer", () => {
    expect(() => parseSaleUnlockStatus({ unlocked: "yes" })).toThrow();
    expect(() => parseSaleUnlockStatus({ ...rpcStatus, remaining: -1 })).toThrow();
  });
});

describe("texts of the unlock", () => {
  it("lists what an unlock opens, without promising what the page does not show", () => {
    expect(unlockedItemsText({ ceiling: "l’enchère plafond", statistics: true })).toBe(
      "l’analyse complète de la vente (l’enchère plafond, l’estimation détaillée et les ventes comparables, la lecture des pièces, l’historique de la vente, les statistiques du tribunal, l’urbanisme et le cadastre, les pièces du dossier et le rapport PDF)",
    );
    expect(unlockedItemsText({ ceiling: null, statistics: false })).toBe(
      "l’analyse complète de la vente (l’estimation détaillée et les ventes comparables, la lecture des pièces, l’historique de la vente, l’urbanisme et le cadastre, les pièces du dossier et le rapport PDF)",
    );
    expect(unlockedItemsText({ ceiling: "l’enchère plafond", statistics: false })).not.toContain(
      "statistiques",
    );
  });

  it("opens the whole Analyse offer on the sale: estimate, comparables, land, PDF report", () => {
    const text = unlockedItemsText({ ceiling: null, statistics: false });
    expect(text).toMatch(/^l’analyse complète de la vente \(/);
    for (const item of [
      "l’estimation détaillée et les ventes comparables",
      "l’urbanisme et le cadastre",
      "le rapport PDF",
    ]) {
      expect(text).toContain(item);
    }
  });

  it("names the ceiling from the label given by the fee regime of the sale", () => {
    expect(unlockedItemsText({ ceiling: "l’offre plafond", statistics: false })).toBe(
      "l’analyse complète de la vente (l’offre plafond, l’estimation détaillée et les ventes comparables, la lecture des pièces, l’historique de la vente, l’urbanisme et le cadastre, les pièces du dossier et le rapport PDF)",
    );
    expect(
      unlockedItemsText({ ceiling: "l’enchère plafond ou l’offre plafond", statistics: false }),
    ).toContain("(l’enchère plafond ou l’offre plafond, l’estimation détaillée");
    // No regime, no ceiling: nothing is promised.
    expect(unlockedItemsText({ ceiling: null, statistics: false })).not.toContain("plafond");
  });

  it("builds the highlights of the free account from the open regimes", () => {
    // The constants are written out (to keep the term computation out of the pages that cite them):
    // they must stay equal to the computation for the regimes open by default.
    expect(unlockHighlightsText()).toBe(UNLOCK_HIGHLIGHTS_TEXT);
    expect(unlockHighlightsInlineText()).toBe(UNLOCK_HIGHLIGHTS_INLINE_TEXT);
    // The tribunal alone: the ceiling is only an « enchère plafond ».
    expect(unlockHighlightsText(["tribunal"])).toBe(
      "l’analyse complète de la vente : enchère plafond (ventes au tribunal), estimation détaillée et ventes comparables, lecture des pièces, historique, urbanisme et rapport PDF, selon la vente",
    );
    expect(unlockHighlightsInlineText(["tribunal"])).toBe(
      "l’analyse complète de la vente : enchère plafond, estimation détaillée et ventes comparables, lecture des pièces, historique, urbanisme et rapport PDF, selon la vente",
    );
    // Both notarial regimes open (default): both terms, each with its sales.
    expect(UNLOCK_HIGHLIGHTS_TEXT).toBe(
      "l’analyse complète de la vente : enchère plafond (ventes au tribunal et ventes notariales à la bougie) ou offre plafond (ventes notariales interactives), estimation détaillée et ventes comparables, lecture des pièces, historique, urbanisme et rapport PDF, selon la vente",
    );
    expect(UNLOCK_HIGHLIGHTS_INLINE_TEXT).toBe(
      "l’analyse complète de la vente : enchère plafond ou offre plafond, estimation détaillée et ventes comparables, lecture des pièces, historique, urbanisme et rapport PDF, selon la vente",
    );
    // A notarial regime switched off promises nothing more.
    expect(unlockHighlightsText(["tribunal", "notary_auction"])).toBe(
      "l’analyse complète de la vente : enchère plafond (ventes au tribunal et ventes notariales à la bougie), estimation détaillée et ventes comparables, lecture des pièces, historique, urbanisme et rapport PDF, selon la vente",
    );
    // A regime whose rules are not defined opens nothing.
    expect(unlockHighlightsText(["tribunal", "state_auction"])).toBe(
      unlockHighlightsText(["tribunal"]),
    );
  });

  it("states the single unlock of the free account, and asks to choose the sale", () => {
    expect(UNLOCK_CALL_TO_ACTION_LABEL).toBe("Débloquer cette vente avec mon compte gratuit");
    expect(UNLOCK_CHOICE_TEXT).toBe(
      "Votre compte gratuit comprend le déblocage d’une vente : choisissez-la.",
    );
  });

  it("says before the click that the unlock is final, and when it is given back", () => {
    expect(UNLOCK_CONFIRMATION_TEXT).toBe(
      "Ce déblocage est définitif : votre compte gratuit n’en comprend qu’un. Il vous est rendu si la vente est retirée avant d’avoir lieu (conditions générales, article 2).",
    );
    expect(UNLOCK_CONFIRMATION_TEXT).not.toMatch(/mois|compteur|remis/);
  });

  it("cites each highlight of the free account in the full list of what an unlock opens", () => {
    const full = unlockedItemsText({
      ceiling: ceilingTermWithArticleText(),
      statistics: false,
    });
    expect(full).toContain("l’enchère plafond ou l’offre plafond");
    for (const word of [
      "analyse complète de la vente",
      "plafond",
      "estimation détaillée",
      "ventes comparables",
      "pièces",
      "historique",
      "urbanisme",
      "rapport PDF",
    ]) {
      expect(UNLOCK_HIGHLIGHTS_TEXT).toContain(word);
      expect(UNLOCK_HIGHLIGHTS_INLINE_TEXT).toContain(word);
      expect(full).toContain(word);
    }
    // Each term of the full list is cited by the highlights too (they must not drift apart).
    for (const term of ["enchère plafond", "offre plafond"]) {
      expect(UNLOCK_HIGHLIGHTS_TEXT).toContain(term);
      expect(UNLOCK_HIGHLIGHTS_INLINE_TEXT).toContain(term);
      expect(full).toContain(term);
    }
  });

  it("sums up the unlock on the account page", () => {
    expect(unlockUsageLine({ remaining: 1 })).toBe("Déblocage du compte gratuit : disponible");
    expect(unlockUsageLine({ remaining: 0 })).toBe("Déblocage du compte gratuit : utilisé");
    expect(unlockUsageLine({ remaining: null })).toBe("Déblocage du compte gratuit : utilisé");
  });

  it("titles a spent unlock without a month, and says the same in the 409 message", () => {
    expect(UNLOCK_QUOTA_REACHED_TITLE).toBe("Votre compte gratuit a déjà débloqué une vente");
    expect(SALE_UNLOCK_QUOTA_MESSAGE).toBe(`${UNLOCK_QUOTA_REACHED_TITLE}.`);
  });

  it("explains how to open the sale: Analyse only when it can be bought, no promise otherwise", () => {
    expect(unlockQuotaReachedText({ analysisOpen: true })).toBe(
      "Pour ouvrir celle-ci aussi, passez à l’offre Analyse : elle ouvre toutes les ventes.",
    );
    expect(unlockQuotaReachedText()).toBe(
      "Le compte gratuit ne débloque qu’une vente ; l’offre Analyse les ouvre toutes.",
    );
    expect(unlockQuotaReachedText({ analysisOpen: false })).not.toMatch(/passez|souscri/);
  });
});

describe("le détail de la pépite parmi ce qu'un déblocage ouvre", () => {
  it("l'ajoute après le plafond, seulement pour une pépite", () => {
    expect(
      unlockedItemsText({ ceiling: "l’enchère plafond", statistics: false, pepite: true }),
    ).toContain(
      "(l’enchère plafond, le détail de la pépite, l’estimation détaillée et les ventes comparables, la lecture des pièces",
    );
    expect(unlockedItemsText({ ceiling: "l’enchère plafond", statistics: false })).not.toContain(
      "pépite",
    );
    expect(
      unlockedItemsText({ ceiling: "l’enchère plafond", statistics: true, pepite: false }),
    ).not.toContain("pépite");
  });
});
