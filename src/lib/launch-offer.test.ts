import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LAUNCH_OFFER_ACCOUNT_TEXT,
  LAUNCH_OFFER_VISITOR_TEXT,
  launchOfferText,
  parseLaunchOfferResponse,
} from "@/lib/launch-offer";
import { FREE_ACCESS_LINE, freeAccessLine } from "@/lib/sale-unlocks";
import { PLAN_LIMITS } from "@/lib/plans";

describe("textes de l'offre de lancement", () => {
  it("dit au compte connecté que l’email confirmé est requis et que les avantages sont retirables sans préavis", () => {
    expect(LAUNCH_OFFER_ACCOUNT_TEXT).toBe(
      "Offre de lancement : votre compte gratuit, une fois votre adresse email confirmée, bénéficie des avantages de l’offre Analyse. Ces avantages pourront vous être retirés, sans préavis, à tout moment, notamment au lancement officiel du site.",
    );
  });

  it("dit au visiteur de créer un compte gratuit et de confirmer son email, avec la même réserve", () => {
    expect(LAUNCH_OFFER_VISITOR_TEXT).toBe(
      "Offre de lancement : créez un compte gratuit, confirmez votre adresse email et accédez aux avantages de l’offre Analyse (avantages retirables sans préavis, à tout moment, notamment au lancement officiel).",
    );
  });

  it("choisit la mention selon le public", () => {
    expect(launchOfferText("account")).toBe(LAUNCH_OFFER_ACCOUNT_TEXT);
    expect(launchOfferText("visitor")).toBe(LAUNCH_OFFER_VISITOR_TEXT);
  });
});

describe("ligne d'accès commune (FREE_ACCESS_LINE)", () => {
  it("garde la promesse du compte gratuit quand l'offre est coupée", () => {
    expect(freeAccessLine()).toBe(FREE_ACCESS_LINE);
    expect(freeAccessLine({ launchOffer: false, signedIn: true })).toBe(FREE_ACCESS_LINE);
  });

  it("bascule sur les textes de l'offre quand elle est active", () => {
    expect(freeAccessLine({ launchOffer: true })).toBe(LAUNCH_OFFER_VISITOR_TEXT);
    expect(freeAccessLine({ launchOffer: true, signedIn: true })).toBe(LAUNCH_OFFER_ACCOUNT_TEXT);
    expect(freeAccessLine({ launchOffer: true })).not.toContain("fiches détaillées par mois");
  });
});

describe("réponse de /api/launch-offer", () => {
  it("ne lit qu'un booléen", () => {
    expect(parseLaunchOfferResponse({ active: true })).toBe(true);
    expect(parseLaunchOfferResponse({ active: false })).toBe(false);
    expect(parseLaunchOfferResponse({ active: "true" })).toBeNull();
    expect(parseLaunchOfferResponse(null)).toBeNull();
    expect(parseLaunchOfferResponse("oui")).toBeNull();
  });
});

