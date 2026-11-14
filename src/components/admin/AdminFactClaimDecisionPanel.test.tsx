// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allowedFactClaimDecisionActions } from "@/lib/fact-claim-decisions";
import { AdminFactClaimDecisionPanel } from "./AdminFactClaimDecisionPanel";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  decide: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/client-api", () => ({
  fetchAdminFactClaimDecisions: mocks.list,
  decideAdminFactClaimClient: mocks.decide,
}));
vi.mock("@/lib/toast", () => ({ toast: { success: mocks.success, error: mocks.error } }));

const saleId = "11111111-1111-4111-8111-111111111111";
const claimId = "22222222-2222-4222-8222-222222222222";
const decisionId = "44444444-4444-4444-8444-444444444444";

type Latest = { decision: string; reasonCode: string | null } | null;

function item(latest: Latest = null, overrides: Record<string, unknown> = {}) {
  return {
    claimId,
    saleId,
    fieldKey: "property.occupancy_status",
    value: "vacant",
    currentValue: "occupied",
    origin: "professional_email",
    sourceUrl: "https://source.example/piece",
    capturedAt: "2026-11-10T09:00:00Z",
    sale: { title: "Appartement T3", city: "Bordeaux", saleDate: "2026-12-01T09:00:00Z" },
    latestDecision: latest
      ? {
          id: decisionId,
          lotAttachment: "single_lot",
          decidedAt: "2026-11-11T09:00:00Z",
          ...latest,
        }
      : null,
    allowedActions: allowedFactClaimDecisionActions(latest),
    ...overrides,
  };
}

function page(items: unknown[]) {
  return { ok: true, items, offset: 0, limit: 50, total: items.length, hasMore: false };
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AdminFactClaimDecisionPanel />
    </QueryClientProvider>,
  );
}

const actionNames = () =>
  within(screen.getByRole("article"))
    .queryAllByRole("button")
    .map((button) => button.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue(page([item()]));
  mocks.decide.mockResolvedValue({ ok: true, result: { state: "held" } });
});

afterEach(cleanup);

