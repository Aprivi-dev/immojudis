// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import { emptyPilotDraft, type PilotDefinition } from "@/lib/professional-pilots";
import { ProfessionalPilotWorkspace } from "./ProfessionalPilotWorkspace";

const mocks = vi.hoisted(() => ({
  userId: null as string | null,
  fetchWorkspace: vi.fn(),
  saveDossier: vi.fn(),
  fetchFavoriteDossier: vi.fn(),
  saveFavoriteDossier: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: mocks.userId ? { id: mocks.userId } : null, loading: false }),
}));
vi.mock("@/lib/client-api", () => ({
  fetchSaleWorkspace: mocks.fetchWorkspace,
  saveProfessionalPilotDossier: mocks.saveDossier,
  fetchFavoriteDossier: mocks.fetchFavoriteDossier,
  saveFavoriteDossier: mocks.saveFavoriteDossier,
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

const SALE_ID = "7d335032-e935-4550-9347-ed22b0f63449";
const ACCOUNT = "9b923d06-df18-403d-9c95-a4655f043825";

/** « Mon dossier » du compte sur la vente : suivie, avec ou sans enchère plafond. */
function dossierResponse(overrides: { followed?: boolean; bidCeilingEur?: number | null } = {}) {
  const { followed = true, bidCeilingEur = null } = overrides;
  return {
    dossier: {
      saleId: SALE_ID,
      followed,
      personalStatus: null,
      personalStatusUpdatedAt: null,
      bidCeilingEur,
      bidCeilingSavedAt: bidCeilingEur ? "2026-10-01T09:00:00.000Z" : null,
    },
  };
}

function renderWorkspace() {
  const sale = { ...EXAMPLE_SALE, id: SALE_ID };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ProfessionalPilotWorkspace sale={sale} definition={definition} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "2. Budget" }));
}

beforeEach(() => {
  mocks.fetchFavoriteDossier.mockResolvedValue(dossierResponse({ followed: false }));
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  mocks.userId = null;
  mocks.fetchWorkspace.mockReset();
  mocks.saveDossier.mockReset();
  mocks.fetchFavoriteDossier.mockReset();
  mocks.saveFavoriteDossier.mockReset();
});

