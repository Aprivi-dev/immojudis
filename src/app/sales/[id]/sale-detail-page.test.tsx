// @vitest-environment jsdom
import { Component, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SaleDetailPage } from "./sale-detail-page";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import { markSaleViewed } from "@/hooks/use-viewed-sales";
import * as queryKeys from "@/lib/query-keys";

const mocks = vi.hoisted(() => ({
  scroll: vi.fn(),
  entitlements: vi.fn(),
  unlockStatus: vi.fn(),
  sale: vi.fn(),
  preview: vi.fn(),
  authenticated: true,
  authLoading: false,
  authError: null as string | null,
  authErrorKind: null as "expired" | "unavailable" | null,
  retry: vi.fn(),
  hint: false,
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    session: mocks.authenticated ? { user: { id: "test" } } : null,
    loading: mocks.authLoading,
    authError: mocks.authError,
    authErrorKind: mocks.authErrorKind,
    retry: mocks.retry,
  }),
}));
vi.mock("@/integrations/supabase/lazy", () => ({ hasSupabaseAuthHint: () => mocks.hint }));
vi.mock("@/hooks/use-viewed-sales", () => ({ markSaleViewed: vi.fn() }));
vi.mock("@/lib/client-api", () => ({
  fetchAccessPlan: mocks.entitlements,
  fetchSaleUnlockStatus: mocks.unlockStatus,
}));
vi.mock("@/lib/queries", () => ({ getSaleById: mocks.sale, getSalePreviewById: mocks.preview }));
vi.mock("@/components/DiscoverySaleDetailView", () => ({
  DiscoverySaleDetailView: ({
    unlockStatus,
    onSaleUnlocked,
  }: {
    unlockStatus?: { remaining: number | null } | null;
    onSaleUnlocked?: (result: unknown) => void;
  }) => (
    <div>
      Offre Découverte
      <span data-testid="remaining">{String(unlockStatus?.remaining ?? "inconnu")}</span>
      <button
        type="button"
        onClick={() =>
          onSaleUnlocked?.({ unlocked: true, remaining: 2, alreadyUnlocked: false, consumed: true })
        }
      >
        Simuler le déblocage
      </button>
    </div>
  ),
}));
vi.mock("@/components/SimplifiedSaleDetailView", () => ({
  UnlockedSaleDetailView: () => <div>Vente débloquée</div>,
  AnalysisSaleDetailView: () => (
    <div
      id="proofs"
      ref={(node) => {
        if (node) node.scrollIntoView = mocks.scroll;
      }}
    >
      Analyse premium
    </div>
  ),
}));
vi.mock("@/components/SalePublicPreview", () => ({
  SalePublicPreview: ({
    returnTo,
    verifyingAccount,
  }: {
    returnTo: string;
    verifyingAccount?: boolean;
  }) => (
    <div>
      Aperçu public <span data-testid="return-to">{returnTo}</span>
      {verifyingAccount ? (
        <span>Vérification de votre compte…</span>
      ) : (
        <span>Créer mon compte</span>
      )}
    </div>
  ),
}));
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  vi.resetAllMocks();
  mocks.authenticated = true;
  mocks.authLoading = false;
  mocks.authError = null;
  mocks.authErrorKind = null;
  mocks.hint = false;
});
describe("listing access resolution", () => {
  it("restores a deep-link anchor after asynchronous access and listing resolution", async () => {
    window.history.replaceState(null, "", "/sales/sale#proofs");
    mocks.entitlements.mockResolvedValue({ plan: { hasAnalysisAccess: true } });
    mocks.sale.mockResolvedValue({ ...EXAMPLE_SALE, id: "sale" });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SaleDetailPage id="sale" />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(mocks.scroll).toHaveBeenCalledWith({ behavior: "instant", block: "start" }),
    );
    expect(screen.getByText("Analyse premium")).toBeTruthy();
  });

  it("reuses the server preview for visitors, then fetches authorized data after login", async () => {
    mocks.authenticated = false;
    const initialData = { sale: null, preview: { ...EXAMPLE_SALE, id: "sale" } };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const content = () => (
      <QueryClientProvider client={client}>
        <SaleDetailPage id="sale" initialData={initialData} />
      </QueryClientProvider>
    );
    const view = render(content());
    await screen.findByText("Aperçu public");
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.sale).not.toHaveBeenCalled();
    mocks.authenticated = true;
    mocks.entitlements.mockResolvedValue({ plan: { hasAnalysisAccess: true } });
    mocks.sale.mockResolvedValue({ ...EXAMPLE_SALE, id: "sale" });
    view.rerender(content());
    await screen.findByText("Analyse premium");
    expect(mocks.sale).toHaveBeenCalledWith("sale", { discovery: false, unlocked: false });
  });

  it("does not reuse a preview belonging to another listing", async () => {
    mocks.authenticated = false;
    mocks.preview.mockResolvedValue({ ...EXAMPLE_SALE, id: "sale" });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SaleDetailPage
          id="sale"
          initialData={{ sale: null, preview: { ...EXAMPLE_SALE, id: "other" } }}
        />
      </QueryClientProvider>,
    );
    await screen.findByText("Aperçu public");
    expect(mocks.preview).toHaveBeenCalledWith("sale");
  });

  it("offers reconnection to the current listing after session rejection", async () => {
    window.history.replaceState(null, "", "/sales/sale#proofs");
    mocks.authenticated = false;
    mocks.authError = "Session non vérifiée";
    mocks.preview.mockResolvedValue(null);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SaleDetailPage id="sale" />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("heading", { name: "Connexion à vérifier" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Se reconnecter" }).getAttribute("href")).toBe(
      "/login?redirect=%2Fsales%2Fsale%23proofs&reason=fiche",
    );
    expect(mocks.sale).not.toHaveBeenCalled();
  });

  it("offers « Réessayer » when the session could not be verified because of the network", () => {
    mocks.authenticated = false;
    mocks.authError = "Votre session n’a pas pu être vérifiée.";
    mocks.authErrorKind = "unavailable";
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SaleDetailPage id="sale" />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Nous n’avons pas pu vérifier votre connexion.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    expect(mocks.retry).toHaveBeenCalledTimes(1);
  });

  it("only proposes to sign in again when the server rejected the session", () => {
    mocks.authenticated = false;
    mocks.authError = "Votre session n’a pas pu être vérifiée.";
    mocks.authErrorKind = "expired";
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SaleDetailPage id="sale" />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/Votre session a expiré/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Réessayer" })).toBeNull();
    expect(screen.getByRole("link", { name: "Se reconnecter" })).toBeTruthy();
  });

  it("keeps the listing on screen, under a banner, when a verified account cannot be re-verified", async () => {
    mocks.authError = "Votre session n’a pas pu être vérifiée.";
    mocks.authErrorKind = "unavailable";
    mocks.entitlements.mockResolvedValue({ plan: { hasAnalysisAccess: true } });
    mocks.sale.mockResolvedValue({ ...EXAMPLE_SALE, id: "sale" });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SaleDetailPage id="sale" />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Analyse premium")).toBeTruthy();
    expect(screen.getByTestId("auth-connection-banner")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Connexion à vérifier" })).toBeNull();
  });

  it("keeps the public preview, saying that the account is verified, instead of a full-screen skeleton", async () => {
    let release!: (value: unknown) => void;
    mocks.entitlements.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    mocks.sale.mockResolvedValue({ ...EXAMPLE_SALE, id: "sale" });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SaleDetailPage
          id="sale"
          initialData={{ sale: null, preview: { ...EXAMPLE_SALE, id: "sale" } }}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/Aperçu public/)).toBeTruthy();
    expect(screen.getByText("Vérification de votre compte…")).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Chargement de la fiche" })).toBeNull();
    release({ plan: { hasAnalysisAccess: true } });
    expect(await screen.findByText("Analyse premium")).toBeTruthy();
    expect(screen.queryByText(/Aperçu public/)).toBeNull();
  });

  it("says nothing about an account while the session is restored for a visitor without stored session", () => {
    mocks.authenticated = false;
    mocks.authLoading = true;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SaleDetailPage
          id="sale"
          initialData={{ sale: null, preview: { ...EXAMPLE_SALE, id: "sale" } }}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Créer mon compte")).toBeTruthy();
    cleanup();
    mocks.hint = true;
    render(
      <QueryClientProvider client={client}>
        <SaleDetailPage
          id="sale"
          initialData={{ sale: null, preview: { ...EXAMPLE_SALE, id: "sale" } }}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Vérification de votre compte…")).toBeTruthy();
  });

  it("only requests the public preview without a verified session", async () => {
    mocks.authenticated = false;
    mocks.preview.mockResolvedValue({ id: "sale", starting_price_eur: 30000 });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SaleDetailPage id="sale" />
      </QueryClientProvider>,
    );
    await screen.findByText("Aperçu public");
    expect(mocks.sale).not.toHaveBeenCalled();
    expect(mocks.entitlements).not.toHaveBeenCalled();
  });

  it("leaves the tab title to the server metadata", async () => {
    document.title = "Appartement à Bayonne - Immojudis";
    mocks.entitlements.mockResolvedValue({ plan: { hasAnalysisAccess: true } });
    mocks.sale.mockResolvedValue({
      id: "sale",
      property_type: "apartment",
      city: "Bayonne",
      starting_price_eur: 30000,
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SaleDetailPage id="sale" />
      </QueryClientProvider>,
    );
    await screen.findByText("Analyse premium");
    expect(document.title).toBe("Appartement à Bayonne - Immojudis");
  });

  it("shows the public page rendered by the server while the session is restored", () => {
    mocks.authenticated = false;
    mocks.authLoading = true;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SaleDetailPage
          id="sale"
          initialData={{ sale: null, preview: { ...EXAMPLE_SALE, id: "sale" } }}
        />
      </QueryClientProvider>,
    );
    // Synchronously available: this is what the server-rendered HTML contains.
    expect(screen.getByText(/Aperçu public/)).toBeTruthy();
    expect(screen.queryByText("Chargement")).toBeNull();
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.sale).not.toHaveBeenCalled();
  });

  it("still waits for the session when the server rendered nothing for this sale", () => {
    mocks.authenticated = false;
    mocks.authLoading = true;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SaleDetailPage
          id="sale"
          initialData={{ sale: null, preview: { ...EXAMPLE_SALE, id: "other" } }}
        />
      </QueryClientProvider>,
    );
    expect(screen.queryByText(/Aperçu public/)).toBeNull();
  });

  it("reads the return link from the browser address, not during rendering", async () => {
    window.history.replaceState(null, "", "/sales/sale?from=%2Fsales%3Fcity%3DPau");
    mocks.authenticated = false;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SaleDetailPage
          id="sale"
          initialData={{ sale: null, preview: { ...EXAMPLE_SALE, id: "sale" } }}
        />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("return-to").textContent).toBe("/sales?city=Pau"),
    );
  });

  it("does not silently downgrade premium on an entitlement failure and retries", async () => {
    mocks.entitlements
      .mockRejectedValueOnce(new Error("service indisponible"))
      .mockResolvedValue({ plan: { hasAnalysisAccess: true } });
    mocks.sale.mockResolvedValue({ id: "sale" });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SaleDetailPage id="sale" />
      </QueryClientProvider>,
    );
    expect((await screen.findByRole("alert")).textContent).toContain("droits d’accès");
    expect(screen.queryByText("Offre Découverte")).toBeNull();
    // The free listing read ahead (while the rights were being checked) is not displayed, and the
    // full listing is never read before the rights are known.
    expect(mocks.sale).not.toHaveBeenCalledWith("sale", { discovery: false, unlocked: false });
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    await waitFor(() => expect(screen.getByText("Analyse premium")).toBeTruthy());
    expect(mocks.sale).toHaveBeenCalledWith("sale", { discovery: false, unlocked: false });
    expect(screen.queryByText("Offre Découverte")).toBeNull();
  });
});

