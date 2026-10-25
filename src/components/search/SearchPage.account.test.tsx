// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuctionSale } from "@/lib/types";

// Ce fichier rend toute la page /sales : 5 s (délai par défaut) est trop court sous charge.
vi.setConfig({ testTimeout: 15_000 });

/**
 * Parcours connecté de /sales : la liste publique servie dans le HTML reste à l'écran pendant la
 * vérification du compte et le chargement de la liste connectée (pas de squelette), puis elle est
 * remplacée. Aucune donnée connectée n'est lue ni affichée avant la réponse du serveur sur les
 * droits, la liste d'un compte n'est jamais montrée à un autre, et un échec n'est pas masqué par la
 * liste publique.
 */
const state = vi.hoisted(() => ({
  auth: { user: null as null | { id: string }, loading: true } as {
    user: null | { id: string };
    loading: boolean;
    authError?: string;
    authErrorKind?: "expired" | "unavailable";
    retry?: () => void;
  },
  fetchAccessPlan: vi.fn(),
  fetchSearchResults: vi.fn(),
  fetchSearchCount: vi.fn(),
  fetchSearchPhotoMirrors: vi.fn(),
  fetchSalesAiReviewProjections: vi.fn(),
  fetchNotificationPreferences: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ session: null, authError: null, ...state.auth }),
}));
vi.mock("./MapPanel", () => ({ MapPanel: () => <div data-testid="map-panel" /> }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/sales",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/client-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-api")>()),
  fetchAccessPlan: state.fetchAccessPlan,
  fetchSalesAiReviewProjections: state.fetchSalesAiReviewProjections,
  fetchNotificationPreferences: state.fetchNotificationPreferences,
}));
// Le menu « Mon compte » et le menu mobile lisent les droits par `@/lib/client-billing`, sous la
// même clé de requête que la page : sans ce second mock, le premier composant monté (le menu, déjà
// chargé par un test précédent, s'abonne avant la page) lançait le vrai appel, qui échoue ici, et
// la page partait en Découverte avant la réponse simulée (échec intermittent en CI).
vi.mock("@/lib/client-billing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-billing")>()),
  fetchAccessPlan: state.fetchAccessPlan,
}));
vi.mock("@/lib/search/search-service", () => ({
  fetchSearchResults: state.fetchSearchResults,
  fetchSearchCount: state.fetchSearchCount,
  fetchSearchMapResults: vi.fn(async () => []),
  fetchSearchPhotoMirrors: state.fetchSearchPhotoMirrors,
}));

import { SearchPage } from "./SearchPage";
import {
  ANONYMOUS_PREVIEW_SCOPE,
  salesSearchCountQueryKey,
  salesSearchQueryKey,
} from "@/lib/search/catalog-placeholder";
import { FAVORITE_ANONYMOUS_TITLE, FAVORITE_VERIFYING_TITLE } from "@/components/favorite-feedback";
import { forgetRememberedPhotoMirrors } from "@/lib/photo-mirror";

const PHOTO = "https://www.licitor.com/photos/maison.jpg";
const MIRROR = {
  path640: "s/abc-640.webp",
  path1600: "s/abc-1600.webp",
  width: 1600,
  height: 1200,
};
const MIRROR_FILE = "sale-photos/s/abc-640.webp";
const PHOTO_HOST = new URL(PHOTO).hostname;

/** Vrai si l'image pointe vers l'hôte de la source, directement ou via l'optimiseur d'images. */
function isSourcePhoto(src: string) {
  const candidates = [src];
  try {
    const nested = new URL(src, "https://immojudis.test").searchParams.get("url");
    if (nested) candidates.push(nested);
  } catch {
    // Adresse illisible : seule la valeur brute est examinée.
  }
  return candidates.some((candidate) => {
    try {
      return new URL(candidate, "https://immojudis.test").hostname === PHOTO_HOST;
    } catch {
      return false;
    }
  });
}
/**
 * Champ qu'une carte ne montre que dans une liste déverrouillée (`listingTitle`) : il prouve ce
 * qu'une liste connectée affiche, donc ce que la liste publique ne doit jamais afficher.
 */
const RESERVED_TITLE = "TITRE-RESERVE-AVOCAT";

