// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InformationAgentContributionForm } from "./InformationAgentContributionForm";

const TOKEN = "a".repeat(64);
const STORAGE_KEY = "immojudis:contribution-token:mission-1";
const OPT_OUT_PATH = `/api/information-agent/opt-out?e=${btoa("cabinet@example.test")}&t=${"c".repeat(64)}`;
const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  storageFrom: vi.fn(),
  uploadToSignedUrl: vi.fn(),
  randomUUID: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { storage: { from: mocks.storageFrom } },
}));

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function referenceResponse() {
  return jsonResponse({
    caseReference: "CASE-1234",
    subject: "Informations sur le bien",
    questions: ["Quelles sont les prochaines dates de visite ?"],
    maxFileBytes: 20 * 1024 * 1024,
    maxSubmissionBytes: 40 * 1024 * 1024,
    maxPortalBytes: 480 * 1024 * 1024,
    maxPortalFiles: 12,
    optOutPath: OPT_OUT_PATH,
  });
}

function renderContribution() {
  window.history.replaceState(null, "", `/contribuer/mission-1#${TOKEN}`);
  render(<InformationAgentContributionForm missionId="mission-1" />);
}

function fillRequiredFields() {
  fireEvent.change(screen.getByLabelText(/Nom ou cabinet/), {
    target: { value: "Cabinet Dupont" },
  });
  fireEvent.change(screen.getByLabelText(/Adresse e-mail/), {
    target: { value: "cabinet@example.test" },
  });
  fireEvent.click(screen.getByLabelText(/J’atteste être autorisé/));
}

