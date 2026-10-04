// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminInformationAgentReviewPanel } from "./AdminInformationAgentReviewPanel";

const mocks = vi.hoisted(() => ({
  fetchEvidenceUrl: vi.fn(),
  fetchReview: vi.fn(),
  reviewFact: vi.fn(),
  updateRights: vi.fn(),
}));

vi.mock("@/lib/client-api", () => ({
  fetchAdminInformationAgentEvidenceUrlClient: mocks.fetchEvidenceUrl,
  fetchAdminInformationAgentReview: mocks.fetchReview,
  reviewAdminInformationAgentFactClient: mocks.reviewFact,
  updateAdminInformationAgentEvidenceRightsClient: mocks.updateRights,
}));

vi.mock("@/lib/router-compat", () => ({
  Link: ({
    to,
    params,
    children,
    ...props
  }: {
    to: string;
    params: Record<string, string>;
    children: React.ReactNode;
  }) => (
    <a href={to.replace("$id", params.id)} {...props}>
      {children}
    </a>
  ),
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe("AdminInformationAgentReviewPanel", () => {
  it("identifies the sale and contact before an admin reviews a fact", async () => {
    mocks.fetchReview.mockResolvedValue({
      facts: [
        {
          id: "44444444-4444-4444-8444-444444444444",
          case_id: "33333333-3333-4333-8333-333333333333",
          sale_id: "11111111-1111-4111-8111-111111111111",
          fact_key: "surface_m2",
          display_value: "70 m²",
          confidence: 0.95,
          evidence_asset_id: null,
          evidence_excerpt: "La surface habitable est de 70 m².",
        },
      ],
      cases: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          recipient_name: "Maître Dupont",
          recipient_email: "cabinet@example.test",
          subject: "Informations complémentaires — vente de Bordeaux",
        },
      ],
      assets: [],
      extractions: [],
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AdminInformationAgentReviewPanel />
      </QueryClientProvider>,
    );

    expect(await screen.findByText(/Maître Dupont/)).toBeTruthy();
    expect(screen.getByText(/cabinet@example\.test/)).toBeTruthy();
    expect(screen.getByText(/Dossier 33333333/)).toBeTruthy();
    expect(screen.getByText(/Informations complémentaires/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Voir l’annonce 11111111/ }).getAttribute("href")).toBe(
      "/sales/11111111-1111-4111-8111-111111111111",
    );
  });

  it("shows an unexpected sender without offering a fact to accept", async () => {
    mocks.fetchReview.mockResolvedValue({
      facts: [],
      assets: [],
      extractions: [],
      messages: [
        {
          id: "message-1",
          case_id: "33333333-3333-4333-8333-333333333333",
          from_email: "other@example.test",
          subject: "Re: Vente A",
          body_text: `Je vous transmets une information. ${"Suite du message. ".repeat(40)}`,
          metadata: { sender_matches_recipient: false },
        },
      ],
      cases: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          sale_id: "11111111-1111-4111-8111-111111111111",
          recipient_email: "contact@example.test",
        },
      ],
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AdminInformationAgentReviewPanel />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Expéditeur à vérifier")).toBeTruthy();
    expect(screen.getByText(/other@example\.test/)).toBeTruthy();
    expect(screen.getByText(/contact@example\.test/)).toBeTruthy();
    expect(screen.getByText("Lire le message complet")).toBeTruthy();
    expect(
      screen
        .getAllByText(/Suite du message\./)
        .some((node) => (node.textContent?.length ?? 0) > 500),
    ).toBe(true);
    expect(screen.queryByRole("button", { name: "Accepter" })).toBeNull();
  });

  it("labels a manually imported message separately from a verified reply", async () => {
    mocks.fetchReview.mockResolvedValue({
      facts: [],
      assets: [],
      extractions: [],
      messages: [
        {
          id: "message-manual",
          case_id: "33333333-3333-4333-8333-333333333333",
          from_email: "contact@example.test",
          subject: "Réponse transmise par téléphone",
          body_text: "Le bien est libre.",
          metadata: { imported_manually: true, content_trust: "untrusted" },
        },
      ],
      cases: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          sale_id: "11111111-1111-4111-8111-111111111111",
          recipient_email: "contact@example.test",
        },
      ],
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AdminInformationAgentReviewPanel />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Import manuel — expéditeur non vérifié")).toBeTruthy();
    expect(screen.getByText(/l’adresse affichée est un rattachement de dossier/)).toBeTruthy();
  });

  it("keeps attachment acceptance disabled until analysis and rights checks finish", async () => {
    mocks.fetchReview.mockResolvedValue({
      facts: [
        {
          id: "fact-1",
          case_id: "33333333-3333-4333-8333-333333333333",
          sale_id: "11111111-1111-4111-8111-111111111111",
          fact_key: "document",
          display_value: "Surface extraite : 70 m²",
          confidence: 1,
          evidence_asset_id: "asset-1",
          evidence_excerpt: null,
        },
      ],
      cases: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          status: "review",
        },
      ],
      assets: [{ id: "asset-1", rights_status: "authorized", original_filename: "pv.pdf" }],
      extractions: [{ asset_id: "asset-1", status: "needs_password" }],
      messages: [],
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AdminInformationAgentReviewPanel />
      </QueryClientProvider>,
    );

    expect(await screen.findByText(/Surface extraite : 70 m²/)).toBeTruthy();
    expect(screen.getByText("Pièce jointe : pv.pdf")).toBeTruthy();
    expect(screen.getByText(/Analyse : needs_password/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Accepter" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("shows a vision summary as review-only text and surfaces extraction details", async () => {
    mocks.fetchReview.mockResolvedValue({
      facts: [
        {
          id: "fact-vision",
          case_id: "33333333-3333-4333-8333-333333333333",
          sale_id: "11111111-1111-4111-8111-111111111111",
          fact_key: "photo",
          display_value: "Photo reçue",
          confidence: 0.82,
          evidence_asset_id: "asset-vision",
          evidence_excerpt: null,
          source_page: 2,
        },
      ],
      cases: [{ id: "33333333-3333-4333-8333-333333333333", status: "review" }],
      assets: [
        {
          id: "asset-vision",
          mime_type: "image/jpeg",
          rights_status: "authorized",
          original_filename: "facade.jpg",
        },
      ],
      extractions: [
        {
          asset_id: "asset-vision",
          status: "completed",
          summary: "Observation visuelle : <b>façade</b>",
          error_message: null,
        },
      ],
      messages: [],
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <AdminInformationAgentReviewPanel />
      </QueryClientProvider>,
    );

    expect(await screen.findByText(/Résumé de l’analyse — à vérifier/)).toBeTruthy();
    expect(screen.getByText("Observation visuelle : <b>façade</b>")).toBeTruthy();
    expect(screen.getByText("Page source : 2")).toBeTruthy();
    expect(container.querySelector("b")).toBeNull();
  });

  it.each(["unsupported", "failed"] as const)(
    "shows a readable extraction error for %s evidence",
    async (status) => {
      mocks.fetchReview.mockResolvedValue({
        facts: [
          {
            id: "fact-" + status,
            case_id: "33333333-3333-4333-8333-333333333333",
            sale_id: "11111111-1111-4111-8111-111111111111",
            fact_key: "document",
            display_value: "Document reçu",
            confidence: 0.4,
            evidence_asset_id: "asset-" + status,
            evidence_excerpt: null,
          },
        ],
        cases: [{ id: "33333333-3333-4333-8333-333333333333", status: "review" }],
        assets: [
          {
            id: "asset-" + status,
            mime_type: "application/octet-stream",
            rights_status: "authorized",
            original_filename: "piece.bin",
          },
        ],
        extractions: [
          {
            asset_id: "asset-" + status,
            status,
            summary: null,
            error_message: "Format de pièce non pris en charge.",
          },
        ],
        messages: [],
      });

      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={client}>
          <AdminInformationAgentReviewPanel />
        </QueryClientProvider>,
      );

      const error = await screen.findByRole("alert");
      expect(error.textContent).toContain(
        "Erreur d’analyse : Format de pièce non pris en charge.",
      );
    },
  );

  it("opens a private attachment and records the administrator rights decision", async () => {
    mocks.fetchReview.mockResolvedValue({
      facts: [
        {
          id: "fact-rights",
          case_id: "33333333-3333-4333-8333-333333333333",
          sale_id: "11111111-1111-4111-8111-111111111111",
          fact_key: "document",
          display_value: "Procès-verbal reçu",
          confidence: 0.94,
          evidence_asset_id: "asset-rights",
          evidence_excerpt: "Le document précise la surface habitable.",
        },
      ],
      cases: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          status: "review",
          recipient_email: "cabinet@example.test",
        },
      ],
      assets: [
        {
          id: "asset-rights",
          rights_status: "unverified",
          original_filename: "pv.pdf",
        },
      ],
      extractions: [{ asset_id: "asset-rights", status: "completed" }],
      messages: [],
    });
    mocks.fetchEvidenceUrl.mockResolvedValue("https://storage.example.test/signed-pv");
    mocks.updateRights.mockResolvedValue({
      ok: true,
      asset: { id: "asset-rights", rights_status: "authorized", review_status: "pending" },
    });
    const location = { assign: vi.fn() };
    const openedWindow = { close: vi.fn(), location, opener: null } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(openedWindow);

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AdminInformationAgentReviewPanel />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Pièce jointe : pv.pdf")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Ex. autorisation reçue dans le message"), {
      target: { value: "Autorisation reçue par retour de mail" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Consulter la pièce" }));
    fireEvent.click(screen.getByRole("button", { name: "Autoriser la diffusion" }));

    await waitFor(() => {
      expect(mocks.fetchEvidenceUrl).toHaveBeenCalledWith("asset-rights");
      expect(location.assign).toHaveBeenCalledWith("https://storage.example.test/signed-pv");
      expect(mocks.updateRights.mock.calls[0]?.[0]).toEqual({
        assetId: "asset-rights",
        rightsStatus: "authorized",
        notes: "Autorisation reçue par retour de mail",
      });
    });
  });

  it("previews a supported private attachment inside the review panel", async () => {
    mocks.fetchReview.mockResolvedValue({
      facts: [
        {
          id: "fact-preview",
          case_id: "33333333-3333-4333-8333-333333333333",
          sale_id: "11111111-1111-4111-8111-111111111111",
          fact_key: "document",
          display_value: "Procès-verbal reçu",
          confidence: 0.94,
          evidence_asset_id: "asset-preview",
          evidence_excerpt: "Le document précise la surface habitable.",
        },
      ],
      cases: [{ id: "33333333-3333-4333-8333-333333333333", status: "review" }],
      assets: [
        {
          id: "asset-preview",
          mime_type: "application/pdf",
          rights_status: "authorized",
          original_filename: "pv.pdf",
        },
      ],
      extractions: [{ asset_id: "asset-preview", status: "completed" }],
      messages: [],
    });
    mocks.fetchEvidenceUrl.mockResolvedValue(
      "https://storage.example.test/private-preview?token=short-lived",
    );

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AdminInformationAgentReviewPanel />
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Prévisualiser la pièce" }));
    const preview = await screen.findByTitle("Aperçu privé de pv.pdf");
    expect(preview.getAttribute("src")).toBe(
      "https://storage.example.test/private-preview?token=short-lived",
    );
    expect(preview.getAttribute("sandbox")).toBe("");
    expect(preview.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(screen.getByText(/l’original reste dans le stockage privé/)).toBeTruthy();
  });

  it("allows acceptance only when a document is authorized and analyzed", async () => {
    mocks.fetchReview.mockResolvedValue({
      facts: [
        {
          id: "fact-ready",
          case_id: "33333333-3333-4333-8333-333333333333",
          sale_id: "11111111-1111-4111-8111-111111111111",
          fact_key: "document",
          display_value: "Surface extraite : 70 m²",
          confidence: 1,
          evidence_asset_id: "asset-ready",
          evidence_excerpt: null,
        },
      ],
      cases: [{ id: "33333333-3333-4333-8333-333333333333", status: "review" }],
      assets: [{ id: "asset-ready", rights_status: "authorized", original_filename: "pv.pdf" }],
      extractions: [{ asset_id: "asset-ready", status: "completed" }],
      messages: [],
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AdminInformationAgentReviewPanel />
      </QueryClientProvider>,
    );

    expect(await screen.findByText(/Droits de diffusion : autorisés/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Accepter" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("disables acceptance when the case is already completed", async () => {
    mocks.fetchReview.mockResolvedValue({
      facts: [
        {
          id: "fact-closed",
          case_id: "33333333-3333-4333-8333-333333333333",
          sale_id: "11111111-1111-4111-8111-111111111111",
          fact_key: "surface_m2",
          display_value: "70 m²",
          confidence: 0.9,
          evidence_asset_id: null,
          evidence_excerpt: null,
        },
      ],
      cases: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          status: "completed",
        },
      ],
      assets: [],
      extractions: [],
      messages: [],
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AdminInformationAgentReviewPanel />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText(/Le dossier est fermé ou indisponible pour cette revue/),
    ).toBeTruthy();
    expect((screen.getByRole("button", { name: "Accepter" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("shows the reason a contact's attachment could not be processed", async () => {
    mocks.fetchReview.mockResolvedValue({
      facts: [],
      assets: [],
      extractions: [],
      cases: [],
      messages: [
        {
          id: "message-2",
          case_id: null,
          from_email: "contact@example.test",
          subject: "Documents",
          body_text: "Pièce jointe.",
          metadata: {
            sender_matches_recipient: true,
            rejected_attachments: [
              { filename: "cahier.docx", reason: "Format non pris en charge" },
            ],
          },
        },
      ],
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AdminInformationAgentReviewPanel />
      </QueryClientProvider>,
    );

    expect(await screen.findByText(/Pièce non traitée : cahier.docx/)).toBeTruthy();
  });

  it("explains when a late response was ignored after case closure", async () => {
    mocks.fetchReview.mockResolvedValue({
      facts: [],
      assets: [],
      extractions: [],
      cases: [],
      messages: [
        {
          id: "message-closed",
          case_id: null,
          from_email: "contact@example.test",
          subject: "Réponse tardive",
          body_text: "Voici les informations demandées.",
          metadata: { processing_ignored_case_status: "completed" },
        },
      ],
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AdminInformationAgentReviewPanel />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText(/Réponse reçue après la clôture du dossier \(completed\)/),
    ).toBeTruthy();
    expect(screen.getByText(/aucun candidat n’a été créé/)).toBeTruthy();
  });

  it("lets an admin reach an older response beyond the first page", async () => {
    const messageCursor = JSON.stringify({
      createdAt: "2026-09-23T13:15:00.000Z",
      id: "22222222-2222-4222-8222-222222222222",
    });
    mocks.fetchReview.mockImplementation(
      async ({ messageCursor: requestedCursor }: { messageCursor?: string }) => ({
        facts: [],
        assets: [],
        extractions: [],
        cases: [],
        messages: [
          {
            id: requestedCursor ? "message-old" : "message-new",
            case_id: null,
            from_email: "contact@example.test",
            subject: requestedCursor ? "Ancienne réponse" : "Réponse récente",
            body_text: requestedCursor ? "Ancien contenu à contrôler" : "Contenu récent",
            metadata: {},
          },
        ],
        hasMoreMessages: !requestedCursor,
        nextMessagesCursor: messageCursor,
      }),
    );

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AdminInformationAgentReviewPanel />
      </QueryClientProvider>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Charger les réponses précédentes" }),
    );
    expect(await screen.findByText("Ancien contenu à contrôler")).toBeTruthy();
    expect(mocks.fetchReview).toHaveBeenCalledWith({
      factCursor: "__done__",
      messageCursor,
    });
  });

  it("lets an admin reach facts beyond the first page", async () => {
    const factCursor = JSON.stringify({
      createdAt: "2026-09-23T13:15:00.000Z",
      id: "33333333-3333-4333-8333-333333333333",
    });
    mocks.fetchReview.mockImplementation(
      async ({ factCursor: requestedCursor }: { factCursor?: string }) => ({
        facts: [
          {
            id: requestedCursor ? "fact-old" : "fact-new",
            case_id: "33333333-3333-4333-8333-333333333333",
            sale_id: "11111111-1111-4111-8111-111111111111",
            fact_key: "surface_m2",
            display_value: requestedCursor ? "60 m²" : "70 m²",
            confidence: 0.9,
            evidence_asset_id: null,
            evidence_excerpt: null,
          },
        ],
        assets: [],
        extractions: [],
        cases: [],
        messages: [],
        hasMoreFacts: !requestedCursor,
        nextFactsCursor: factCursor,
        hasMoreMessages: false,
        nextMessagesCursor: null,
      }),
    );

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AdminInformationAgentReviewPanel />
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Charger plus d’informations" }));
    expect(await screen.findByText("60 m²")).toBeTruthy();
    expect(mocks.fetchReview).toHaveBeenCalledWith({
      factCursor,
      messageCursor: "__done__",
    });
  });
});
