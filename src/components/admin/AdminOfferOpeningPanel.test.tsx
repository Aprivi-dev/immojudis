// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  audience: vi.fn(),
  test: vi.fn(),
  send: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/lib/client-api", () => ({
  fetchAdminOfferOpeningAudience: mocks.audience,
  sendAdminOfferOpeningTest: mocks.test,
  sendAdminOfferOpeningBatch: mocks.send,
}));
vi.mock("@/lib/toast", () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock("@/components/admin/AdminShell", () => ({
  AdminPanel: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}));

import { AdminOfferOpeningPanel } from "./AdminOfferOpeningPanel";

const audience = {
  recipients: 12,
  alreadyNotified: 3,
  batchSize: 200,
  configured: true,
  missing: [],
  preview: { subject: "Immojudis : l’ouverture de l’offre Analyse", text: "Bonjour,\n\nTexte." },
};

function renderPanel() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <AdminOfferOpeningPanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.audience.mockResolvedValue(audience);
});
afterEach(cleanup);

describe("bloc « Prévenir la liste d'attente »", () => {
  it("montre le nombre de destinataires et l'aperçu", async () => {
    renderPanel();
    expect((await screen.findByTestId("opening-count")).textContent).toContain(
      "12 destinataires actifs",
    );
    expect(screen.getByTestId("opening-count").textContent).toContain("3 déjà prévenus");
    expect(screen.getByTestId("opening-preview-subject").textContent).toBe(
      audience.preview.subject,
    );
    expect(screen.getByTestId("opening-preview-text").textContent).toContain("Bonjour,");
    expect(screen.getByRole("button", { name: "Envoyer à 12 personnes" })).toBeTruthy();
  });

  it("signale les demandes à vérifier avant relance, et seulement s'il y en a", async () => {
    mocks.audience.mockResolvedValue({ ...audience, needsReview: 2 });
    renderPanel();
    expect((await screen.findByTestId("opening-review")).textContent).toContain(
      "2 demandes à vérifier",
    );
    cleanup();
    mocks.audience.mockResolvedValue({ ...audience, needsReview: 0 });
    renderPanel();
    await screen.findByTestId("opening-count");
    expect(screen.queryByTestId("opening-review")).toBeNull();
  });

  it("limite le lot affiché à 200 personnes", async () => {
    mocks.audience.mockResolvedValue({ ...audience, recipients: 1_500 });
    renderPanel();
    expect(await screen.findByRole("button", { name: "Envoyer à 200 personnes" })).toBeTruthy();
  });

  it("envoie l'essai à l'administrateur sans confirmation de lot", async () => {
    mocks.test.mockResolvedValue({ sentTo: "admin@immojudis.test" });
    renderPanel();
    await screen.findByTestId("opening-count");
    fireEvent.click(screen.getByRole("button", { name: "M’envoyer un essai" }));
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith("Message d’essai envoyé à admin@immojudis.test."),
    );
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("n'envoie le lot qu'après confirmation", async () => {
    mocks.send.mockResolvedValue({
      sent: 12,
      failed: 0,
      skipped: 0,
      remaining: 0,
      stoppedEarly: false,
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPanel();
    await screen.findByTestId("opening-count");
    const button = screen.getByRole("button", { name: "Envoyer à 12 personnes" });
    fireEvent.click(button);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(mocks.send).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(button);
    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith(expect.stringContaining("12 messages envoyés")),
    );
  });

  it("désactive les envois quand l'envoi d'emails n'est pas configuré", async () => {
    mocks.audience.mockResolvedValue({
      ...audience,
      configured: false,
      missing: ["RESEND_API_KEY"],
    });
    renderPanel();
    expect(await screen.findByText(/manque : RESEND_API_KEY/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "M’envoyer un essai" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole("button", { name: /Envoyer à/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("n'offre aucun envoi quand personne n'est à prévenir", async () => {
    mocks.audience.mockResolvedValue({ ...audience, recipients: 0 });
    renderPanel();
    await screen.findByTestId("opening-count");
    const button = screen.getByRole("button", { name: /Envoyer à/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});