describe("professional pilot workspace", () => {
  it("keeps a user's notarial offer and review status in the local draft", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ProfessionalPilotWorkspace sale={EXAMPLE_SALE} definition={definition} publicDemo />
      </QueryClientProvider>,
    );

    expect(screen.getByText("1 information à confirmer")).toBeTruthy();
    fireEvent.click(screen.getByText("1 information à confirmer"));
    expect(screen.getByText("Consignation")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "2. Budget" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Offre envisagée" }), {
      target: { value: "210000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "3. Vérifications" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Statut : Financement validé" }), {
      target: { value: "blocked" },
    });

    const key = `immojudis:professional-pilot:v1:guest:${EXAMPLE_SALE.id}`;
    await waitFor(() => {
      const saved = JSON.parse(window.localStorage.getItem(key) ?? "null");
      expect(saved.priceEur).toBe(210_000);
      expect(saved.checkStatuses["notary-financing"]).toBe("blocked");
    });
    fireEvent.click(screen.getByRole("button", { name: "2. Budget" }));
    expect(
      screen.getByRole<HTMLInputElement>("spinbutton", { name: "Offre envisagée" }).value,
    ).toBe("210000");
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
    fireEvent.click(screen.getByRole("button", { name: "2. Budget" }));
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
    fireEvent.click(screen.getByRole("button", { name: "2. Budget" }));
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

  describe("enchère plafond de « Mon dossier » (une seule porte)", () => {
    it("initialise « Offre envisagée » avec le plafond enregistré, sans rien écrire dans « Mon dossier »", async () => {
      mocks.userId = ACCOUNT;
      mocks.fetchWorkspace.mockResolvedValue({ workspace: null });
      mocks.fetchFavoriteDossier.mockResolvedValue(dossierResponse({ bidCeilingEur: 185_000 }));
      renderWorkspace();

      await waitFor(() =>
        expect(
          screen.getByRole<HTMLInputElement>("spinbutton", { name: "Offre envisagée" }).value,
        ).toBe("185000"),
      );
      const line = await screen.findByTestId("saved-ceiling-line");
      expect(line.textContent).toMatch(/Enchère plafond enregistrée :\s*185\s000\s€/);
      // Prix identique au plafond : rien à mettre à jour.
      expect(screen.queryByRole("button", { name: "Mettre à jour" })).toBeNull();
      expect(mocks.saveFavoriteDossier).not.toHaveBeenCalled();
    });

    it("garde le dossier du compte quand il existe : le plafond ne l'écrase pas", async () => {
      mocks.userId = ACCOUNT;
      mocks.fetchWorkspace.mockResolvedValue({
        workspace: {
          updated_at: "2026-09-23T09:00:00.000Z",
          private_notes: {
            professionalDossier: {
              ...emptyPilotDraft("notary"),
              priceEur: 210_000,
              updatedAt: "2026-09-23T09:00:00.000Z",
            },
          },
        },
      });
      mocks.fetchFavoriteDossier.mockResolvedValue(dossierResponse({ bidCeilingEur: 185_000 }));
      renderWorkspace();

      await waitFor(() =>
        expect(
          screen.getByRole<HTMLInputElement>("spinbutton", { name: "Offre envisagée" }).value,
        ).toBe("210000"),
      );
      expect(await screen.findByRole("button", { name: "Mettre à jour" })).toBeTruthy();
      expect(mocks.saveFavoriteDossier).not.toHaveBeenCalled();
    });

    it("n'écrit dans « Mon dossier » que sur « Mettre à jour »", async () => {
      mocks.userId = ACCOUNT;
      mocks.fetchWorkspace.mockResolvedValue({ workspace: null });
      mocks.fetchFavoriteDossier.mockResolvedValue(dossierResponse({ bidCeilingEur: 185_000 }));
      mocks.saveFavoriteDossier.mockResolvedValue(dossierResponse({ bidCeilingEur: 190_000 }));
      renderWorkspace();
      await waitFor(() =>
        expect(
          screen.getByRole<HTMLInputElement>("spinbutton", { name: "Offre envisagée" }).value,
        ).toBe("185000"),
      );

      fireEvent.change(screen.getByRole("spinbutton", { name: "Offre envisagée" }), {
        target: { value: "190000" },
      });
      // Saisir un prix ne modifie pas « Mon dossier ».
      expect(mocks.saveFavoriteDossier).not.toHaveBeenCalled();
      fireEvent.click(await screen.findByRole("button", { name: "Mettre à jour" }));

      await waitFor(() =>
        expect(mocks.saveFavoriteDossier).toHaveBeenCalledWith({
          data: { saleId: SALE_ID, bidCeilingEur: 190_000 },
        }),
      );
      await waitFor(() =>
        expect(screen.getByTestId("saved-ceiling-line").textContent).toMatch(/190\s000\s€/),
      );
      expect(screen.getByTestId("saved-ceiling-line").textContent).toContain("mise à jour");
    });

    it("dit de suivre la vente quand elle n'est pas dans les favoris", async () => {
      mocks.userId = ACCOUNT;
      mocks.fetchWorkspace.mockResolvedValue({ workspace: null });
      renderWorkspace();

      const line = await screen.findByTestId("saved-ceiling-line");
      expect(line.textContent).toContain("suivez la vente");
      expect(screen.queryByRole("button", { name: "Mettre à jour" })).toBeNull();
      expect(
        screen.getByRole<HTMLInputElement>("spinbutton", { name: "Offre envisagée" }).value,
      ).toBe("");
    });
  });
});
