// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SaleUnlockResult, SaleUnlockStatus } from "@/lib/sale-unlocks";

const mocks = vi.hoisted(() => {
  class SaleUnlockQuotaReachedError extends Error {
    readonly status: unknown;
    constructor(status: unknown) {
      super("quota");
      this.status = status;
    }
  }
  return { unlock: vi.fn(), SaleUnlockQuotaReachedError };
});
vi.mock("@/lib/client-api", () => ({
  unlockSaleRequest: mocks.unlock,
  SaleUnlockQuotaReachedError: mocks.SaleUnlockQuotaReachedError,
}));

import { SaleUnlockPanel } from "./SaleUnlockPanel";

const saleId = "11111111-1111-4111-8111-111111111111";
const status = (overrides: Partial<SaleUnlockStatus> = {}): SaleUnlockStatus => ({
  saleId,
  unlocked: false,
  analysisAccess: false,
  limit: 3,
  used: 1,
  remaining: 2,
  periodStart: "2026-09-30T22:00:00.000Z",
  resetsAt: "2026-10-31T23:00:00.000Z",
  ...overrides,
});
const result: SaleUnlockResult = {
  ...status({ unlocked: true, used: 2, remaining: 1 }),
  alreadyUnlocked: false,
  consumed: true,
};

beforeEach(() => {
  mocks.unlock.mockReset();
});
afterEach(cleanup);

