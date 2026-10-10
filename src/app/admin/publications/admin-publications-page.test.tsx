// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminPublicationsPage } from "./admin-publications-page";

const mocks = vi.hoisted(() => ({ publicationResult: vi.fn() }));

// Les machines de CI chargées (build en parallèle) dépassent parfois le délai par défaut d’une seconde.
const SLOW = { timeout: 5_000 };

vi.mock("@/components/admin/AdminShell", () => ({
  AdminPanel: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  AdminSectionHeading: ({ title, action }: { title: string; action?: ReactNode }) => (
    <div>
      <h2>{title}</h2>
      {action}
    </div>
  ),
  AdminShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { email: "admin@example.test" } }),
}));

vi.mock("@/lib/client-api", () => ({
  fetchAdminPublicationRequests: mocks.publicationResult,
  reviewAdminPublicationRequest: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { storage: { from: () => ({ createSignedUrl: vi.fn() }) } },
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

beforeEach(() => {
  mocks.publicationResult.mockResolvedValue({
    requests: [],
    pendingCount: 0,
    totalCount: 0,
    hasMore: false,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AdminPublicationsPage", () => {
  it("loads publications beyond 100 in bounded pages and resets pagination with the filter", async () => {
    mocks.publicationResult.mockImplementation(async ({ offset, limit, status }) => ({
      requests: Array.from({ length: 30 }, (_, index) => ({
        id: `${status}-${offset + index}`,
        title: `${status} publication ${offset + index}`,
        status: "pending",
        created_at: "2026-10-04T12:00:00Z",
        document_types: [],
        promotion_options: [],
        submitted_documents: [],
      })),
      offset,
      limit,
      totalCount: 120,
      pendingCount: 120,
      hasMore: offset + limit < 120,
    }));

    renderPublications();
    await screen.findByRole("heading", { name: "all publication 0" }, SLOW);
    for (const last of [59, 89, 119]) {
      fireEvent.click(await screen.findByRole("button", { name: "Charger 30 de plus" }, SLOW));
      await screen.findByRole("heading", { name: `all publication ${last}` }, SLOW);
    }
    expect(screen.getAllByRole("article")).toHaveLength(120);
    expect(
      mocks.publicationResult.mock.calls.map(([input]) => [input.offset, input.limit]),
    ).toEqual([
      [0, 30],
      [30, 30],
      [60, 30],
      [90, 30],
    ]);
    expect(screen.queryByRole("button", { name: "Charger 30 de plus" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "En attente" }));
    await screen.findByRole("heading", { name: "pending publication 0" }, SLOW);
    expect(screen.getAllByRole("article")).toHaveLength(30);
    expect(mocks.publicationResult).toHaveBeenLastCalledWith({
      status: "pending",
      search: "",
      offset: 0,
      limit: 30,
    });
  }, 20_000);

  it("only loads the publication requests, nothing from the other views", async () => {
    renderPublications();
    await screen.findByText("Aucune demande ne correspond aux filtres.");
    expect(mocks.publicationResult).toHaveBeenCalledTimes(1);
  });
});

function renderPublications() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AdminPublicationsPage />
    </QueryClientProvider>,
  );
}
