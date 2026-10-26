// @vitest-environment jsdom

import { cleanup } from "@testing-library/react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OfferOpeningRequest } from "./OfferOpeningRequest";

const mocks = vi.hoisted(() => ({
  fetchOfferOpeningNotification: vi.fn(),
  updateOfferOpeningNotification: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { id: "investor" }, loading: false }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/client-billing", () => ({
  fetchOfferOpeningNotification: mocks.fetchOfferOpeningNotification,
  updateOfferOpeningNotification: mocks.updateOfferOpeningNotification,
  updateOfferOpeningSurvey: vi.fn(),
}));
vi.mock("@/lib/product-events", () => ({ trackProductEvent: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("OfferOpeningRequest", () => {
  it("keeps a request clicked before the initial status read even starts, whatever that read answers", async () => {
    const reactGlobal = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previousActEnvironment = reactGlobal.IS_REACT_ACT_ENVIRONMENT;
    // Hors `act` : le rendu et ses effets différés se font comme dans le navigateur, ce qui permet
    // de cliquer entre l'affichage du bouton et l'exécution de l'effet qui lit l'état initial.
    reactGlobal.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      let answerInitialStatus!: (value: { notification: { requested: boolean } }) => void;
      mocks.fetchOfferOpeningNotification.mockImplementation(
        () =>
          new Promise((resolve) => {
            answerInitialStatus = resolve;
          }),
      );
      mocks.updateOfferOpeningNotification.mockResolvedValue({
        notification: { requested: true, consentedAt: "2026-10-20T10:00:00.000Z" },
      });

      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      const clicked = new Promise<void>((resolve) => {
        new MutationObserver((_records, observer) => {
          const button = container.querySelector("button");
          if (!button) return;
          observer.disconnect();
          // Dans la même micro-tâche que l'affichage : l'effet de lecture n'a pas encore tourné.
          button.click();
          resolve();
        }).observe(container, { childList: true, subtree: true });
      });
      root.render(<OfferOpeningRequest />);
      await clicked;

      await vi.waitFor(() =>
        expect(container.textContent).toContain("Votre demande est enregistrée"),
      );
      await vi.waitFor(() => expect(mocks.fetchOfferOpeningNotification).toHaveBeenCalled());

      // La lecture répond ensuite avec l'état d'avant le clic : elle est ignorée.
      answerInitialStatus({ notification: { requested: false } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(container.textContent).toContain("Votre demande est enregistrée");
      expect(container.textContent).not.toContain("Me prévenir de l’ouverture");
      root.unmount();
    } finally {
      reactGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
  });
});
