import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LAUNCH_OFFER_ACCOUNT_TEXT,
  LAUNCH_OFFER_DATA_TEXT,
  LAUNCH_OFFER_DURATION_TEXT,
  LAUNCH_OFFER_SHORT_TEXT,
  LAUNCH_OFFER_VISITOR_TEXT,
  launchOfferText,
  parseLaunchOfferResponse,
  SIGNUP_TRIAL_DENIED_TEXT,
  signupTrialStatusText,
} from "@/lib/launch-offer";
import { FREE_ACCESS_LINE, freeAccessLine } from "@/lib/sale-unlocks";
import { PLAN_LIMITS } from "@/lib/plans";

const END_RULES =
  "À son terme, votre compte revient à l’offre Découverte, gratuite et sans limite de durée : rien ne devient payant automatiquement. L’offre Analyse est ensuite proposée sur abonnement payant ; son tarif figure sur la page Offres. L’essai peut être retiré plus tôt, sans préavis, en cas d’abus ou d’impératif technique ou juridique.";

describe("textes de l'essai gratuit à l'inscription", () => {
  it("disent les règles : début à la confirmation, 7 jours, une fois par personne, retour à Découverte", () => {
    expect(LAUNCH_OFFER_DURATION_TEXT).toBe(
      `L’essai commence à la confirmation de votre adresse email, dure 7 jours et n’est proposé qu’une fois par personne. ${END_RULES}`,
    );
    expect(LAUNCH_OFFER_DATA_TEXT).toBe(
      "Vos données (favoris, alertes, rapports enregistrés) restent conservées tant que votre compte existe et dans les durées de la politique de confidentialité. Elles redeviennent accessibles avec l’offre Analyse.",
    );
  });

  it("disent à un compte connecté la règle, vraie que son essai soit en cours, fini ou refusé", () => {
    expect(LAUNCH_OFFER_ACCOUNT_TEXT).toBe(
      `Essai gratuit : le premier compte confirmé de chaque personne bénéficie de l’offre Analyse pendant 7 jours à compter de la confirmation de son adresse email, sans carte bancaire. ${END_RULES}`,
    );
  });

  it("disent au visiteur l'inscription gratuite et ses conditions dans la même phrase", () => {
    expect(LAUNCH_OFFER_VISITOR_TEXT).toBe(
      `Inscrivez-vous gratuitement : une fois votre adresse email confirmée, votre compte bénéficie de l’offre Analyse pendant 7 jours (un essai par personne), sans carte bancaire. ${END_RULES}`,
    );
    expect(LAUNCH_OFFER_SHORT_TEXT).toBe(
      "Inscription gratuite : 7 jours d’accès à l’offre Analyse, sans carte bancaire",
    );
  });

  it("ne promettent ni retrait « à tout moment » sans condition, ni prix sans le dire payant", () => {
    for (const text of [LAUNCH_OFFER_ACCOUNT_TEXT, LAUNCH_OFFER_VISITOR_TEXT]) {
      expect(text).not.toContain("à tout moment");
      expect(text).not.toContain("offre de lancement");
      expect(text).toContain("adresse email");
      expect(text).toContain("abonnement payant");
    }
  });

  it("choisit la mention selon le public", () => {
    expect(launchOfferText("account")).toBe(LAUNCH_OFFER_ACCOUNT_TEXT);
    expect(launchOfferText("visitor")).toBe(LAUNCH_OFFER_VISITOR_TEXT);
  });

  it("dit à un compte l'état de son essai : en cours, terminé ou refusé", () => {
    expect(signupTrialStatusText({ trialEndsAt: "2026-11-01T13:05:00.000Z" })).toBe(
      "Essai gratuit de l’offre Analyse jusqu’au 1er novembre 2026 à 14:05. À son terme, votre compte revient à l’offre Découverte, gratuite : rien ne devient payant automatiquement.",
    );
    expect(signupTrialStatusText({ trialEndedAt: "2026-10-30T09:00:00.000Z" })).toBe(
      "Votre essai gratuit de l’offre Analyse s’est terminé le 30 octobre 2026 à 10:00 : votre compte est revenu à l’offre Découverte. Pour continuer avec l’offre Analyse, il faudra y souscrire ; l’état de l’abonnement est indiqué ci-dessous.",
    );
    expect(signupTrialStatusText({ trialDenied: true })).toBe(SIGNUP_TRIAL_DENIED_TEXT);
    expect(signupTrialStatusText({})).toBeNull();
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

  it("limite l'éligibilité à 7 jours après la confirmation, sans ouvrir aux navigateurs (20261103100000)", () => {
    const trial = stripComments(read("20261103100000_signup_trial_seven_days.sql"));
    expect(trial).toMatch(/account\.email_confirmed_at \+ interval '7 days'/);
    expect(trial).toMatch(
      /launch_offer_account_eligible[\s\S]*?coalesce\(app_private\.signup_trial_ends_at\(p_user_id\) > now\(\), false\)/,
    );
    for (const fn of [
      "app_private.signup_trial_ends_at(uuid)",
      "app_private.launch_offer_account_eligible(uuid)",
      "public.get_signup_trial_end(uuid)",
    ]) {
      expect(trial).toContain(`revoke all on function ${fn} from public, anon, authenticated`);
      expect(trial).toContain(`grant execute on function ${fn} to service_role`);
    }
    // Les fonctions d'accès Analyse ne sont pas redéfinies : elles lisent déjà l'éligibilité.
    expect(trial).not.toMatch(
      /function app_private\.(current_user_has_premium_access|has_active_analysis_access)/,
    );
    expect(latestDefinition("app_private.launch_offer_account_eligible(").file).toBe(
      "20261103100000_signup_trial_seven_days.sql",
    );
  });

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