describe("SaleUnlockPanel", () => {
  it("offers the unlock with the number left and the items it opens, nothing else", () => {
    render(
      <SaleUnlockPanel saleId={saleId} status={status()} unlocked={false} onUnlocked={vi.fn()} />,
    );

    expect(screen.getByRole("heading", { name: "Débloquer cette vente" })).toBeTruthy();
    expect(screen.getByText("Il vous reste 2 déblocages sur 3 ce mois-ci.")).toBeTruthy();
    expect(screen.getByText(/l’enchère plafond, la lecture des pièces/)).toBeTruthy();
    // No countdown, no scarcity: only the figure and the reset date (given at confirmation).
    expect(document.body.textContent).not.toMatch(/dernière chance|plus que|vite|expire/i);
    expect(mocks.unlock).not.toHaveBeenCalled();
  });

  it("only promises the elements the sale really offers (no ceiling on a notarial sale)", () => {
    render(
      <SaleUnlockPanel
        saleId={saleId}
        status={status()}
        unlocked={false}
        opens={{ ceiling: false, statistics: false }}
        onUnlocked={vi.fn()}
      />,
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain(
      "la lecture des pièces, l’historique de la vente et les pièces du dossier",
    );
    expect(text).not.toContain("enchère plafond");
    expect(text).not.toContain("statistiques du tribunal");
  });

  it("asks for a confirmation before consuming anything, and can be cancelled", () => {
    render(
      <SaleUnlockPanel saleId={saleId} status={status()} unlocked={false} onUnlocked={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Débloquer cette vente" }));

    expect(
      screen.getByText(
        "Ce déblocage est définitif et ne sera pas restitué. Le compteur est remis à 3 le 1er novembre.",
      ),
    ).toBeTruthy();
    expect(mocks.unlock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Annuler" }));
    expect(screen.queryByText(/définitif/)).toBeNull();
    expect(mocks.unlock).not.toHaveBeenCalled();
  });

  it("unlocks once confirmed and reports the result", async () => {
    mocks.unlock.mockResolvedValue(result);
    const onUnlocked = vi.fn();
    render(
      <SaleUnlockPanel
        saleId={saleId}
        status={status()}
        unlocked={false}
        onUnlocked={onUnlocked}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Débloquer cette vente" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmer le déblocage" }));

    await waitFor(() => expect(onUnlocked).toHaveBeenCalledWith(result));
    expect(mocks.unlock).toHaveBeenCalledTimes(1);
    expect(mocks.unlock).toHaveBeenCalledWith(saleId);
  });

  it("does not let a second click go through while the first is running", async () => {
    let resolveUnlock: (value: SaleUnlockResult) => void = () => undefined;
    mocks.unlock.mockReturnValue(
      new Promise<SaleUnlockResult>((resolve) => (resolveUnlock = resolve)),
    );
    render(
      <SaleUnlockPanel saleId={saleId} status={status()} unlocked={false} onUnlocked={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Débloquer cette vente" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmer le déblocage" }));
    const pending = screen.getByRole("button", { name: "Déblocage en cours…" });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(pending);
    expect(mocks.unlock).toHaveBeenCalledTimes(1);

    resolveUnlock(result);
    await waitFor(() => expect(screen.queryByText("Déblocage en cours…")).toBeNull());
  });

  it("explains a technical failure without consuming, and lets the account retry", async () => {
    mocks.unlock.mockRejectedValue(new Error("boom"));
    render(
      <SaleUnlockPanel saleId={saleId} status={status()} unlocked={false} onUnlocked={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Débloquer cette vente" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmer le déblocage" }));

    expect((await screen.findByRole("alert")).textContent).toBeTruthy();
    expect(screen.getByRole("button", { name: "Débloquer cette vente" })).toBeTruthy();
  });

  it("switches to the exhausted message when the quota was spent elsewhere in the meantime", async () => {
    mocks.unlock.mockRejectedValue(
      new mocks.SaleUnlockQuotaReachedError(status({ used: 3, remaining: 0 })),
    );
    render(
      <SaleUnlockPanel saleId={saleId} status={status()} unlocked={false} onUnlocked={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Débloquer cette vente" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmer le déblocage" }));

    expect(
      await screen.findByText(
        /Vous avez utilisé vos 3 déblocages d’octobre\. Ils reviennent le 1er novembre\./,
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Débloquer cette vente" })).toBeNull();
  });

  it("points an account without unlock left to the offers page, with the price", () => {
    render(
      <SaleUnlockPanel
        saleId={saleId}
        status={status({ used: 3, remaining: 0 })}
        unlocked={false}
        onUnlocked={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Vous avez utilisé vos déblocages" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "Vous avez utilisé vos 3 déblocages d’octobre. Ils reviennent le 1er novembre.",
    );
    expect(screen.getByRole("status").textContent).toContain("Vous pouvez aussi souscrire Analyse");
    expect(screen.getByRole("status").textContent).toContain("29 € TTC / mois");
    expect(
      screen.getByRole("link", { name: "Découvrir l’offre Analyse" }).getAttribute("href"),
    ).toBe("/offres");
    expect(screen.queryByRole("button", { name: "Débloquer cette vente" })).toBeNull();
  });

  it("recalls what an unlocked sale gives, and what stays on Analyse", () => {
    render(
      <SaleUnlockPanel
        saleId={saleId}
        status={status({ unlocked: true, used: 2, remaining: 1 })}
        unlocked
        onUnlocked={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Cette vente est débloquée" })).toBeTruthy();
    expect(screen.getByText(/tant qu’elle est en ligne/)).toBeTruthy();
    expect(
      screen.getByText(/exports PDF et CSV et les rapports enregistrés restent réservés/),
    ).toBeTruthy();
    expect(screen.getByText("Il vous reste 1 déblocage sur 3 ce mois-ci.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders nothing before the status is known and for an Analyse account", () => {
    const pending = render(
      <SaleUnlockPanel saleId={saleId} status={null} unlocked={false} onUnlocked={vi.fn()} />,
    );
    expect(pending.container.textContent).toBe("");
    pending.unmount();

    const analysis = render(
      <SaleUnlockPanel
        saleId={saleId}
        status={status({ analysisAccess: true, limit: null, remaining: null, used: 0 })}
        unlocked={false}
        onUnlocked={vi.fn()}
      />,
    );
    expect(analysis.container.textContent).toBe("");
  });
});
