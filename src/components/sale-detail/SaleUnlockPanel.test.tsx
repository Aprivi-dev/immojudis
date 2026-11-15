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
  return {
    unlock: vi.fn(),
    checkoutOpen: vi.fn(),
    // Offre d'achat à l'unité lue (`null` : achat fermé, l'écran d'avant le lot 3).
    purchase: null as { label: string; amountCents: number } | null,
    analysisLabel: "59 € TTC / mois",
    firstMonthDeductionCents: 0,
    startCheckout: vi.fn(),
    track: vi.fn(),
    SaleUnlockQuotaReachedError,
  };
});
vi.mock("@/lib/client-api", () => ({
  unlockSaleRequest: mocks.unlock,
  SaleUnlockQuotaReachedError: mocks.SaleUnlockQuotaReachedError,
}));

vi.mock("@/lib/product-events", () => ({ trackProductEvent: mocks.track }));

// One read of the offer for both the subscription and the purchase of a single sale.
vi.mock("@/hooks/use-sale-unlock-purchase-offer", () => ({
  useSaleUnlockPurchaseOffer: () => {
    const open = mocks.checkoutOpen();
    if (open === null) return { status: "loading" };
    const cents = Number.parseInt(mocks.analysisLabel, 10) * 100;
    return {
      status: "ready",
      analysisOpen: open,
      analysisLabel: mocks.analysisLabel,
      analysisCents: Number.isFinite(cents) ? cents : null,
      purchase: mocks.purchase,
      firstMonthDeductionCents: mocks.firstMonthDeductionCents,
    };
  },
}));

vi.mock("@/lib/client-billing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-billing")>()),
  startSaleUnlockCheckout: mocks.startCheckout,
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
  limit: 1,
  used: 0,
  remaining: 1,
  ...overrides,
});
const result: SaleUnlockResult = {
  ...status({ unlocked: true, used: 1, remaining: 0 }),
  alreadyUnlocked: false,
  consumed: true,
};

beforeEach(() => {
  mocks.purchase = null;
  mocks.analysisLabel = "59 € TTC / mois";
  mocks.firstMonthDeductionCents = 0;
  mocks.startCheckout.mockReset();
  mocks.unlock.mockReset();
  mocks.track.mockReset();
  mocks.checkoutOpen.mockReset();
  mocks.checkoutOpen.mockReturnValue(true);
});
afterEach(cleanup);

