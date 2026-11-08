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
  return { unlock: vi.fn(), checkoutOpen: vi.fn(), track: vi.fn(), SaleUnlockQuotaReachedError };
});
vi.mock("@/lib/client-api", () => ({
  unlockSaleRequest: mocks.unlock,
  SaleUnlockQuotaReachedError: mocks.SaleUnlockQuotaReachedError,
}));

vi.mock("@/lib/product-events", () => ({ trackProductEvent: mocks.track }));

vi.mock("@/hooks/use-analysis-checkout-open", () => ({
  useAnalysisCheckoutOpen: () => mocks.checkoutOpen(),
}));

// The opening request has its own tests (BillingActions): here only its presence matters.
vi.mock("@/components/OfferOpeningRequest", () => ({
  OfferOpeningRequest: () => <button type="button">Me prévenir de l’ouverture</button>,
}));

import { SaleUnlockPanel } from "./SaleUnlockPanel";

const saleId = "11111111-1111-4111-8111-111111111111";
const status = (overrides: Partial<SaleUnlockStatus> = {}): SaleUnlockStatus => ({
  saleId,
  unlocked: false,
  unlockable: true,
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
  mocks.track.mockReset();
  mocks.checkoutOpen.mockReset();
  mocks.checkoutOpen.mockReturnValue(true);
});
afterEach(cleanup);

