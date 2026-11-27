import { describe, expect, it, vi } from "vitest";
import {
  INFORMATION_AGENT_AUTOMATIC_SEND_SEARCHED_ADDRESS_MESSAGE,
  informationAgentLegalFooterLines,
  informationAgentLegalFooterSections,
  type InformationAgentAddressOrigin,
  type InformationAgentLegalFooter,
} from "@/lib/information-agent-compliance";
import { findInformationAgentCommercialMentions } from "@/lib/information-agent-commercial-guard";
import {
  DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
  renderInformationAgentEmailContent,
} from "@/lib/information-agent-email-template";
import { buildInformationAgentLegalFooter } from "@/lib/information-agent/message-guards";
import { renderInformationRequestEmail } from "../../emails/information-request";

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: vi.fn() },
}));

/**
 * Pied d'un message du pilote automatique (relecture juridique du 23/11/2026, section 2.2) : rubrique « Envoi
 * automatique » juste après « Pourquoi ce message ? », compléments de la conservation et de l'opposition. Jamais la
 * mention « relu et validé par un membre de l'équipe » sur un envoi automatique, jamais la rubrique automatique sur
 * un envoi manuel.
 */
const APP_URL = "https://immojudis.example";
const REVIEWED = /relu et validé par un membre de l’équipe/;
const AUTOMATIC_SENTENCES = [
  "Ce message a été préparé et envoyé automatiquement par un outil d’Immojudis, sans relecture par un membre de l’équipe avant son envoi.",
  "L’outil n’écrit qu’à l’avocat dont l’adresse figure dans l’annonce publique de la vente, et ne pose que des questions d’une liste fixe sur les informations absentes de l’annonce.",
  "Le texte est un modèle fixe : il n’est pas rédigé par une IA.",
  "Cet envoi ne produit aucun effet juridique à votre égard et ne vous affecte d’aucune autre manière importante : ce n’est pas une décision prise à votre sujet au sens de l’article 22 du RGPD. Répondre est facultatif ; ne pas répondre n’a aucune conséquence pour vous.",
  // Décision du propriétaire du 27/11/2026 : publication automatique de certaines informations, sans relecture
  // préalable (la phrase disait « rien n’est publié automatiquement »).
  "Vos réponses sont lues avec l’aide d’un outil d’IA. Certaines informations d’une réponse par email (par exemple une surface ou un nombre de pièces) peuvent être reprises sur la fiche telles que vous les avez écrites, sur décision de cet outil et sans relecture préalable par un membre de l’équipe ; les autres sont vérifiées par un membre de l’équipe avant toute mise à jour de la fiche. Vous pouvez demander le retrait d’une information à tout moment.",
  "Si ce message ne vous concerne pas, répondez « mauvais destinataire » : l’envoi automatique ne vous écrira plus pendant 24 mois, et il est arrêté jusqu’à vérification.",
];
const RETENTION_COMPLEMENT =
  "Si vous signalez une erreur de destinataire, votre identité professionnelle est conservée 24 mois, à cette seule fin. Le journal de l’envoi automatique ne contient pas votre adresse.";
const OBJECTION_COMPLEMENT =
  "Le lien « Ne plus être contacté » ouvre une page où un seul bouton enregistre votre opposition, sans compte ni motif. Si votre messagerie affiche un bouton « Se désinscrire », il l’enregistre directement. Vous pouvez aussi répondre « STOP ».";

const footer = (
  overrides: Partial<InformationAgentLegalFooter> = {},
): InformationAgentLegalFooter => ({
  controllerName: "Immojudis SAS",
  controllerAddress: "1 rue de la Paix, 75002 Paris",
  contactEmail: "contact@immojudis.example",
  saleReference: "Appartement T3 à Bordeaux",
  addressOrigin:
    "Votre adresse professionnelle figure dans l’annonce publique de cette vente sur Licitor (https://www.licitor.com/annonce/1), consultée le 14/10/2026.",
  addressOriginUrl: "https://www.licitor.com/annonce/1",
  replyDisplay: "source_lawyer",
  aiProvider: { id: "replicate", name: "Replicate", country: "États-Unis" },
  privacyUrl: `${APP_URL}/privacy`,
  optOutUrl: `${APP_URL}/api/information-agent/opt-out?e=abc&t=def`,
  ...overrides,
});

