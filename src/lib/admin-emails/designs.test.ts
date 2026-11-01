import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmailTemplateDefinition } from "@/lib/email-templates/types";

const HTML =
  "<!doctype html><style>@media (prefers-color-scheme: dark) { .a { color: #fff; } }</style><p>Bonjour</p>";

const templates = vi.hoisted(() => ({ list: [] as EmailTemplateDefinition[] }));
vi.mock("@/lib/email-templates/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email-templates/registry")>()),
  get EMAIL_TEMPLATES() {
    return templates.list;
  },
}));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

import { getEmailDesigns } from "./designs";

const definition = (overrides: Partial<EmailTemplateDefinition>): EmailTemplateDefinition => ({
  key: "alert",
  label: "Alerte",
  description: "Une alerte.",
  category: "alert",
  sender: "ALERT_EMAIL_FROM",
  level: "editable",
  ...overrides,
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("getEmailDesigns", () => {
  it("laisse le HTML tel quel en mode clair et applique les règles sombres sur demande", async () => {
    templates.list = [
      definition({
        sample: async () => [{ key: "v", label: "V", subject: "Objet", html: HTML, text: "texte" }],
      }),
    ];

    const light = await getEmailDesigns({ dark: false });
    const dark = await getEmailDesigns({ dark: true });

    expect(light.dark).toBe(false);
    expect(light.templates[0].variants[0].html).toBe(HTML);
    expect(dark.dark).toBe(true);
    expect(dark.templates[0].variants[0].html).toContain("@media all {");
    expect(dark.templates[0].variants[0].html).not.toContain("prefers-color-scheme: dark");
  });

  it("n'envoie le texte brut que pour un email sans HTML", async () => {
    templates.list = [
      definition({
        sample: async () => [
          { key: "h", label: "H", subject: "S", html: HTML, text: "doublon inutile" },
          { key: "t", label: "T", subject: "S", html: null, text: "texte seul" },
        ],
      }),
    ];
    const { templates: result } = await getEmailDesigns({ dark: false });
    expect(result[0].variants.map((variant) => variant.text)).toEqual(["", "texte seul"]);
  });

  it("affiche l'expéditeur effectif après repli, ou signale qu'il manque", async () => {
    vi.stubEnv("ALERT_EMAIL_FROM", "Immojudis <alertes@immojudis.com>");
    vi.stubEnv("TRANSACTIONAL_EMAIL_FROM", "");
    vi.stubEnv("CONTACT_EMAIL_FROM", "");
    templates.list = [
      definition({ key: "a", sender: "ALERT_EMAIL_FROM" }),
      definition({ key: "b", sender: "TRANSACTIONAL_EMAIL_FROM" }),
      definition({ key: "c", sender: "CONTACT_EMAIL_FROM" }),
      definition({ key: "d", sender: null, level: "supabase" }),
    ];
    const { templates: result } = await getEmailDesigns({ dark: false });
    expect(result.map((template) => template.badges[1])).toEqual([
      { text: "Expéditeur : Immojudis <alertes@immojudis.com>", tone: "neutral" },
      { text: "Expéditeur : Immojudis <alertes@immojudis.com>", tone: "neutral" },
      { text: "Expéditeur : CONTACT_EMAIL_FROM non configuré", tone: "bad" },
      { text: "Expéditeur : SMTP de Supabase", tone: "neutral" },
    ]);
    expect(result.map((template) => template.notice !== undefined)).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });

  it("n'écarte pas les autres gabarits quand un aperçu échoue, et ne cite pas l'erreur", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    templates.list = [
      definition({
        key: "casse",
        sample: async () => {
          throw new Error("détail interne avec un@email.test");
        },
      }),
      definition({
        key: "ok",
        sample: async () => [{ key: "v", label: "V", subject: "S", html: HTML, text: "" }],
      }),
      definition({ key: "sans-apercu", sampleUnavailable: "Pas d'aperçu." }),
    ];
    const { templates: result } = await getEmailDesigns({ dark: false });

    expect(result.map((template) => [template.key, template.variants.length])).toEqual([
      ["casse", 0],
      ["ok", 1],
      ["sans-apercu", 0],
    ]);
    expect(result[0].unavailable).toContain("a échoué");
    expect(JSON.stringify(result)).not.toContain("un@email.test");
    expect(result[2].unavailable).toBe("Pas d'aperçu.");
  });
});