function publicSale(index: number) {
  return {
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    starting_price_eur: 50_000 + index * 1000,
    sale_venue_type: "tribunal",
    sale_verification_status: "verified",
    city: "Romainville",
    department: "93",
    property_type: "apartment",
    sale_date: "2099-10-20T09:00:00Z",
    app_surface_m2: 50,
    media: [],
  };
}
const publicSales = Array.from({ length: 24 }, (_, index) =>
  publicSale(index),
) as unknown as AuctionSale[];
/** Liste publique du serveur avec la copie de la première photo (`media[].mirror`). */
const publicSalesWithMirror = publicSales.map((sale, index) =>
  index === 0 ? { ...sale, media: [{ type: "image", url: PHOTO, mirror: MIRROR }] } : sale,
) as unknown as AuctionSale[];

/** Liste connectée d'un compte : le titre réservé et la ville portent le nom du compte. */
function connectedListOf(label: string) {
  return [
    {
      ...publicSale(100),
      city: label,
      title: `${RESERVED_TITLE} ${label}`,
      media: [{ type: "image", url: PHOTO }],
    },
    { ...publicSale(101), city: label, title: `${RESERVED_TITLE} ${label} bis` },
  ] as unknown as AuctionSale[];
}
const connectedSales = connectedListOf("Lyon");

const analysisPlan = {
  plan: {
    plan: "analyse",
    hasAnalysisAccess: true,
    features: {
      salesStatistics: "included",
      dpeExplorer: "included",
      salesCsvExport: "included",
      watchedZones: "included",
      smartAlerts: "included",
    },
  },
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function seededClient({
  list = publicSales,
  count = 2276,
}: { list?: AuctionSale[] | null; count?: number | null } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (list) client.setQueryData(salesSearchQueryKey("[]", ANONYMOUS_PREVIEW_SCOPE), list);
  if (count != null) {
    client.setQueryData(salesSearchCountQueryKey("[]", ANONYMOUS_PREVIEW_SCOPE), count);
  }
  return client;
}

function page(client: QueryClient, serverSeeded = true) {
  return (
    <QueryClientProvider client={client}>
      <SearchPage search={{}} serverSeeded={serverSeeded} />
    </QueryClientProvider>
  );
}

function signIn(userId: string) {
  state.auth = { user: { id: userId }, loading: false };
}

const cards = () => screen.queryAllByRole("article");
const bodyText = () => document.body.textContent ?? "";
/** Le titre réservé n'est que dans le nom accessible des liens d'une carte déverrouillée. */
const reservedShown = () => document.querySelector(`[aria-label*="${RESERVED_TITLE}"]`) !== null;
const firstHeart = () => screen.getAllByRole("button", { name: /favoris/i })[0]!;
/** Cartes squelettes de la liste (8 quand la liste se charge sans rien à montrer). */
const skeletonShown = () =>
  document.querySelectorAll('[aria-hidden="true"] > .animate-pulse').length > 0;
/** Le compteur de l'en-tête annonce « Recherche en cours… » tant que le total n'est pas connu. */
const countLoading = () => screen.queryByText("Recherche en cours…") !== null;
const errorShown = () => screen.queryByRole("alert") !== null;

/** `src` / `srcset` posés sur des `<img>`, y compris ceux qu'un rendu suivant remplace aussitôt. */
function recordImageSources() {
  const seen: string[] = [];
  const original = Element.prototype.setAttribute;
  const spy = vi.spyOn(Element.prototype, "setAttribute").mockImplementation(function (
    this: Element,
    name: string,
    value: string,
  ) {
    if (this.tagName === "IMG" && (name === "src" || name === "srcset")) seen.push(value);
    return original.call(this, name, value);
  });
  return { seen, stop: () => spy.mockRestore() };
}

beforeEach(() => {
  forgetRememberedPhotoMirrors();
  state.auth = { user: null, loading: true };
  state.fetchAccessPlan.mockReset();
  state.fetchSearchResults.mockReset();
  state.fetchSearchCount.mockReset();
  state.fetchSearchPhotoMirrors.mockReset().mockResolvedValue(new Map());
  state.fetchSalesAiReviewProjections.mockReset().mockResolvedValue({ projections: [] });
  state.fetchNotificationPreferences
    .mockReset()
    .mockResolvedValue({ preferences: { alertEmailEnabled: false } });
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("/sales : session impossible à vérifier", () => {
  it("garde la liste publique et ajoute le bandeau « Réessayer » / « Se reconnecter »", () => {
    const retry = vi.fn();
    state.auth = {
      user: null,
      loading: false,
      authError: "Votre session n’a pas pu être vérifiée.",
      authErrorKind: "unavailable",
      retry,
    };
    render(page(seededClient()));
    expect(cards()).toHaveLength(24);
    const banner = screen.getByTestId("auth-connection-banner");
    expect(banner.textContent).toContain("Nous n’avons pas pu vérifier votre connexion.");
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: "Se reconnecter" }).getAttribute("href")).toMatch(
      /^\/login\?redirect=/,
    );
  });

  it("n'affiche aucun bandeau pour un visiteur ordinaire", () => {
    state.auth = { user: null, loading: false };
    render(page(seededClient()));
    expect(screen.queryByTestId("auth-connection-banner")).toBeNull();
  });
});