const section = (sections: ReturnType<typeof informationAgentLegalFooterSections>, label: string) =>
  sections.find((item) => item.label === label)?.text ?? "";

describe("pied d'un envoi automatique du pilote", () => {
  it("ajoute la rubrique « Envoi automatique » juste après « Pourquoi ce message ? », avec ses six phrases", () => {
    const sections = informationAgentLegalFooterSections(footer({ automaticSend: true }));
    expect(sections.map((item) => item.label).slice(0, 3)).toEqual([
      "Pourquoi ce message ?",
      "Envoi automatique :",
      "Vos données :",
    ]);
    expect(section(sections, "Envoi automatique :")).toBe(AUTOMATIC_SENTENCES.join(" "));
  });

  it("complète la conservation et l'opposition, sans rien retirer du texte commun", () => {
    const manual = informationAgentLegalFooterSections(footer());
    const automatic = informationAgentLegalFooterSections(footer({ automaticSend: true }));
    expect(section(automatic, "Conservation :")).toBe(
      `${section(manual, "Conservation :")} ${RETENTION_COMPLEMENT}`,
    );
    expect(section(automatic, "Opposition :")).toBe(
      `${section(manual, "Opposition :")} ${OBJECTION_COMPLEMENT}`,
    );
    // Les autres rubriques sont identiques (Destinataires et le prestataire d'IA compris).
    for (const label of [
      "Pourquoi ce message ?",
      "Vos données :",
      "Destinataires :",
      "Vos droits :",
    ]) {
      expect(section(automatic, label), label).toBe(section(manual, label));
    }
  });

  it("garde la portée de l'opposition d'une structure après le complément automatique", () => {
    const text = section(
      informationAgentLegalFooterSections(
        footer({ automaticSend: true, structureOpposition: "law_firm" }),
      ),
      "Opposition :",
    );
    expect(text.indexOf(OBJECTION_COMPLEMENT)).toBeGreaterThan(0);
    expect(text.indexOf(OBJECTION_COMPLEMENT)).toBeLessThan(text.indexOf("Si vous vous opposez"));
  });

  it("n'affiche jamais « relu et validé par un membre de l'équipe » sur un envoi automatique", async () => {
    const lines = informationAgentLegalFooterLines(footer({ automaticSend: true })).join("\n");
    expect(lines).not.toMatch(REVIEWED);
    // Une adresse retrouvée par recherche porte cette mention : avec un envoi automatique, le pied refuse.
    expect(() =>
      informationAgentLegalFooterSections(footer({ automaticSend: true, automatedSearch: true })),
    ).toThrow(INFORMATION_AGENT_AUTOMATIC_SEND_SEARCHED_ADDRESS_MESSAGE);
    const email = await renderAutomatic(true);
    for (const output of [email.html, email.text]) expect(output).not.toMatch(REVIEWED);
  });

  it("n'affiche jamais la rubrique automatique ni ses compléments sur un envoi manuel", async () => {
    for (const manual of [
      footer(),
      footer({ automaticSend: false }),
      footer({ automatedSearch: true }),
    ]) {
      const lines = informationAgentLegalFooterLines(manual).join("\n");
      expect(lines).not.toContain("Envoi automatique :");
      expect(lines).not.toContain(AUTOMATIC_SENTENCES[0]);
      expect(lines).not.toContain(RETENTION_COMPLEMENT);
      expect(lines).not.toContain(OBJECTION_COMPLEMENT);
    }
    const email = await renderAutomatic(false);
    for (const output of [email.html, email.text]) {
      expect(output).not.toContain("Envoi automatique");
      expect(output).not.toContain("envoyé automatiquement");
    }
  });

  it("le message automatique rendu (HTML et texte) passe le contrôle commercial", async () => {
    const email = await renderAutomatic(true);
    for (const output of [email.html, email.text]) {
      expect(
        findInformationAgentCommercialMentions(output, {
          appOrigin: APP_URL,
          allowedUrls: ["https://www.licitor.com/annonce/1"],
          ignore: ["Appartement T3 à Bordeaux"],
        }),
      ).toEqual([]);
      expect(output).toContain("Envoi automatique");
      expect(output).toContain("au sens de l’article 22 du RGPD");
    }
  });
});