describe("SaleUnlockPanel", () => {
  it("offers the unlock with the number left and the items it opens, nothing else", () => {
    render(
      <SaleUnlockPanel saleId={saleId} status={status()} unlocked={false} onUnlocked={vi.fn()} />,
    );

    expect(screen.getByRole("heading", { name: "Débloquer cette vente" })).toBeTruthy();
    expect(screen.getByText("Il vous reste 2 déblocages sur 3 ce mois-ci.")).toBeTruthy();
    // Without a regime of its own (default), both terms of the open regimes are named.
    expect(
      screen.getByText(/l’enchère plafond ou l’offre plafond, la lecture des pièces/),
    ).toBeTruthy();
    // No countdown, no scarcity: only the figure and the reset date (given at confirmation).
    expect(document.body.textContent).not.toMatch(/dernière chance|plus que|vite|expire/i);
    expect(mocks.unlock).not.toHaveBeenCalled();
  });

  it("only promises the elements the sale really offers (no ceiling on a sale without a fee regime)", () => {
    render(
      <SaleUnlockPanel
        saleId={saleId}
        status={status()}
        unlocked={false}
        opens={{ ceiling: null, ceilingTerm: null, statistics: false }}
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

  it("names the ceiling with the label of the fee regime of the sale", () => {
    render(
      <SaleUnlockPanel
        saleId={saleId}
        status={status()}
        unlocked={false}
        opens={{ ceiling: "l’offre plafond", ceilingTerm: "offre plafond", statistics: false }}
        onUnlocked={vi.fn()}
      />,
    );
    expect(document.body.textContent).toContain("l’offre plafond, la lecture des pièces");
    expect(document.body.textContent).not.toContain("enchère plafond");
  });

  it("tells at the confirmation that fees are estimated when the sale opens a ceiling", () => {
    const estimated =
      "Si l’annonce ne les donne pas, les frais sont estimés : vous pourrez les corriger ensuite.";
    const { unmount } = render(
      <SaleUnlockPanel saleId={saleId} status={status()} unlocked={false} onUnlocked={vi.fn()} />,
    );
    // Only at the confirmation step, not before.
    expect(screen.queryByText(estimated)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Débloquer cette vente" }));
    expect(screen.getByText(estimated)).toBeTruthy();
    unmount();

    render(
      <SaleUnlockPanel
        saleId={saleId}
        status={status()}
        unlocked={false}
        opens={{ ceiling: null, ceilingTerm: null, statistics: false }}
        onUnlocked={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Débloquer cette vente" }));
    expect(screen.getByRole("group", { name: "Confirmer le déblocage" })).toBeTruthy();
    expect(screen.queryByText(estimated)).toBeNull();
  });

  it("asks for a confirmation before consuming anything, and can be cancelled", () => {
    render(
      <SaleUnlockPanel saleId={saleId} status={status()} unlocked={false} onUnlocked={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Débloquer cette vente" }));

    expect(
      screen.getByText(
        "Ce déblocage est définitif : il n’est restitué que si Immojudis retire elle-même la vente (conditions générales, article 2). Le compteur est remis à 3 le 1er novembre.",
      ),
    ).toBeTruthy();
    expect(mocks.unlock).not.toHaveBeenCalled();
    expect(mocks.track).not.toHaveBeenCalled();

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
    // La confirmation est mesurée une fois, sans identifiant de vente ni de compte.
    expect(mocks.track.mock.calls).toEqual([["sale_unlock_confirmed"]]);
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
      await screen.findByRole("heading", { name: "Vos 3 ventes d’octobre sont débloquées" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Débloquer cette vente" })).toBeNull();
    // Announced by the live region that stays mounted across the states, without naming the
    // subscription (its availability is not read there).
    expect(screen.getByRole("status").textContent).toBe(
      "Vos 3 ventes d’octobre sont débloquées. Vous pourrez la débloquer le 1er novembre avec le compte gratuit.",
    );
  });

  it("forgets a refusal when the account status is read again", async () => {
    mocks.unlock.mockRejectedValue(
      new mocks.SaleUnlockQuotaReachedError(status({ used: 3, remaining: 0 })),
    );
    const first = status();
    const { rerender } = render(
      <SaleUnlockPanel saleId={saleId} status={first} unlocked={false} onUnlocked={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Débloquer cette vente" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmer le déblocage" }));
    await screen.findByRole("heading", { name: "Vos 3 ventes d’octobre sont débloquées" });

    // The status is read again (a new month, a refund): the panel follows it.
    rerender(
      <SaleUnlockPanel
        saleId={saleId}
        status={{ ...first }}
        unlocked={false}
        onUnlocked={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { name: "Débloquer cette vente" })).toBeTruthy();
  });

  it("points an account without unlock left to the offers page, with the price, when the subscription is open", () => {
    mocks.checkoutOpen.mockReturnValue(true);
    const { container } = render(
      <SaleUnlockPanel
        saleId={saleId}
        status={status({ used: 3, remaining: 0 })}
        unlocked={false}
        onUnlocked={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Vos 3 ventes d’octobre sont débloquées" }),
    ).toBeTruthy();
    const text = container.textContent ?? "";
    expect(text).toContain(
      "Vous pourrez la débloquer le 1er novembre avec le compte gratuit, ou l’ouvrir dès maintenant avec l’offre Analyse, qui ouvre toutes les ventes.",
    );
    expect(text).toContain("Son prix : 59\u00a0€\u00a0TTC / mois, résiliable à tout moment.");
    expect(screen.getByRole("link", { name: "Voir l’offre Analyse" }).getAttribute("href")).toBe(
      "/offres",
    );
    expect(screen.queryByRole("button", { name: "Me prévenir de l’ouverture" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Débloquer cette vente" })).toBeNull();
  });

  it("never suggests subscribing while the subscription is closed", async () => {
    mocks.checkoutOpen.mockReturnValue(false);
    const { container } = render(
      <SaleUnlockPanel
        saleId={saleId}
        status={status({ used: 3, remaining: 0 })}
        unlocked={false}
        onUnlocked={vi.fn()}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("L’offre Analyse n’est pas encore ouverte à la souscription.");
    expect(text).not.toMatch(/souscrire|59[ \u00a0]€|résiliable|dès maintenant/);
    expect(text).toContain("Vous pourrez la débloquer le 1er novembre avec le compte gratuit.");
    // The primary action is the opening request (loaded on demand), not a link to a page that
    // cannot sell it yet.
    expect(await screen.findByRole("button", { name: "Me prévenir de l’ouverture" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /offre Analyse/ })).toBeNull();
  });

  it("promises nothing about the subscription while its availability is unknown", () => {
    mocks.checkoutOpen.mockReturnValue(null);
    const { container } = render(
      <SaleUnlockPanel
        saleId={saleId}
        status={status({ used: 3, remaining: 0 })}
        unlocked={false}
        onUnlocked={vi.fn()}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/souscri|59[ \u00a0]€|résiliable|pas encore ouverte|dès maintenant/);
    expect(text).toContain("Vous pourrez la débloquer le 1er novembre avec le compte gratuit.");
    expect(screen.getByRole("link", { name: "Voir l’offre Analyse" })).toBeTruthy();
  });

  it("links an account without unlock left to the sales it already opened", () => {
    for (const open of [true, false, null]) {
      mocks.checkoutOpen.mockReturnValue(open);
      const view = render(
        <SaleUnlockPanel
          saleId={saleId}
          status={status({ used: 3, remaining: 0 })}
          unlocked={false}
          onUnlocked={vi.fn()}
        />,
      );
      expect(
        screen.getByRole("link", { name: "Voir mes ventes débloquées" }).getAttribute("href"),
      ).toBe("/compte/ventes-debloquees");
      view.unmount();
    }
  });

  it("names the month with its elision and follows the limit of the account", () => {
    render(
      <SaleUnlockPanel
        saleId={saleId}
        status={status({
          used: 3,
          remaining: 0,
          periodStart: "2026-10-31T23:00:00.000Z",
          resetsAt: "2026-11-30T23:00:00.000Z",
        })}
        unlocked={false}
        onUnlocked={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Vos 3 ventes de novembre sont débloquées" }),
    ).toBeTruthy();
    expect(document.body.textContent).toContain("le 1er décembre avec le compte gratuit");
  });

  it("gives each of its three cards the « debloquer » anchor the previews link to", () => {
    const { container, rerender } = render(
      <SaleUnlockPanel saleId={saleId} status={status()} unlocked={false} onUnlocked={vi.fn()} />,
    );
    expect(container.querySelector("section#debloquer")).toBeTruthy();

    rerender(
      <SaleUnlockPanel
        saleId={saleId}
        status={status({ used: 3, remaining: 0 })}
        unlocked={false}
        onUnlocked={vi.fn()}
      />,
    );
    expect(container.querySelector("section#debloquer")).toBeTruthy();

    rerender(
      <SaleUnlockPanel
        saleId={saleId}
        status={status({ unlocked: true, used: 2, remaining: 1 })}
        unlocked
        onUnlocked={vi.fn()}
      />,
    );
    expect(container.querySelector("section#debloquer")).toBeTruthy();
  });

  it("offers no button for a sale the database would refuse to unlock", () => {
    const { container } = render(
      <SaleUnlockPanel
        saleId={saleId}
        status={status({ unlockable: false })}
        unlocked={false}
        onUnlocked={vi.fn()}
      />,
    );
    expect(container.textContent).toContain(
      "Cette vente ne peut pas être débloquée pour le moment.",
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector("#debloquer")).toBeNull();
    expect(mocks.unlock).not.toHaveBeenCalled();
  });

  it("still shows an unlocked sale without a ceiling as unlocked", () => {
    render(
      <SaleUnlockPanel
        saleId={saleId}
        status={status({ unlocked: true, unlockable: true, used: 2, remaining: 1 })}
        unlocked
        opens={{ ceiling: null, ceilingTerm: null, statistics: false }}
        onUnlocked={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { name: "Cette vente est débloquée" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/est prête|est prêt\b/);
  });

  it("does not look at the subscription before the quota is spent", () => {
    render(
      <SaleUnlockPanel saleId={saleId} status={status()} unlocked={false} onUnlocked={vi.fn()} />,
    );
    expect(mocks.checkoutOpen).not.toHaveBeenCalled();
  });

  it("moves the focus to the confirmation and says where the unlock is recorded", () => {
    render(
      <SaleUnlockPanel saleId={saleId} status={status()} unlocked={false} onUnlocked={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Débloquer cette vente" }));

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Confirmer le déblocage" }),
    );
    const group = screen.getByRole("group", { name: "Confirmer le déblocage" });
    expect(group.textContent).toContain(
      "Le déblocage est enregistré sur votre compte (vente et date).",
    );
    expect(
      screen.getByRole("link", { name: "Politique de confidentialité" }).getAttribute("href"),
    ).toBe("/privacy");
  });

  it("announces the pending unlock", async () => {
    mocks.unlock.mockReturnValue(new Promise(() => undefined));
    render(
      <SaleUnlockPanel saleId={saleId} status={status()} unlocked={false} onUnlocked={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Débloquer cette vente" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmer le déblocage" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Déblocage en cours…"));
  });

  it("puts the focus on the result of an unlock made a moment ago", () => {
    render(
      <SaleUnlockPanel
        saleId={saleId}
        status={status({ unlocked: true, used: 2, remaining: 1 })}
        unlocked
        announce
        opens={{ ceiling: "l’enchère plafond", ceilingTerm: "enchère plafond", statistics: false }}
        onUnlocked={vi.fn()}
      />,
    );
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Votre enchère plafond est débloquée" }),
    );
  });

  it("recalls what an unlocked sale gives, and what stays on Analyse", () => {
    render(
      <SaleUnlockPanel
        saleId={saleId}
        status={status({ unlocked: true, used: 2, remaining: 1 })}
        unlocked
        opens={{ ceiling: null, ceilingTerm: null, statistics: false }}
        onUnlocked={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Cette vente est débloquée" })).toBeTruthy();
    expect(
      screen.getByText(/tant qu’elle est en ligne sur Immojudis, dans la limite de 24 mois/),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /exports PDF et CSV, les rapports enregistrés, l’estimation détaillée et les ventes comparables restent réservés/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Ces éléments sont une aide à la décision : ils ne constituent ni un conseil juridique ni un conseil financier.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Il vous reste 1 déblocage sur 3 ce mois-ci.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("puts the ready ceiling first, then its button, then the duration, and keeps the rest under it", () => {
    const { container } = render(
      <SaleUnlockPanel
        saleId={saleId}
        status={status({ unlocked: true, used: 2, remaining: 1 })}
        unlocked
        opens={{ ceiling: "l’enchère plafond", ceilingTerm: "enchère plafond", statistics: false }}
        onUnlocked={vi.fn()}
      />,
    );

    const heading = screen.getByRole("heading", { name: "Votre enchère plafond est débloquée" });
    const button = screen.getByRole("link", { name: "Voir mon enchère plafond" });
    const duration = screen.getByText(
      "Ouvert pour cette vente, tant qu’elle est en ligne (24 mois au plus).",
    );
    const reserved = screen.getByText(
      /Les exports PDF et CSV, les rapports enregistrés, l’estimation détaillée et les ventes comparables restent réservés à l’offre Analyse\./,
    );
    const reserve = screen.getByText(
      "Ces éléments sont une aide à la décision : ils ne constituent ni un conseil juridique ni un conseil financier, et l’enchère plafond est une simulation fondée sur des hypothèses modifiables.",
    );
    // Document order: heading, button, duration, what stays reserved, the decision-aid reserve.
    const order = [heading, button, duration, reserved, reserve];
    for (let index = 1; index < order.length; index += 1) {
      expect(
        order[index - 1].compareDocumentPosition(order[index]) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    expect(reserved.textContent).toContain(
      "Ce déblocage ouvre l’enchère plafond, la lecture des pièces",
    );
    expect(screen.getByText("Il vous reste 1 déblocage sur 3 ce mois-ci.")).toBeTruthy();
    expect(container.textContent).not.toContain("Cette vente est débloquée");
  });

  it("names the ready ceiling with the term of the regime, or « plafond » when both apply", () => {
    const unlockedStatus = status({ unlocked: true, used: 2, remaining: 1 });
    const online = render(
      <SaleUnlockPanel
        saleId={saleId}
        status={unlockedStatus}
        unlocked
        opens={{ ceiling: "l’offre plafond", ceilingTerm: "offre plafond", statistics: false }}
        onUnlocked={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { name: "Votre offre plafond est débloquée" })).toBeTruthy();
    online.unmount();

    render(
      <SaleUnlockPanel
        saleId={saleId}
        status={unlockedStatus}
        unlocked
        opens={{
          ceiling: "l’enchère plafond ou l’offre plafond",
          ceilingTerm: null,
          statistics: false,
        }}
        onUnlocked={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { name: "Votre plafond est débloqué" })).toBeTruthy();
  });

  it("links an unlocked sale to its bid ceiling with the term of its regime, and never promises one elsewhere", () => {
    const unlockedStatus = status({ unlocked: true, used: 2, remaining: 1 });
    const tribunal = {
      ceiling: "l’enchère plafond",
      ceilingTerm: "enchère plafond",
      statistics: false,
    };
    const view = render(
      <SaleUnlockPanel
        saleId={saleId}
        status={unlockedStatus}
        unlocked
        opens={tribunal}
        onUnlocked={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("link", { name: "Voir mon enchère plafond" }).getAttribute("href"),
    ).toBe("#calculation");
    view.unmount();

    const online = render(
      <SaleUnlockPanel
        saleId={saleId}
        status={unlockedStatus}
        unlocked
        opens={{ ceiling: "l’offre plafond", ceilingTerm: "offre plafond", statistics: false }}
        onUnlocked={vi.fn()}
      />,
    );
    expect(screen.getByRole("link", { name: "Voir mon offre plafond" }).getAttribute("href")).toBe(
      "#calculation",
    );
    expect(screen.queryByRole("link", { name: "Voir mon enchère plafond" })).toBeNull();
    online.unmount();

    // The mode of a notarial sale is unknown before the unlock reads its conditions: both terms.
    const either = render(
      <SaleUnlockPanel
        saleId={saleId}
        status={unlockedStatus}
        unlocked
        opens={{
          ceiling: "l’enchère plafond ou l’offre plafond",
          ceilingTerm: null,
          statistics: false,
        }}
        onUnlocked={vi.fn()}
      />,
    );
    expect(screen.getByRole("link", { name: "Voir mon plafond" })).toBeTruthy();
    either.unmount();

    render(
      <SaleUnlockPanel
        saleId={saleId}
        status={unlockedStatus}
        unlocked
        opens={{ ceiling: null, ceilingTerm: null, statistics: false }}
        onUnlocked={vi.fn()}
      />,
    );
    expect(screen.queryByRole("link", { name: "Voir mon enchère plafond" })).toBeNull();
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

  describe("ceiling that will stay to be completed (P4)", () => {
    const opens = {
      ceiling: "l’enchère plafond",
      ceilingTerm: "enchère plafond",
      statistics: false,
      ceilingGap: { reason: "surface absente", surface: true },
    };

    it("warns before the confirmation, and only then, without changing the unlock", async () => {
      mocks.unlock.mockResolvedValue(result);
      const onUnlocked = vi.fn();
      render(
        <SaleUnlockPanel
          saleId={saleId}
          status={status()}
          unlocked={false}
          opens={opens}
          onUnlocked={onUnlocked}
        />,
      );
      expect(screen.queryByTestId("unlock-ceiling-gap")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Débloquer cette vente" }));
      const group = screen.getByRole("group", { name: "Confirmer le déblocage" });
      const warning = screen.getByTestId("unlock-ceiling-gap");
      expect(group.contains(warning)).toBe(true);
      expect(warning.textContent).toBe(
        "L’enchère plafond restera à compléter : surface absente. Vous pourrez saisir dans « Mon dossier » la surface lue dans les pièces.",
      );
      // The warning comes before the button that consumes the unlock.
      const confirm = screen.getByRole("button", { name: "Confirmer le déblocage" });
      expect(
        warning.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      // Information only: the unlock goes through exactly as without the warning.
      fireEvent.click(confirm);
      await waitFor(() => expect(onUnlocked).toHaveBeenCalledWith(result));
      expect(mocks.unlock).toHaveBeenCalledTimes(1);
    });

    it("names « le plafond » while both terms are possible, and says nothing without a ceiling", () => {
      const both = render(
        <SaleUnlockPanel
          saleId={saleId}
          status={status()}
          unlocked={false}
          opens={{
            ...opens,
            ceiling: "l’enchère plafond ou l’offre plafond",
            ceilingTerm: null,
            ceilingGap: { reason: "données de l’annonce contradictoires", surface: false },
          }}
          onUnlocked={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Débloquer cette vente" }));
      expect(screen.getByTestId("unlock-ceiling-gap").textContent).toBe(
        "Le plafond restera à compléter : données de l’annonce contradictoires.",
      );
      both.unmount();

      render(
        <SaleUnlockPanel
          saleId={saleId}
          status={status()}
          unlocked={false}
          opens={{ ...opens, ceiling: null, ceilingTerm: null }}
          onUnlocked={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Débloquer cette vente" }));
      expect(screen.queryByTestId("unlock-ceiling-gap")).toBeNull();
    });

    it("does not title an unlocked sale « plafond débloqué » while the ceiling is not computed", () => {
      render(
        <SaleUnlockPanel
          saleId={saleId}
          status={status({ unlocked: true, used: 2, remaining: 1 })}
          unlocked
          opens={opens}
          onUnlocked={vi.fn()}
        />,
      );
      expect(screen.getByRole("heading", { name: "Cette vente est débloquée" })).toBeTruthy();
      expect(screen.queryByRole("heading", { name: /plafond est débloquée/ })).toBeNull();
      expect(screen.getByTestId("unlock-ceiling-gap").textContent).toBe(
        "Votre enchère plafond reste à compléter : surface absente. Saisissez dans « Mon dossier » la surface lue dans les pièces pour la calculer.",
      );
      expect(
        screen
          .getByRole("link", { name: "Saisir la surface lue dans les pièces" })
          .getAttribute("href"),
      ).toBe("#mon-dossier");
      expect(screen.queryByRole("link", { name: "Voir mon enchère plafond" })).toBeNull();
    });

    it("offers no link to a calculation that a valuation conflict suspends", () => {
      render(
        <SaleUnlockPanel
          saleId={saleId}
          status={status({ unlocked: true, used: 2, remaining: 1 })}
          unlocked
          opens={{
            ...opens,
            ceilingGap: { reason: "données de l’annonce contradictoires", surface: false },
          }}
          onUnlocked={vi.fn()}
        />,
      );
      expect(screen.getByRole("heading", { name: "Cette vente est débloquée" })).toBeTruthy();
      expect(screen.queryByRole("link", { name: /Voir mon|Saisir la surface/ })).toBeNull();
    });
  });
});
