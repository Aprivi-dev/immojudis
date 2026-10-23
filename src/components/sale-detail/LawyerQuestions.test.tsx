// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LawyerQuestion } from "@/lib/lawyer-questions-text";
import { LawyerQuestions } from "./LawyerQuestions";

const mocks = vi.hoisted(() => ({ readJson: vi.fn() }));
vi.mock("@/lib/client-api-core", () => ({
  authHeaders: async () => ({ authorization: "Bearer t" }),
  readJson: mocks.readJson,
}));

const SALE_ID = "11111111-1111-4111-8111-111111111111";

function question(overrides: Partial<LawyerQuestion> = {}): LawyerQuestion {
  return {
    key: "documents",
    label: "Pièces du dossier",
    question: "Pourriez-vous me transmettre le cahier des conditions de vente ?",
    reason: "Pièces absentes : le cahier des conditions de vente.",
    blocking: true,
    ...overrides,
  };
}

function renderQuestions() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <LawyerQuestions saleId={SALE_ID} access="analysis" userKey="user-1" />
    </QueryClientProvider>,
  );
}

function answer(questions: LawyerQuestion[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ questions }) }),
  );
  mocks.readJson.mockResolvedValue({ questions });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mocks.readJson.mockReset();
});

describe("LawyerQuestions (Mes questions pour l'avocat)", () => {
  it("liste les questions calculées par le serveur, sans rien envoyer", async () => {
    answer([
      question(),
      question({ key: "occupancy", label: "Occupation", question: "Le bien est-il libre ?" }),
    ]);
    renderQuestions();

    expect(
      await screen.findByRole("heading", { name: "Mes questions pour l’avocat" }),
    ).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getAllByText(/^Dans la fiche : /)).toHaveLength(2);
    expect(screen.getByText(/Rien n’est envoyé/)).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith(
      `/api/sales/${SALE_ID}/lawyer-questions`,
      expect.objectContaining({ headers: { authorization: "Bearer t" } }),
    );
  });

  it("copie la liste numérotée et le dit dans une région vivante", async () => {
    answer([question()]);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderQuestions();

    fireEvent.click(await screen.findByRole("button", { name: "Copier la liste" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Liste copiée."));
    expect(writeText).toHaveBeenCalledWith(
      `Mes questions pour l’avocat\n\n1. ${question().question}`,
    );
  });

  it("dit que la copie a échoué quand le navigateur la refuse", async () => {
    answer([question()]);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("refusé")) },
      configurable: true,
    });
    renderQuestions();

    fireEvent.click(await screen.findByRole("button", { name: "Copier la liste" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Copie impossible/));
  });

  it("imprime la liste seule : le reste de la page est masqué à l'impression", async () => {
    answer([question()]);
    const print = vi.spyOn(window, "print").mockImplementation(() => undefined);
    const { container } = renderQuestions();

    fireEvent.click(await screen.findByRole("button", { name: "Imprimer" }));

    expect(print).toHaveBeenCalledOnce();
    expect(container.querySelector("section")?.id).toBe("questions-avocat");
    const style = container.querySelector("style")?.textContent ?? "";
    expect(style).toContain("@media print");
    expect(style).toContain(":not(:has(#questions-avocat))");
    expect(screen.getByRole("button", { name: "Imprimer" }).parentElement?.className).toContain(
      "print:hidden",
    );
  });

  it("ne rassure pas quand aucune question n'est détectée, et n'affiche pas de boutons", async () => {
    answer([]);
    renderQuestions();

    expect(
      await screen.findByText(
        "Aucune question détectée automatiquement. Relisez tout de même le cahier des conditions de vente avec votre avocat.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/aucun point ouvert|fiche est complète/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Copier la liste" })).toBeNull();
  });

  it("n'affiche rien quand la lecture est refusée ou échoue", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    mocks.readJson.mockRejectedValue(Object.assign(new Error("Réservé"), { status: 403 }));
    const { container } = renderQuestions();

    await waitFor(() => expect(mocks.readJson).toHaveBeenCalled());
    await Promise.resolve();
    expect(container.innerHTML).toBe("");
  });
});
