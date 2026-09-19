// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
  INFORMATION_AGENT_EMAIL_VARIABLES,
  type InformationAgentEmailTemplateWorkspace,
} from "@/lib/information-agent-email-template";
import { AdminInformationAgentTemplatePanel } from "./AdminInformationAgentTemplatePanel";

const state = vi.hoisted(() => ({
  fetch: vi.fn(),
  preview: vi.fn(),
  save: vi.fn(),
  publish: vi.fn(),
}));

vi.mock("@/lib/client-api", () => ({
  fetchAdminInformationAgentEmailTemplate: state.fetch,
  previewAdminInformationAgentEmailTemplate: state.preview,
  saveAdminInformationAgentEmailTemplateDraft: state.save,
  publishAdminInformationAgentEmailTemplateDraft: state.publish,
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/components/admin/AdminShell", () => ({
  AdminPanel: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  AdminSectionHeading: ({ title, description }: { title: string; description: ReactNode }) => (
    <div>
      <div>{title}</div>
      <div>{description}</div>
    </div>
  ),
}));

afterEach(cleanup);

function workspace(
  id: string,
  updatedAt: string,
  name: string,
): InformationAgentEmailTemplateWorkspace {
  const source = {
    ...DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
    id,
    name,
    revision: 1,
    status: "published" as const,
    createdAt: updatedAt,
    updatedAt,
    publishedAt: updatedAt,
    blocks: DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE.blocks.map((block) => ({ ...block })),
  };

  return {
    published: source,
    draft: null,
    history: [source],
    variables: INFORMATION_AGENT_EMAIL_VARIABLES,
    protectedBlocks: [],
  };
}

function renderPanel(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <AdminInformationAgentTemplatePanel />
    </QueryClientProvider>,
  );
}

describe("AdminInformationAgentTemplatePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.fetch.mockResolvedValue(workspace("template-a", "2026-08-01T10:00:00.000Z", "Version A"));
  });

  it("syncs a clean editor when a newer cached workspace arrives", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderPanel(client);

    await screen.findByDisplayValue("Version A");
    client.setQueryData(
      ["admin-information-agent-email-template"],
      workspace("template-b", "2026-08-01T11:00:00.000Z", "Version B"),
    );

    await waitFor(() => expect(screen.getByDisplayValue("Version B")).toBeTruthy());
  });

  it("preserves dirty editor content and disables refresh while editing", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderPanel(client);

    const field = await screen.findByDisplayValue("Version A");
    fireEvent.change(field, { target: { value: "Modification locale" } });
    expect(screen.getByRole("status").textContent).toContain("Modifications non enregistrées");

    client.setQueryData(
      ["admin-information-agent-email-template"],
      workspace("template-b", "2026-08-01T11:00:00.000Z", "Version B"),
    );
    await client.invalidateQueries({ queryKey: ["admin-information-agent-email-template"] });

    await waitFor(() => expect(screen.getByDisplayValue("Modification locale")).toBeTruthy());
    expect(state.fetch).toHaveBeenCalledOnce();
  });
  it("locks editing while a draft save is pending", async () => {
    state.save.mockImplementation(() => new Promise(() => {}));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderPanel(client);
    const field = await screen.findByDisplayValue("Version A");
    fireEvent.change(field, { target: { value: "Modification locale" } });
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer le brouillon" }));
    await waitFor(() => expect(field.closest("fieldset")?.disabled).toBe(true));
  });
});