describe("/sales : compte reconnu avec une liste publique déjà affichée", () => {
  it("garde la liste publique, sans squelette, jusqu'à l'arrivée de la liste connectée qui la remplace", async () => {
    const plan = deferred<typeof analysisPlan>();
    const list = deferred<AuctionSale[]>();
    const count = deferred<number>();
    state.fetchAccessPlan.mockReturnValue(plan.promise);
    state.fetchSearchResults.mockReturnValue(list.promise);
    state.fetchSearchCount.mockReturnValue(count.promise);
    const client = seededClient();

    // 1. Le HTML : visiteur anonyme, session en cours de restauration.
    const view = render(page(client));
    expect(cards()).toHaveLength(24);

    // 2. Le compte est reconnu, ses droits sont en cours de vérification côté serveur.
    signIn("user-1");
    view.rerender(page(client));
    expect(cards()).toHaveLength(24);
    expect(skeletonShown()).toBe(false);
    expect(screen.getByText(/2\s?276 annonces/)).toBeTruthy();
    // La liste publique reste en mode aperçu (comme dans le HTML) et rien de connecté n'est lu.
    // Le cœur est désactivé et le dit (au lieu d'un clic sans effet).
    expect(firstHeart().getAttribute("aria-disabled")).toBe("true");
    expect(firstHeart().getAttribute("title")).toBe(FAVORITE_VERIFYING_TITLE);
    expect(state.fetchAccessPlan).toHaveBeenCalledTimes(1);
    expect(state.fetchSearchResults).not.toHaveBeenCalled();
    expect(state.fetchSearchCount).not.toHaveBeenCalled();
    expect(state.fetchSalesAiReviewProjections).not.toHaveBeenCalled();

    // 3. Les droits arrivent : la liste et le décompte partent ensemble, la liste publique reste.
    await act(async () => plan.resolve(analysisPlan));
    await waitFor(() => expect(state.fetchSearchResults).toHaveBeenCalledTimes(1));
    expect(state.fetchSearchCount).toHaveBeenCalledTimes(1);
    expect(state.fetchSearchResults.mock.calls[0]![0]).toMatchObject({
      preview: false,
      discovery: false,
    });
    expect(cards()).toHaveLength(24);
    expect(skeletonShown()).toBe(false);
    expect(state.fetchSalesAiReviewProjections).not.toHaveBeenCalled();

    // 4. La liste connectée arrive (le décompte, lui, tarde) : elle remplace la liste publique.
    await act(async () => list.resolve(connectedSales));
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(screen.getAllByText(/Lyon/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Romainville/)).toBeNull();
    // Le cœur est actif : plus de vérification en cours.
    expect(firstHeart().getAttribute("aria-disabled")).toBeNull();
    expect(firstHeart().getAttribute("title")).toBeNull();
    // Le décompte ne retarde pas la liste : il s'annonce à part.
    expect(skeletonShown()).toBe(false);
    expect(countLoading()).toBe(true);
    await act(async () => count.resolve(2));
    await waitFor(() => expect(countLoading()).toBe(false));
    expect(screen.getByText(/2 annonces/)).toBeTruthy();
  });

  it("le champ réservé n'apparaît ni avant la réponse sur les droits ni dans la liste publique, mais la liste connectée, lancée, le rend", async () => {
    const plan = deferred<typeof analysisPlan>();
    const list = deferred<AuctionSale[]>();
    state.fetchAccessPlan.mockReturnValue(plan.promise);
    state.fetchSearchResults.mockReturnValue(list.promise);
    state.fetchSearchCount.mockResolvedValue(2);
    const client = seededClient();

    // Le HTML anonyme, puis le compte reconnu pendant que ses droits sont vérifiés.
    const view = render(page(client));
    expect(reservedShown()).toBe(false);
    signIn("user-1");
    view.rerender(page(client));
    await act(async () => undefined);
    expect(reservedShown()).toBe(false);
    expect(state.fetchSearchResults).not.toHaveBeenCalled();
    expect(state.fetchSearchCount).not.toHaveBeenCalled();
    expect(state.fetchSalesAiReviewProjections).not.toHaveBeenCalled();
    expect(cards()).toHaveLength(24);

    // Les droits arrivent : la requête connectée est réellement lancée, la liste publique reste
    // sans le champ réservé.
    await act(async () => plan.resolve(analysisPlan));
    await waitFor(() => expect(state.fetchSearchResults).toHaveBeenCalledTimes(1));
    expect(state.fetchSearchResults.mock.calls[0]![0]).toMatchObject({ preview: false });
    expect(cards()).toHaveLength(24);
    expect(bodyText()).toContain("Romainville");
    expect(reservedShown()).toBe(false);

    // La liste connectée est rendue : c'est elle, et elle seule, qui montre le champ réservé.
    await act(async () => list.resolve(connectedSales));
    await waitFor(() => expect(reservedShown()).toBe(true));
    expect(cards()).toHaveLength(2);
    expect(bodyText()).not.toContain("Romainville");
  });

  it("garde le squelette quand le serveur n'a servi aucune liste publique", async () => {
    state.fetchAccessPlan.mockReturnValue(new Promise(() => undefined));
    const client = seededClient({ list: null, count: null });
    const view = render(page(client, false));
    signIn("user-1");
    view.rerender(page(client, false));

    expect(cards()).toHaveLength(0);
    expect(skeletonShown()).toBe(true);
  });
});

