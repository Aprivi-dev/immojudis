// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FavoriteButton } from "./FavoriteButton";

const mocks = vi.hoisted(() => ({
  auth: { user: { id: "alice" } as { id: string } | null, loading: false },
  read: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
  push: vi.fn(),
  fetchFavorites: vi.fn(),
  toastSuccess: vi.fn(),
  track: vi.fn(),
}));
vi.mock("@/lib/product-events", () => ({ trackProductEvent: mocks.track }));

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => mocks.auth }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));
vi.mock("@/lib/client-api", () => ({
  addFavoriteSale: mocks.add,
  removeFavoriteSale: mocks.remove,
  fetchFavoriteSales: mocks.fetchFavorites,
}));
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess, error: vi.fn() } }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => {
      const query = { select: () => query, eq: () => query, maybeSingle: mocks.read };
      return query;
    },
  },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.auth.user = { id: "alice" };
});

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = () => (
    <QueryClientProvider client={client}>
      <FavoriteButton saleId="sale" />
    </QueryClientProvider>
  );
  const rendered = render(view());
  return { client, rerender: () => rendered.rerender(view()) };
}

describe("favorite account isolation", () => {
  it("ignores a previous account's delayed lookup after switching accounts", async () => {
    let resolveAlice!: (value: unknown) => void;
    mocks.read
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveAlice = resolve;
          }),
      )
      .mockResolvedValueOnce({ data: null, error: null });
    const view = setup();
    mocks.auth.user = { id: "bob" };
    view.rerender();
    await waitFor(() =>
      expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(false),
    );
    await act(async () => resolveAlice({ data: { sale_id: "sale" }, error: null }));
    expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe("false");
  });

  it("does not apply an old account's mutation result to the next account", async () => {
    let resolveAdd!: () => void;
    mocks.read.mockResolvedValue({ data: null, error: null });
    mocks.add.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveAdd = resolve;
        }),
    );
    const view = setup();
    await waitFor(() =>
      expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(mocks.add).toHaveBeenCalledOnce());
    mocks.auth.user = { id: "bob" };
    view.rerender();
    await act(async () => resolveAdd());
    await waitFor(() =>
      expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(false),
    );
    expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe("false");
    mocks.auth.user = null;
    view.rerender();
    expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe("false");
  });

  it("updates any cached catalogue favorite status after a detail toggle", async () => {
    mocks.read.mockResolvedValue({ data: null, error: null });
    mocks.add.mockResolvedValue({ favorite: { saleId: "sale" } });
    const view = setup();
    view.client.setQueryData(["search-favorite-status", "alice", ["sale"]], []);

    await waitFor(() =>
      expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(mocks.add).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(view.client.getQueryData(["search-favorite-status", "alice", ["sale"]])).toEqual([
        "sale",
      ]),
    );
  });
});

describe("favorite vocabulary and onboarding", () => {
  it("uses « Ajouter aux favoris » then « Retirer des favoris »", async () => {
    mocks.read.mockResolvedValue({ data: { sale_id: "sale" }, error: null });
    setup();
    const button = await screen.findByRole("button", { name: "Retirer des favoris" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: /suivre/i })).toBeNull();
  });

  it("keeps the heart for a visitor and explains the free account in its title", () => {
    mocks.auth.user = null;
    setup();
    const button = screen.getByRole("button", { name: "Ajouter aux favoris" });
    expect(button.getAttribute("title")).toBe(
      "Créer un compte gratuit pour garder cette vente (10 favoris)",
    );
  });

  it("sends a visitor to the sign-up page with the favourite reason", () => {
    mocks.auth.user = null;
    window.history.pushState({}, "", "/sales/abc?from=%2Fsales");
    setup();
    fireEvent.click(screen.getByRole("button"));
    expect(mocks.push).toHaveBeenCalledWith(
      "/login?redirect=%2Fsales%2Fabc%3Ffrom%3D%252Fsales&mode=investor&reason=favori",
    );
  });

  it("tells a Découverte account how many favourites it uses and links to the alerts", async () => {
    mocks.read.mockResolvedValue({ data: null, error: null });
    mocks.add.mockResolvedValue({
      favorite: { saleId: "sale" },
      created: true,
      plan: { limit: 3 },
    });
    mocks.fetchFavorites.mockResolvedValue({
      favorites: [{ saleId: "sale" }, { saleId: "other" }],
      unavailableSaleIds: [],
    });
    setup();
    await waitFor(() =>
      expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledOnce());
    const [message, options] = mocks.toastSuccess.mock.calls[0];
    expect(message).toBe("Vente ajoutée aux favoris : 2 favoris sur 3.");
    expect(options.description.props.href).toBe("/alertes");
  });

  it("does not show a count when the plan has no limit", async () => {
    mocks.read.mockResolvedValue({ data: null, error: null });
    mocks.add.mockResolvedValue({
      favorite: { saleId: "sale" },
      created: true,
      plan: { limit: null },
    });
    setup();
    await waitFor(() =>
      expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledOnce());
    expect(mocks.toastSuccess.mock.calls[0][0]).toBe("Vente ajoutée aux favoris.");
    expect(mocks.fetchFavorites).not.toHaveBeenCalled();
    expect(mocks.track).toHaveBeenCalledOnce();
    expect(mocks.track).toHaveBeenCalledWith("favorite_added");
  });
});

describe("favorite touch target", () => {
  it("garde une hauteur tactile d'au moins 44 px, y compris dans sa version non compacte", () => {
    mocks.read.mockResolvedValue({ data: null, error: null });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <FavoriteButton saleId="sale" />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("button").className).toContain("min-h-11");
    cleanup();
    render(
      <QueryClientProvider client={client}>
        <FavoriteButton saleId="sale" compact />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("button").className).toContain("h-11");
  });
});