beforeEach(() => {
  window.sessionStorage.clear();
  mocks.fetch.mockReset();
  mocks.storageFrom.mockReset();
  mocks.uploadToSignedUrl.mockReset();
  mocks.randomUUID.mockReset();
  mocks.storageFrom.mockReturnValue({ uploadToSignedUrl: mocks.uploadToSignedUrl });
  mocks.uploadToSignedUrl.mockResolvedValue({ data: { path: "uploaded" }, error: null });
  mocks.randomUUID.mockReturnValue("11111111-1111-4111-8111-111111111111");
  vi.stubGlobal("fetch", mocks.fetch);
  vi.stubGlobal("crypto", { randomUUID: mocks.randomUUID });
  vi.stubGlobal("scrollTo", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("InformationAgentContributionForm", () => {
  it("efface le jeton du fragment avant de charger la référence", async () => {
    mocks.fetch.mockImplementation(async () => {
      expect(window.location.hash).toBe("");
      return referenceResponse();
    });

    renderContribution();

    expect(await screen.findByText("CASE-1234")).toBeTruthy();
    expect(window.location.hash).toBe("");
    expect(mocks.fetch).toHaveBeenCalledWith(
      "/api/information-agent/contributions/mission-1",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ token: TOKEN }),
      }),
    );
  });

  it("ne révèle aucune référence avec un jeton absent ou invalide", async () => {
    window.history.replaceState(null, "", "/contribuer/mission-1#not-a-token");
    render(<InformationAgentContributionForm missionId="mission-1" />);

    expect((await screen.findByRole("alert")).textContent).toContain("Ce lien semble incomplet");
    expect(screen.queryByText("CASE-1234")).toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("");
  });

  it("accepte une réponse texte et des liens sans fichier", async () => {
    vi.stubEnv("NEXT_PUBLIC_INFORMATION_AGENT_PRO_INVITATION", "true");
    mocks.fetch
      .mockResolvedValueOnce(referenceResponse())
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, messageId: "message-1", assetCount: 0 }, 201),
      );
    renderContribution();
    await screen.findByText("CASE-1234");
    expect(
      screen.getByText(/Pour pouvoir vous répondre si une précision est nécessaire/),
    ).toBeTruthy();
    expect(screen.queryByText(/Nous la comparons/)).toBeNull();
    // The questions of the email are recalled above the form.
    expect(screen.getByText("Ce que nous vous avons demandé")).toBeTruthy();
    expect(screen.getByText("Quelles sont les prochaines dates de visite ?")).toBeTruthy();
    fillRequiredFields();
    fireEvent.change(screen.getByLabelText("Votre réponse"), {
      target: { value: "La visite est possible sur rendez-vous." },
    });
    fireEvent.change(screen.getByLabelText("Liens utiles"), {
      target: { value: "https://example.test/plan" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Transmettre ma réponse" }));

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("bien été transmise"),
    );
    const submitCall = mocks.fetch.mock.calls[1];
    expect(submitCall?.[0]).toBe("/api/information-agent/contributions/mission-1/submit");
    expect(JSON.parse(String(submitCall?.[1]?.body))).toMatchObject({
      token: TOKEN,
      senderName: "Cabinet Dupont",
      senderEmail: "cabinet@example.test",
      note: "La visite est possible sur rendez-vous.",
      externalLinks: ["https://example.test/plan"],
      authorizedToTransmit: true,
      files: [],
    });
    expect(mocks.storageFrom).not.toHaveBeenCalled();
    // Après une réponse volontaire : ce qui va se passer, puis l'invitation au dépôt direct.
    expect(screen.getByText(/rien n’est publié sans cette vérification/)).toBeTruthy();
    const invitation = screen.getByRole("link", { name: "Créer un accès professionnel" });
    expect(invitation.getAttribute("href")).toBe("/login?mode=professional&redirect=%2Fpublish");
  });

  it("confirme une opposition sans rien proposer d'autre", async () => {
    vi.stubEnv("NEXT_PUBLIC_INFORMATION_AGENT_PRO_INVITATION", "true");
    mocks.fetch
      .mockResolvedValueOnce(referenceResponse())
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, messageId: "message-1", assetCount: 0, opposed: true }, 201),
      );
    renderContribution();
    await screen.findByText("CASE-1234");
    fillRequiredFields();
    fireEvent.change(screen.getByLabelText("Votre réponse"), {
      target: { value: "Merci de ne plus me contacter." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Transmettre ma réponse" }));

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("ne vous sollicitera plus"),
    );
    expect(screen.queryByRole("link", { name: "Créer un accès professionnel" })).toBeNull();
  });

  it.each([
    ["absente", undefined],
    ["vide", ""],
    ["false", "false"],
    ["différente de true", "1"],
  ])("n'affiche pas l'invitation par défaut (variable %s)", async (_label, value) => {
    vi.stubEnv("NEXT_PUBLIC_INFORMATION_AGENT_PRO_INVITATION", value);
    mocks.fetch
      .mockResolvedValueOnce(referenceResponse())
      .mockResolvedValueOnce(jsonResponse({ ok: true, messageId: "m", assetCount: 0 }, 201));
    renderContribution();
    await screen.findByText("CASE-1234");
    fillRequiredFields();
    fireEvent.change(screen.getByLabelText("Votre réponse"), { target: { value: "Oui." } });
    fireEvent.click(screen.getByRole("button", { name: "Transmettre ma réponse" }));
    await screen.findByText("Réponse reçue");
    expect(screen.queryByRole("link", { name: "Créer un accès professionnel" })).toBeNull();
  });

  it("prépare chaque fichier, dépose via Supabase puis soumet son ticket", async () => {
    mocks.fetch
      .mockResolvedValueOnce(referenceResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          bucket: "information-agent-evidence",
          path: "case/portal/file/pv.pdf",
          token: "signed-upload-token",
          ticket: `1234567890123.${"b".repeat(64)}`,
          remainingBytes: 440 * 1024 * 1024,
          remainingFiles: 11,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, messageId: "message-1", assetCount: 1 }, 201),
      );
    renderContribution();
    await screen.findByText("CASE-1234");
    // No capacity jargon while plenty remains.
    expect(screen.queryByText(/Chaque préparation réserve/)).toBeNull();
    fillRequiredFields();
    const file = new File(["%PDF-1.7"], "pv.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("Pièces jointes"), {
      target: { files: [file] },
    });
    expect(await screen.findByText("pv.pdf")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Transmettre ma réponse" }));

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("bien été transmise"),
    );
    expect(mocks.fetch.mock.calls[1]?.[0]).toContain("/upload");
    expect(JSON.parse(String(mocks.fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      token: TOKEN,
      filename: "pv.pdf",
      mimeType: "application/pdf",
      size: file.size,
    });
    expect(mocks.storageFrom).toHaveBeenCalledWith("information-agent-evidence");
    expect(mocks.uploadToSignedUrl).toHaveBeenCalledWith(
      "case/portal/file/pv.pdf",
      "signed-upload-token",
      file,
    );
    const submitBody = JSON.parse(String(mocks.fetch.mock.calls[2]?.[1]?.body));
    expect(submitBody.files).toEqual([
      {
        path: "case/portal/file/pv.pdf",
        filename: "pv.pdf",
        mimeType: "application/pdf",
        size: file.size,
        ticket: `1234567890123.${"b".repeat(64)}`,
      },
    ]);
  });

  it("refuse un fichier trop volumineux avec une erreur accessible", async () => {
    mocks.fetch.mockResolvedValueOnce(referenceResponse());
    renderContribution();
    await screen.findByText("CASE-1234");
    const oversized = new File([new Uint8Array(20 * 1024 * 1024 + 1)], "large.pdf", {
      type: "application/pdf",
    });
    fireEvent.change(screen.getByLabelText("Pièces jointes"), {
      target: { files: [oversized] },
    });

    expect((await screen.findByRole("alert")).textContent).toContain("dépasse la limite de 20 Mo");
    expect(screen.queryByText("large.pdf")).toBeNull();
  });

  it("explique comment joindre un document Word, qui n'est pas accepté", async () => {
    mocks.fetch.mockResolvedValueOnce(referenceResponse());
    renderContribution();
    await screen.findByText("CASE-1234");
    expect(
      screen.getByText(/Un document Word ou Excel : enregistrez-le d’abord en PDF/),
    ).toBeTruthy();
    const word = new File(["x"], "pv.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    fireEvent.change(screen.getByLabelText("Pièces jointes"), { target: { files: [word] } });

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Enregistrez le document en PDF",
    );
  });

  it("refuse les pièces vides et les noms trop longs avant le dépôt", async () => {
    mocks.fetch.mockResolvedValueOnce(referenceResponse());
    renderContribution();
    await screen.findByText("CASE-1234");
    const fileInput = screen.getByLabelText("Pièces jointes");
    const longName = new File(["%PDF-1.7"], `${"a".repeat(181)}.pdf`, {
      type: "application/pdf",
    });
    fireEvent.change(fileInput, { target: { files: [longName] } });
    expect((await screen.findByRole("alert")).textContent).toContain("180 caractères");

    const empty = new File([], "empty.pdf", { type: "application/pdf" });
    fireEvent.change(fileInput, { target: { files: [empty] } });
    expect((await screen.findByRole("alert")).textContent).toContain("est vide");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("reprend un dépôt après une erreur réseau sans régénérer ni re-déposer la pièce", async () => {
    const uploadResponse = jsonResponse({
      bucket: "information-agent-evidence",
      path: "case/portal/file/pv.pdf",
      token: "signed-upload-token",
      ticket: `1234567890123.${"b".repeat(64)}`,
      remainingBytes: 440 * 1024 * 1024,
      remainingFiles: 11,
    });
    mocks.fetch
      .mockResolvedValueOnce(referenceResponse())
      .mockResolvedValueOnce(uploadResponse)
      .mockResolvedValueOnce(
        jsonResponse({ error: "Le service est temporairement indisponible." }, 503),
      )
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, messageId: "message-2", assetCount: 1 }, 201),
      );
    renderContribution();
    await screen.findByText("CASE-1234");
    fillRequiredFields();
    const file = new File(["%PDF-1.7"], "pv.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("Pièces jointes"), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Transmettre ma réponse" }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("temporairement indisponible"),
    );
    expect(mocks.randomUUID).toHaveBeenCalledTimes(2);
    expect(mocks.uploadToSignedUrl).toHaveBeenCalledTimes(1);
    const firstSubmit = JSON.parse(String(mocks.fetch.mock.calls[2]?.[1]?.body));

    fireEvent.click(screen.getByRole("button", { name: "Transmettre ma réponse" }));

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("bien été transmise"),
    );
    expect(mocks.randomUUID).toHaveBeenCalledTimes(2);
    expect(mocks.uploadToSignedUrl).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(4);
    const retrySubmit = JSON.parse(String(mocks.fetch.mock.calls[3]?.[1]?.body));
    expect(retrySubmit.submissionId).toBe(firstSubmit.submissionId);
    expect(retrySubmit.files).toEqual(firstSubmit.files);
  });

  it("ne renvoie pas une pièce déjà déposée quand la réponse est corrigée après une erreur", async () => {
    mocks.fetch
      .mockResolvedValueOnce(referenceResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          bucket: "information-agent-evidence",
          path: "case/portal/file/pv.pdf",
          token: "signed-upload-token",
          ticket: `1234567890123.${"b".repeat(64)}`,
          remainingBytes: 440 * 1024 * 1024,
          remainingFiles: 11,
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ error: "Service indisponible." }, 503))
      .mockResolvedValueOnce(jsonResponse({ ok: true, messageId: "m", assetCount: 1 }, 201));
    renderContribution();
    await screen.findByText("CASE-1234");
    fillRequiredFields();
    fireEvent.change(screen.getByLabelText("Pièces jointes"), {
      target: { files: [new File(["%PDF-1.7"], "pv.pdf", { type: "application/pdf" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Transmettre ma réponse" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("indisponible"));

    fireEvent.change(screen.getByLabelText("Votre réponse"), {
      target: { value: "Voici le PV, corrigé." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Transmettre ma réponse" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("bien été transmise"),
    );
    // One reservation and one upload only: the edited answer reuses the file already sent.
    expect(mocks.uploadToSignedUrl).toHaveBeenCalledTimes(1);
    const retry = JSON.parse(String(mocks.fetch.mock.calls[3]?.[1]?.body));
    expect(retry.files).toHaveLength(1);
    expect(retry.note).toBe("Voici le PV, corrigé.");
  });

  it("dit qu'une contribution est déjà transmise quand la page est rechargée", async () => {
    mocks.fetch
      .mockResolvedValueOnce(referenceResponse())
      .mockResolvedValueOnce(jsonResponse({ ok: true, messageId: "m", assetCount: 0 }, 201));
    renderContribution();
    await screen.findByText("CASE-1234");
    fillRequiredFields();
    fireEvent.change(screen.getByLabelText("Votre réponse"), { target: { value: "Oui." } });
    fireEvent.click(screen.getByRole("button", { name: "Transmettre ma réponse" }));
    await screen.findByText("Réponse reçue");

    // Reload: the fragment and the token are gone, the submission is remembered for this tab.
    cleanup();
    window.history.replaceState(null, "", "/contribuer/mission-1");
    render(<InformationAgentContributionForm missionId="mission-1" />);
    expect((await screen.findByRole("status")).textContent).toContain(
      "Votre réponse au dossier CASE-1234 a déjà été transmise.",
    );
    expect(screen.queryByText(/Ce lien semble incomplet/)).toBeNull();
  });

  describe("jeton de dépôt", () => {
    it("conserve le jeton dans sessionStorage, jamais dans l'URL", async () => {
      mocks.fetch.mockResolvedValueOnce(referenceResponse());
      renderContribution();
      await screen.findByText("CASE-1234");

      expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe(TOKEN);
      expect(window.location.href).not.toContain(TOKEN);
      expect(document.body.innerHTML).not.toContain(TOKEN);
    });

    it("relit le jeton après un rechargement sans fragment", async () => {
      window.sessionStorage.setItem(STORAGE_KEY, TOKEN);
      window.history.replaceState(null, "", "/contribuer/mission-1");
      mocks.fetch.mockResolvedValueOnce(referenceResponse());
      render(<InformationAgentContributionForm missionId="mission-1" />);

      expect(await screen.findByText("CASE-1234")).toBeTruthy();
      expect(mocks.fetch).toHaveBeenCalledWith(
        "/api/information-agent/contributions/mission-1",
        expect.objectContaining({ body: JSON.stringify({ token: TOKEN }) }),
      );
    });

    it("n'utilise pas le jeton d'une autre enquête", async () => {
      window.sessionStorage.setItem("immojudis:contribution-token:mission-2", TOKEN);
      window.history.replaceState(null, "", "/contribuer/mission-1");
      render(<InformationAgentContributionForm missionId="mission-1" />);

      expect((await screen.findByRole("alert")).textContent).toContain(
        "Rouvrez-le depuis l’email que vous avez reçu, ou répondez simplement à cet email.",
      );
      expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it("ignore un jeton stocké mal formé", async () => {
      window.sessionStorage.setItem(STORAGE_KEY, "tronque");
      window.history.replaceState(null, "", "/contribuer/mission-1");
      render(<InformationAgentContributionForm missionId="mission-1" />);

      expect((await screen.findByRole("alert")).textContent).toContain("incomplet");
      expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it("efface le jeton quand le serveur confirme que le lien a expiré", async () => {
      mocks.fetch.mockResolvedValueOnce(
        jsonResponse({ error: "Lien de dépôt invalide ou expiré." }, 404),
      );
      renderContribution();

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("Lien de dépôt invalide ou expiré.");
      expect(alert.textContent).toContain("Répondez simplement à l’email");
      expect(screen.queryByRole("button", { name: "Réessayer" })).toBeNull();
      expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it("propose de réessayer après une panne serveur sans perdre le jeton", async () => {
      mocks.fetch
        .mockResolvedValueOnce(jsonResponse({ error: "Service de dépôt indisponible." }, 500))
        .mockResolvedValueOnce(referenceResponse());
      renderContribution();

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("Service momentanément indisponible.");
      expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe(TOKEN);

      fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));

      expect(await screen.findByText("CASE-1234")).toBeTruthy();
      expect(mocks.fetch).toHaveBeenCalledTimes(2);
      expect(JSON.parse(String(mocks.fetch.mock.calls[1]?.[1]?.body))).toEqual({ token: TOKEN });
    });

    it("traite une coupure réseau comme une panne passagère", async () => {
      mocks.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      renderContribution();

      expect((await screen.findByRole("alert")).textContent).toContain(
        "Service momentanément indisponible.",
      );
      expect(screen.getByRole("button", { name: "Réessayer" })).toBeTruthy();
      expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe(TOKEN);
    });

    it("efface le jeton après un dépôt réussi", async () => {
      mocks.fetch
        .mockResolvedValueOnce(referenceResponse())
        .mockResolvedValueOnce(jsonResponse({ ok: true }, 201));
      renderContribution();
      await screen.findByText("CASE-1234");
      fillRequiredFields();
      fireEvent.change(screen.getByLabelText("Votre réponse"), { target: { value: "Oui." } });
      fireEvent.click(screen.getByRole("button", { name: "Transmettre ma réponse" }));

      await screen.findByText("Réponse reçue");
      expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it("efface le jeton si le dépôt est refusé car le lien a expiré", async () => {
      mocks.fetch
        .mockResolvedValueOnce(referenceResponse())
        .mockResolvedValueOnce(jsonResponse({ error: "Ce dossier n’accepte plus de dépôt." }, 410));
      renderContribution();
      await screen.findByText("CASE-1234");
      fillRequiredFields();
      fireEvent.change(screen.getByLabelText("Votre réponse"), { target: { value: "Oui." } });
      fireEvent.click(screen.getByRole("button", { name: "Transmettre ma réponse" }));

      await waitFor(() =>
        expect(screen.getByRole("alert").textContent).toContain("n’accepte plus de dépôt"),
      );
      expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });
  });

  describe("pied de page", () => {
    it("propose la confidentialité et l'opposition sans exposer de lien signé", async () => {
      mocks.fetch.mockResolvedValueOnce(referenceResponse());
      renderContribution();
      await screen.findByText("CASE-1234");

      // One link in the information notice above the button, one in the footer.
      const privacyLinks = screen.getAllByRole("link", { name: "Politique de confidentialité" });
      expect(privacyLinks).toHaveLength(2);
      for (const privacy of privacyLinks) {
        expect(privacy.getAttribute("href")).toBe("/privacy");
        expect(privacy.getAttribute("rel")).toContain("noopener");
      }
      expect(
        screen.getByRole("button", { name: "Ne plus être contacté par Immojudis" }),
      ).toBeTruthy();
      expect(screen.queryByText(/Pour vous opposer ou exercer vos droits/)).toBeNull();
      expect(document.body.innerHTML).not.toContain("opt-out");
    });

    it("mène à la page d'opposition signée côté serveur au clic", async () => {
      const assign = vi.fn();
      mocks.fetch.mockResolvedValueOnce(referenceResponse());
      renderContribution();
      await screen.findByText("CASE-1234");
      vi.stubGlobal("location", { assign });

      expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe(TOKEN);

      fireEvent.click(screen.getByRole("button", { name: "Ne plus être contacté par Immojudis" }));

      expect(assign).toHaveBeenCalledWith(OPT_OUT_PATH);
      // The stored token is forgotten before the navigation.
      expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it("n'affiche pas l'opposition avec une adresse externe", async () => {
      mocks.fetch.mockResolvedValueOnce(
        jsonResponse({
          caseReference: "CASE-1234",
          subject: "Informations sur le bien",
          optOutPath: "https://evil.example/opt-out?e=1",
        }),
      );
      renderContribution();
      await screen.findByText("CASE-1234");

      expect(
        screen.queryByRole("button", { name: "Ne plus être contacté par Immojudis" }),
      ).toBeNull();
      expect(screen.getAllByRole("link", { name: "Politique de confidentialité" })).toHaveLength(2);
      expect(screen.getByText(/Pour vous opposer ou exercer vos droits/)).toBeTruthy();
    });

    it("publie l'adresse de contact quand le lien est expiré ou invalide", async () => {
      vi.stubEnv("NEXT_PUBLIC_LEGAL_CONTACT_EMAIL", "contact@immojudis.example");
      mocks.fetch.mockResolvedValueOnce(jsonResponse({ error: "Lien expiré." }, 410));
      renderContribution();
      await screen.findByRole("alert");

      expect(screen.queryByRole("button", { name: /Ne plus être contacté/ })).toBeNull();
      const contact = screen.getByRole("link", { name: "contact@immojudis.example" });
      expect(contact.getAttribute("href")).toBe("mailto:contact@immojudis.example");
      vi.unstubAllEnvs();
    });
  });

  describe("information des personnes", () => {
    it("informe lisiblement, au-dessus du bouton d'envoi, de l'usage, de l'IA et des droits", async () => {
      vi.stubEnv("NEXT_PUBLIC_LEGAL_ENTITY_NAME", "Immojudis SAS");
      mocks.fetch.mockResolvedValueOnce(referenceResponse());
      renderContribution();
      await screen.findByText("CASE-1234");

      const notice = document.getElementById("contribution-privacy-notice");
      expect(notice).not.toBeNull();
      expect(notice?.textContent).toContain("Immojudis (Immojudis SAS) utilise ces informations");
      expect(notice?.textContent).toContain("intérêt légitime");
      expect(notice?.textContent).toContain("prestataire établi aux États-Unis");
      expect(notice?.textContent).toContain("Conservation : 12 à 24 mois");
      expect(notice?.textContent).toContain("saisir la CNIL");
      expect(notice?.className).not.toContain("text-xs");
      expect(notice?.className).not.toContain("text-muted-foreground");

      const submit = screen.getByRole("button", { name: "Transmettre ma réponse" });
      expect(
        notice!.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        screen.getByText(/stockés dans un espace privé, accessible à l’équipe Immojudis/),
      ).toBeTruthy();
      vi.unstubAllEnvs();
    });
  });

  describe("accessibilité", () => {
    it("amène l'erreur de validation à l'écran et au focus, et marque le champ fautif", async () => {
      const scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView;
      mocks.fetch.mockResolvedValueOnce(referenceResponse());
      renderContribution();
      await screen.findByText("CASE-1234");

      fireEvent.click(screen.getByRole("button", { name: "Transmettre ma réponse" }));

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("Indiquez votre nom ou votre cabinet.");
      expect(alert.getAttribute("tabindex")).toBe("-1");
      await waitFor(() => expect(document.activeElement).toBe(alert));
      expect(scrollIntoView).toHaveBeenCalled();
      const name = screen.getByLabelText(/Nom ou cabinet/);
      expect(name.getAttribute("aria-invalid")).toBe("true");
      expect(name.getAttribute("aria-describedby")).toBe(alert.id);
      expect(screen.getByLabelText(/Adresse e-mail/).getAttribute("aria-invalid")).toBeNull();
    });

    it("garde l'indice du champ e-mail et refocalise une erreur répétée", async () => {
      Element.prototype.scrollIntoView = vi.fn();
      mocks.fetch.mockResolvedValueOnce(referenceResponse());
      renderContribution();
      await screen.findByText("CASE-1234");
      fireEvent.change(screen.getByLabelText(/Nom ou cabinet/), { target: { value: "Cabinet" } });
      fireEvent.change(screen.getByLabelText(/Adresse e-mail/), {
        target: { value: "pas-un-mail" },
      });

      fireEvent.click(screen.getByRole("button", { name: "Transmettre ma réponse" }));
      const alert = await screen.findByRole("alert");
      await waitFor(() => expect(document.activeElement).toBe(alert));
      const email = screen.getByLabelText(/Adresse e-mail/);
      expect(email.getAttribute("aria-invalid")).toBe("true");
      expect(email.getAttribute("aria-describedby")).toBe(`sender-email-hint ${alert.id}`);

      (document.activeElement as HTMLElement).blur();
      fireEvent.click(screen.getByRole("button", { name: "Transmettre ma réponse" }));
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("alert")));
    });

    it("déplace aria-invalid vers le nouveau champ fautif", async () => {
      Element.prototype.scrollIntoView = vi.fn();
      mocks.fetch.mockResolvedValueOnce(referenceResponse());
      renderContribution();
      await screen.findByText("CASE-1234");
      fireEvent.click(screen.getByRole("button", { name: "Transmettre ma réponse" }));
      await screen.findByRole("alert");

      fireEvent.change(screen.getByLabelText(/Nom ou cabinet/), { target: { value: "Cabinet" } });
      fireEvent.change(screen.getByLabelText(/Adresse e-mail/), {
        target: { value: "cabinet@example.test" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Transmettre ma réponse" }));

      await waitFor(() =>
        expect(screen.getByRole("alert").textContent).toContain("Ajoutez une réponse"),
      );
      expect(screen.getByLabelText(/Nom ou cabinet/).getAttribute("aria-invalid")).toBeNull();
      expect(screen.getByLabelText("Votre réponse").getAttribute("aria-invalid")).toBe("true");
    });

    it("focalise le titre « Réponse reçue » et remonte en haut après le dépôt", async () => {
      const scrollTo = vi.fn();
      vi.stubGlobal("scrollTo", scrollTo);
      mocks.fetch
        .mockResolvedValueOnce(referenceResponse())
        .mockResolvedValueOnce(jsonResponse({ ok: true }, 201));
      renderContribution();
      await screen.findByText("CASE-1234");
      fillRequiredFields();
      fireEvent.change(screen.getByLabelText("Votre réponse"), { target: { value: "Oui." } });
      fireEvent.click(screen.getByRole("button", { name: "Transmettre ma réponse" }));

      const title = await screen.findByRole("heading", { name: "Réponse reçue" });
      await waitFor(() => expect(document.activeElement).toBe(title));
      expect(title.getAttribute("tabindex")).toBe("-1");
      expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
    });

    it("montre le focus clavier sur la zone de dépôt et agrandit la cible « Retirer »", async () => {
      mocks.fetch.mockResolvedValueOnce(referenceResponse());
      renderContribution();
      await screen.findByText("CASE-1234");

      const input = screen.getByLabelText("Pièces jointes");
      expect(input.closest("label")?.className).toContain("has-[:focus-visible]:outline-2");
      expect(input.closest("label")?.className).toContain("has-[:focus-visible]:outline-gold-soft");

      fireEvent.change(input, {
        target: { files: [new File(["%PDF-1.7"], "pv.pdf", { type: "application/pdf" })] },
      });
      const remove = await screen.findByRole("button", { name: "Retirer pv.pdf" });
      expect(remove.className).toContain("min-h-11");
      expect(remove.className).toContain("min-w-11");
    });
  });

  describe("lisibilité du formulaire (n° 49)", () => {
    it("annonce les champs obligatoires avant le premier champ, avec l'objet de la vente en tête et la référence en petit", async () => {
      mocks.fetch.mockResolvedValueOnce(referenceResponse());
      renderContribution();
      await screen.findByText("CASE-1234");

      const legend = screen.getByText(/sont obligatoires/);
      const firstField = screen.getByLabelText(/Nom ou cabinet/);
      expect(
        legend.compareDocumentPosition(firstField) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(legend.textContent).toContain("Les champs marqués");

      const subject = screen.getByText("Informations sur le bien");
      expect(subject.className).toContain("text-2xl");
      expect(subject.className).toContain("font-display");
      const reference = screen.getByText("CASE-1234");
      expect(reference.className).not.toContain("text-2xl");
      expect(reference.parentElement?.textContent).toContain("Référence de suivi");
    });

    it("rappelle, avant le premier champ, ce que deviennent les données", async () => {
      mocks.fetch.mockResolvedValueOnce(referenceResponse());
      renderContribution();
      await screen.findByText("CASE-1234");

      const reminder = screen.getByText(/lues par l’équipe Immojudis, avec l’aide d’un outil d’IA/);
      expect(reminder.textContent).toContain("Rien n’est publié sans cette vérification");
      expect(
        reminder.compareDocumentPosition(screen.getByLabelText(/Nom ou cabinet/)) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it("garde des contrastes suffisants : bordure des champs, case cochée et survol des boutons", async () => {
      mocks.fetch.mockResolvedValueOnce(referenceResponse());
      renderContribution();
      await screen.findByText("CASE-1234");

      for (const field of [
        screen.getByLabelText(/Nom ou cabinet/),
        screen.getByLabelText(/Adresse e-mail/),
        screen.getByLabelText("Votre réponse"),
        screen.getByLabelText("Liens utiles"),
      ]) {
        expect(field.className).toContain("border-brand-navy/55");
        expect(field.className).not.toContain("border-input");
      }
      const checkbox = screen.getByLabelText(/J’atteste être autorisé/);
      expect(checkbox.className).toContain("accent-brand-navy");
      expect(checkbox.className).not.toContain("accent-gold");
      const submit = screen.getByRole("button", { name: "Transmettre ma réponse" });
      expect(submit.className).not.toContain("hover:bg-gold-soft");
      expect(submit.className).toContain("hover:bg-gold-light");
    });
  });

  describe("mêmes contrôles que le serveur, avant tout téléversement (n° 45)", () => {
    async function readyWithFile() {
      Element.prototype.scrollIntoView = vi.fn();
      mocks.fetch.mockResolvedValueOnce(referenceResponse());
      renderContribution();
      await screen.findByText("CASE-1234");
      fillRequiredFields();
      fireEvent.change(screen.getByLabelText("Pièces jointes"), {
        target: { files: [new File(["%PDF-1.7"], "pv.pdf", { type: "application/pdf" })] },
      });
    }

    it.each([
      [
        "une adresse e-mail que le serveur refuse",
        /Adresse e-mail/,
        "a@b.c",
        "Indiquez une adresse e-mail valide.",
        /Adresse e-mail/,
      ],
      [
        "un nom de 181 caractères",
        /Nom ou cabinet/,
        "N".repeat(181),
        "ne doit pas dépasser 180 caractères",
        /Nom ou cabinet/,
      ],
      [
        "une réponse de plus de 10 000 caractères",
        "Votre réponse",
        "x".repeat(10_001),
        "dépasse 10\u202f000 caractères",
        "Votre réponse",
      ],
      [
        "un lien de plus de 2 048 caractères",
        "Liens utiles",
        `https://example.test/${"a".repeat(2040)}`,
        "dépasse 2\u202f048 caractères",
        "Liens utiles",
      ],
      [
        "un lien avec identifiants",
        "Liens utiles",
        "https://u:mdp@example.test/",
        "Chaque lien doit commencer",
        "Liens utiles",
      ],
    ] as Array<[string, RegExp | string, string, string, RegExp | string]>)(
      "refuse %s sans rien téléverser, et désigne le champ",
      async (_label, fieldLabel, value, message, invalidLabel) => {
        await readyWithFile();
        fireEvent.change(screen.getByLabelText(fieldLabel), { target: { value } });

        fireEvent.click(screen.getByRole("button", { name: "Transmettre ma réponse" }));

        const alert = await screen.findByRole("alert");
        expect(alert.textContent).toContain(message);
        expect(screen.getByLabelText(invalidLabel).getAttribute("aria-invalid")).toBe("true");
        // Seule la lecture du dossier a eu lieu : pas de préparation de pièce, pas de dépôt.
        expect(mocks.fetch).toHaveBeenCalledTimes(1);
        expect(mocks.storageFrom).not.toHaveBeenCalled();
        expect(mocks.uploadToSignedUrl).not.toHaveBeenCalled();
      },
    );

    it("met en évidence le champ que le serveur désigne dans sa réponse 400", async () => {
      Element.prototype.scrollIntoView = vi.fn();
      mocks.fetch.mockResolvedValueOnce(referenceResponse()).mockResolvedValueOnce(
        jsonResponse(
          {
            error: "Chaque lien doit commencer par http:// ou https://.",
            field: "externalLinks",
          },
          400,
        ),
      );
      renderContribution();
      await screen.findByText("CASE-1234");
      fillRequiredFields();
      fireEvent.change(screen.getByLabelText("Votre réponse"), { target: { value: "Oui." } });
      fireEvent.click(screen.getByRole("button", { name: "Transmettre ma réponse" }));

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("Chaque lien doit commencer");
      expect(screen.getByLabelText("Liens utiles").getAttribute("aria-invalid")).toBe("true");
      expect(screen.getByLabelText("Votre réponse").getAttribute("aria-invalid")).toBeNull();
    });
  });
});