describe("/sales : déconnexion et changement de compte", () => {
  it("la déconnexion retire la liste du compte : la liste publique revient, sans donnée connectée", async () => {
    state.fetchAccessPlan.mockResolvedValue(analysisPlan);
    state.fetchSearchResults.mockImplementation(async ({ preview }: { preview: boolean }) =>
      preview ? publicSales : connectedSales,
    );
    state.fetchSearchCount.mockResolvedValue(2);
    signIn("user-1");
    const client = seededClient();
    const view = render(page(client));
    await waitFor(() => expect(reservedShown()).toBe(true));
    expect(cards()).toHaveLength(2);

    state.auth = { user: null, loading: false };
    view.rerender(page(client));
    // Dès le rendu qui suit la déconnexion, pas après une requête.
    expect(reservedShown()).toBe(false);
    await act(async () => undefined);

    expect(reservedShown()).toBe(false);
    expect(bodyText()).not.toContain("Lyon");
    expect(cards()).toHaveLength(24);
    expect(firstHeart().getAttribute("title")).toBe(FAVORITE_ANONYMOUS_TITLE);
    expect(firstHeart().getAttribute("aria-disabled")).toBeNull();
  });

  it("la liste du compte A n'est jamais montrée au compte B", async () => {
    const planB = deferred<typeof analysisPlan>();
    const listB = deferred<AuctionSale[]>();
    state.fetchAccessPlan.mockImplementation(() =>
      state.auth.user?.id === "user-b" ? planB.promise : Promise.resolve(analysisPlan),
    );
    state.fetchSearchResults.mockImplementation(async ({ preview }: { preview: boolean }) =>
      preview
        ? publicSales
        : state.auth.user?.id === "user-b"
          ? listB.promise
          : connectedListOf("Compte-A"),
    );
    state.fetchSearchCount.mockResolvedValue(2);
    signIn("user-a");
    const client = seededClient();
    const view = render(page(client));
    await waitFor(() => expect(bodyText()).toContain("Compte-A"));

    // Le compte B se connecte : A disparaît tout de suite, la liste publique tient la place.
    const leaks: string[] = [];
    const watcher = new MutationObserver(() => {
      if (bodyText().includes("Compte-A")) leaks.push(bodyText());
    });
    watcher.observe(document.body, { subtree: true, childList: true, characterData: true });
    const callsBeforeSwitch = state.fetchSearchResults.mock.calls.length;
    signIn("user-b");
    view.rerender(page(client));
    expect(bodyText()).not.toContain("Compte-A");
    await act(async () => undefined);
    expect(bodyText()).not.toContain("Compte-A");
    expect(cards()).toHaveLength(24);
    expect(firstHeart().getAttribute("aria-disabled")).toBe("true");

    // Les droits de B arrivent, sa liste est demandée : A n'apparaît toujours pas.
    await act(async () => planB.resolve(analysisPlan));
    await waitFor(() =>
      expect(state.fetchSearchResults.mock.calls.length).toBeGreaterThan(callsBeforeSwitch),
    );
    expect(bodyText()).not.toContain("Compte-A");
    expect(cards()).toHaveLength(24);

    await act(async () => listB.resolve(connectedListOf("Compte-B")));
    await waitFor(() => expect(bodyText()).toContain("Compte-B"));
    expect(cards()).toHaveLength(2);
    expect(bodyText()).not.toContain("Compte-A");
    watcher.disconnect();
    expect(leaks).toEqual([]);
  });
});

