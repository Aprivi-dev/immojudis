// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InformationAgentContributionForm } from "./InformationAgentContributionForm";

const TOKEN = "a".repeat(64);
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
    maxFileBytes: 20 * 1024 * 1024,
    maxSubmissionBytes: 40 * 1024 * 1024,
    maxPortalBytes: 480 * 1024 * 1024,
    maxPortalFiles: 12,
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
  mocks.fetch.mockReset();
  mocks.storageFrom.mockReset();
  mocks.uploadToSignedUrl.mockReset();
  mocks.randomUUID.mockReset();
  mocks.storageFrom.mockReturnValue({ uploadToSignedUrl: mocks.uploadToSignedUrl });
  mocks.uploadToSignedUrl.mockResolvedValue({ data: { path: "uploaded" }, error: null });
  mocks.randomUUID.mockReturnValue("11111111-1111-4111-8111-111111111111");
  vi.stubGlobal("fetch", mocks.fetch);
  vi.stubGlobal("crypto", { randomUUID: mocks.randomUUID });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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

    expect((await screen.findByRole("alert")).textContent).toContain("invalide");
    expect(screen.queryByText("CASE-1234")).toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("");
  });

  it("accepte une réponse texte et des liens sans fichier", async () => {
    mocks.fetch
      .mockResolvedValueOnce(referenceResponse())
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, messageId: "message-1", assetCount: 0 }, 201),
      );
    renderContribution();
    await screen.findByText("CASE-1234");
    expect(screen.getByText(/Cette adresse est déclarative/)).toBeTruthy();
    fillRequiredFields();
    fireEvent.change(screen.getByLabelText("Votre réponse"), {
      target: { value: "La visite est possible sur rendez-vous." },
    });
    fireEvent.change(screen.getByLabelText("Liens utiles"), {
      target: { value: "https://example.test/plan" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Transmettre ma contribution" }));

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
    expect(screen.getByText(/jusqu’à 12 dépôts/)).toBeTruthy();
    fillRequiredFields();
    const file = new File(["%PDF-1.7"], "pv.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("Pièces jointes"), {
      target: { files: [file] },
    });
    expect(await screen.findByText("pv.pdf")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Transmettre ma contribution" }));

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
    fireEvent.click(screen.getByRole("button", { name: "Transmettre ma contribution" }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("temporairement indisponible"),
    );
    expect(mocks.randomUUID).toHaveBeenCalledTimes(2);
    expect(mocks.uploadToSignedUrl).toHaveBeenCalledTimes(1);
    const firstSubmit = JSON.parse(String(mocks.fetch.mock.calls[2]?.[1]?.body));

    fireEvent.click(screen.getByRole("button", { name: "Transmettre ma contribution" }));

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
});
