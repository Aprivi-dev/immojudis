// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PublicationRequestDetail,
  PublicationRequestSummary,
} from "@/lib/publication-requests-client";
import type { AccountProfile } from "@/lib/account";
import { ProfessionalWorkspacePage } from "./professional-workspace-page";

const mocks = vi.hoisted(() => ({
  auth: {
    user: {
      id: "user-1",
      email: "pro@example.test",
    },
    profile: {
      user_id: "user-1",
      email: "pro@example.test",
      full_name: null,
      account_type: "b2b" as const,
      account_tier: "free" as const,
      user_role: "user" as const,
      professional_role: "lawyer" as const,
      organization_name: "Cabinet Exemple",
      professional_status: "approved" as const,
    },
    loading: false,
  } as {
    user: { id: string; email: string } | null;
    profile: AccountProfile | null;
    loading: boolean;
  },
  list: vi.fn(),
  detail: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => mocks.auth,
}));

vi.mock("@/lib/publication-requests-client", () => ({
  fetchAllPublicationRequestsClient: mocks.list,
  fetchPublicationRequestClient: mocks.detail,
}));

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.user = { id: "user-1", email: "pro@example.test" };
  mocks.auth.profile = {
    user_id: "user-1",
    email: "pro@example.test",
    full_name: null,
    account_type: "b2b",
    account_tier: "free",
    user_role: "user",
    professional_role: "lawyer",
    organization_name: "Cabinet Exemple",
    professional_status: "approved",
  };
  mocks.auth.loading = false;
  mocks.list.mockResolvedValue({ requests: [] });
  mocks.detail.mockResolvedValue({ request: publicationDetail() });
});

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ProfessionalWorkspacePage />
    </QueryClientProvider>,
  );
}

function publicationSummary(
  overrides: Partial<PublicationRequestSummary> = {},
): PublicationRequestSummary {
  return {
    id: "7d335032-e935-4550-9347-ed22b0f63449",
    requesterId: "user-1",
    requesterEmail: "pro@example.test",
    status: "pending",
    title: "Maison judiciaire à Bordeaux",
    location: "Bordeaux",
    startingPriceEur: 180_000,
    hearingDate: "2026-11-04",
    court: "TJ Bordeaux",
    description: "Une maison avec jardin.",
    strengths: "Jardin",
    cautions: "Occupation à vérifier",
    anonymizeDocuments: true,
    documentTypes: ["Cahier des conditions de vente"],
    promotionOptions: ["featured"],
    documentCount: 1,
    adminNotes: null,
    publishedSaleId: null,
    publishedAt: null,
    publishedUrl: null,
    reviewedAt: null,
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
    ...overrides,
  };
}

function publicationDetail(): PublicationRequestDetail {
  return {
    ...publicationSummary(),
    documents: [
      {
        name: "cahier.pdf",
        size: 2048,
        mime_type: "application/pdf",
        uploaded_at: "2026-10-01T10:00:00.000Z",
        signedUrl: "https://storage.example.test/signed-document",
      },
    ],
  };
}