describe("/sales : échec de la liste connectée et « Réessayer »", () => {
  it("une liste connectée en erreur ne reste pas masquée par la liste publique", async () => {
    state.fetchAccessPlan.mockResolvedValue(analysisPlan);
    state.fetchSearchResults.mockRejectedValue(new Error("Catalogue indisponible"));
    state.fetchSearchCount.mockResolvedValue(0);
    const client = seededClient();
    const view = render(page(client));
    signIn("user-1");
    view.rerender(page(client));

    await waitFor(() => expect(errorShown()).toBe(true));
    expect(cards()).toHaveLength(0);
    expect(bodyText()).not.toContain("Romainville");
  });

  it("Réessayer ne réaffiche pas la liste publique verrouillée, ni pendant le nouvel essai ni après un second échec", async () => {
    const retry = deferred<AuctionSale[]>();
    state.fetchAccessPlan.mockResolvedValue(analysisPlan);
    state.fetchSearchCount.mockResolvedValue(2);
    state.fetchSearchResults
      .mockRejectedValueOnce(new Error("Catalogue indisponible"))
      .mockReturnValueOnce(retry.promise);
    const client = seededClient();
    const view = render(page(client));
    signIn("user-1");
    view.rerender(page(client));
    await waitFor(() => expect(errorShown()).toBe(true));
    expect(cards()).toHaveLength(0);

    // Premier « Réessayer » : le nouvel essai est en cours.
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    await waitFor(() => expect(state.fetchSearchResults).toHaveBeenCalledTimes(2));
    expect(cards()).toHaveLength(0);
    expect(bodyText()).not.toContain("Romainville");
    // Le message reste ou un chargement s'affiche.
    expect(errorShown() || skeletonShown()).toBe(true);

    // Le nouvel essai échoue aussi : le message revient, toujours sans liste publique.
    await act(async () => retry.reject(new Error("Catalogue indisponible")));
    await waitFor(() => expect(errorShown()).toBe(true));
    expect(cards()).toHaveLength(0);
    expect(bodyText()).not.toContain("Romainville");

    // Troisième essai : succès. La liste connectée remplace le message.
    state.fetchSearchResults.mockResolvedValueOnce(connectedSales);
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(reservedShown()).toBe(true);
    expect(bodyText()).not.toContain("Romainville");
    expect(errorShown()).toBe(false);
  });
});

describe("/sales : total de la liste publique", () => {
  it("sans total public, l'en-tête annonce « Recherche en cours… » au lieu de la longueur de la liste", async () => {
    state.fetchAccessPlan.mockReturnValue(new Promise(() => undefined));
    const client = seededClient({ count: null });
    const view = render(page(client));
    signIn("user-1");
    view.rerender(page(client));

    expect(cards()).toHaveLength(24);
    expect(countLoading()).toBe(true);
    expect(bodyText()).not.toMatch(/24\s+annonces/);
  });

  it("avec le total public, il est affiché tel quel", () => {
    state.fetchAccessPlan.mockReturnValue(new Promise(() => undefined));
    const client = seededClient({ count: 2276 });
    const view = render(page(client));
    signIn("user-1");
    view.rerender(page(client));

    expect(countLoading()).toBe(false);
    expect(screen.getByText(/2\s?276 annonces/)).toBeTruthy();
  });
});

