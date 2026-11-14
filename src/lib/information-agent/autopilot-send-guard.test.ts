import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  excluded: vi.fn(),
  registry: vi.fn(),
  history: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: vi.fn(), rpc: vi.fn() },
}));
vi.mock("@/lib/information-agent/autopilot-settings", () => ({
  loadAutopilotSettings: mocks.settings,
  loadExcludedIdentityKeys: mocks.excluded,
}));
vi.mock("@/lib/information-agent/autopilot-facts", () => ({
  loadAutopilotRegistryFacts: mocks.registry,
  loadAutopilotHistoryFacts: mocks.history,
}));

import {
  assertAutopilotSendAllowed,
  AutopilotSendRefusedError,
} from "@/lib/information-agent/autopilot-send-guard";

const NOW = new Date("2026-11-03T09:30:00Z");
const base = {
  saleId: "sale-1",
  email: "Me.Dupont@cabinet-dupont.fr",
  identityKeys: ["lawyer|bordeaux|dupont jean"],
  recipientKind: "source_lawyer",
  addressOriginKind: "sale_listing" as string | null,
  courtFallback: false,
  now: NOW,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.settings.mockResolvedValue({
    mode: "live",
    allowLicitorDecoded: false,
    art14RuleEnabled: true,
    art14MaxAgeDays: 30,
  });
  mocks.excluded.mockResolvedValue(new Set());
  mocks.registry.mockResolvedValue({
    firstRecordedAt: "2026-10-25T10:00:00Z",
    observedAt: "2026-10-25T10:00:00Z",
    originKinds: ["sale_listing"],
    licitorDecoded: false,
  });
  mocks.history.mockResolvedValue({
    alreadyInformed: false,
    lastReplyAt: null,
    silentSendsInSixMonths: 0,
    lastSendAt: null,
  });
});

describe("revérification des règles du pilote juste avant l'envoi", () => {
  it("laisse passer l'avocat poursuivant de l'annonce quand rien n'a changé", async () => {
    await expect(assertAutopilotSendAllowed(base)).resolves.toBeUndefined();
  });

  it.each([
    [
      "pilote repassé hors du mode réel entre la sélection et l'envoi",
      () =>
        mocks.settings.mockResolvedValue({
          mode: "simulation",
          allowLicitorDecoded: false,
          art14RuleEnabled: true,
          art14MaxAgeDays: 30,
        }),
      {},
      "not_live",
    ],
    ["greffe de secours", () => undefined, { courtFallback: true }, "court_registry_refused"],
    [
      "origine résolue autre que l'annonce",
      () => undefined,
      { addressOriginKind: "admin_entry" },
      "source_not_sale_listing",
    ],
    [
      "origine absente : aucune valeur par défaut",
      () => undefined,
      { addressOriginKind: null },
      "source_not_sale_listing",
    ],
    [
      "une autre origine existe pour cette adresse et cette vente",
      () =>
        mocks.registry.mockResolvedValue({
          firstRecordedAt: "2026-10-25T10:00:00Z",
          observedAt: "2026-10-25T10:00:00Z",
          originKinds: ["sale_listing", "agent_search"],
          licitorDecoded: false,
        }),
      {},
      "source_not_sale_listing",
    ],
    [
      "destinataire qui n'est pas un avocat",
      () => undefined,
      { recipientKind: "source_contact" },
      "role_not_lawyer",
    ],
    [
      "messagerie grand public",
      () => undefined,
      { email: "me.dupont@gmail.com" },
      "consumer_domain",
    ],
    [
      "sous-domaine d'une messagerie grand public",
      () => undefined,
      { email: "me.dupont@smtp.orange.fr" },
      "consumer_domain",
    ],
    [
      "identité exclue depuis la sélection",
      () => mocks.excluded.mockResolvedValue(new Set(["lawyer|bordeaux|dupont jean"])),
      {},
      "identity_excluded",
    ],
    [
      "réponse reçue depuis la sélection : pause de 90 jours",
      () =>
        mocks.history.mockResolvedValue({
          alreadyInformed: true,
          lastReplyAt: "2026-10-30T10:00:00Z",
          silentSendsInSixMonths: 0,
          lastSendAt: "2026-10-01T10:00:00Z",
        }),
      {},
      "reply_pause",
    ],
    [
      "deux envois sans réponse : pause de 6 mois",
      () =>
        mocks.history.mockResolvedValue({
          alreadyInformed: true,
          lastReplyAt: null,
          silentSendsInSixMonths: 2,
          lastSendAt: "2026-09-01T10:00:00Z",
        }),
      {},
      "silence_pause",
    ],
    [
      "date de relevé absente",
      () =>
        mocks.registry.mockResolvedValue({
          firstRecordedAt: "2026-10-25T10:00:00Z",
          observedAt: null,
          originKinds: ["sale_listing"],
          licitorDecoded: false,
        }),
      {},
      "address_stale",
    ],
    [
      "article 14 : premier relevé trop ancien, personne non informée",
      () =>
        mocks.registry.mockResolvedValue({
          firstRecordedAt: "2026-08-01T10:00:00Z",
          observedAt: "2026-10-25T10:00:00Z",
          originKinds: ["sale_listing"],
          licitorDecoded: false,
        }),
      {},
      "art14_window_expired",
    ],
    [
      "article 14 : date du premier relevé absente",
      () =>
        mocks.registry.mockResolvedValue({
          firstRecordedAt: null,
          observedAt: "2026-10-25T10:00:00Z",
          originKinds: ["sale_listing"],
          licitorDecoded: false,
        }),
      {},
      "art14_unknown",
    ],
    [
      "notaire ou service de l'État lus dans l'annonce : le pilote reste réservé à l'avocat",
      () => undefined,
      { recipientKind: "source_contact", identityKeys: ["notary|bordeaux|martin jean"] },
      "role_not_lawyer",
    ],
    [
      "adresse générique sans identité du professionnel : la clé de structure ne suffit pas",
      () => undefined,
      { identityKeys: ["structure|domain|cabinet-dupont.fr"] },
      "identity_incomplete",
    ],
    [
      "adresse Licitor décodée sans réglage",
      () =>
        mocks.registry.mockResolvedValue({
          firstRecordedAt: "2026-10-25T10:00:00Z",
          observedAt: "2026-10-25T10:00:00Z",
          originKinds: ["sale_listing"],
          licitorDecoded: true,
        }),
      {},
      "licitor_decoded_refused",
    ],
  ])("refuse : %s", async (_label, arrange, overrides, code) => {
    arrange();
    const check = assertAutopilotSendAllowed({ ...base, ...overrides });
    await expect(check).rejects.toThrow(`(${code})`);
    // Refus dédié : l'exécuteur le journalise à part, jamais comme une erreur d'API.
    await expect(check).rejects.toBeInstanceOf(AutopilotSendRefusedError);
    await expect(check).rejects.toMatchObject({ refusal: code, status: 409 });
  });
});
