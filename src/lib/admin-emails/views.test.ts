import { describe, expect, it } from "vitest";
import type { EmailAddressesReport } from "./addresses";
import { buildAddressesView, buildTemplatesView, type EmailViewSection } from "./views";

const report = (overrides: Partial<EmailAddressesReport> = {}): EmailAddressesReport => ({
  checkedAt: "2026-11-02T10:00:00.000Z",
  addresses: [
    {
      variable: "ALERT_EMAIL_FROM",
      label: "Expéditeur des alertes",
      value: "Immojudis <alertes@immojudis.com>",
      origin: "configured",
      domain: "immojudis.com",
      usedBy: ["Alerte de recherche", "Rappel d’audience"],
    },
    {
      variable: "TRANSACTIONAL_EMAIL_FROM",
      label: "Expéditeur de la facturation",
      value: "Immojudis <alertes@immojudis.com>",
      origin: "fallback",
      fallbackFrom: "ALERT_EMAIL_FROM",
      domain: "immojudis.com",
      usedBy: [],
    },
    {
      variable: "CONTACT_EMAIL_FROM",
      label: "Expéditeur du contact",
      value: null,
      origin: "missing",
      consequence: "Le formulaire de contact répond qu’il est indisponible.",
      domain: null,
      usedBy: [],
    },
  ],
  secrets: [
    { name: "RESEND_API_KEY", configured: true, purpose: "Envoi" },
    { name: "RESEND_WEBHOOK_SECRET", configured: false, purpose: "Réponses" },
  ],
  resend: {
    ok: true,
    domains: [
      {
        name: "immojudis.com",
        status: "verified",
        region: "eu-west-1",
        sending: true,
        receiving: false,
        records: [
          { kind: "DKIM", type: "CNAME", name: "k", status: "verified" },
          { kind: "SPF", type: "TXT", name: "send", status: "pending" },
        ],
      },
    ],
  },
  webhooks: {
    ok: true,
    items: [
      {
        label: "Rebonds et plaintes",
        path: "/api/webhooks/resend/account-emails",
        secretConfigured: true,
        state: "events_missing",
        missingEvents: ["email.complained"],
      },
    ],
  },
  dns: [
    {
      domain: "immojudis.com",
      dmarc: { status: "absent" },
      spf: { status: "present", value: "v=spf1 ~all" },
    },
    {
      domain: "reponses.immojudis.com",
      dmarc: { status: "present", value: "v=DMARC1; p=none", inheritedFrom: "immojudis.com" },
      spf: { status: "error" },
      mx: { status: "present", value: ["inbound-smtp.eu-west-1.amazonaws.com"] },
    },
  ],
  dmarcRecommended: "v=DMARC1; p=none; rua=mailto:contact@immojudis.com",
  alerts: [{ id: "a1", severity: "error", message: "Aucun DMARC publié pour immojudis.com." }],
  ...overrides,
});

const section = (sections: EmailViewSection[], title: string) =>
  sections.find((candidate) => candidate.title === title)!;

