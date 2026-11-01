import { afterEach, describe, expect, it, vi } from "vitest";
import { EMAIL_CATEGORIES } from "@/lib/email-alerts";
import { AUTH_EMAIL_TEMPLATES } from "@/lib/auth-email-templates";
import { EMAIL_TEMPLATES, emailTemplatesUsingSender, summarizeEmailTemplate } from "./registry";
import { forceDarkScheme } from "./preview";
import { SAMPLE_ENV, SAMPLE_NOW } from "./samples";
import { EMAIL_CATEGORIES_WITHOUT_TEMPLATE } from "./types";

// Les constructeurs sont appelés pour de vrai ; la base et le réseau ne doivent jamais l'être.
const database = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: database.from, rpc: database.rpc, auth: { admin: {} } },
}));

afterEach(() => vi.restoreAllMocks());

const EDITABLE_LATER = [
  "alert",
  "sale_reminder",
  "weekly_digest",
  "sale_result",
  "trial_end",
  "offer_opening",
  "payment_failed",
  "trial_ending",
  "cancellation",
];
const READ_ONLY = [
  "commercial_confirmation",
  "lawyer_referral",
  "operations_incident",
  "replies_review_digest",
  "contact_message",
  "agent_request",
  "agent_court_registry",
];

describe("registre des emails", () => {
  it("a des clés uniques", () => {
    const keys = EMAIL_TEMPLATES.map((template) => template.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("couvre chaque catégorie d'envoi, ou la déclare interne", () => {
    const covered = new Set(EMAIL_TEMPLATES.map((template) => template.category));
    for (const category of EMAIL_CATEGORIES) {
      expect(
        covered.has(category) || EMAIL_CATEGORIES_WITHOUT_TEMPLATE.includes(category),
        `catégorie ${category} sans gabarit`,
      ).toBe(true);
    }
  });

  it("range les gabarits dans les niveaux décidés", () => {
    const level = (key: string) => EMAIL_TEMPLATES.find((template) => template.key === key)?.level;
    for (const key of EDITABLE_LATER) expect(level(key), key).toBe("editable");
    for (const key of READ_ONLY) expect(level(key), key).toBe("readonly");
    const supabase = EMAIL_TEMPLATES.filter((template) => template.level === "supabase");
    expect(supabase).toHaveLength(AUTH_EMAIL_TEMPLATES.length);
    expect(EMAIL_TEMPLATES).toHaveLength(
      EDITABLE_LATER.length + READ_ONLY.length + AUTH_EMAIL_TEMPLATES.length,
    );
  });

  it("ne déclare aucune zone éditable avant le lot 5", () => {
    expect(EMAIL_TEMPLATES.filter((template) => template.editableZones)).toEqual([]);
  });

  it("explique l'absence d'aperçu quand il n'y a pas de sample()", () => {
    for (const template of EMAIL_TEMPLATES) {
      expect(
        Boolean(template.sample) !== Boolean(template.sampleUnavailable),
        `${template.key}: un aperçu ou une raison, pas les deux ni aucun`,
      ).toBe(true);
    }
  });

  it("retrouve les gabarits d'un expéditeur", () => {
    const keys = emailTemplatesUsingSender("INFORMATION_AGENT_EMAIL_FROM").map((t) => t.key);
    expect(keys).toEqual(["agent_request", "agent_court_registry"]);
    expect(emailTemplatesUsingSender("CONTACT_EMAIL_FROM").map((t) => t.key)).toEqual([
      "contact_message",
    ]);
  });

  it("résume un gabarit sans exposer sa fonction d'aperçu", () => {
    const summary = summarizeEmailTemplate(EMAIL_TEMPLATES[0]);
    expect(Object.keys(summary).sort()).toEqual(
      ["category", "description", "key", "label", "level", "previewable", "sender"].sort(),
    );
    expect(JSON.stringify(summary)).not.toContain("function");
  });
});

describe("aperçus du registre (vrais constructeurs, données fictives)", () => {
  const previewable = EMAIL_TEMPLATES.filter((template) => template.sample);

  it.each(previewable.map((template) => [template.key, template] as const))(
    "%s : rend sans erreur, sans réseau ni base",
    async (_key, template) => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const variants = await template.sample!();

      expect(variants.length).toBeGreaterThan(0);
      expect(new Set(variants.map((variant) => variant.key)).size).toBe(variants.length);
      for (const variant of variants) {
        expect(variant.subject.trim()).not.toBe("");
        if (variant.html === null) {
          expect(variant.text.trim()).not.toBe("");
          continue;
        }
        expect(variant.html).toMatch(/^<!doctype html>/i);
        // Un aperçu s'affiche dans une iframe sans script, mais le HTML d'un email n'en porte jamais.
        expect(variant.html).not.toMatch(/<script/i);
      }
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(database.from).not.toHaveBeenCalled();
      expect(database.rpc).not.toHaveBeenCalled();
    },
  );

  it("signe les liens avec la clé factice, jamais avec celle du serveur", async () => {
    vi.stubEnv("EMAIL_UNSUBSCRIBE_SECRET", "cle-reelle-du-serveur-ne-doit-pas-servir");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-ne-doit-pas-servir");
    const template = EMAIL_TEMPLATES.find((candidate) => candidate.key === "sale_reminder")!;
    const [variant] = await template.sample!();
    const token = /notification-preferences\/unsubscribe\?token=([^"&\s]+)/.exec(
      variant.html ?? "",
    )?.[1];
    expect(token).toBeTruthy();
    const { verifyUnsubscribeToken } = await import("@/lib/email-unsubscribe-token");
    const options = { now: SAMPLE_NOW };
    expect(
      verifyUnsubscribeToken(decodeURIComponent(token!), { ...options, env: SAMPLE_ENV }),
    ).not.toBeNull();
    expect(
      verifyUnsubscribeToken(decodeURIComponent(token!), {
        ...options,
        env: { EMAIL_UNSUBSCRIBE_SECRET: "cle-reelle-du-serveur-ne-doit-pas-servir" },
      }),
    ).toBeNull();
    vi.unstubAllEnvs();
  });

  it("propose des variantes pour les alertes et les rappels (une vente, plusieurs, mode interne)", async () => {
    const variantsOf = async (key: string) =>
      (await EMAIL_TEMPLATES.find((template) => template.key === key)!.sample!()).map(
        (variant) => variant.key,
      );
    expect(await variantsOf("alert")).toEqual(["one-sale", "many-sales"]);
    expect(await variantsOf("sale_reminder")).toEqual(["one-sale", "many-sales-internal"]);
    expect(await variantsOf("trial_end")).toEqual(["normal", "internal"]);
  });

  it("garde le formulaire de contact en texte seul", async () => {
    const template = EMAIL_TEMPLATES.find((candidate) => candidate.key === "contact_message")!;
    const [variant] = await template.sample!();
    expect(variant.html).toBeNull();
    expect(variant.text).toContain("Marie Durand");
  });

  it("donne aux emails Supabase le HTML à coller et un aperçu sans variable Go", async () => {
    const templates = EMAIL_TEMPLATES.filter((template) => template.level === "supabase");
    for (const template of templates) {
      const [variant] = await template.sample!();
      expect(variant.pasteHtml, template.key).toContain("{{ .");
      expect(variant.html, template.key).not.toMatch(/\{\{/);
    }
    const [confirmation] = await templates.find((template) => template.key === "auth_confirmation")!
      .sample!();
    expect(confirmation.html).toContain("marie.durand@exemple.fr");
  });
});

describe("mode sombre de l'aperçu", () => {
  it("remplace la condition du cadre commun par @media all, sans autre changement", async () => {
    const template = EMAIL_TEMPLATES.find((candidate) => candidate.key === "offer_opening")!;
    const [variant] = await template.sample!();
    const html = variant.html as string;
    expect(html.match(/@media \(prefers-color-scheme: dark\)/g)).toHaveLength(1);

    const dark = forceDarkScheme(html);
    expect(dark).not.toContain("prefers-color-scheme: dark");
    expect(dark).toContain("@media all {");
    expect(dark.replace("@media all {", "@media (prefers-color-scheme: dark) {")).toBe(html);
  });
});
