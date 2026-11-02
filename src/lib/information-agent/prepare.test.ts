import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  create: vi.fn(),
  preview: vi.fn(),
  template: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from: mocks.from } }));
vi.mock("@/lib/admin-information-agent-email-template", () => ({
  getPublishedInformationAgentEmailTemplate: mocks.template,
}));
vi.mock("@/lib/information-agent/draft", () => ({
  createAdminInformationAgentDraft: mocks.create,
}));
vi.mock("@/lib/information-agent/preview", () => ({
  previewAdminInformationAgentMission: mocks.preview,
}));

import { prepareAdminInformationAgentDraft } from "@/lib/information-agent/prepare";

const auth = { isAdmin: true, userId: "admin-1" } as never;
const saleId = "11111111-1111-4111-8111-111111111111";

function row(id: string, revision: number) {
  return {
    id,
    case_id: null,
    sale_id: saleId,
    status: "draft",
    recipient_kind: "source_lawyer",
    recipient_name: "Maître Dupont",
    recipient_email: "dupont@cabinet-dupont.test",
    subject: "Demande de pièces",
    body_text: "Bonjour, pourriez-vous transmettre les pièces du dossier ?",
    question_keys: ["documents"],
    missing_information: ["documents"],
    failure_reason: null,
    metadata: { email_content_template_revision: revision },
    approved_at: null,
    sent_at: null,
    replied_at: null,
    created_at: "2026-11-02T09:00:00Z",
    updated_at: "2026-11-02T09:00:00Z",
  };
}

function editableDrafts(rows: unknown[]) {
  const query: Record<string, unknown> = {};
  for (const name of ["select", "eq", "in", "order"]) query[name] = () => query;
  query.limit = async () => ({ data: rows, error: null });
  mocks.from.mockReturnValue(query);
}

const createdMission = {
  ok: true as const,
  mission: {
    id: "new-mission",
    recipientEmail: "dupont@cabinet-dupont.test",
    recipientName: null,
    subject: "S",
    bodyText: "B",
  },
  gaps: [],
  inventory: [],
  facts: [],
};
const previewOk = {
  ok: true,
  preview: { html: "<p>x</p>" },
  blockers: [],
  fingerprint: "f".repeat(64),
};

describe("prepareAdminInformationAgentDraft : brouillon et aperçu en une réponse", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.template.mockResolvedValue({ id: "tpl", revision: 9, content: {} });
    mocks.create.mockResolvedValue(createdMission);
    mocks.preview.mockResolvedValue(previewOk);
  });

  it("crée le brouillon puis rend l'aperçu de ce brouillon, sans rien envoyer", async () => {
    editableDrafts([]);

    const response = await prepareAdminInformationAgentDraft({ auth, input: { saleId } });

    expect(mocks.create).toHaveBeenCalledWith({ auth, input: { saleId } });
    expect(mocks.preview).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ missionId: "new-mission", recipientOriginUrl: null }),
      }),
    );
    expect(response).toMatchObject({ reused: false, previewError: null, preview: previewOk });
  });

  it("réutilise l'unique brouillon modifiable à jour : il n'est ni recréé ni annulé", async () => {
    editableDrafts([row("existing", 9)]);

    const response = await prepareAdminInformationAgentDraft({ auth, input: { saleId } });

    expect(mocks.create).not.toHaveBeenCalled();
    expect(response.reused).toBe(true);
    expect(response.mission.id).toBe("existing");
    expect(mocks.preview).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          missionId: "existing",
          subject: "Demande de pièces",
          recipientEmail: "dupont@cabinet-dupont.test",
        }),
      }),
    );
  });

  it.each([
    ["révision du gabarit publié changée", [row("old", 8)], { saleId }],
    ["plusieurs brouillons : aucun n'est choisi au hasard", [row("a", 9), row("b", 9)], { saleId }],
    [
      "adresse demandée explicitement",
      [row("a", 9)],
      { saleId, recipientEmail: "autre@cabinet.test" },
    ],
    [
      "questions choisies par l'administrateur",
      [row("a", 9)],
      { saleId, questionKeys: ["documents"] as never },
    ],
  ])("crée un brouillon : %s", async (_name, rows, input) => {
    editableDrafts(rows);

    const response = await prepareAdminInformationAgentDraft({ auth, input });

    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(response.reused).toBe(false);
  });

  it("rend le brouillon même si l'aperçu échoue, et dit pourquoi", async () => {
    editableDrafts([]);
    mocks.preview.mockRejectedValue(new Error("Aperçu impossible"));

    const response = await prepareAdminInformationAgentDraft({ auth, input: { saleId } });

    expect(response.mission.id).toBe("new-mission");
    expect(response.preview).toBeNull();
    expect(response.previewError).toBe("Aperçu impossible");
  });

  it("refuse un compte qui n'est pas administrateur avant toute lecture", async () => {
    await expect(
      prepareAdminInformationAgentDraft({
        auth: { isAdmin: false, userId: "x" } as never,
        input: { saleId },
      }),
    ).rejects.toThrow("accès administrateur");
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