describe("vue des adresses", () => {
  it("compose les expéditeurs effectifs avec leurs replis et leurs conséquences", () => {
    const { sections } = buildAddressesView(report());
    const items = section(sections, "Expéditeurs et adresses").items;

    expect(items[0]).toMatchObject({
      title: "Expéditeur des alertes",
      code: "ALERT_EMAIL_FROM",
      badges: [],
      lines: [
        { text: "Immojudis <alertes@immojudis.com>", mono: true },
        { text: "Utilisé par : Alerte de recherche, Rappel d’audience" },
      ],
    });
    expect(items[1].badges).toEqual([{ text: "Repli : ALERT_EMAIL_FROM", tone: "warn" }]);
    expect(items[2].badges).toEqual([{ text: "Non configuré", tone: "bad" }]);
    expect(items[2].lines).toEqual([
      { text: "Le formulaire de contact répond qu’il est indisponible.", bad: true },
    ]);
  });

  it("ne donne des secrets que « Renseigné » ou « Absent »", () => {
    const { sections } = buildAddressesView(report());
    expect(section(sections, "Secrets").items).toEqual([
      {
        title: "Envoi",
        code: "RESEND_API_KEY",
        badges: [{ text: "Renseigné", tone: "ok" }],
        lines: [],
      },
      {
        title: "Réponses",
        code: "RESEND_WEBHOOK_SECRET",
        badges: [{ text: "Absent", tone: "bad" }],
        lines: [],
      },
    ]);
  });

  it("met en rouge ce qui n'est pas vérifié chez Resend", () => {
    const [domain] = section(buildAddressesView(report()).sections, "Domaines chez Resend").items;
    expect(domain.badges).toEqual([
      { text: "verified", tone: "ok" },
      { text: "Envoi", tone: "neutral" },
    ]);
    expect(domain.lines).toEqual([
      { text: "DKIM (CNAME) : verified", bad: false },
      { text: "SPF (TXT) : pending", bad: true },
    ]);
  });

  it("donne DMARC absent en rouge avec la valeur recommandée, et distingue l'erreur de l'absence", () => {
    const items = section(
      buildAddressesView(report()).sections,
      "Vérification publique des DNS",
    ).items;
    expect(items[0].badges).toEqual([
      { text: "DMARC : absent", tone: "bad" },
      { text: "SPF : présent", tone: "ok" },
    ]);
    expect(items[0].lines).toEqual([
      { text: "Valeur recommandée pour DMARC :", bad: true },
      { text: "v=DMARC1; p=none; rua=mailto:contact@immojudis.com", mono: true },
    ]);
    expect(items[1].badges).toEqual([
      { text: "DMARC : présent", tone: "ok" },
      { text: "SPF : vérification impossible", tone: "warn" },
      { text: "MX (réception) : présent", tone: "ok" },
    ]);
    expect(items[1].lines).toContainEqual({ text: "Politique héritée de immojudis.com." });
  });

  it("indique l'état des webhooks et les évènements manquants", () => {
    const [hook] = section(buildAddressesView(report()).sections, "Webhooks").items;
    expect(hook.badges).toEqual([
      { text: "Évènements manquants", tone: "bad" },
      { text: "Secret de signature renseigné", tone: "ok" },
    ]);
    expect(hook.lines).toEqual([
      { text: "/api/webhooks/resend/account-emails", mono: true },
      { text: "Manquant : email.complained", bad: true },
    ]);
  });

  it("remplace une erreur Resend par une catégorie lisible, sans détail du fournisseur", () => {
    const { sections } = buildAddressesView(
      report({
        resend: { ok: false, failure: "missing_permission" },
        webhooks: { ok: false, failure: "rate_limited" },
      }),
    );
    expect(section(sections, "Domaines chez Resend").notice).toEqual({
      text: "La clé Resend n’a pas le droit de lire ces informations (clé limitée à l’envoi).",
      tone: "bad",
    });
    expect(section(sections, "Webhooks").notice?.text).toContain("limite le débit");
    expect(section(sections, "Webhooks").items).toEqual([]);
  });

  it("signale l'absence de domaine chez Resend", () => {
    const { sections } = buildAddressesView(report({ resend: { ok: true, domains: [] } }));
    expect(section(sections, "Domaines chez Resend").notice).toEqual({
      text: "Aucun domaine déclaré chez Resend.",
      tone: "warn",
    });
  });

  it("date la vérification à l'heure de Paris et rappelle que la boîte de contact est hors Resend", () => {
    const view = buildAddressesView(report());
    expect(view.footnote).toContain("Vérifié le 2 novembre 2026 à 11 h 00");
    expect(view.footnote).toContain("Google Workspace");
    expect(view.alerts).toEqual(["Aucun DMARC publié pour immojudis.com."]);
  });
});

describe("vue des modèles", () => {
  it("liste chaque modèle avec son niveau, sa catégorie et son expéditeur", () => {
    const view = buildTemplatesView([
      {
        key: "alert",
        label: "Alerte",
        description: "Une alerte.",
        category: "alert",
        sender: "ALERT_EMAIL_FROM",
        level: "editable",
        previewable: true,
      },
      {
        key: "auth_recovery",
        label: "Mot de passe",
        description: "Oublié.",
        category: null,
        sender: null,
        level: "supabase",
        previewable: true,
      },
    ]);
    expect(view.alerts).toEqual([]);
    expect(view.sections[0].items).toEqual([
      {
        title: "Alerte",
        code: "alert · ALERT_EMAIL_FROM",
        badges: [
          { text: "Textes éditables (bientôt)", tone: "warn" },
          { text: "Catégorie : alert", tone: "neutral" },
        ],
        lines: [{ text: "Une alerte." }],
      },
      {
        title: "Mot de passe",
        code: "auth_recovery · expéditeur hors environnement",
        badges: [
          { text: "Supabase", tone: "neutral" },
          { text: "Catégorie : aucune", tone: "neutral" },
        ],
        lines: [{ text: "Oublié." }],
      },
    ]);
  });
});