it("offers access to the selected listing when its public preview is absent", async () => {
  mocks.authenticated = false;
  mocks.preview.mockResolvedValue(null);
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SaleDetailPage id="sale" />
    </QueryClientProvider>,
  );
  const link = await screen.findByRole("link", { name: "Se connecter ou créer un compte" });
  expect(link.getAttribute("href")).toBe(
    "/login?redirect=%2Fsales%2Fsale&mode=investor&reason=fiche",
  );
  expect(screen.queryByText("Introuvable")).toBeNull();
});

describe("« 3 déblocages par mois » on the sale page", () => {
  const status = (unlocked: boolean) => ({
    saleId: "sale",
    unlocked,
    unlockable: true,
    analysisAccess: false,
    limit: 3,
    used: unlocked ? 1 : 0,
    remaining: unlocked ? 2 : 3,
    periodStart: "2026-09-30T22:00:00.000Z",
    resetsAt: "2026-10-31T23:00:00.000Z",
  });
  const renderPage = () =>
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <SaleDetailPage id="sale" />
      </QueryClientProvider>,
    );

  it("serves the free view, with the counter, for a sale that is not unlocked", async () => {
    mocks.entitlements.mockResolvedValue({ plan: { hasAnalysisAccess: false } });
    mocks.unlockStatus.mockResolvedValue(status(false));
    mocks.sale.mockResolvedValue({ ...EXAMPLE_SALE, id: "sale" });

    renderPage();

    await screen.findByText("Offre Découverte");
    expect(screen.getByTestId("remaining").textContent).toBe("3");
    expect(mocks.sale).toHaveBeenCalledWith("sale", { discovery: true, unlocked: false });
    expect(mocks.sale).not.toHaveBeenCalledWith("sale", { discovery: false, unlocked: false });
  });

  it("serves the full rows, and the unlocked view, for a sale the account unlocked", async () => {
    mocks.entitlements.mockResolvedValue({ plan: { hasAnalysisAccess: false } });
    mocks.unlockStatus.mockResolvedValue(status(true));
    mocks.sale.mockResolvedValue({ ...EXAMPLE_SALE, id: "sale" });

    renderPage();

    await screen.findByText("Vente débloquée");
    expect(mocks.sale).toHaveBeenCalledWith("sale", { discovery: false, unlocked: true });
    // The full catalogue view stays closed to an unlock: the sale comes from its own view.
    expect(mocks.sale).not.toHaveBeenCalledWith("sale", { discovery: false, unlocked: false });
    expect(screen.queryByText("Offre Découverte")).toBeNull();
  });

  it("falls back to the free view when the sale leaves the catalogue after the check", async () => {
    mocks.entitlements.mockResolvedValue({ plan: { hasAnalysisAccess: false } });
    mocks.unlockStatus.mockResolvedValue(status(true));
    mocks.sale.mockImplementation(async (_id: string, options: { discovery: boolean }) =>
      options.discovery ? { ...EXAMPLE_SALE, id: "sale" } : null,
    );

    renderPage();

    await screen.findByText("Vente débloquée");
    expect(mocks.sale).toHaveBeenCalledWith("sale", { discovery: true });
  });

  it("retries once, then keeps the free view with a notice and a retry button", async () => {
    mocks.entitlements.mockResolvedValue({ plan: { hasAnalysisAccess: false } });
    mocks.unlockStatus.mockRejectedValue(new Error("indisponible"));
    mocks.sale.mockResolvedValue({ ...EXAMPLE_SALE, id: "sale" });

    renderPage();

    const alert = await screen.findByRole("alert", {}, { timeout: 5000 });
    expect(alert.textContent).toContain("État de vos déblocages indisponible");
    expect(mocks.unlockStatus).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Offre Découverte")).toBeTruthy();
    expect(screen.getByTestId("remaining").textContent).toBe("inconnu");
  });

  it("shows the unlocked sale once the retry button reads the status", async () => {
    mocks.entitlements.mockResolvedValue({ plan: { hasAnalysisAccess: false } });
    mocks.unlockStatus.mockRejectedValueOnce(new Error("indisponible"));
    mocks.unlockStatus.mockRejectedValueOnce(new Error("indisponible"));
    mocks.unlockStatus.mockResolvedValue(status(true));
    mocks.sale.mockResolvedValue({ ...EXAMPLE_SALE, id: "sale" });

    renderPage();
    await screen.findByRole("alert", {}, { timeout: 5000 });
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));

    await screen.findByText("Vente débloquée");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("never asks for an unlock status from an Analyse account whose rights are already known", async () => {
    mocks.sale.mockResolvedValue({ ...EXAMPLE_SALE, id: "sale" });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.featureEntitlementsPlan("test"), {
      plan: { hasAnalysisAccess: true },
    });

    render(
      <QueryClientProvider client={client}>
        <SaleDetailPage id="sale" />
      </QueryClientProvider>,
    );

    await screen.findByText("Analyse premium");
    expect(mocks.unlockStatus).not.toHaveBeenCalled();
    expect(mocks.entitlements).not.toHaveBeenCalled();
    // Only the listing of the Analyse view is read: no read-ahead of the free one.
    expect(mocks.sale).toHaveBeenCalledTimes(1);
    expect(mocks.sale).toHaveBeenCalledWith("sale", { discovery: false, unlocked: false });
  });

  it("never asks for an unlock status from an Analyse account, even while its rights are read", async () => {
    mocks.entitlements.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ plan: { hasAnalysisAccess: true } }), 30),
        ),
    );
    mocks.unlockStatus.mockResolvedValue(status(true));
    mocks.sale.mockResolvedValue({ ...EXAMPLE_SALE, id: "sale" });

    renderPage();
    // The free listing is read ahead, but it is never displayed to this account.
    await waitFor(() => expect(mocks.sale).toHaveBeenCalledWith("sale", expect.anything()));
    expect(mocks.unlockStatus).not.toHaveBeenCalled();
    expect(screen.queryByText("Offre Découverte")).toBeNull();

    await screen.findByText("Analyse premium");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.unlockStatus).not.toHaveBeenCalled();
    expect(screen.queryByText("Offre Découverte")).toBeNull();
    expect(screen.queryByText("Vente débloquée")).toBeNull();
  });

  it("reads the free listing while the rights are read, and the unlock status only after them", async () => {
    let grantRights: (plan: unknown) => void = () => undefined;
    mocks.entitlements.mockImplementation(() => new Promise((resolve) => (grantRights = resolve)));
    mocks.unlockStatus.mockResolvedValue(status(false));
    mocks.sale.mockResolvedValue({ ...EXAMPLE_SALE, id: "sale" });

    renderPage();

    // The free listing starts before the rights answer…
    await waitFor(() => expect(mocks.sale).toHaveBeenCalledTimes(1));
    expect(mocks.sale).toHaveBeenCalledWith("sale", { discovery: true, unlocked: false });
    // …the unlock status does not, and nothing is displayed until the rights answer.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.unlockStatus).not.toHaveBeenCalled();
    expect(screen.queryByText("Offre Découverte")).toBeNull();

    grantRights({ plan: { hasAnalysisAccess: false } });

    await screen.findByText("Offre Découverte");
    // The listing read ahead is reused, not read a second time.
    expect(mocks.sale).toHaveBeenCalledTimes(1);
    expect(mocks.unlockStatus).toHaveBeenCalledTimes(1);
  });

  it("does not mark a listing as viewed before the access is known", async () => {
    mocks.entitlements.mockImplementation(() => new Promise(() => undefined));
    mocks.unlockStatus.mockResolvedValue(status(false));
    mocks.sale.mockResolvedValue({ ...EXAMPLE_SALE, id: "sale" });

    renderPage();
    await waitFor(() => expect(mocks.sale).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(markSaleViewed).not.toHaveBeenCalled();
  });

  it("switches to the unlocked view as soon as the unlock is confirmed", async () => {
    mocks.entitlements.mockResolvedValue({ plan: { hasAnalysisAccess: false } });
    mocks.unlockStatus.mockResolvedValue(status(false));
    mocks.sale.mockResolvedValue({ ...EXAMPLE_SALE, id: "sale" });

    renderPage();
    await screen.findByText("Offre Découverte");
    fireEvent.click(screen.getByRole("button", { name: "Simuler le déblocage" }));

    await screen.findByText("Vente débloquée");
    expect(mocks.sale).toHaveBeenCalledWith("sale", { discovery: false, unlocked: true });
  });

  describe("right after « Confirmer le déblocage »", () => {
    const free = { ...EXAMPLE_SALE, id: "sale" };
    const setup = (unlockedRead: () => Promise<unknown>) => {
      mocks.entitlements.mockResolvedValue({ plan: { hasAnalysisAccess: false } });
      mocks.unlockStatus.mockResolvedValue(status(false));
      mocks.sale.mockImplementation(async (_id: string, options: { unlocked?: boolean }) =>
        options.unlocked ? unlockedRead() : free,
      );
    };

    it("keeps the free view on screen with a status banner while the detail loads", async () => {
      setup(() => new Promise(() => undefined));
      renderPage();
      await screen.findByText("Offre Découverte");
      fireEvent.click(screen.getByRole("button", { name: "Simuler le déblocage" }));

      const banner = await screen.findByRole("status");
      expect(banner.textContent).toBe("Vente débloquée. Chargement du détail…");
      // No blank skeleton: the view that was on screen is still there.
      expect(screen.getByText("Offre Découverte")).toBeTruthy();
      expect(screen.queryByRole("status", { name: "Chargement de la fiche" })).toBeNull();
    });

    it("replaces the banner with the unlocked view once it is read", async () => {
      let finish: (sale: unknown) => void = () => undefined;
      setup(() => new Promise((resolve) => (finish = resolve)));
      renderPage();
      await screen.findByText("Offre Découverte");
      fireEvent.click(screen.getByRole("button", { name: "Simuler le déblocage" }));
      await screen.findByRole("status");

      finish(free);

      await screen.findByText("Vente débloquée");
      expect(screen.queryByText("Offre Découverte")).toBeNull();
      expect(screen.queryByRole("status")).toBeNull();
    });

    it("says the unlock is kept when the detail cannot be read, with a retry and no error page", async () => {
      let attempt = 0;
      setup(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("boom");
        return free;
      });
      renderPage();
      await screen.findByText("Offre Découverte");
      fireEvent.click(screen.getByRole("button", { name: "Simuler le déblocage" }));

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain(
        "Vente débloquée, mais le détail n’a pas pu être chargé. Votre déblocage est conservé.",
      );
      // Nothing was thrown to the error page: the free view is still rendered.
      expect(screen.getByText("Offre Découverte")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));

      await screen.findByText("Vente débloquée");
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("still ends on the error page when the first read of the sale fails", async () => {
      mocks.entitlements.mockResolvedValue({ plan: { hasAnalysisAccess: false } });
      mocks.unlockStatus.mockResolvedValue(status(false));
      mocks.sale.mockRejectedValue(new Error("boom"));
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const Boundary = class extends Component<{ children: ReactNode }, { failed: boolean }> {
        state = { failed: false };
        static getDerivedStateFromError() {
          return { failed: true };
        }
        render() {
          return this.state.failed ? <p>Erreur affichée</p> : this.props.children;
        }
      };
      render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <Boundary>
            <SaleDetailPage id="sale" />
          </Boundary>
        </QueryClientProvider>,
      );
      await screen.findByText("Erreur affichée");
    });
  });
});