describe("AdminFactClaimDecisionPanel : affichage", () => {
  it("montre le champ, les deux valeurs, l'origine, la source et l'état", async () => {
    renderPanel();

    expect(screen.getByRole("status").textContent).toContain("Chargement des observations");
    expect(await screen.findByRole("heading", { name: /Occupation.*Appartement T3/ })).toBeTruthy();
    expect(screen.getByText("Valeur proposée").nextElementSibling?.textContent).toBe("Libre");
    expect(screen.getByText("Valeur affichée aujourd’hui").nextElementSibling?.textContent).toBe(
      "Occupé",
    );
    expect(screen.getByText(/Origine : Réponse d’un professionnel par e-mail/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Ouvrir la source/ }).getAttribute("href")).toBe(
      "https://source.example/piece",
    );
    expect(screen.getByRole("link", { name: "Voir la fiche" }).getAttribute("href")).toBe(
      `/sales/${saleId}`,
    );
    expect(screen.getByText("À décider")).toBeTruthy();
    expect(mocks.list).toHaveBeenCalledWith({ saleId: undefined, offset: 0, limit: 50 });
  });

  it("dit dans le titre, le bouton et l'aide que l'acceptation met à jour la fiche", async () => {
    renderPanel();

    expect(
      await screen.findByRole("heading", {
        name: "Observations à décider, avec effet sur la fiche",
      }),
    ).toBeTruthy();
    expect(screen.getByText(/^Accepter une observation met à jour la fiche/)).toBeTruthy();
    expect(
      await screen.findByRole("button", { name: "Accepter et mettre à jour la fiche" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accepter" })).toBeNull();
  });

  it("montre l'état vide", async () => {
    mocks.list.mockResolvedValue(page([]));
    renderPanel();

    expect(
      await screen.findByText("Aucune observation de professionnel ou d’administrateur à décider."),
    ).toBeTruthy();
  });

  it("montre l'erreur de chargement et permet de réessayer", async () => {
    mocks.list.mockRejectedValueOnce(new Error("Liste des observations indisponible."));
    renderPanel();

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Liste des observations indisponible.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    expect(await screen.findByText("À décider")).toBeTruthy();
  });

  it("filtre sur une vente à partir de l'adresse de la fiche, et refuse un texte sans identifiant", async () => {
    renderPanel();
    await screen.findByText("À décider");
    const field = screen.getByLabelText("Vente (identifiant ou adresse de la fiche)");

    fireEvent.change(field, { target: { value: "appartement bordeaux" } });
    fireEvent.click(screen.getByRole("button", { name: "Afficher cette vente" }));
    expect(screen.getByRole("alert").textContent).toContain("Identifiant de vente non reconnu");
    expect(mocks.list).toHaveBeenCalledTimes(1);

    fireEvent.change(field, { target: { value: `https://immojudis.test/sales/${saleId}` } });
    fireEvent.click(screen.getByRole("button", { name: "Afficher cette vente" }));
    await waitFor(() =>
      expect(mocks.list).toHaveBeenLastCalledWith({ saleId, offset: 0, limit: 50 }),
    );
  });
});

describe("AdminFactClaimDecisionPanel : actions permises par état", () => {
  it.each<[string, Latest, string, string[]]>([
    [
      "à décider",
      null,
      "À décider",
      ["Accepter et mettre à jour la fiche", "Rejeter l’observation", "Enregistrer une opposition"],
    ],
    [
      "acceptée",
      { decision: "accepted", reasonCode: null },
      "Dernière décision : acceptée",
      ["Rejeter l’observation", "Retirer de la fiche", "Enregistrer une opposition"],
    ],
    [
      "rejetée",
      { decision: "rejected", reasonCode: "other" },
      "Dernière décision : rejetée",
      ["Accepter et mettre à jour la fiche", "Enregistrer une opposition"],
    ],
    [
      "retirée",
      { decision: "withdrawn", reasonCode: "entry_error" },
      "Dernière décision : retirée",
      ["Accepter et mettre à jour la fiche", "Enregistrer une opposition"],
    ],
    [
      "autorisation retirée",
      { decision: "withdrawn", reasonCode: "authorization_withdrawn" },
      "Dernière décision : autorisation retirée (définitif)",
      ["Enregistrer une opposition"],
    ],
  ])("%s", async (_name, latest, badge, actions) => {
    mocks.list.mockResolvedValue(page([item(latest)]));
    renderPanel();

    expect(await screen.findByText(badge)).toBeTruthy();
    expect(actionNames()).toEqual(actions);
  });

  it("ne propose aucune action après une opposition", async () => {
    mocks.list.mockResolvedValue(
      page([item({ decision: "opposed", reasonCode: "professional_opposition" })]),
    );
    renderPanel();

    expect(await screen.findByText("Dernière décision : opposition (définitif)")).toBeTruthy();
    expect(actionNames()).toEqual([]);
    expect(
      screen.getByText("Aucune action possible : cette décision est définitive."),
    ).toBeTruthy();
  });
});

describe("AdminFactClaimDecisionPanel : états particuliers", () => {
  it("ne dit pas « définitive » pour un état inconnu", async () => {
    mocks.list.mockResolvedValue(page([item({ decision: "autre", reasonCode: null })]));
    renderPanel();

    expect(await screen.findByText("État inconnu")).toBeTruthy();
    expect(screen.getByText("Aucune action proposée pour cet état.")).toBeTruthy();
    expect(screen.queryByText(/cette décision est définitive/)).toBeNull();
  });

  it("dit « Non comparée ici » pour un champ sans colonne connue, pas « Non renseignée »", async () => {
    const { currentValue: _omitted, ...unknownField } = item();
    mocks.list.mockResolvedValue(
      page([{ ...unknownField, fieldKey: "property.property_type", value: "house" }]),
    );
    renderPanel();

    const label = await screen.findByText("Valeur affichée aujourd’hui");
    expect(label.nextElementSibling?.textContent).toBe("Non comparée ici");
  });

  it("dit « Non renseignée » quand la fiche n'a pas de valeur pour un champ connu", async () => {
    mocks.list.mockResolvedValue(page([item(null, { currentValue: null })]));
    renderPanel();

    const label = await screen.findByText("Valeur affichée aujourd’hui");
    expect(label.nextElementSibling?.textContent).toBe("Non renseignée");
  });
});

describe("AdminFactClaimDecisionPanel : décisions", () => {
  it("accepte après le choix du rattachement au lot, en nommant la décision remplacée", async () => {
    mocks.list.mockResolvedValue(page([item({ decision: "rejected", reasonCode: "other" })]));
    renderPanel();

    fireEvent.click(
      await screen.findByRole("button", { name: "Accepter et mettre à jour la fiche" }),
    );
    const confirm = screen.getByRole("button", { name: "Confirmer l’acceptation" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement?.textContent).toBe("Accepter cette observation");

    fireEvent.change(screen.getByLabelText("Rattachement au lot (obligatoire)"), {
      target: { value: "matched" },
    });
    fireEvent.change(screen.getByLabelText(/Lot cité par la pièce/), {
      target: { value: " lot 2 " },
    });
    expect(
      screen.getByText(
        "Si cette observation l’emporte, sa valeur remplacera celle de la fiche. Le résultat s’affiche après l’enregistrement.",
      ),
    ).toBeTruthy();
    fireEvent.click(confirm);

    await waitFor(() => expect(mocks.decide).toHaveBeenCalled());
    expect(mocks.decide.mock.calls[0][0]).toEqual({
      action: "accept",
      claimId,
      lotAttachment: "matched",
      lotRef: "lot 2",
      supersedesDecisionId: decisionId,
    });
    const message = "Observation acceptée. Sa valeur est maintenant affichée sur la fiche.";
    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith(message));
    expect(screen.getByRole("status").textContent).toBe(message);
    // L'état est relu sur le serveur après la décision.
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
  });

  it("prévient quand une acceptation ne sera pas affichée", async () => {
    mocks.decide.mockResolvedValue({ ok: true, result: { state: null } });
    renderPanel();

    fireEvent.click(
      await screen.findByRole("button", { name: "Accepter et mettre à jour la fiche" }),
    );
    fireEvent.change(screen.getByLabelText("Rattachement au lot (obligatoire)"), {
      target: { value: "unknown" },
    });
    expect(
      screen.getByText(
        "La décision sera enregistrée, mais la valeur ne sera pas affichée sur la fiche.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirmer l’acceptation" }));

    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith(
        "Observation acceptée et enregistrée. Sa valeur n’est pas affichée sur la fiche.",
      ),
    );
    expect(mocks.decide.mock.calls[0][0]).toEqual({
      action: "accept",
      claimId,
      lotAttachment: "unknown",
    });
  });

  it("exige un motif pour rejeter", async () => {
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Rejeter l’observation" }));
    const confirm = screen.getByRole("button", { name: "Confirmer le rejet" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Motif (obligatoire)"), {
      target: { value: "implausible_value" },
    });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() => expect(mocks.decide).toHaveBeenCalled());
    expect(mocks.decide.mock.calls[0][0]).toEqual({
      action: "reject",
      claimId,
      reasonCode: "implausible_value",
    });
  });

  it("retire sans confirmation supplémentaire pour un motif ordinaire", async () => {
    mocks.list.mockResolvedValue(page([item({ decision: "accepted", reasonCode: null })]));
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Retirer de la fiche" }));
    fireEvent.change(screen.getByLabelText("Motif (obligatoire)"), {
      target: { value: "entry_error" },
    });
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Confirmer le retrait" }));

    await waitFor(() => expect(mocks.decide).toHaveBeenCalled());
    expect(mocks.decide.mock.calls[0][0]).toEqual({
      action: "withdraw",
      claimId,
      reasonCode: "entry_error",
    });
  });

  it("demande une confirmation explicite pour un retrait d'autorisation, dit définitif", async () => {
    mocks.list.mockResolvedValue(page([item({ decision: "accepted", reasonCode: null })]));
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Retirer de la fiche" }));
    fireEvent.change(screen.getByLabelText("Motif (obligatoire)"), {
      target: { value: "authorization_withdrawn" },
    });
    expect(screen.getByText(/Un retrait d’autorisation est définitif\./)).toBeTruthy();
    expect(screen.getByText(/la décision ne peut pas être annulée/)).toBeTruthy();
    const confirm = screen.getByRole("button", {
      name: "Confirmer le retrait définitif",
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.submit(confirm.closest("form") as HTMLFormElement);
    expect(mocks.decide).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("checkbox", { name: "J’ai compris que cette décision est définitive." }),
    );
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() => expect(mocks.decide).toHaveBeenCalled());
    expect(mocks.decide.mock.calls[0][0]).toEqual({
      action: "withdraw",
      claimId,
      reasonCode: "authorization_withdrawn",
    });
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith(
        "Autorisation retirée. Cette décision est définitive.",
      ),
    );
  });

  it("demande une confirmation explicite pour une opposition, dite définitive", async () => {
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Enregistrer une opposition" }));
    expect(screen.getByText(/Une opposition est définitive\./)).toBeTruthy();
    const confirm = screen.getByRole("button", {
      name: "Confirmer l’opposition définitive",
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.submit(confirm.closest("form") as HTMLFormElement);
    expect(mocks.decide).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(confirm);

    await waitFor(() => expect(mocks.decide).toHaveBeenCalled());
    expect(mocks.decide.mock.calls[0][0]).toEqual({ action: "oppose", claimId });
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith(
        "Opposition enregistrée. Cette décision est définitive.",
      ),
    );
  });

  it("annule sans rien envoyer et rend le focus au titre de l'observation", async () => {
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Enregistrer une opposition" }));
    fireEvent.click(screen.getByRole("button", { name: "Annuler" }));

    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(mocks.decide).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 3 }));
  });

  it("rend le focus au titre de l'observation après une réussite", async () => {
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Rejeter l’observation" }));
    fireEvent.change(screen.getByLabelText("Motif (obligatoire)"), { target: { value: "other" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmer le rejet" }));

    await waitFor(() => expect(mocks.success).toHaveBeenCalled());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { level: 3 })),
    );
  });

  it("redemande la confirmation d'une décision définitive après un refus", async () => {
    mocks.decide.mockRejectedValue(
      new Error("Import en cours sur cette vente, réessayez dans une minute."),
    );
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Enregistrer une opposition" }));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Confirmer l’opposition définitive" }));

    await waitFor(() => expect(mocks.error).toHaveBeenCalled());
    await waitFor(() =>
      expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false),
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Confirmer l’opposition définitive",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(mocks.decide).toHaveBeenCalledTimes(1);
  });

  it("affiche le message d'échec du serveur et relit l'état", async () => {
    mocks.decide.mockRejectedValue(new Error("Cette observation a déjà été traitée."));
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Rejeter l’observation" }));
    fireEvent.change(screen.getByLabelText("Motif (obligatoire)"), { target: { value: "other" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmer le rejet" }));

    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith("Cette observation a déjà été traitée."),
    );
    const article = screen.getByRole("article");
    expect(within(article).getByRole("button", { name: "Confirmer le rejet" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Cette observation a déjà été traitée.");
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
  });
});
