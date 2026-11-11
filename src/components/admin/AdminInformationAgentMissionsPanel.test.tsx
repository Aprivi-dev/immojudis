// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminInformationAgentMissionsList } from "./AdminInformationAgentMissionsList";
import {
  AdminInformationAgentMissionsPanel,
  type OpenMissionRequest,
} from "./AdminInformationAgentMissionsPanel";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  action: vi.fn(),
  sourceStatus: vi.fn(),
  sourceRefresh: vi.fn(),
  preview: vi.fn(),
}));

vi.mock("@/lib/client-api", () => ({
  fetchAdminInformationAgentMissions: mocks.list,
  createAdminInformationAgentMission: mocks.create,
  runAdminInformationAgentMissionAction: mocks.action,
  previewAdminInformationAgentMission: mocks.preview,
  fetchAdminSourceRefreshStatus: mocks.sourceStatus,
  requestAdminSourceRefresh: mocks.sourceRefresh,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("AdminInformationAgentMissionsPanel", () => {
  it("opens the editable draft after one selection and keeps sending explicit", async () => {
    const draft = mission("draft");
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.create.mockResolvedValue({ ok: true, mission: draft, gaps: [], facts: [] });
    mocks.action.mockResolvedValue({ ok: true, missions: [mission("sent")], facts: [] });
    mocks.preview.mockResolvedValue(previewResponse());
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderPanel();

    expect(screen.queryByRole("button", { name: "Valider et envoyer" })).toBeNull();
    await screen.findByRole("button", { name: "Valider et envoyer" });
    expect(mocks.create.mock.calls[0][0]).toEqual({
      saleId: "11111111-1111-4111-8111-111111111111",
    });
    // Aucun envoi possible avant l'aperçu.
    expect(sendButton().disabled).toBe(true);

    await showPreview();
    // L'aperçu ne suffit pas : la relecture doit être confirmée avant l'envoi.
    expect(sendButton().disabled).toBe(true);
    confirmReview();
    expect(sendButton().disabled).toBe(false);
    fireEvent.click(sendButton());
    await waitFor(() => expect(mocks.action).toHaveBeenCalledTimes(1));
    expect(mocks.action.mock.calls[0][0]).toMatchObject({
      action: "approve_and_send",
      approvalConfirmed: true,
      previewFingerprint: "f".repeat(64),
      recipientEmail: "cabinet@example.test",
    });
    expect(mocks.action.mock.calls[0][0]).not.toHaveProperty("shareRequesterEmail");
  });

  it("lets the admin pick the questions and shows the plain-text version", async () => {
    const draft = { ...mission("draft"), missingInformation: ["documents", "visit", "cadastre"] };
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.create.mockResolvedValue({ ok: true, mission: draft, gaps: [], facts: [] });
    mocks.preview.mockResolvedValue(previewResponse());

    renderPanel();
    await screen.findByRole("button", { name: "Valider et envoyer" });
    expect(screen.getByRole("checkbox", { name: /Pièces du dossier/ })).toHaveProperty(
      "checked",
      true,
    );
    const regenerate = screen.getByRole("button", { name: "Régénérer avec ces questions" });
    expect(regenerate).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("checkbox", { name: /Visites/ }));
    fireEvent.click(regenerate);
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2));
    expect(mocks.create.mock.calls[1][0]).toMatchObject({
      saleId: "11111111-1111-4111-8111-111111111111",
      questionKeys: ["documents", "visit"],
    });

    await showPreview();
    expect(screen.getByText(/Version texte/)).toBeTruthy();
  });

  it("shows why a mission failed and warns about an old draft", async () => {
    const failed = { ...mission("failed"), failureReason: "Resend a refusé l'envoi (422)." };
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.create.mockResolvedValue({ ok: true, mission: failed, gaps: [], facts: [] });

    renderPanel();
    await screen.findByRole("button", { name: "Valider et envoyer" });
    expect(screen.getByText("Motif de l’échec :")).toBeTruthy();
    expect(screen.getByText(/Resend a refusé l'envoi \(422\)\./)).toBeTruthy();
    // Prepared on 19/09: older than three days, the admin is told the preview rereads the sale.
    expect(screen.getByText(/Brouillon préparé il y a plus de 3 jours/)).toBeTruthy();
  });

  it("clears the name when the email changes and keeps the edited message explicit", async () => {
    const draft = mission("draft");
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.create.mockResolvedValue({ ok: true, mission: draft, gaps: [], facts: [] });
    mocks.action.mockResolvedValue({ ok: true, missions: [mission("sent")], facts: [] });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderPanel();
    await screen.findByRole("button", { name: "Valider et envoyer" });
    const name = screen.getByRole("textbox", { name: "Nom du destinataire" }) as HTMLInputElement;
    const email = screen.getByRole("textbox", { name: "Email" }) as HTMLInputElement;
    const body = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    const originalBody = body.value;
    expect(name.value).toBe("Maître Dupont");

    fireEvent.change(email, { target: { value: "new-contact@example.test" } });

    expect(name.value).toBe("");
    expect(body.value).toBe(originalBody);
    expect(
      screen.getByRole("heading", { name: "Brouillon pour new-contact@example.test" }),
    ).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "Relisez le nom et la formule d’appel dans le message",
    );
    mocks.preview.mockResolvedValue(previewResponse());
    await showPreview();
    expect(mocks.preview.mock.calls[0][0]).toMatchObject({
      recipientEmail: "new-contact@example.test",
      recipientName: null,
    });
    confirmReview();
    fireEvent.click(sendButton());
    await waitFor(() => expect(mocks.action).toHaveBeenCalledTimes(1));
    expect(mocks.action.mock.calls[0][0]).toMatchObject({
      recipientEmail: "new-contact@example.test",
      recipientName: null,
      bodyText: originalBody,
    });
  });

  it("restores in-session edits after closing and reopening the same draft", async () => {
    const draft = mission("draft");
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.create.mockResolvedValue({ ok: true, mission: draft, gaps: [], facts: [] });
    const selection = {
      saleId: "11111111-1111-4111-8111-111111111111",
      title: "Appartement à Bordeaux",
      recipientName: "Maître Dupont",
      recipientContact: "cabinet@example.test",
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <AdminInformationAgentMissionsPanel selection={selection} onClose={vi.fn()} />
      </QueryClientProvider>,
    );
    await screen.findByRole("button", { name: "Valider et envoyer" });
    fireEvent.change(screen.getByRole("textbox", { name: "Email" }), {
      target: { value: "verified@example.test" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Nom du destinataire" }), {
      target: { value: "Cabinet vérifié" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Objet" }), {
      target: { value: "Objet relu par l’administration" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Message relu et complété manuellement avant envoi." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Fermer" }));
    view.rerender(
      <QueryClientProvider client={client}>
        <AdminInformationAgentMissionsPanel selection={null} onClose={vi.fn()} />
      </QueryClientProvider>,
    );
    view.rerender(
      <QueryClientProvider client={client}>
        <AdminInformationAgentMissionsPanel selection={selection} onClose={vi.fn()} />
      </QueryClientProvider>,
    );

    await screen.findByRole("button", { name: "Valider et envoyer" });
    expect(
      (screen.getByRole("textbox", { name: "Nom du destinataire" }) as HTMLInputElement).value,
    ).toBe("Cabinet vérifié");
    expect((screen.getByRole("textbox", { name: "Email" }) as HTMLInputElement).value).toBe(
      "verified@example.test",
    );
    expect((screen.getByRole("textbox", { name: "Objet" }) as HTMLInputElement).value).toBe(
      "Objet relu par l’administration",
    );
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe(
      "Message relu et complété manuellement avant envoi.",
    );
  });

  it("does not reuse an arbitrary draft when several contacts exist for the sale", async () => {
    const saleId = "11111111-1111-4111-8111-111111111111";
    mocks.list.mockResolvedValue({
      ok: true,
      missions: [
        mission("failed", saleId, "one@example.test"),
        mission("failed", saleId, "two@example.test"),
      ],
      facts: [],
    });
    mocks.create.mockResolvedValue({
      ok: true,
      mission: mission("draft", saleId, "resolved@example.test"),
      gaps: [],
      facts: [],
    });

    renderPanel({
      saleId,
      title: "Appartement à Bordeaux",
      recipientName: null,
      recipientContact: null,
    });

    await screen.findByRole("button", { name: "Valider et envoyer" });
    expect(mocks.create.mock.calls[0][0]).toEqual({ saleId });
  });

  it("keeps sent mission fields read-only", async () => {
    const sent = mission("sent");
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.create.mockResolvedValue({ ok: true, mission: sent, gaps: [], facts: [] });

    renderPanel();
    await screen.findByRole("heading", { name: "Brouillon pour cabinet@example.test" });
    expect(
      (screen.getByRole("textbox", { name: "Nom du destinataire" }) as HTMLInputElement).readOnly,
    ).toBe(true);
    expect((screen.getByRole("textbox", { name: "Email" }) as HTMLInputElement).readOnly).toBe(
      true,
    );
    expect((screen.getByRole("textbox", { name: "Objet" }) as HTMLInputElement).readOnly).toBe(
      true,
    );
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).readOnly).toBe(
      true,
    );
    expect(screen.queryByRole("button", { name: "Valider et envoyer" })).toBeNull();
  });

  it("does not reopen a sent draft from the local preparation cache", async () => {
    const draft = mission("draft");
    const sent = mission("sent");
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.create.mockResolvedValue({ ok: true, mission: draft, gaps: [], facts: [] });
    mocks.action.mockResolvedValue({ ok: true, missions: [sent], facts: [] });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const selection = {
      saleId: "11111111-1111-4111-8111-111111111111",
      title: "Appartement à Bordeaux",
      recipientName: "Maître Dupont",
      recipientContact: "Tél. 01 02 03 · cabinet@example.test",
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <AdminInformationAgentMissionsPanel selection={selection} onClose={vi.fn()} />
      </QueryClientProvider>,
    );
    await screen.findByRole("button", { name: "Valider et envoyer" });
    mocks.preview.mockResolvedValue(previewResponse());
    await showPreview();
    confirmReview();
    fireEvent.click(sendButton());
    await waitFor(() => expect(mocks.action).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Fermer" }));
    view.rerender(
      <QueryClientProvider client={client}>
        <AdminInformationAgentMissionsPanel selection={null} onClose={vi.fn()} />
      </QueryClientProvider>,
    );
    view.rerender(
      <QueryClientProvider client={client}>
        <AdminInformationAgentMissionsPanel selection={selection} onClose={vi.fn()} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2));
  });

  it("keeps sending blocked while a control fails and after an edit since the preview", async () => {
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.create.mockResolvedValue({ ok: true, mission: mission("draft"), gaps: [], facts: [] });
    mocks.preview.mockResolvedValueOnce(
      previewResponse({ blockers: ["Le contact est explicitement opposé."], fingerprint: null }),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderPanel();
    await screen.findByRole("button", { name: "Valider et envoyer" });
    await showPreview();
    expect(screen.getByRole("alert").textContent).toContain("explicitement opposé");
    expect(sendButton().disabled).toBe(true);

    mocks.preview.mockResolvedValueOnce(previewResponse());
    await showPreview("Actualiser l’aperçu");
    expect(sendButton().disabled).toBe(true);
    confirmReview();
    expect(sendButton().disabled).toBe(false);

    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Message modifié après l’aperçu, à revoir avant tout envoi." },
    });
    expect(sendButton().disabled).toBe(true);
    expect(screen.getByText(/modifié depuis cet aperçu/)).toBeTruthy();
    fireEvent.click(sendButton());
    expect(mocks.action).not.toHaveBeenCalled();
  });

  it("flags an address found by the automatic search and links its source page", async () => {
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.create.mockResolvedValue({ ok: true, mission: mission("draft"), gaps: [], facts: [] });
    mocks.preview.mockResolvedValue(
      previewResponse({
        addressOrigin: {
          text: "Votre adresse professionnelle figure sur le site de votre cabinet ou de votre étude (https://www.cabinet-dupont.fr/contact).",
          url: "https://www.cabinet-dupont.fr/contact",
          automated: true,
          known: true,
        },
      }),
    );

    renderPanel();
    await screen.findByRole("button", { name: "Valider et envoyer" });
    await showPreview();

    const note = screen.getByRole("note");
    expect(note.textContent).toContain("Adresse retrouvée automatiquement");
    const link = within(note).getByRole("link", { name: "Ouvrir la page source" });
    expect(link.getAttribute("href")).toBe("https://www.cabinet-dupont.fr/contact");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("marks a request addressed to a court registry (no lawyer) with a « Greffe » note", async () => {
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.create.mockResolvedValue({ ok: true, mission: mission("draft"), gaps: [], facts: [] });
    mocks.preview.mockResolvedValue(
      previewResponse({
        addressOrigin: {
          text: "adresse de contact de votre juridiction, issue du référentiel des tribunaux tenu par Immojudis ; l’annonce ne donne aucune adresse d’avocat.",
          url: null,
          automated: false,
          courtRegistry: true,
          known: true,
        },
      }),
    );

    renderPanel();
    await screen.findByRole("button", { name: "Valider et envoyer" });
    await showPreview();

    const note = screen.getByRole("note");
    expect(note.textContent).toContain("Greffe");
    expect(note.textContent).toContain("adressée au greffe du tribunal");
    expect(note.textContent).not.toContain("Adresse retrouvée automatiquement");
  });

  it("shows no automatic-search note for an address taken from the listing", async () => {
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.create.mockResolvedValue({ ok: true, mission: mission("draft"), gaps: [], facts: [] });
    mocks.preview.mockResolvedValue(previewResponse());

    renderPanel();
    await screen.findByRole("button", { name: "Valider et envoyer" });
    await showPreview();

    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.queryByText(/retrouvée automatiquement/)).toBeNull();
  });

  it("« Régénérer le brouillon » recrée le brouillon d'une vente de la file, sans attendre un changement de questions", async () => {
    const regenerated = { ...mission("draft"), id: "55555555-5555-4555-8555-555555555555" };
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.create
      .mockResolvedValueOnce({ ok: true, mission: mission("draft"), gaps: [], facts: [] })
      .mockResolvedValueOnce({
        ok: true,
        mission: { ...regenerated, subject: "Objet régénéré" },
        gaps: [],
        facts: [],
      });

    renderPanel();
    await screen.findByRole("button", { name: "Valider et envoyer" });
    const button = screen.getByRole("button", { name: "Régénérer le brouillon" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);

    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2));
    expect(mocks.create.mock.calls[1][0]).toEqual({
      saleId: "11111111-1111-4111-8111-111111111111",
      recipientEmail: "cabinet@example.test",
      recipientName: "Maître Dupont",
    });
    await waitFor(() =>
      expect((screen.getByRole("textbox", { name: "Objet" }) as HTMLInputElement).value).toBe(
        "Objet régénéré",
      ),
    );
  });

  it("« Régénérer le brouillon » vaut aussi pour un brouillon ouvert depuis la liste des envois", async () => {
    // Cas réel : un brouillon d'avant le lot, que l'aperçu refuse en demandant de le régénérer.
    const legacy = mission("draft");
    mocks.list.mockResolvedValue({ ok: true, missions: [legacy], facts: [] });
    mocks.sourceStatus.mockResolvedValue({ ok: true, request: null, history: [] });
    mocks.create.mockResolvedValue({
      ok: true,
      mission: {
        ...legacy,
        id: "55555555-5555-4555-8555-555555555555",
        subject: "Objet régénéré",
      },
      gaps: [],
      facts: [],
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AdminInformationAgentMissionsPanel
          selection={null}
          onClose={vi.fn()}
          openRequest={{ mission: legacy as never, nonce: 1 }}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Régénérer le brouillon" }));

    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.create.mock.calls[0][0]).toEqual({
      saleId: legacy.saleId,
      recipientEmail: "cabinet@example.test",
      recipientName: "Maître Dupont",
    });
    await waitFor(() =>
      expect((screen.getByRole("textbox", { name: "Objet" }) as HTMLInputElement).value).toBe(
        "Objet régénéré",
      ),
    );
  });

  it("aucun bouton « Régénérer le brouillon » sur une mission envoyée", async () => {
    const sent = mission("sent");
    mocks.list.mockResolvedValue({ ok: true, missions: [sent], facts: [] });
    mocks.sourceStatus.mockResolvedValue({ ok: true, request: null, history: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AdminInformationAgentMissionsPanel
          selection={null}
          onClose={vi.fn()}
          openRequest={{ mission: sent as never, nonce: 1 }}
        />
      </QueryClientProvider>,
    );
    await screen.findByText(/Brouillon pour cabinet@example.test/);
    expect(screen.queryByRole("button", { name: "Régénérer le brouillon" })).toBeNull();
  });

  it("montre le rôle du destinataire proposé, l'origine de l'adresse et sa nature", async () => {
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.create.mockResolvedValue({
      ok: true,
      mission: {
        ...mission("draft"),
        recipientProfile: {
          roleLabel: "Notaire",
          addressKind: "generic",
          addressKindLabel: "Adresse générique de la structure",
          originLabel: "Adresse publiée dans l’annonce",
          originSourceName: "notaires",
          originUrl: "https://annonces.example.test/notaires/vente-1",
        },
      },
      gaps: [],
      facts: [],
    });

    renderPanel();
    await screen.findByRole("button", { name: "Valider et envoyer" });
    const profile = screen.getByTestId("recipient-profile");
    expect(profile.textContent).toContain("Notaire");
    expect(profile.textContent).toContain("Adresse publiée dans l’annonce (notaires)");
    expect(profile.textContent).toContain("Adresse générique de la structure");
    expect(within(profile).getByRole("link", { name: "voir l’annonce" }).getAttribute("href")).toBe(
      "https://annonces.example.test/notaires/vente-1",
    );

    // L'administrateur saisit une autre adresse : le profil ne la décrit plus, il disparaît.
    fireEvent.change(screen.getByRole("textbox", { name: "Email" }), {
      target: { value: "autre.adresse@example.test" },
    });
    expect(screen.queryByTestId("recipient-profile")).toBeNull();
  });

  it("n'affiche aucun profil quand le brouillon n'en porte pas", async () => {
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.create.mockResolvedValue({ ok: true, mission: mission("draft"), gaps: [], facts: [] });

    renderPanel();
    await screen.findByRole("button", { name: "Valider et envoyer" });
    expect(screen.queryByTestId("recipient-profile")).toBeNull();
  });

  it("shows the inventory of the fiche with what is missing and what is known", async () => {
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.create.mockResolvedValue({
      ok: true,
      mission: {
        ...mission("draft"),
        inventory: [
          {
            key: "pv_descriptif",
            label: "Procès-verbal descriptif",
            status: "missing",
            detail: "Absent des pièces consultables.",
            origin: null,
          },
          {
            key: "surface",
            label: "Surface",
            status: "present",
            detail: "82,99 m²",
            origin: "Annonce (avoventes)",
          },
        ],
      },
      gaps: [],
      facts: [],
    });

    renderPanel();
    const inventory = await screen.findByRole("region", { name: "Inventaire de la fiche" });
    expect(inventory.textContent).toContain("À obtenir (1)");
    expect(inventory.textContent).toContain("Procès-verbal descriptif");
    expect(inventory.textContent).toContain("Déjà disponible (1)");
    expect(inventory.textContent).toContain("82,99 m² (Annonce (avoventes))");
  });

  it("attaches a reply received outside the case address to a sent mission", async () => {
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.create.mockResolvedValue({ ok: true, mission: mission("sent"), gaps: [], facts: [] });
    mocks.action.mockResolvedValue({ ok: true, missions: [mission("sent")], facts: [] });

    renderPanel();
    const reply = await screen.findByRole("textbox", {
      name: /Consigner une réponse reçue hors de l’adresse du dossier/,
    });
    fireEvent.change(reply, { target: { value: "Le bien est libre, surface Carrez 61 m²." } });
    fireEvent.click(screen.getByRole("button", { name: "Rattacher la réponse au dossier" }));
    await waitFor(() => expect(mocks.action).toHaveBeenCalledTimes(1));
    expect(mocks.action.mock.calls[0][0]).toEqual({
      action: "record_reply",
      missionId: "22222222-2222-4222-8222-222222222222",
      bodyText: "Le bien est libre, surface Carrez 61 m².",
    });
  });

  it("lets an admin resume a mission after a transient send failure", async () => {
    mocks.list.mockResolvedValue({ ok: true, missions: [mission("failed")], facts: [] });

    renderWithList(null);

    fireEvent.click(await screen.findByRole("button", { name: "Reprendre" }));
    expect(screen.getByRole("button", { name: "Valider et envoyer" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Annuler la mission" })).toBeTruthy();
  });

  it("offers Ouvrir for every status and opens a sent mission read-only", async () => {
    mocks.list.mockResolvedValue({
      ok: true,
      missions: [mission("sent")],
      facts: [],
    });
    mocks.action.mockResolvedValue({ ok: true, missions: [mission("sent")], facts: [] });

    renderWithList(null);

    expect(screen.queryByRole("button", { name: "Reprendre" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Ouvrir" }));

    expect((screen.getByRole("textbox", { name: "Email" }) as HTMLInputElement).readOnly).toBe(
      true,
    );
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).readOnly).toBe(
      true,
    );
    expect(screen.queryByRole("button", { name: "Valider et envoyer" })).toBeNull();
    // Le formulaire de réponse consignée reste accessible pour une mission envoyée.
    fireEvent.change(
      screen.getByRole("textbox", {
        name: /Consigner une réponse reçue hors de l’adresse du dossier/,
      }),
      { target: { value: "Réponse reçue par téléphone : le bien est libre." } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Rattacher la réponse au dossier" }));
    await waitFor(() => expect(mocks.action).toHaveBeenCalledTimes(1));
    expect(mocks.action.mock.calls[0][0]).toMatchObject({
      action: "record_reply",
      missionId: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("explains next to the button why sending is not available yet", async () => {
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.create.mockResolvedValue({ ok: true, mission: mission("draft"), gaps: [], facts: [] });
    mocks.preview.mockResolvedValueOnce(previewResponse());

    renderPanel();
    await screen.findByRole("button", { name: "Valider et envoyer" });

    const reason = screen.getByText("Affichez l’aperçu pour activer l’envoi.");
    expect(sendButton().getAttribute("title")).toBeNull();
    expect(sendButton().getAttribute("aria-describedby")).toBe(reason.id);

    await showPreview();
    expect(screen.queryByText("Affichez l’aperçu pour activer l’envoi.")).toBeNull();
    const confirmation = screen.getByText(
      "Cochez la confirmation de relecture pour activer l’envoi.",
    );
    expect(sendButton().getAttribute("aria-describedby")).toBe(confirmation.id);
    confirmReview();
    expect(sendButton().getAttribute("aria-describedby")).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Message modifié après l’aperçu, à revoir avant tout envoi." },
    });
    expect(screen.getByText(/Le message a changé depuis l’aperçu/)).toBeTruthy();
  });

  it("explains a blocked preview and an invalid recipient next to the send button", async () => {
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.create.mockResolvedValue({ ok: true, mission: mission("draft"), gaps: [], facts: [] });
    mocks.preview.mockResolvedValueOnce(
      previewResponse({ blockers: ["Le contact est explicitement opposé."], fingerprint: null }),
    );

    renderPanel();
    await screen.findByRole("button", { name: "Valider et envoyer" });
    await showPreview();
    expect(screen.getByText(/L’aperçu signale un blocage/)).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: "Email" }), {
      target: { value: "pas-un-email" },
    });
    expect(
      screen.getByText("Renseignez une adresse email valide pour activer l’envoi."),
    ).toBeTruthy();
  });

  it("keeps a resumed history mission when a previous queue request finishes late", async () => {
    const firstSaleId = "11111111-1111-4111-8111-111111111111";
    const historyMission = mission(
      "failed",
      "99999999-9999-4999-8999-999999999999",
      "history@example.test",
    );
    let resolveFirst!: (value: unknown) => void;
    const firstResponse = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    mocks.list.mockResolvedValue({ ok: true, missions: [historyMission], facts: [] });
    mocks.sourceStatus.mockResolvedValue({ ok: true, request: null, history: [] });
    mocks.create.mockReturnValue(firstResponse);
    renderWithList({
      saleId: firstSaleId,
      title: "File en cours",
      recipientName: null,
      recipientContact: null,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Reprendre" }));
    expect(
      screen.getByRole("heading", { name: "Brouillon pour history@example.test" }),
    ).toBeTruthy();
    resolveFirst({
      ok: true,
      mission: mission("draft", firstSaleId, "late@example.test"),
      gaps: [],
      facts: [],
    });
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Brouillon pour history@example.test" }),
      ).toBeTruthy(),
    );
    expect(screen.queryByRole("heading", { name: "Brouillon pour late@example.test" })).toBeNull();
  });

  it("lets the backend resolve a contact when the selection has no email", async () => {
    const draft = mission("draft");
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.sourceStatus.mockResolvedValue({ ok: true, request: null, history: [] });
    mocks.create.mockResolvedValue({ ok: true, mission: draft, gaps: [], facts: [] });

    renderPanel({
      saleId: "11111111-1111-4111-8111-111111111111",
      title: "Maison à Lille",
      recipientName: "Maître Martin",
      recipientContact: "Téléphone uniquement",
    });

    await screen.findByRole("button", { name: "Valider et envoyer" });
    expect(mocks.create.mock.calls[0][0]).toEqual({
      saleId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("does not trust the first email embedded in a contact label", async () => {
    const draft = mission("draft");
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.sourceStatus.mockResolvedValue({ ok: true, request: null, history: [] });
    mocks.create.mockResolvedValue({ ok: true, mission: draft, gaps: [], facts: [] });

    renderPanel({
      saleId: "11111111-1111-4111-8111-111111111111",
      title: "Maison à Lille",
      recipientName: null,
      recipientContact: "contact@cabinet.example.test",
    });

    await screen.findByRole("button", { name: "Valider et envoyer" });
    expect(mocks.create.mock.calls[0][0]).toEqual({
      saleId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("falls back to a manually confirmed contact after an ambiguous selection", async () => {
    const draft = mission("draft");
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.create
      .mockRejectedValueOnce(new Error("Plusieurs contacts sont possibles."))
      .mockResolvedValueOnce({ ok: true, mission: draft, gaps: [], facts: [] });
    mocks.sourceStatus.mockResolvedValue({ ok: true, request: null, history: [] });

    renderPanel({
      saleId: "11111111-1111-4111-8111-111111111111",
      title: "Maison à Lille",
      recipientName: "Contact à vérifier",
      recipientContact: "cabinet-a@example.test · cabinet-b@example.test",
    });

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Plusieurs contacts sont possibles",
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Nom du destinataire (à vérifier)" }), {
      target: { value: "Cabinet A" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Email du destinataire" }), {
      target: { value: "cabinet-a@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Préparer avec ce contact" }));

    await screen.findByRole("button", { name: "Valider et envoyer" });
    expect(mocks.create.mock.calls[0][0]).toEqual({
      saleId: "11111111-1111-4111-8111-111111111111",
    });
    expect(mocks.create.mock.calls[1][0]).toEqual({
      saleId: "11111111-1111-4111-8111-111111111111",
      recipientEmail: "cabinet-a@example.test",
      recipientName: "Cabinet A",
    });
  });

  it("n'active la préparation manuelle que pour une adresse email valide", async () => {
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.create.mockRejectedValueOnce(
      new Error("Aucune adresse email de contact : l'agent ne peut pas écrire."),
    );
    mocks.sourceStatus.mockResolvedValue({ ok: true, request: null, history: [] });

    renderPanel({
      saleId: "11111111-1111-4111-8111-111111111111",
      title: "Maison à Lille",
      recipientName: "Cabinet source",
      recipientContact: "05 56 00 00 01",
    });

    expect((await screen.findByRole("alert")).textContent).toContain("Aucune adresse email");
    const field = screen.getByRole("textbox", { name: "Email du destinataire" });
    const action = screen.getByRole("button", { name: "Préparer avec ce contact" });
    for (const value of ["05 56 00 00 01", "Maître Dupont", "dupont@cabinet"]) {
      fireEvent.change(field, { target: { value } });
      expect((action as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.change(field, { target: { value: "dupont@cabinet-dupont.test" } });
    expect((action as HTMLButtonElement).disabled).toBe(false);
  });

  it("place le champ d'origine juste sous le message « Origine de l'adresse inconnue »", async () => {
    const message =
      "Origine de l’adresse inconnue : elle ne figure pas dans l’annonce de cette vente. Indiquez la page publique où vous l’avez trouvée avant l’envoi.";
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.create.mockResolvedValue({ ok: true, mission: mission("draft"), gaps: [], facts: [] });
    mocks.preview.mockResolvedValue(
      previewResponse({
        blockers: [message],
        fingerprint: null,
        addressOrigin: { text: message, url: null, automated: false, known: false },
      }),
    );

    renderPanel();
    await screen.findByRole("button", { name: "Valider et envoyer" });
    await showPreview();

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Origine de l’adresse inconnue");
    const field = screen.getByRole("textbox", { name: /Page publique où figure l’adresse/ });
    // Dans le bloc de l'aperçu, après la liste des motifs de blocage, et mis en évidence.
    const preview = screen.getByRole("region", { name: "Aperçu de l’e-mail" });
    expect(preview.contains(field)).toBe(true);
    expect(alert.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(alert.nextElementSibling?.getAttribute("data-origin-required")).toBe("true");
    expect(alert.nextElementSibling?.contains(field)).toBe(true);
    // Le champ peut recevoir le focus et sa saisie est envoyée avec l'aperçu suivant.
    (field as HTMLInputElement).focus();
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: "https://annuaire.example.test/cabinet" } });
    mocks.preview.mockResolvedValue(previewResponse());
    await showPreview("Afficher l’aperçu");
    expect(mocks.preview.mock.calls.at(-1)?.[0]).toMatchObject({
      recipientOriginUrl: "https://annuaire.example.test/cabinet",
    });
  });

  it("garde le champ d'origine dans l'aperçu sans le mettre en évidence quand l'origine est connue", async () => {
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.create.mockResolvedValue({ ok: true, mission: mission("draft"), gaps: [], facts: [] });
    mocks.preview.mockResolvedValue(previewResponse());

    renderPanel();
    await screen.findByRole("button", { name: "Valider et envoyer" });
    const field = screen.getByRole("textbox", { name: /Page publique où figure l’adresse/ });
    expect(field.closest("[data-origin-required]")).toBeNull();
    await showPreview();
    // Même élément avant et après l'aperçu : la saisie et le focus ne sont pas perdus.
    expect(screen.getByRole("textbox", { name: /Page publique où figure l’adresse/ })).toBe(field);
    expect(field.closest("[data-origin-required]")).toBeNull();
  });

  it("dit que l'actualisation de la source est facultative et sans rapport avec l'origine de l'adresse", async () => {
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.create.mockResolvedValue({ ok: true, mission: mission("draft"), gaps: [], facts: [] });

    renderPanel();
    await screen.findByRole("button", { name: "Valider et envoyer" });

    expect(screen.getByText("Actualiser la source (facultatif)")).toBeTruthy();
    expect(screen.getByText(/sans rapport avec l’origine de l’adresse/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Actualiser la source" })).toBeTruthy();
  });

  it("ne relit pas le statut du refresh tant que l'éditeur est masqué", async () => {
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.create.mockResolvedValue({ ok: true, mission: mission("draft"), gaps: [], facts: [] });
    mocks.sourceStatus.mockResolvedValue({ ok: true, request: null, history: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const selection = {
      saleId: "11111111-1111-4111-8111-111111111111",
      title: "Appartement à Bordeaux",
      recipientName: null,
      recipientContact: null,
    };

    render(
      <QueryClientProvider client={client}>
        <AdminInformationAgentMissionsPanel
          selection={selection}
          onClose={vi.fn()}
          active={false}
        />
      </QueryClientProvider>,
    );
    await screen.findByRole("button", { name: "Valider et envoyer" });

    expect(mocks.sourceStatus).not.toHaveBeenCalled();
  });

  it("queues a refresh for the exact sale and exposes its running status", async () => {
    mocks.create.mockResolvedValue({ ok: true, mission: mission("draft"), gaps: [], facts: [] });
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.sourceRefresh.mockResolvedValue({
      ok: true,
      saleId: "11111111-1111-4111-8111-111111111111",
      request: {
        id: "55555555-5555-4555-8555-555555555555",
        saleId: "11111111-1111-4111-8111-111111111111",
        kind: "source_detail",
        status: "queued",
        priority: 85,
        reused: false,
        requestedAt: "2026-09-28T10:00:00.000Z",
        startedAt: null,
        completedAt: null,
        errorMessage: null,
      },
      history: [],
    });

    renderPanel();

    await screen.findByRole("button", { name: "Valider et envoyer" });
    fireEvent.click(await screen.findByRole("button", { name: "Actualiser la source" }));
    await waitFor(() =>
      expect(mocks.sourceRefresh.mock.calls[0]?.[0]).toEqual({
        saleId: "11111111-1111-4111-8111-111111111111",
        force: true,
      }),
    );
    expect(await screen.findByText("en file")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Refresh en cours…" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("does not label an older completed refresh as this draft's refresh", async () => {
    mocks.create.mockResolvedValue({ ok: true, mission: mission("draft"), gaps: [], facts: [] });
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });

    renderPanel(undefined, {
      ok: true,
      saleId: "11111111-1111-4111-8111-111111111111",
      request: {
        id: "55555555-5555-4555-8555-555555555555",
        saleId: "11111111-1111-4111-8111-111111111111",
        kind: "source_detail",
        status: "completed",
        priority: 120,
        reused: false,
        requestedAt: "2026-09-28T10:00:00.000Z",
        startedAt: "2026-09-28T10:01:00.000Z",
        completedAt: "2026-09-28T10:02:00.000Z",
        errorMessage: null,
      },
      history: [],
    });

    await screen.findByRole("button", { name: "Valider et envoyer" });
    expect(screen.getByRole("button", { name: "Actualiser la source" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Régénérer depuis la source actualisée" }),
    ).toBeNull();
  });

  it("ignores a stale draft response after the admin changes the selection", async () => {
    const firstSaleId = "11111111-1111-4111-8111-111111111111";
    const secondSaleId = "99999999-9999-4999-8999-999999999999";
    let resolveFirst!: (value: unknown) => void;
    const firstResponse = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.create.mockImplementation(({ saleId }: { saleId: string }) =>
      saleId === firstSaleId
        ? firstResponse
        : Promise.resolve({
            ok: true,
            mission: mission("draft", secondSaleId, "second@example.test"),
            gaps: [],
            facts: [],
          }),
    );

    const firstSelection = {
      saleId: firstSaleId,
      title: "Première annonce",
      recipientName: null,
      recipientContact: null,
    };
    const secondSelection = {
      saleId: secondSaleId,
      title: "Seconde annonce",
      recipientName: null,
      recipientContact: null,
    };
    mocks.sourceStatus.mockResolvedValue({ ok: true, request: null, history: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <AdminInformationAgentMissionsPanel selection={firstSelection} onClose={vi.fn()} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(mocks.create.mock.calls[0]?.[0]).toEqual({ saleId: firstSaleId }));
    view.rerender(
      <QueryClientProvider client={client}>
        <AdminInformationAgentMissionsPanel selection={secondSelection} onClose={vi.fn()} />
      </QueryClientProvider>,
    );
    await screen.findByRole("button", { name: "Valider et envoyer" });
    expect(
      screen.getByRole("heading", { name: "Brouillon pour second@example.test" }),
    ).toBeTruthy();

    resolveFirst({
      ok: true,
      mission: mission("draft", firstSaleId, "first@example.test"),
      gaps: [],
      facts: [],
    });
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Brouillon pour second@example.test" }),
      ).toBeTruthy(),
    );
    expect(screen.queryByRole("heading", { name: "Brouillon pour first@example.test" })).toBeNull();
  });

  it("looks up the sale's own drafts before creating one when the history has more pages", async () => {
    const saleId = "11111111-1111-4111-8111-111111111111";
    const existing = { ...mission("draft", saleId, "existing@example.test"), id: "old-draft" };
    mocks.list.mockImplementation(async (args: { saleId?: string; offset?: number }) =>
      args.saleId
        ? {
            ok: true,
            missions: [existing],
            facts: [],
            offset: 0,
            limit: 100,
            total: 1,
            hasMore: false,
          }
        : {
            ok: true,
            missions: [{ ...mission("sent"), id: "recent", saleId: "other-sale" }],
            facts: [],
            offset: 0,
            limit: 50,
            total: 80,
            hasMore: true,
          },
    );
    mocks.create.mockResolvedValue({ ok: true, mission: mission("draft"), gaps: [], facts: [] });

    renderPanel({
      saleId,
      title: "Appartement à Bordeaux",
      recipientName: null,
      recipientContact: null,
    });

    expect(
      await screen.findByRole("heading", { name: "Brouillon pour existing@example.test" }),
    ).toBeTruthy();
    expect(mocks.list).toHaveBeenCalledWith({ saleId, limit: 100 });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("creates the draft when the sale has none even though the history has more pages", async () => {
    const saleId = "11111111-1111-4111-8111-111111111111";
    mocks.list.mockImplementation(async (args: { saleId?: string }) =>
      args.saleId
        ? { ok: true, missions: [], facts: [], offset: 0, limit: 100, total: 0, hasMore: false }
        : {
            ok: true,
            missions: [{ ...mission("sent"), id: "recent", saleId: "other-sale" }],
            facts: [],
            offset: 0,
            limit: 50,
            total: 80,
            hasMore: true,
          },
    );
    mocks.create.mockResolvedValue({
      ok: true,
      mission: mission("draft", saleId, "created@example.test"),
      gaps: [],
      facts: [],
    });

    renderPanel({
      saleId,
      title: "Appartement à Bordeaux",
      recipientName: null,
      recipientContact: null,
    });

    expect(
      await screen.findByRole("heading", { name: "Brouillon pour created@example.test" }),
    ).toBeTruthy();
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
});

describe("AdminInformationAgentMissionsPanel : préparation et relecture en deux étapes", () => {
  it("affiche l'aperçu rendu avec le brouillon, sans cliquer sur « Afficher l'aperçu »", async () => {
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.create.mockResolvedValue({
      ok: true,
      mission: mission("draft"),
      gaps: [],
      facts: [],
      preview: previewResponse(),
      previewError: null,
      reused: false,
    });
    mocks.action.mockResolvedValue({ ok: true, missions: [mission("sent")], facts: [] });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderPanel();

    await screen.findByTitle("Aperçu de l’e-mail envoyé");
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Actualiser l’aperçu" })).toBeTruthy();
    expect(sendButton().disabled).toBe(true);

    confirmReview();
    expect(sendButton().disabled).toBe(false);
    fireEvent.click(sendButton());
    await waitFor(() => expect(mocks.action).toHaveBeenCalledTimes(1));
    expect(mocks.action.mock.calls[0][0]).toMatchObject({
      action: "approve_and_send",
      previewFingerprint: "f".repeat(64),
    });
  });

  it("retire la confirmation dès que le message change, et refuse l'envoi sans case cochée", async () => {
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.create.mockResolvedValue({
      ok: true,
      mission: mission("draft"),
      gaps: [],
      facts: [],
      preview: previewResponse(),
      previewError: null,
      reused: false,
    });

    renderPanel();
    await screen.findByTitle("Aperçu de l’e-mail envoyé");
    confirmReview();
    expect(sendButton().disabled).toBe(false);

    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Message modifié après la relecture, à relire avant tout envoi." },
    });
    expect(sendButton().disabled).toBe(true);
    expect(
      (screen.getByRole("checkbox", { name: /J’ai relu le message exact/ }) as HTMLInputElement)
        .checked,
    ).toBe(false);
    expect(mocks.action).not.toHaveBeenCalled();
  });

  it("ne permet pas de cocher la confirmation quand l'aperçu signale un blocage", async () => {
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.create.mockResolvedValue({
      ok: true,
      mission: mission("draft"),
      gaps: [],
      facts: [],
      preview: previewResponse({
        blockers: [
          "Deux rebonds passagers en 30 jours pour cette adresse : elle n’est plus sollicitée.",
        ],
        fingerprint: null,
      }),
      previewError: null,
      reused: false,
    });

    renderPanel();
    await screen.findByTitle("Aperçu de l’e-mail envoyé");

    expect(screen.getByRole("alert").textContent).toContain("rebonds passagers");
    expect(
      (screen.getByRole("checkbox", { name: /J’ai relu le message exact/ }) as HTMLInputElement)
        .disabled,
    ).toBe(true);
    expect(sendButton().disabled).toBe(true);
  });
});

/** Coche la case « J'ai relu le message exact » : l'envoi n'est possible qu'après cette confirmation. */
function confirmReview() {
  fireEvent.click(screen.getByRole("checkbox", { name: /J’ai relu le message exact/ }));
}

function sendButton() {
  return screen.getByRole("button", { name: "Valider et envoyer" }) as HTMLButtonElement;
}

async function showPreview(label = "Afficher l’aperçu") {
  fireEvent.click(screen.getByRole("button", { name: label }));
  await screen.findByTitle("Aperçu de l’e-mail envoyé");
  await waitFor(() => expect(screen.queryByRole("button", { name: "Préparation…" })).toBeNull());
}

function previewResponse(
  overrides: Partial<{
    blockers: string[];
    fingerprint: string | null;
    addressOrigin: {
      text: string;
      url: string | null;
      automated: boolean;
      known: boolean;
      courtRegistry?: boolean;
    };
  }> = {},
) {
  return {
    ok: true,
    preview: {
      from: "agent@example.test",
      to: "Maître Dupont <cabinet@example.test>",
      replyTo: "enquete+jeton-attribue-a-l-envoi@reponses.example.test",
      subject: "Demande de pièces",
      html: "<p>Aperçu</p>",
      text: "Aperçu",
    },
    blockers: [],
    addressOrigin: {
      text: "Votre adresse professionnelle figure dans l’annonce publique de cette vente sur Licitor (https://www.licitor.com/annonce/1.html), consultée le 14/10/2026.",
      url: "https://www.licitor.com/annonce/1.html",
      automated: false,
      known: true,
    },
    fingerprint: "f".repeat(64),
    ...overrides,
  };
}

type Selection = {
  saleId: string;
  title: string;
  recipientName: string | null;
  recipientContact: string | null;
};

/** Comme l'espace de travail : l'éditeur (À contacter) et la liste des envois, reliés par `openRequest`. */
function Harness({ initial }: { initial: Selection | null }) {
  const [selection, setSelection] = useState(initial);
  const [openRequest, setOpenRequest] = useState<OpenMissionRequest | null>(null);
  return (
    <>
      <AdminInformationAgentMissionsPanel
        selection={selection}
        onClose={() => setSelection(null)}
        openRequest={openRequest}
      />
      <AdminInformationAgentMissionsList
        onOpenMission={(mission) => {
          setSelection(null);
          setOpenRequest((previous) => ({ mission, nonce: (previous?.nonce ?? 0) + 1 }));
        }}
      />
    </>
  );
}

function renderWithList(selection: Selection | null) {
  mocks.sourceStatus.mockResolvedValue({ ok: true, request: null, history: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Harness initial={selection} />
    </QueryClientProvider>,
  );
}

function renderPanel(
  selection: {
    saleId: string;
    title: string;
    recipientName: string | null;
    recipientContact: string | null;
  } | null = {
    saleId: "11111111-1111-4111-8111-111111111111",
    title: "Appartement à Bordeaux",
    recipientName: "Maître Dupont",
    recipientContact: "Tél. 01 02 03 · cabinet@example.test",
  },
  sourceStatus: unknown = { ok: true, request: null, history: [] },
) {
  mocks.sourceStatus.mockResolvedValue(sourceStatus);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AdminInformationAgentMissionsPanel selection={selection} onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}

function mission(
  status: "draft" | "sent" | "failed",
  saleId = "11111111-1111-4111-8111-111111111111",
  recipientEmail = "cabinet@example.test",
) {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    caseId: "33333333-3333-4333-8333-333333333333",
    saleId,
    status,
    recipientKind: "source_lawyer",
    recipientName: "Maître Dupont",
    recipientEmail,
    subject: "Demande de pièces",
    bodyText: "Bonjour, pourriez-vous transmettre les pièces complémentaires du dossier ?",
    questionKeys: ["documents"],
    missingInformation: ["documents"],
    failureReason: null,
    approvedAt: status === "sent" ? "2026-09-19T10:00:00.000Z" : null,
    sentAt: status === "sent" ? "2026-09-19T10:01:00.000Z" : null,
    repliedAt: null,
    createdAt: "2026-09-19T09:00:00.000Z",
    updatedAt: "2026-09-19T10:01:00.000Z",
  };
}