describe("construction du pied : seuls l'envoi et l'aperçu du pilote posent l'indicateur", () => {
  const env = {
    NEXT_PUBLIC_LEGAL_ENTITY_NAME: "Immojudis SAS",
    NEXT_PUBLIC_LEGAL_ENTITY_ADDRESS: "1 rue de la Paix, 75002 Paris",
    NEXT_PUBLIC_LEGAL_CONTACT_EMAIL: "contact@immojudis.example",
    INFORMATION_AGENT_PORTAL_SECRET: "portal-secret-that-is-at-least-32-characters-long",
  };
  const origin = (automated: boolean): InformationAgentAddressOrigin => ({
    text: "Origine.",
    url: null,
    automated,
  });

  it("absent par défaut, posé seulement sur demande", () => {
    const base = { appUrl: APP_URL, email: "me.dupont@cabinet.example", env };
    expect(
      buildInformationAgentLegalFooter({ ...base, addressOrigin: origin(false) }).automaticSend,
    ).toBe(false);
    expect(
      buildInformationAgentLegalFooter({
        ...base,
        addressOrigin: origin(false),
        automaticSend: true,
      }).automaticSend,
    ).toBe(true);
  });

  it("refuse un envoi automatique à une adresse retrouvée par recherche ; en aperçu, c'est un blocage", () => {
    const base = { appUrl: APP_URL, email: "me.dupont@cabinet.example", env, automaticSend: true };
    expect(() =>
      buildInformationAgentLegalFooter({ ...base, addressOrigin: origin(true) }),
    ).toThrow(INFORMATION_AGENT_AUTOMATIC_SEND_SEARCHED_ADDRESS_MESSAGE);
    const blockers: string[] = [];
    const previewed = buildInformationAgentLegalFooter({
      ...base,
      addressOrigin: origin(true),
      preview: { blockers },
    });
    expect(blockers).toContain(INFORMATION_AGENT_AUTOMATIC_SEND_SEARCHED_ADDRESS_MESSAGE);
    expect(previewed.automaticSend).toBe(false);
  });

  it("l'envoi et l'aperçu passent l'indicateur depuis le déclencheur du pilote, et eux seuls", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const path = await import("node:path");
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const child = path.join(dir, entry);
        if (statSync(child).isDirectory()) return walk(child);
        return /\.tsx?$/.test(entry) && !/\.test\./.test(entry) ? [child] : [];
      });
    const setters = walk(path.join(process.cwd(), "src"))
      .filter((file) => /\bautomaticSend:\s*Boolean\(trigger\)/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(process.cwd(), file))
      .sort();
    expect(setters).toEqual([
      "src/lib/information-agent/preview.ts",
      "src/lib/information-agent/send.ts",
    ]);
  });
});

async function renderAutomatic(automaticSend: boolean) {
  const { bodyText, subject } = renderInformationAgentEmailContent({
    template: DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
    values: {
      recipient_name: "Maître Dupont",
      salutation: "Bonjour Maître Dupont,",
      sale_title: "Appartement T3 à Bordeaux",
      sale_subject_title: "Appartement T3 à Bordeaux",
      sale_reference: "Appartement T3 à Bordeaux",
      location: "33000 Bordeaux",
      tribunal: "Tribunal judiciaire de Bordeaux",
      hearing_date: "14 septembre 2026",
      hearing_line: "Audience annoncée : 14 septembre 2026",
      subject_date: "audience du 14/09/2026",
      starting_price: "85 000 €",
      price_line: "Mise à prix annoncée : 85 000 €",
      questions: "- Pourriez-vous indiquer où consulter le cahier des conditions de vente ?",
    },
  });
  return renderInformationRequestEmail({
    subject,
    bodyText,
    replyTo: "enquete+jeton@reponses.immojudis.example",
    caseReference: "IJ-ABC123",
    appUrl: APP_URL,
    contributionUrl: `${APP_URL}/contribuer/jeton-prive`,
    legalFooter: footer({ automaticSend }),
  });
}
