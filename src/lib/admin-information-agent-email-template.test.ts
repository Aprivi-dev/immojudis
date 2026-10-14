import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  rpc: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuthContext: vi.fn(async () => ({ isAdmin: true, userId: "admin-1" })),
}));

vi.mock("@/integrations/supabase/client.server", () => {
  class Query {
    private status: string | null = null;
    private id: string | null = null;
    select() {
      return this;
    }
    eq(column: string, value: string) {
      if (column === "status") this.status = value;
      if (column === "id") this.id = value;
      return this;
    }
    order() {
      return this;
    }
    limit() {
      return this;
    }
    private matching() {
      return mocks.rows.filter(
        (row) => (!this.status || row.status === this.status) && (!this.id || row.id === this.id),
      );
    }
    async maybeSingle() {
      return { data: this.matching()[0] ?? null, error: null };
    }
    async single() {
      return { data: this.matching()[0] ?? null, error: null };
    }
    then(onFulfilled: (value: { data: unknown; error: null }) => unknown) {
      return Promise.resolve({ data: this.matching(), error: null }).then(onFulfilled);
    }
  }
  return {
    supabaseAdmin: { from: () => new Query(), rpc: mocks.rpc },
  };
});

import {
  getAdminInformationAgentEmailTemplateWorkspace,
  getPublishedInformationAgentEmailTemplate,
  runAdminInformationAgentEmailTemplateAction,
} from "@/lib/admin-information-agent-email-template";
import {
  DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
  INFORMATION_AGENT_EMAIL_TEMPLATE_REVISION,
  MIN_COMPLIANT_TEMPLATE_REVISION,
} from "@/lib/information-agent-email-template";

function row(overrides: Record<string, unknown>) {
  const base = DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE;
  return {
    id: "template-1",
    revision: 4,
    status: "published",
    name: "Ancien modèle",
    subject_template: base.subjectTemplate,
    blocks: base.blocks.map((block) =>
      block.id === "identity"
        ? {
            ...block,
            content:
              "Immojudis est un service indépendant qui aide les acquéreurs. Créez un compte professionnel sur immojudis.com.",
          }
        : block,
    ),
    created_at: "2026-10-04T10:00:00Z",
    updated_at: "2026-10-04T10:00:00Z",
    published_at: "2026-10-04T10:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  mocks.rows = [];
  mocks.rpc.mockReset();
  mocks.rpc.mockResolvedValue({ error: null });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("modèle de message publié en base", () => {
  it("la révision minimale est celle du modèle du code", () => {
    expect(MIN_COMPLIANT_TEMPLATE_REVISION).toBe(INFORMATION_AGENT_EMAIL_TEMPLATE_REVISION);
    expect(MIN_COMPLIANT_TEMPLATE_REVISION).toBe(7);
  });

  it("ignore un modèle publié antérieur à la mise en conformité et retombe sur le modèle du code", async () => {
    mocks.rows = [row({ revision: 4 })];
    const template = await getPublishedInformationAgentEmailTemplate();
    expect(template.id).toBeNull();
    expect(template.revision).toBe(INFORMATION_AGENT_EMAIL_TEMPLATE_REVISION);
    expect(template.content).toEqual(DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE);
    expect(JSON.stringify(template.content)).not.toContain("service indépendant");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("utilise un modèle publié à partir de la révision minimale", async () => {
    mocks.rows = [row({ revision: 7, name: "Modèle personnalisé v7" })];
    const template = await getPublishedInformationAgentEmailTemplate();
    expect(template.id).toBe("template-1");
    expect(template.revision).toBe(7);
    expect(template.content.name).toBe("Modèle personnalisé v7");
  });

  it("l'éditeur signale que le modèle publié antérieur est ignoré", async () => {
    mocks.rows = [row({ revision: 4 })];
    const workspace = await getAdminInformationAgentEmailTemplateWorkspace("token");
    expect(workspace.publishedIgnored).toBe(true);
    expect(workspace.minCompliantRevision).toBe(7);
    expect(workspace.fallback.revision).toBe(7);
    expect(workspace.fallback.name).toBe(DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE.name);

    mocks.rows = [row({ revision: 8 })];
    expect((await getAdminInformationAgentEmailTemplateWorkspace("token")).publishedIgnored).toBe(
      false,
    );
  });
});

describe("publication d'un modèle", () => {
  const draft = (blockContent: string, revision = 8) =>
    row({
      id: "draft-1",
      revision,
      status: "draft",
      name: "Brouillon",
      published_at: null,
      blocks: DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE.blocks.map((block) =>
        block.id === "closing" ? { ...block, content: blockContent } : block,
      ),
    });

  it("refuse de publier un modèle qui contient une mention commerciale", async () => {
    mocks.rows = [
      row({ revision: 7 }),
      draft("Découvrez nos offres sur https://immojudis.com/offres"),
    ];
    await expect(
      runAdminInformationAgentEmailTemplateAction({
        authToken: "token",
        input: { action: "publish", draftId: "draft-1", publicationConfirmed: true },
      }),
    ).rejects.toThrow("aucune mention commerciale");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("refuse de publier un brouillon antérieur à la révision minimale", async () => {
    mocks.rows = [row({ revision: 7 }), draft("Bien cordialement,\nL’équipe Immojudis", 3)];
    await expect(
      runAdminInformationAgentEmailTemplateAction({
        authToken: "token",
        input: { action: "publish", draftId: "draft-1", publicationConfirmed: true },
      }),
    ).rejects.toThrow("antérieur à la révision 7");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("publie un modèle conforme", async () => {
    mocks.rows = [row({ revision: 7 }), draft("Bien cordialement,\nL’équipe Immojudis")];
    await runAdminInformationAgentEmailTemplateAction({
      authToken: "token",
      input: { action: "publish", draftId: "draft-1", publicationConfirmed: true },
    });
    expect(mocks.rpc).toHaveBeenCalledWith("publish_information_agent_email_template", {
      p_admin_id: "admin-1",
      p_template_id: "draft-1",
    });
  });
});
