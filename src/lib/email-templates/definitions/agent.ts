import { INFORMATION_AGENT_OPT_OUT_PATH } from "@/lib/information-agent-link-paths";
import { INFORMATION_AGENT_COURT_REGISTRY_FALLBACK } from "@/lib/information-agent/court-registry-fallback";
import { SAMPLE_APP_URL, SAMPLE_SALE_A } from "../samples";
import type { EmailSampleVariant, EmailTemplateDefinition } from "../types";

/**
 * Demandes d'information de l'agent, envoyées à des professionnels (avocats, greffes) et non aux
 * comptes. Expéditeur : `INFORMATION_AGENT_EMAIL_FROM`, sans repli. Le texte et les blocs de l'agent se
 * règlent dans `/admin/agent-ia` (éditeur du template) : ils restent en lecture seule ici.
 */

const CONTRIBUTION_URL = `${SAMPLE_APP_URL}/contribuer/mission#jeton-prive`;
const OPT_OUT_URL = `${SAMPLE_APP_URL}${INFORMATION_AGENT_OPT_OUT_PATH}?e=exemple&t=${"a".repeat(64)}`;
const REPLY_TO = "enquete+exemple@reponses.immojudis.com";

const SAMPLE_SALE = {
  id: SAMPLE_SALE_A,
  title: "Appartement T3",
  property_type: "apartment",
  address: "12 rue du Palais",
  city: "Bordeaux",
  tribunal: "Tribunal judiciaire de Bordeaux",
  postal_code: "33000",
  sale_date: "2026-12-10T10:00:00Z",
  starting_price_eur: 85000,
  lawyer_name: "Maître Jean Dupont",
  lawyer_contact: "cabinet@exemple.test",
} as never;

async function renderRequest(options: {
  key: string;
  label: string;
  subject: string;
  bodyText: string;
  court: boolean;
}): Promise<EmailSampleVariant> {
  const [{ renderInformationRequestEmail }, { informationAgentAddressOrigin }] = await Promise.all([
    import("../../../../emails/information-request"),
    import("@/lib/information-agent-compliance"),
  ]);
  const origin = options.court
    ? informationAgentAddressOrigin({
        sourceKind: INFORMATION_AGENT_COURT_REGISTRY_FALLBACK,
        sourceName: "Tribunal judiciaire de Bordeaux",
        observedAt: "2026-10-14",
      })
    : informationAgentAddressOrigin({
        sourceKind: "sale_listing",
        sourceName: "Licitor",
        sourceUrl: "https://www.licitor.com/annonce/10/99/72/109972.html",
        observedAt: "2026-10-14",
      });
  const rendered = await renderInformationRequestEmail({
    subject: options.subject,
    bodyText: options.bodyText,
    replyTo: REPLY_TO,
    caseReference: "IJ-EXEMPLE",
    appUrl: SAMPLE_APP_URL,
    contributionUrl: CONTRIBUTION_URL,
    legalFooter: {
      controllerName: "Immojudis (exemple)",
      controllerAddress: "1 rue de l’Exemple, 33000 Bordeaux",
      contactEmail: "contact@immojudis.com",
      saleReference: "Appartement T3 — 33000 Bordeaux — Tribunal judiciaire de Bordeaux",
      addressOrigin: origin.text,
      addressOriginUrl: options.court
        ? null
        : "https://www.licitor.com/annonce/10/99/72/109972.html",
      courtRegistryDailyCap: options.court ? 3 : null,
      // Avocat poursuivant : le pied annonce l'affichage de ses réponses sur la fiche (J10).
      replyDisplay: options.court ? "court_registry" : "source_lawyer",
      aiProvider: { id: "replicate", name: "Replicate", country: "États-Unis" },
      privacyUrl: `${SAMPLE_APP_URL}/privacy`,
      optOutUrl: OPT_OUT_URL,
    },
  });
  return {
    key: options.key,
    label: options.label,
    subject: options.subject,
    html: rendered.html,
    text: rendered.text,
  };
}

const agentRequest: EmailTemplateDefinition = {
  key: "agent_request",
  label: "Demande à un avocat poursuivant",
  description: "Prise de contact de l’agent après relecture : questions sur une vente, pied RGPD.",
  category: "agent",
  sender: "INFORMATION_AGENT_EMAIL_FROM",
  level: "readonly",
  async sample() {
    const { buildInformationRequestDraft } = await import("@/lib/information-agent/draft");
    const draft = buildInformationRequestDraft({
      sale: SAMPLE_SALE,
      recipientName: "Maître Jean Dupont",
      questionKeys: ["documents", "visit", "occupancy", "diagnostics"],
      signatureName: null,
    });
    return [
      await renderRequest({
        key: "lawyer",
        label: "Avocat poursuivant",
        subject: draft.subject,
        bodyText: draft.bodyText,
        court: false,
      }),
    ];
  },
};

const agentCourtRegistry: EmailTemplateDefinition = {
  key: "agent_court_registry",
  label: "Demande à un greffe",
  description: "Repli quand l’avocat poursuivant est introuvable : demande au greffe du tribunal.",
  category: "agent",
  sender: "INFORMATION_AGENT_EMAIL_FROM",
  level: "readonly",
  async sample() {
    const [
      { buildInformationRequestDraft },
      { COURT_REGISTRY_EMAIL_TEMPLATE, COURT_REGISTRY_QUESTION },
    ] = await Promise.all([
      import("@/lib/information-agent/draft"),
      import("@/lib/information-agent/court-registry-template"),
    ]);
    const draft = buildInformationRequestDraft({
      sale: SAMPLE_SALE,
      recipientName: null,
      questionKeys: [],
      questionLines: [COURT_REGISTRY_QUESTION],
      template: COURT_REGISTRY_EMAIL_TEMPLATE,
    });
    return [
      await renderRequest({
        key: "court",
        label: "Greffe du tribunal",
        subject: draft.subject,
        bodyText: draft.bodyText,
        court: true,
      }),
    ];
  },
};

export const AGENT_EMAIL_TEMPLATES: readonly EmailTemplateDefinition[] = [
  agentRequest,
  agentCourtRegistry,
];
