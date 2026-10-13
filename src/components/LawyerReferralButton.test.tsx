// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  fetchAccessPlan: vi.fn(),
  fetchLawyerReferrals: vi.fn(),
  fetchLawyerReferralPreview: vi.fn(),
  requestLawyerReferral: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { id: "user-1" }, loading: false }),
}));
vi.mock("@/lib/client-api", () => ({
  fetchAccessPlan: mocks.fetchAccessPlan,
  fetchLawyerReferrals: mocks.fetchLawyerReferrals,
  fetchLawyerReferralPreview: mocks.fetchLawyerReferralPreview,
  requestLawyerReferral: mocks.requestLawyerReferral,
}));

import { LawyerReferralButton } from "./LawyerReferralButton";

const LAWYER = {
  id: "lawyer-1",
  displayName: "Me Dupont",
  firmName: "Cabinet Dupont",
  barAssociation: "Bordeaux",
  city: "Bordeaux",
  department: "33",
};

beforeEach(() => {
  mocks.fetchAccessPlan.mockResolvedValue({ plan: { features: { lawyerReferrals: "enabled" } } });
  mocks.fetchLawyerReferrals.mockResolvedValue({ requests: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function openRecap(props: { requestedLawyerId?: string } = {}) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <LawyerReferralButton saleId="sale-1" {...props} />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Mise en relation Immojudis" }));
  return screen.getByRole("group", { name: "Récapitulatif avant mise en relation" });
}

describe("LawyerReferralButton", () => {
  it("nomme l'avocat destinataire et sa mise en avant payante avant le consentement", async () => {
    mocks.fetchLawyerReferralPreview.mockResolvedValue({
      recipient: { ...LAWYER, placement: "active" },
    });
    const recap = await openRecap();

    await waitFor(() => expect(recap.textContent).toContain("Me Dupont · Cabinet Dupont"));
    const text = recap.textContent ?? "";
    expect(text).toContain("Cet avocat bénéficie d'une mise en avant payante sur Immojudis.");
    expect(text).toContain(
      "Vous restez libre de choisir un autre avocat dans l'annuaire ou d'en contacter un directement. Ses honoraires sont fixés librement avec lui.",
    );
    expect(text).not.toMatch(/forfait|ne perçoit aucune part|peut être un partenaire/i);
    expect(mocks.fetchLawyerReferralPreview).toHaveBeenCalledWith({
      saleId: "sale-1",
      lawyerId: undefined,
    });
    expect(mocks.requestLawyerReferral).not.toHaveBeenCalled();
  });

  it("indique une mise en avant en essai, sans dire qu'elle est déjà payée", async () => {
    mocks.fetchLawyerReferralPreview.mockResolvedValue({
      recipient: { ...LAWYER, placement: "trial" },
    });
    const recap = await openRecap();

    await waitFor(() => expect(recap.textContent).toContain("période d'essai de l'offre payante"));
    expect(recap.textContent).not.toContain("mise en avant payante sur Immojudis.");
  });

  it("dit que l'avocat ne rémunère pas Immojudis sans mise en avant", async () => {
    mocks.fetchLawyerReferralPreview.mockResolvedValue({
      recipient: { ...LAWYER, placement: "none" },
    });
    const recap = await openRecap({ requestedLawyerId: "lawyer-1" });

    await waitFor(() =>
      expect(recap.textContent).toContain("Cet avocat ne rémunère pas Immojudis."),
    );
    expect(recap.textContent).not.toContain("mise en avant payante sur Immojudis.");
    expect(mocks.fetchLawyerReferralPreview).toHaveBeenCalledWith({
      saleId: "sale-1",
      lawyerId: "lawyer-1",
    });
  });

  it("le dit quand aucun avocat n'est déterminable, sans promettre de transmission", async () => {
    mocks.fetchLawyerReferralPreview.mockResolvedValue({ recipient: null });
    const recap = await openRecap();

    await waitFor(() => expect(recap.textContent).toContain("Avocat destinataire : aucun."));
    expect(recap.textContent).toContain("Aucun avocat n'est désigné automatiquement");
    expect(recap.textContent).toContain("mise en avant payante (ou en période d'essai)");
  });

  it("n'autorise le consentement qu'une fois le destinataire connu", async () => {
    let resolvePreview: (value: unknown) => void = () => undefined;
    mocks.fetchLawyerReferralPreview.mockReturnValue(
      new Promise((resolve) => {
        resolvePreview = resolve;
      }),
    );
    const recap = await openRecap();
    const checkbox = recap.querySelector("input[type=checkbox]") as HTMLInputElement;
    const send = screen.getByRole("button", { name: "Envoyer la demande" }) as HTMLButtonElement;

    expect(checkbox.disabled).toBe(true);
    expect(send.disabled).toBe(true);

    resolvePreview({ recipient: { ...LAWYER, placement: "active" } });
    await waitFor(() => expect(checkbox.disabled).toBe(false));
    fireEvent.click(checkbox);
    expect(send.disabled).toBe(false);
  });

  it("bloque le consentement si le destinataire ne peut pas être déterminé", async () => {
    mocks.fetchLawyerReferralPreview.mockRejectedValue(new Error("Prévisualisation indisponible"));
    const recap = await openRecap();

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    const checkbox = recap.querySelector("input[type=checkbox]") as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
    expect(mocks.requestLawyerReferral).not.toHaveBeenCalled();
  });

  it("ne liste que les données réellement transmises", async () => {
    mocks.fetchLawyerReferralPreview.mockResolvedValue({ recipient: null });
    const recap = await openRecap();

    const items = Array.from(recap.querySelectorAll("li")).map((item) => item.textContent);
    expect(items).toHaveLength(3);
    expect(recap.textContent).toContain("Aucune autre donnée de votre compte n'est transmise.");
  });
});