describe("ProfessionalWorkspacePage", () => {
  it("keeps a pending professional in the workspace with existing requests", async () => {
    mocks.auth.profile = { ...mocks.auth.profile!, professional_status: "pending" };
    mocks.list.mockResolvedValue({ requests: [publicationSummary()] });

    renderPage();

    expect(
      await screen.findByText(/Votre compte professionnel est en cours de validation/),
    ).toBeTruthy();
    expect(
      await screen.findByRole("button", { name: /Maison judiciaire à Bordeaux/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Nouvelle demande/ })).toBeNull();
  });

  it("loads the selected request and exposes only its signed document URL", async () => {
    const summary = publicationSummary({
      status: "approved",
      publishedSaleId: "sale-1",
      publishedAt: "2026-10-03T10:00:00.000Z",
      publishedUrl: "/sales/sale-1",
    });
    mocks.list.mockResolvedValue({ requests: [summary] });
    mocks.detail.mockResolvedValue({ request: { ...publicationDetail(), ...summary } });

    renderPage();

    const card = await screen.findByRole("button", { name: /Maison judiciaire à Bordeaux/ });
    expect(screen.getByText("Validée")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Voir la vente publiée/ }).getAttribute("href")).toBe(
      "/sales/sale-1",
    );

    fireEvent.click(card);

    await waitFor(() => expect(mocks.detail).toHaveBeenCalledWith(summary.id));
    expect((await screen.findByRole("link", { name: "Ouvrir" })).getAttribute("href")).toBe(
      "https://storage.example.test/signed-document",
    );
  });

  it("explains the login path to signed-out visitors without calling the private API", () => {
    mocks.auth.user = null;
    mocks.auth.profile = null;

    renderPage();

    expect(screen.getByRole("heading", { name: /Connectez-vous/ })).toBeTruthy();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  describe("parcours vers l'espace pro (repasse n° 18)", () => {
    it("ouvre le formulaire de connexion, et propose à part la création d'un compte pro", () => {
      mocks.auth.user = null;
      mocks.auth.profile = null;

      renderPage();

      expect(screen.getByRole("link", { name: /Se connecter/ }).getAttribute("href")).toBe(
        "/login?redirect=%2Fespace-pro",
      );
      expect(
        screen.getByRole("link", { name: "Créer un compte professionnel" }).getAttribute("href"),
      ).toBe("/login?mode=professional&redirect=%2Fespace-pro");
    });

    it("n'envoie pas un compte connecté non professionnel vers la connexion (boucle)", () => {
      mocks.auth.profile = {
        ...mocks.auth.profile!,
        account_type: "b2c",
        professional_role: null,
        professional_status: "not_applicable",
      };

      renderPage();

      expect(
        screen.getByRole("heading", { name: "Cet espace est réservé aux comptes professionnels" }),
      ).toBeTruthy();
      const link = screen.getByRole("link", { name: /Demander un accès pro/ });
      expect(link.getAttribute("href")).toBe("/contact?sujet=professionnel");
      expect(document.querySelector('a[href^="/login"]')).toBeNull();
    });

    it("renvoie un compte refusé vers le contact « Espace professionnel »", () => {
      mocks.auth.profile = { ...mocks.auth.profile!, professional_status: "rejected" };

      renderPage();

      expect(screen.getByRole("link", { name: /Contacter Immojudis/ }).getAttribute("href")).toBe(
        "/contact?sujet=professionnel",
      );
    });

    it("envoie vers le compte, pas vers la connexion, quand l'adresse email manque", () => {
      mocks.auth.user = { id: "user-1", email: "" };

      renderPage();

      expect(screen.getByRole("link", { name: /Gérer mon compte/ }).getAttribute("href")).toBe(
        "/compte",
      );
    });
  });

  it("affiche statuts et alertes aux jetons de la charte, lisibles sur fond clair (repasse n° 6)", async () => {
    mocks.auth.profile = { ...mocks.auth.profile!, professional_status: "pending" };
    mocks.list.mockResolvedValue({
      requests: [
        publicationSummary(),
        publicationSummary({ id: "b", status: "approved", title: "Vente validée" }),
        publicationSummary({ id: "c", status: "rejected", title: "Vente refusée" }),
      ],
    });

    renderPage();

    expect((await screen.findByText("Validée")).className).toContain("text-success");
    expect(screen.getByText("Refusée").className).toContain("text-danger");
    expect(screen.getByText("En attente").className).toContain("text-warning");
    expect(
      screen.getByText(/Votre compte professionnel est en cours de validation/).className,
    ).toContain("bg-warning-tint");
    // Plus aucune couleur claire d'un ancien thème sombre, ni de texte sous 12 px.
    expect(document.body.innerHTML).not.toMatch(
      /text-(?:amber|red|emerald)-(?:50|100)\b|text-\[1[01]px\]|text-\[10px\]|liquid-/,
    );
  });

  it("affiche l'erreur de chargement en bandeau d'alerte", async () => {
    mocks.list.mockRejectedValue(new Error("Service indisponible"));

    renderPage();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Impossible de charger vos demandes.");
    expect(alert.className).toContain("text-danger");
  });
});