describe("/sales : copies de photos de la liste connectée", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_PHOTO_MIRROR", "on");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://ci.supabase.co");
  });

  it("la liste s'affiche sans attendre les copies, qui sont posées ensuite", async () => {
    const mirrors = deferred<Map<string, unknown>>();
    state.fetchAccessPlan.mockResolvedValue(analysisPlan);
    state.fetchSearchResults.mockResolvedValue(connectedSales);
    state.fetchSearchCount.mockResolvedValue(2);
    state.fetchSearchPhotoMirrors.mockReturnValue(mirrors.promise);
    signIn("user-1");

    const { container } = render(page(seededClient({ list: null, count: null }), false));

    await waitFor(() => expect(cards()).toHaveLength(2));
    await waitFor(() => expect(state.fetchSearchPhotoMirrors).toHaveBeenCalledTimes(1));
    // Les copies sont demandées pour les ventes lues, et la liste est déjà à l'écran.
    expect(state.fetchSearchPhotoMirrors.mock.calls[0]![0]).toHaveLength(2);
    expect(container.innerHTML).not.toContain("sale-photos/");
    expect(state.fetchSearchResults.mock.calls[0]![0]).toMatchObject({ withMirrors: false });

    await act(async () => mirrors.resolve(new Map([[PHOTO, MIRROR]])));
    await waitFor(() => expect(container.innerHTML).toContain(MIRROR_FILE));
  });

  it("la liste publique garde sa copie quand la liste connectée, sans copie, la remplace (pas de passage par la source)", async () => {
    const plan = deferred<typeof analysisPlan>();
    const list = deferred<AuctionSale[]>();
    const mirrors = deferred<Map<string, unknown>>();
    state.fetchAccessPlan.mockReturnValue(plan.promise);
    state.fetchSearchResults.mockReturnValue(list.promise);
    state.fetchSearchCount.mockResolvedValue(2);
    // Les copies de la liste connectée arrivent bien après sa liste : seule la mémoire de la liste
    // publique peut empêcher le retour à la photo de la source entre les deux.
    state.fetchSearchPhotoMirrors.mockReturnValue(mirrors.promise);
    const images = recordImageSources();
    try {
      const client = seededClient({ list: publicSalesWithMirror });
      const { container, rerender } = render(page(client));
      expect(container.innerHTML).toContain(MIRROR_FILE);

      signIn("user-1");
      rerender(page(client));
      await act(async () => plan.resolve(analysisPlan));
      await waitFor(() => expect(state.fetchSearchResults).toHaveBeenCalledTimes(1));
      expect(container.innerHTML).toContain(MIRROR_FILE);

      // La liste connectée arrive sans copie : la carte garde la copie, tout de suite.
      await act(async () => list.resolve(connectedSales));
      await waitFor(() => expect(cards()).toHaveLength(2));
      expect(reservedShown()).toBe(true);
      expect(container.innerHTML).toContain(MIRROR_FILE);
      expect(state.fetchSearchPhotoMirrors).toHaveBeenCalledTimes(1);

      // Puis la lecture des copies aboutit : rien ne change pour l'image.
      await act(async () => mirrors.resolve(new Map([[PHOTO, MIRROR]])));
      expect(container.innerHTML).toContain(MIRROR_FILE);
      // Aucune image n'a jamais été posée avec l'URL de la source.
      expect(images.seen.filter((src) => isSourcePhoto(src))).toEqual([]);
      expect(images.seen.some((src) => src.includes(MIRROR_FILE))).toBe(true);
    } finally {
      images.stop();
    }
  });

  it("sans copie dans la liste publique, la photo de la source est celle d'avant (le test ci-dessus détecte bien la source)", async () => {
    const plan = deferred<typeof analysisPlan>();
    state.fetchAccessPlan.mockReturnValue(plan.promise);
    state.fetchSearchResults.mockResolvedValue(connectedSales);
    state.fetchSearchCount.mockResolvedValue(2);
    state.fetchSearchPhotoMirrors.mockReturnValue(new Promise(() => undefined));
    const images = recordImageSources();
    try {
      const client = seededClient({ list: publicSales });
      const { rerender } = render(page(client));
      signIn("user-1");
      rerender(page(client));
      await act(async () => plan.resolve(analysisPlan));
      await waitFor(() => expect(cards()).toHaveLength(2));

      expect(images.seen.some((src) => isSourcePhoto(src))).toBe(true);
      expect(images.seen.some((src) => src.includes(MIRROR_FILE))).toBe(false);
    } finally {
      images.stop();
    }
  });
});
