import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUserById: vi.fn(),
  from: vi.fn(),
  upsert: vi.fn(),
  sendResendEmail: vi.fn(),
  resolveConfig: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, auth: { admin: { getUserById: mocks.getUserById } } },
}));
vi.mock("@/lib/email-alerts", () => ({
  resolveEmailAlertDeliveryConfig: mocks.resolveConfig,
  sendResendEmail: mocks.sendResendEmail,
}));

import { LEGAL_DOCUMENTS } from "@/lib/legal-documents";
import { sendCommercialConfirmation } from "@/lib/commercial-acceptance";

const ACCEPTANCE_ID = "22222222-2222-4222-8222-222222222222";
const OLD_TERMS_SHA = "a".repeat(64);
const OLD_PRIVACY_SHA = "b".repeat(64);

function table(result: { data: unknown; error?: unknown }) {
  const builder = {
    select: vi.fn((_columns?: string) => builder),
    eq: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => ({ data: result.data, error: result.error ?? null })),
  };
  return builder;
}

describe("sendCommercialConfirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserById.mockResolvedValue({
      data: { user: { email: "client@example.test" } },
      error: null,
    });
    mocks.resolveConfig.mockReturnValue({
      configured: true,
      missing: [],
      apiKey: "re_test",
      from: "Immojudis <contact@example.test>",
      appUrl: "https://immojudis.example",
    });
    mocks.sendResendEmail.mockResolvedValue({ id: "email_1" });
    mocks.upsert.mockResolvedValue({ error: null });
  });

  function wire(acceptance: Record<string, unknown>) {
    mocks.from.mockImplementation((name: string) => {
      if (name === "commercial_confirmation_deliveries") {
        return { ...table({ data: null }), upsert: mocks.upsert };
      }
      if (name === "commercial_acceptances") return table({ data: acceptance });
      return table({ data: null });
    });
  }

  it("cite la version et l'empreinte enregistrées avec l'acceptation, pas la version courante", async () => {
    // Acceptation signée sous la version « .1 », relancée alors que la version en vigueur est « .2 ».
    expect(LEGAL_DOCUMENTS.terms.version).not.toBe("2026-10-13.1");
    wire({
      offer_code: "analyse_30_days",
      amount_cents: 1900,
      currency: "eur",
      evidence: {},
      terms_version: "2026-10-13.1",
      terms_sha256: OLD_TERMS_SHA,
      privacy_version: "2026-10-13.1",
      privacy_sha256: OLD_PRIVACY_SHA,
    });

    const outcome = await sendCommercialConfirmation({
      acceptanceId: ACCEPTANCE_ID,
      checkoutSessionId: "cs_test_1",
      userId: "11111111-1111-4111-8111-111111111111",
      paidAt: "2026-10-13T10:00:00.000Z",
    });

    expect(outcome).toBe("sent");
    const { text, html } = mocks.sendResendEmail.mock.calls[0]![0].message;
    expect(text).toContain("Conditions acceptées : version 2026-10-13.1");
    expect(text).toContain("Politique de confidentialité : version 2026-10-13.1");
    expect(text).toContain(`Empreinte SHA-256 des conditions acceptées : ${OLD_TERMS_SHA}`);
    expect(text).not.toContain(LEGAL_DOCUMENTS.terms.version);
    expect(text).not.toContain(LEGAL_DOCUMENTS.terms.sha256);
    expect(html).toContain("Conditions version 2026-10-13.1");
    expect(html).toContain(OLD_TERMS_SHA);
    expect(html).not.toContain(LEGAL_DOCUMENTS.terms.sha256);
  });

  it("lit ces quatre colonnes de commercial_acceptances", async () => {
    const acceptances = table({
      data: {
        offer_code: "analyse_30_days",
        evidence: {},
        terms_version: LEGAL_DOCUMENTS.terms.version,
        terms_sha256: LEGAL_DOCUMENTS.terms.sha256,
        privacy_version: LEGAL_DOCUMENTS.privacy.version,
        privacy_sha256: LEGAL_DOCUMENTS.privacy.sha256,
      },
    });
    mocks.from.mockImplementation((name: string) =>
      name === "commercial_confirmation_deliveries"
        ? { ...table({ data: null }), upsert: mocks.upsert }
        : name === "commercial_acceptances"
          ? acceptances
          : table({ data: null }),
    );
    await sendCommercialConfirmation({
      acceptanceId: ACCEPTANCE_ID,
      checkoutSessionId: "cs_test_2",
      userId: "11111111-1111-4111-8111-111111111111",
      paidAt: "2026-10-13T10:00:00.000Z",
    });
    const columns = String(acceptances.select.mock.calls[0]![0]);
    for (const column of ["terms_version", "terms_sha256", "privacy_version", "privacy_sha256"]) {
      expect(columns).toContain(column);
    }
  });
});
