// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import { emptyPilotDraft, type PilotDefinition } from "@/lib/professional-pilots";
import { ProfessionalPilotWorkspace } from "./ProfessionalPilotWorkspace";

const mocks = vi.hoisted(() => ({
  userId: null as string | null,
  fetchWorkspace: vi.fn(),
  saveDossier: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: mocks.userId ? { id: mocks.userId } : null, loading: false }),
}));
vi.mock("@/lib/client-api", () => ({
  fetchSaleWorkspace: mocks.fetchWorkspace,
  saveProfessionalPilotDossier: mocks.saveDossier,
}));

const definition: PilotDefinition = {
  kind: "notary",
  title: "Bureau d'offre notariale",
  description: "Préparer une offre",
  priceLabel: "Offre envisagée",
  packetLabel: "Fiche d'offre",
  counterpartyLabel: "Étude notariale",
  counterparty: null,
  facts: [{ label: "Consignation", value: null }],
  milestones: [{ label: "Date de séance", date: null }],
  checks: [{ id: "notary-financing", label: "Financement validé", reason: "À confirmer" }],
};

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  mocks.userId = null;
  mocks.fetchWorkspace.mockReset();
  mocks.saveDossier.mockReset();
});

describe("professional pilot workspace", () => {
  it("keeps a user's notarial offer and review status in the local draft", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ProfessionalPilotWorkspace sale={EXAMPLE_SALE} definition={definition} publicDemo />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Consignation").parentElement?.textContent).toContain("À confirmer");
    fireEvent.change(screen.getByRole("spinbutton", { name: "Offre envisagée" }), {
      target: { value: "210000" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Statut : Financement validé" }), {
      target: { value: "blocked" },
    });

    const key = `immojudis:professional-pilot:v1:guest:${EXAMPLE_SALE.id}`;
    await waitFor(() => {
      const saved = JSON.parse(window.localStorage.getItem(key) ?? "null");
      expect(saved.priceEur).toBe(210_000);
      expect(saved.checkStatuses["notary-financing"]).toBe("blocked");
    });
    expect(screen.getByText("1 point(s) bloquant(s)")).toBeTruthy();
  });

  it("clears the previous user's dossier when the account changes", async () => {
    const sale = { ...EXAMPLE_SALE, id: "7d335032-e935-4550-9347-ed22b0f63449" };
    const accountA = "9b923d06-df18-403d-9c95-a4655f043825";
    const accountB = "27d49fe3-bd12-4208-b6c4-d7e1976c8de7";
    mocks.userId = accountA;
    mocks.fetchWorkspace.mockImplementation(async () => ({
      workspace:
        mocks.userId === accountA
          ? {
              updated_at: "2026-09-23T09:00:00.000Z",
              private_notes: {
                professionalDossier: {
                  ...emptyPilotDraft("notary"),
                  priceEur: 210_000,
                  updatedAt: "2026-09-23T09:00:00.000Z",
                },
              },
            }
          : null,
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <ProfessionalPilotWorkspace sale={sale} definition={definition} />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(
        screen.getByRole<HTMLInputElement>("spinbutton", { name: "Offre envisagée" }).value,
      ).toBe("210000");
    });

    mocks.userId = accountB;
    view.rerender(
      <QueryClientProvider client={client}>
        <ProfessionalPilotWorkspace sale={sale} definition={definition} />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(
        screen.getByRole<HTMLInputElement>("spinbutton", { name: "Offre envisagée" }).value,
      ).toBe("");
    });
    expect(
      window.localStorage.getItem(`immojudis:professional-pilot:v1:${accountB}:${sale.id}`),
    ).not.toContain("210000");
  });

  it("ignores a completed save from the account used before a switch", async () => {
    const sale = { ...EXAMPLE_SALE, id: "7d335032-e935-4550-9347-ed22b0f63449" };
    const accountA = "9b923d06-df18-403d-9c95-a4655f043825";
    const accountB = "27d49fe3-bd12-4208-b6c4-d7e1976c8de7";
    mocks.userId = accountA;
    mocks.fetchWorkspace.mockResolvedValue({ workspace: null });
    let finishSave: (value: unknown) => void = () => {};
    mocks.saveDossier.mockReturnValue(
      new Promise((resolve) => {
        finishSave = resolve;
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <ProfessionalPilotWorkspace sale={sale} definition={definition} />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Enregistrer le dossier" }).hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.change(screen.getByRole("spinbutton", { name: "Offre envisagée" }), {
      target: { value: "210000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer le dossier" }));
    await waitFor(() => expect(mocks.saveDossier).toHaveBeenCalledOnce());

    mocks.userId = accountB;
    view.rerender(
      <QueryClientProvider client={client}>
        <ProfessionalPilotWorkspace sale={sale} definition={definition} />
      </QueryClientProvider>,
    );
    await act(async () => {
      finishSave({ workspace: { updated_at: "2026-09-23T09:00:01.000Z" } });
    });
    await waitFor(() => {
      expect(
        screen.getByRole<HTMLInputElement>("spinbutton", { name: "Offre envisagée" }).value,
      ).toBe("");
    });
  });
});