describe("migrations de l'offre de lancement", () => {
  const dir = resolve("supabase/migrations");
  const read = (name: string) => readFileSync(resolve(dir, name), "utf8");
  const stripComments = (text: string) => text.replace(/--[^\n]*/g, "");
  // 20261028120000 crée la table et l'interrupteur ; les fonctions d'accès y ont été remplacées
  // ensuite (20261028170000, puis les migrations suivantes) : on teste la dernière définition.
  const sql = stripComments(read("20261028120000_launch_offer.sql"));
  const latestDefinition = (signature: string) => {
    const header = `create or replace function ${signature}`;
    const files = readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .filter((name) => stripComments(read(name)).includes(header));
    const file = files.at(-1);
    expect(file, `définition de ${signature}`).toBeDefined();
    return { file: file as string, text: stripComments(read(file as string)) };
  };

  it("crée une table à une seule ligne, active à l'application, fermée aux navigateurs", () => {
    expect(sql).toMatch(/create table if not exists app_private\.launch_offer/);
    expect(sql).toMatch(/singleton boolean primary key default true check \(singleton\)/);
    expect(sql).toMatch(
      /insert into app_private\.launch_offer \(singleton, active\)\s*values \(true, true\)\s*on conflict \(singleton\) do nothing/,
    );
    expect(sql).toMatch(
      /revoke all on table app_private\.launch_offer from public, anon, authenticated/,
    );
    expect(sql).toMatch(/alter table app_private\.launch_offer enable row level security/);
  });

  it("n'écrit jamais dans les comptes ni dans les abonnements", () => {
    expect(sql).not.toMatch(/(update|insert into|delete from)\s+public\.user_profiles/i);
    expect(sql).not.toMatch(/(update|insert into|delete from)\s+public\.user_subscriptions/i);
    expect(sql).not.toMatch(/set\s+account_tier/i);
  });

  it("lit l'état dans une fonction stable, à search_path vide, fermée à anon", () => {
    expect(sql).toMatch(
      /function app_private\.launch_offer_active\(\)\s*returns boolean\s*language sql\s*stable\s*security definer\s*set search_path to ''/,
    );
    expect(sql).toMatch(
      /revoke all on function app_private\.launch_offer_active\(\) from public, anon, authenticated/,
    );
    expect(sql).not.toMatch(
      /grant execute on function app_private\.launch_offer_active\(\)\s*to[^;]*anon/,
    );
    expect(sql).not.toMatch(
      /grant execute on function public\.get_launch_offer_status\(\)\s*to[^;]*(anon|authenticated)/,
    );
  });

  it("fait lire l'offre aux deux fonctions d'accès (dernière définition), et garde leurs droits", () => {
    for (const fn of [
      "app_private.current_user_has_premium_access()",
      "app_private.has_active_analysis_access(p_user_id uuid)",
    ]) {
      const { file, text } = latestDefinition(fn);
      const start = text.indexOf(`create or replace function ${fn}`);
      const body = text.slice(start, text.indexOf("$function$;", start + 200));
      expect(body, file).toContain("app_private.launch_offer_active()");
      expect(body, file).toContain("subscription_grants_access");
      expect(body, file).toMatch(/security definer\s*set search_path to ''/);
      // Dernière définition : l'email confirmé (et non le seul profil) ouvre l'offre.
      expect(body, file).toContain("app_private.launch_offer_account_eligible(");
      if (fn.startsWith("app_private.has_active_analysis_access")) {
        expect(text).toMatch(
          /revoke all on function app_private\.has_active_analysis_access\(uuid\)\s*from public, anon, authenticated;\s*grant execute on function app_private\.has_active_analysis_access\(uuid\) to service_role/,
        );
      } else {
        expect(text).toMatch(
          /grant execute on function app_private\.current_user_has_premium_access\(\)\s*to authenticated, service_role/,
        );
      }
    }
  });

  it("réserve l'interrupteur aux administrateurs et refuse anon", () => {
    expect(sql).toMatch(
      /if not public\.is_admin\(\) then\s*raise exception using errcode = '42501'/,
    );
    expect(sql).toMatch(
      /revoke all on function public\.set_launch_offer\(boolean\) from public, anon/,
    );
  });

  it("ramène le quota de favoris du compte gratuit à la limite de plans.ts", () => {
    const favorites = read("20261028120100_free_favorites_quota_10.sql");
    const limit = /function app_private\.free_favorite_limit\(\)[\s\S]*?select\s+(\d+)\s*;/.exec(
      favorites,
    )?.[1];
    expect(Number(limit)).toBe(PLAN_LIMITS.decouverte.favoriteSales);
    expect(favorites).toContain("app_private.free_favorite_limit()");
    expect(favorites).toContain(
      `Quota de ${PLAN_LIMITS.decouverte.favoriteSales} favoris gratuits`,
    );
    // La constante n'est plus écrite en dur dans le déclencheur.
    expect(favorites).not.toMatch(/>=\s*\d+\s+then/);
  });
});