describe("SaleUnlockPanel", () => {
  it("offers the single unlock of the free account and the items it opens, nothing else", () => {
    render(
      <SaleUnlockPanel saleId={saleId} status={status()} unlocked={false} onUnlocked={vi.fn()} />,
    );

    expect(screen.getByRole("heading", { name: "Débloquer cette vente" })).toBeTruthy();
    expect(
      screen.getByText("Votre compte gratuit comprend le déblocage d’une vente : choisissez-la."),
    ).toBeTruthy();
    expect(screen.getByText(/Déblocage du compte gratuit/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Débloquer cette vente avec mon compte gratuit" }),
    ).toBeTruthy();
    // Without a regime of its own (default), both terms of the open regimes are named.
    expect(
      screen.getByText(
        /l’enchère plafond ou l’offre plafond, l’estimation détaillée et les ventes comparables, la lecture des pièces/,
      ),
    ).toBeTruthy();
    // No countdown, no scarcity, no month: the free account comprises one unlock, and says so.
    expect(document.body.textContent).not.toMatch(
      /dernière chance|plus que|vite|expire|ce mois|par mois|chaque mois/i,
    );
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
      "l’estimation détaillée et les ventes comparables, la lecture des pièces, l’historique de la vente, l’urbanisme et le cadastre, les pièces du dossier et le rapport PDF",
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
    expect(document.body.textContent).toContain("l’offre plafond, l’estimation détaillée");
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
    fireEvent.click(
      screen.getByRole("button", { name: "Débloquer cette vente avec mon compte gratuit" }),
    );
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
    fireEvent.click(
      screen.getByRole("button", { name: "Débloquer cette vente avec mon compte gratuit" }),
    );
    expect(screen.getByRole("group", { name: "Confirmer le déblocage" })).toBeTruthy();
    expect(screen.queryByText(estimated)).toBeNull();
  });

  it("asks for a confirmation before consuming anything, and can be cancelled", () => {
    render(
      <SaleUnlockPanel saleId={saleId} status={status()} unlocked={false} onUnlocked={vi.fn()} />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Débloquer cette vente avec mon compte gratuit" }),
    );

    expect(
      screen.getByText(
        "Ce déblocage est définitif : votre compte gratuit n’en comprend qu’un. Il vous est rendu si la vente est retirée avant d’avoir lieu (conditions générales, article 2).",
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

    fireEvent.click(
      screen.getByRole("button", { name: "Débloquer cette vente avec mon compte gratuit" }),
    );
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

    fireEvent.click(
      screen.getByRole("button", { name: "Débloquer cette vente avec mon compte gratuit" }),
    );
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

    fireEvent.click(
      screen.getByRole("button", { name: "Débloquer cette vente avec mon compte gratuit" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirmer le déblocage" }));

    expect((await screen.findByRole("alert")).textContent).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Débloquer cette vente avec mon compte gratuit" }),
    ).toBeTruthy();
  });

  it("switches to the exhausted message when the quota was spent elsewhere in the meantime", async () => {
    mocks.unlock.mockRejectedValue(
      new mocks.SaleUnlockQuotaReachedError(status({ used: 1, remaining: 0 })),
    );
    render(
      <SaleUnlockPanel saleId={saleId} status={status()} unlocked={false} onUnlocked={vi.fn()} />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Débloquer cette vente avec mon compte gratuit" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirmer le déblocage" }));

    expect(
      await screen.findByRole("heading", {
        name: "Votre compte gratuit a déjà débloqué une vente",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Débloquer cette vente avec mon compte gratuit" }),
    ).toBeNull();
    // Announced by the live region that stays mounted across the states, without naming the
    // subscription (its availability is not read there).
    expect(screen.getByRole("status").textContent).toBe(
      "Votre compte gratuit a déjà débloqué une vente. Le compte gratuit ne débloque qu’une vente ; l’offre Analyse les ouvre toutes.",
    );
  });

  it("forgets a refusal when the account status is read again", async () => {
    mocks.unlock.mockRejectedValue(
      new mocks.SaleUnlockQuotaReachedError(status({ used: 1, remaining: 0 })),
    );
    const first = status();
    const { rerender } = render(
      <SaleUnlockPanel saleId={saleId} status={first} unlocked={false} onUnlocked={vi.fn()} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Débloquer cette vente avec mon compte gratuit" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirmer le déblocage" }));
    await screen.findByRole("heading", { name: "Votre compte gratuit a déjà débloqué une vente" });

    // The status is read again (the unlock was given back): the panel follows it.
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
        status={status({ used: 1, remaining: 0 })}
        unlocked={false}
        onUnlocked={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Votre compte gratuit a déjà débloqué une vente" }),
    ).toBeTruthy();
    const text = container.textContent ?? "";
    expect(text).toContain(
      "Pour ouvrir celle-ci aussi, passez à l’offre Analyse : elle ouvre toutes les ventes.",
    );
    expect(text).toContain(
      "L’offre Analyse est un abonnement à 59\u00a0€\u00a0TTC / mois, prélevé automatiquement chaque mois jusqu’à résiliation, résiliable à tout moment.",
    );
    expect(screen.getByRole("link", { name: "Voir l’offre Analyse" }).getAttribute("href")).toBe(
      "/offres",
    );
    expect(screen.queryByRole("button", { name: "Me prévenir de l’ouverture" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Débloquer cette vente avec mon compte gratuit" }),
    ).toBeNull();
  });

  it("never suggests subscribing while the subscription is closed", async () => {
    mocks.checkoutOpen.mockReturnValue(false);
    const { container } = render(
      <SaleUnlockPanel
        saleId={saleId}
        status={status({ used: 1, remaining: 0 })}
        unlocked={false}
        onUnlocked={vi.fn()}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("L’offre Analyse n’est pas encore ouverte à la souscription.");
    expect(text).not.toMatch(/souscrire|59[ \u00a0]€|résiliable|passez/);
    expect(text).toContain(
      "Le compte gratuit ne débloque qu’une vente ; l’offre Analyse les ouvre toutes.",
    );
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
        status={status({ used: 1, remaining: 0 })}
        unlocked={false}
        onUnlocked={vi.fn()}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/souscri|59[ \u00a0]€|résiliable|pas encore ouverte|passez/);
    expect(text).toContain(
      "Le compte gratuit ne débloque qu’une vente ; l’offre Analyse les ouvre toutes.",
    );
    expect(screen.getByRole("link", { name: "Voir l’offre Analyse" })).toBeTruthy();
  });

  it("links an account without unlock left to the sale it already opened", () => {
    for (const open of [true, false, null]) {
      mocks.checkoutOpen.mockReturnValue(open);
      const view = render(
        <SaleUnlockPanel
          saleId={saleId}
          status={status({ used: 1, remaining: 0 })}
          unlocked={false}
          onUnlocked={vi.fn()}
        />,
      );
      expect(
        screen.getByRole("link", { name: "Voir la vente débloquée" }).getAttribute("href"),
      ).toBe("/compte/ventes-debloquees");
      view.unmount();
    }
  });

  it("names no month and no reset date once the unlock is spent", () => {
    mocks.checkoutOpen.mockReturnValue(false);
    render(
      <SaleUnlockPanel
        saleId={saleId}
        status={status({ used: 1, remaining: 0 })}
        unlocked={false}
        onUnlocked={vi.fn()}
      />,
    );
    expect(document.body.textContent).not.toMatch(/mois|1er|remis|reviennent|pourrez la débloquer/);
  });

  it("gives each of its three cards the « debloquer » anchor the previews link to", () => {
    const { container, rerender } = render(
      <SaleUnlockPanel saleId={saleId} status={status()} unlocked={false} onUnlocked={vi.fn()} />,
    );
    expect(container.querySelector("section#debloquer")).toBeTruthy();

    rerender(
      <SaleUnlockPanel
        saleId={saleId}
        status={status({ used: 1, remaining: 0 })}
        unlocked={false}
        onUnlocked={vi.fn()}
      />,
    );
    expect(container.querySelector("section#debloquer")).toBeTruthy();

    rerender(
      <SaleUnlockPanel
        saleId={saleId}
        status={status({ unlocked: true, used: 1, remaining: 0 })}
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
        status={status({ unlocked: true, unlockable: true, used: 1, remaining: 0 })}
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
    fireEvent.click(
      screen.getByRole("button", { name: "Débloquer cette vente avec mon compte gratuit" }),
    );

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
    fireEvent.click(
      screen.getByRole("button", { name: "Débloquer cette vente avec mon compte gratuit" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirmer le déblocage" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Déblocage en cours…"));
  });

  it("puts the focus on the result of an unlock made a moment ago", () => {
    render(
      <SaleUnlockPanel
        saleId={saleId}
        status={status({ unlocked: true, used: 1, remaining: 0 })}
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
        status={status({ unlocked: true, used: 1, remaining: 0 })}
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
        /Le partage d’un rapport par lien, l’export CSV et l’espace de travail restent réservés/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Ces éléments sont une aide à la décision : ils ne constituent ni un conseil juridique ni un conseil financier.",
      ),
    ).toBeTruthy();
    // No count left once the sale is unlocked: the free account comprises this one.
    expect(document.body.textContent).not.toMatch(/Il vous reste|ce mois-ci/);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("puts the ready ceiling first, then its button, then the duration, and keeps the rest under it", () => {
    const { container } = render(
      <SaleUnlockPanel
        saleId={saleId}
        status={status({ unlocked: true, used: 1, remaining: 0 })}
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
      /Le partage d’un rapport par lien, l’export CSV et l’espace de travail restent réservés à l’offre Analyse\./,
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
      "Ce déblocage ouvre l’analyse complète de la vente (l’enchère plafond, l’estimation détaillée",
    );
    expect(container.textContent).not.toMatch(/Il vous reste|ce mois-ci/);
    expect(container.textContent).not.toContain("Cette vente est débloquée");
  });

  it("names the ready ceiling with the term of the regime, or « plafond » when both apply", () => {
    const unlockedStatus = status({ unlocked: true, used: 1, remaining: 0 });
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
    const unlockedStatus = status({ unlocked: true, used: 1, remaining: 0 });
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
      fireEvent.click(
        screen.getByRole("button", { name: "Débloquer cette vente avec mon compte gratuit" }),
      );
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
      fireEvent.click(
        screen.getByRole("button", { name: "Débloquer cette vente avec mon compte gratuit" }),
      );
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
      fireEvent.click(
        screen.getByRole("button", { name: "Débloquer cette vente avec mon compte gratuit" }),
      );
      expect(screen.queryByTestId("unlock-ceiling-gap")).toBeNull();
    });

    it("does not title an unlocked sale « plafond débloqué » while the ceiling is not computed", () => {
      render(
        <SaleUnlockPanel
          saleId={saleId}
          status={status({ unlocked: true, used: 1, remaining: 0 })}
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
          status={status({ unlocked: true, used: 1, remaining: 0 })}
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

describe("SaleUnlockPanel, achat d'une vente à l'unité (lot 3)", () => {
  const spent = (overrides: Partial<SaleUnlockStatus> = {}) =>
    status({ used: 1, remaining: 0, ...overrides });
  const nbsp = (text: string) => text.replace(/[\u00a0\u202f]/g, " ");
  const bodyText = () => nbsp(document.body.textContent ?? "");
  const openPurchase = (label = "19 €", amountCents = 1900) => {
    mocks.checkoutOpen.mockReturnValue(true);
    mocks.purchase = { label, amountCents };
  };

  it("with a credit left: its own title and button, the same two-step confirmation, no purchase", async () => {
    openPurchase();
    mocks.unlock.mockResolvedValue(result);
    const onUnlocked = vi.fn();
    render(
      <SaleUnlockPanel
        saleId={saleId}
        status={spent({ credits: 1 })}
        unlocked={false}
        onUnlocked={onUnlocked}
      />,
    );

    expect(screen.getByRole("heading", { name: "Vous avez un crédit de déblocage" })).toBeTruthy();
    expect(
      screen.getByText(
        "Une vente que vous aviez achetée n’a pas eu lieu ou n’était plus disponible : son déblocage vous est rendu.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Acheter cette vente/)).toBeNull();
    // The credit is used without reading the offer.
    expect(mocks.checkoutOpen).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Débloquer cette vente avec mon crédit" }));
    expect(
      screen.getByText(
        "Ce déblocage utilise votre crédit : il ne servira plus pour une autre vente. Il vous est rendu de nouveau si cette vente est retirée avant d’avoir lieu.",
      ),
    ).toBeTruthy();
    expect(mocks.unlock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirmer le déblocage" }));
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledWith(result));
    expect(mocks.unlock).toHaveBeenCalledWith(saleId);
  });

  it("purchase closed: exactly the current screen, nothing mentions a purchase", () => {
    mocks.checkoutOpen.mockReturnValue(true);
    render(
      <SaleUnlockPanel saleId={saleId} status={spent()} unlocked={false} onUnlocked={vi.fn()} />,
    );
    expect(
      screen.getByText(
        /Pour ouvrir celle-ci aussi, passez à l’offre Analyse : elle ouvre toutes les ventes\./,
      ),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Voir l’offre Analyse" })).toBeTruthy();
    expect(bodyText()).not.toMatch(/Acheter|à l’unité|19 €|Cette vente :/);
  });

  it("purchase open, nothing to deduct: the subscription first and recommended, then this sale", () => {
    openPurchase();
    render(
      <SaleUnlockPanel saleId={saleId} status={spent()} unlocked={false} onUnlocked={vi.fn()} />,
    );

    const headings = screen
      .getAllByRole("heading", { level: 3 })
      .map((h) => nbsp(h.textContent ?? ""));
    expect(headings).toEqual(["Toutes les ventes pendant un mois : 59 €", "Cette vente : 19 €"]);
    const text = bodyText();
    expect(text).toContain("Recommandée");
    expect(text).toContain(
      "Sans engagement. À partir de quatre ventes à l’unité, l’abonnement revient moins cher.",
    );
    // 3 × 19 € = 57 € ne dépasse pas 59 € ; 4 × 19 € = 76 € le dépasse.
    expect(text).not.toContain("trois ventes");
    expect(text).toContain(
      "Paiement unique. L’analyse complète de cette vente, tant qu’elle est en ligne (24 mois au plus).",
    );
    expect(text).toContain(
      "Si vous vous abonnez dans les 30 jours, ces 19 € sont déduits de votre premier mois.",
    );
    expect(text).not.toContain("sont déduits : ");
    expect(
      screen.getByRole("link", { name: "Choisir l’abonnement Analyse" }).getAttribute("href"),
    ).toBe("/offres#tarifs");
    expect(screen.getByRole("button", { name: /Acheter cette vente : 19.€/ })).toBeTruthy();
    // No countdown, no scarcity, no pressure to bid.
    expect(text).not.toMatch(/dernière chance|plus que|vite|expire|enchérissez/i);
  });

  it("purchase open with purchases to deduct: the first month says what is deducted", () => {
    openPurchase();
    mocks.firstMonthDeductionCents = 1900;
    render(
      <SaleUnlockPanel saleId={saleId} status={spent()} unlocked={false} onUnlocked={vi.fn()} />,
    );
    const text = bodyText();
    expect(text).toContain(
      "Vos achats à l’unité des 30 derniers jours sont déduits : 40 € le premier mois, puis 59 € par mois.",
    );
    expect(text).not.toContain("Si vous vous abonnez dans les 30 jours");
  });

  it("writes no amount by hand: another price changes every text, and the exact threshold", () => {
    openPurchase("25 €", 2500);
    mocks.analysisLabel = "99 € TTC / mois";
    render(
      <SaleUnlockPanel saleId={saleId} status={spent()} unlocked={false} onUnlocked={vi.fn()} />,
    );
    const headings = screen
      .getAllByRole("heading", { level: 3 })
      .map((h) => nbsp(h.textContent ?? ""));
    expect(headings).toEqual(["Toutes les ventes pendant un mois : 99 €", "Cette vente : 25 €"]);
    const text = bodyText();
    expect(text).toContain("Acheter cette vente : 25 €");
    expect(text).toContain("ces 25 € sont déduits");
    // 3 × 25 € = 75 € ≤ 99 € < 4 × 25 € = 100 € : four sales.
    expect(text).toContain(
      "Sans engagement. À partir de quatre ventes à l’unité, l’abonnement revient moins cher.",
    );
    expect(text).not.toMatch(/19 €|59 €/);
  });

  it("collects the consent before the payment: two unchecked boxes, the button disabled until both", async () => {
    openPurchase();
    mocks.startCheckout.mockResolvedValue({ url: "https://checkout.stripe.test/s" });
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    try {
      render(
        <SaleUnlockPanel saleId={saleId} status={spent()} unlocked={false} onUnlocked={vi.fn()} />,
      );
      fireEvent.click(screen.getByRole("button", { name: /Acheter cette vente/ }));

      const group = screen.getByRole("group", { name: "Avant le paiement" });
      const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
      expect(boxes).toHaveLength(2);
      expect(boxes.every((box) => !box.checked)).toBe(true);
      expect(document.activeElement).toBe(boxes[0]);
      expect(group.textContent).toContain(
        "Je demande à accéder immédiatement à l’analyse de cette vente et je reconnais perdre mon droit de rétractation une fois l’accès fourni.",
      );
      expect(group.textContent).toContain(
        "Si la vente est retirée avant d’avoir lieu, votre achat devient un crédit pour débloquer une autre vente. Il n’est pas remboursé.",
      );
      expect(screen.getByRole("link", { name: "conditions générales" }).getAttribute("href")).toBe(
        "/conditions-generales",
      );

      const pay = screen.getByRole("button", { name: "Commander avec obligation de paiement" });
      expect((pay as HTMLButtonElement).disabled).toBe(true);
      const why = document.getElementById(pay.getAttribute("aria-describedby") ?? "");
      expect(why?.textContent).toBe("Cochez les deux cases pour accéder au paiement.");

      fireEvent.click(boxes[0]);
      expect((pay as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(pay);
      expect(mocks.startCheckout).not.toHaveBeenCalled();

      fireEvent.click(boxes[1]);
      expect((pay as HTMLButtonElement).disabled).toBe(false);
      expect(pay.getAttribute("aria-describedby")).toBeNull();
      fireEvent.click(pay);

      await waitFor(() => expect(assign).toHaveBeenCalledWith("https://checkout.stripe.test/s"));
      // The credits before leaving for Stripe, to recognise a purchase turned into a credit.
      expect(window.sessionStorage.getItem(`immojudis:achat-vente:credits-avant:${saleId}`)).toBe(
        "0",
      );
      expect(mocks.startCheckout).toHaveBeenCalledWith({
        saleId,
        consent: expect.objectContaining({
          termsAccepted: true,
          paymentObligationAcknowledged: true,
          immediatePerformanceRequested: true,
          withdrawalInformationAcknowledged: true,
          withdrawalWaiverAcknowledged: true,
        }),
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("cancelling the consent goes back to the two choices, without paying", () => {
    openPurchase();
    render(
      <SaleUnlockPanel saleId={saleId} status={spent()} unlocked={false} onUnlocked={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Acheter cette vente/ }));
    fireEvent.click(screen.getByRole("button", { name: "Annuler" }));
    expect(screen.queryByRole("group", { name: "Avant le paiement" })).toBeNull();
    expect(document.activeElement?.textContent).toMatch(/Acheter cette vente/);
    expect(mocks.startCheckout).not.toHaveBeenCalled();
  });

  it.each([
    ["analysis_access", "Votre compte a déjà accès à toutes les ventes : il n’y a rien à acheter."],
    [
      "free_unlock_available",
      "Votre compte gratuit peut encore débloquer une vente : utilisez-le pour celle-ci, sans paiement.",
    ],
    [
      "credit_available",
      "Vous avez un crédit de déblocage : utilisez-le pour cette vente, sans paiement.",
    ],
    [
      "already_unlocked",
      "Cette vente est déjà débloquée pour votre compte : la fiche se recharge.",
    ],
    ["sale_not_unlockable", "Cette vente ne peut pas être débloquée pour le moment."],
  ])("explains the refusal %s and reads the account state again", async (code, message) => {
    openPurchase();
    mocks.startCheckout.mockRejectedValue(
      Object.assign(new Error("Refusé."), { status: 409, code }),
    );
    const onStatusStale = vi.fn();
    render(
      <SaleUnlockPanel
        saleId={saleId}
        status={spent()}
        unlocked={false}
        onStatusStale={onStatusStale}
        onUnlocked={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Acheter cette vente/ }));
    for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: "Commander avec obligation de paiement" }));

    await waitFor(() => expect(onStatusStale).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("sale-unlock-notice").textContent).toBe(message);
    expect(screen.getByRole("status").textContent).toBe(message);
  });

  it("keeps the refusal on screen once the state read again offers the free unlock", async () => {
    openPurchase();
    mocks.startCheckout.mockRejectedValue(
      Object.assign(new Error("Refusé."), { status: 409, code: "free_unlock_available" }),
    );
    const view = render(
      <SaleUnlockPanel saleId={saleId} status={spent()} unlocked={false} onUnlocked={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Acheter cette vente/ }));
    for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: "Commander avec obligation de paiement" }));
    await screen.findByTestId("sale-unlock-notice");

    view.rerender(
      <SaleUnlockPanel saleId={saleId} status={status()} unlocked={false} onUnlocked={vi.fn()} />,
    );
    expect(
      screen.getByRole("button", { name: "Débloquer cette vente avec mon compte gratuit" }),
    ).toBeTruthy();
    expect(screen.getByTestId("sale-unlock-notice").textContent).toContain(
      "Votre compte gratuit peut encore débloquer une vente",
    );
  });

  it("shows another failure as an error, and the consent stays to retry", async () => {
    openPurchase();
    mocks.startCheckout.mockRejectedValue(
      Object.assign(new Error("Achat indisponible."), { status: 503 }),
    );
    render(
      <SaleUnlockPanel saleId={saleId} status={spent()} unlocked={false} onUnlocked={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Acheter cette vente/ }));
    for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: "Commander avec obligation de paiement" }));
    expect((await screen.findByRole("alert")).textContent).toBeTruthy();
    expect(screen.getByRole("group", { name: "Avant le paiement" })).toBeTruthy();
  });

  it("back from the payment, not confirmed yet: says it is in progress, offers nothing else", () => {
    openPurchase();
    render(
      <SaleUnlockPanel
        saleId={saleId}
        status={spent()}
        unlocked={false}
        purchaseReturn="pending"
        onUnlocked={vi.fn()}
      />,
    );
    expect(screen.getByTestId("sale-purchase-return").textContent).toBe(
      "Paiement reçu. L’ouverture de la vente est en cours…",
    );
    expect(screen.getByRole("status").textContent).toBe(
      "Paiement reçu. L’ouverture de la vente est en cours…",
    );
    expect(screen.queryByRole("button", { name: /Acheter/ })).toBeNull();
    expect(bodyText()).not.toMatch(/débloquée/);
  });

  it("back from the payment, never confirmed: says what to do, never « débloquée »", () => {
    render(
      <SaleUnlockPanel
        saleId={saleId}
        status={spent()}
        unlocked={false}
        purchaseReturn="delayed"
        onUnlocked={vi.fn()}
      />,
    );
    expect(screen.getByTestId("sale-purchase-return").textContent).toBe(
      "Paiement reçu, mais l’ouverture de la vente n’est pas encore confirmée. Rechargez la page dans quelques minutes. Si la vente n’est toujours pas ouverte, écrivez-nous depuis la page Contact en indiquant cette vente.",
    );
    expect(screen.getByRole("button", { name: "Recharger la page" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Écrire au support" }).getAttribute("href")).toBe(
      "/contact",
    );
    expect(bodyText()).not.toMatch(/débloquée/);
  });

  it("back from the payment, turned into a credit: says so at once, without the fallback", () => {
    render(
      <SaleUnlockPanel
        saleId={saleId}
        status={spent({ credits: 1, unlockable: false })}
        unlocked={false}
        purchaseReturn="credited"
        onUnlocked={vi.fn()}
      />,
    );
    expect(screen.getByTestId("sale-purchase-return").textContent).toBe(
      "Paiement reçu. Cette vente n’était plus disponible : votre achat est devenu un crédit pour débloquer une autre vente.",
    );
    expect(screen.getByRole("status").textContent).toContain("devenu un crédit");
    expect(screen.getByRole("link", { name: "Choisir une autre vente" }).getAttribute("href")).toBe(
      "/sales",
    );
    expect(screen.queryByRole("button", { name: "Recharger la page" })).toBeNull();
    expect(bodyText()).not.toMatch(/débloquée|rembours/);
  });

  it("back from the payment, confirmed: the unlocked card takes the focus", () => {
    render(
      <SaleUnlockPanel
        saleId={saleId}
        status={spent({ unlocked: true })}
        unlocked
        announce
        onUnlocked={vi.fn()}
      />,
    );
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading.textContent).toMatch(/débloquée/);
    expect(document.activeElement).toBe(heading);
  });
});
