// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), headers: vi.fn(), fetch: vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => mocks.auth() }));
vi.mock("@/lib/client-api-core", () => ({ authHeaders: mocks.headers }));

import { SaleSignalFeedback } from "./SaleSignalFeedback";

const saleId = "11111111-1111-4111-8111-111111111111";

function respond(recorded: boolean, ok = true) {
  mocks.fetch.mockResolvedValue({ ok, json: async () => ({ recorded }) });
}

function lastBody() {
  const calls = mocks.fetch.mock.calls;
  return JSON.parse(calls[calls.length - 1][1].body as string);
}

describe("SaleSignalFeedback", () => {
  beforeEach(() => {
    mocks.auth.mockReturnValue({ user: { id: "user-1" }, loading: false });
    mocks.headers.mockResolvedValue({ Authorization: "Bearer token" });
    respond(true);
    vi.stubGlobal("fetch", mocks.fetch);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it("renders nothing without an account: no anonymous measure", () => {
    mocks.auth.mockReturnValue({ user: null, loading: false });

    const { container } = render(<SaleSignalFeedback saleId={saleId} signal="market_gap_band" />);

    expect(container.innerHTML).toBe("");
  });

  it("renders nothing while the session is being read", () => {
    mocks.auth.mockReturnValue({ user: null, loading: true });

    const { container } = render(<SaleSignalFeedback saleId={saleId} signal="market_gap_band" />);

    expect(container.innerHTML).toBe("");
  });

  it("offers « Utile » and « Pas pertinent » to an account", () => {
    render(<SaleSignalFeedback saleId={saleId} signal="market_gap_band" />);

    expect(screen.getByText("Ce repère vous est-il utile ?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Utile" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pas pertinent" })).toBeTruthy();
    expect(screen.queryByText(/Pourquoi/)).toBeNull();
  });

  it("asks about the list for the points to verify", () => {
    render(<SaleSignalFeedback saleId={saleId} signal="points_to_verify" />);

    expect(screen.getByText("Cette liste vous est-elle utile ?")).toBeTruthy();
  });

  it("sends a « useful » to the route of the sale with the session, and confirms", async () => {
    render(<SaleSignalFeedback saleId={saleId} signal="market_gap_band" />);

    fireEvent.click(screen.getByRole("button", { name: "Utile" }));

    await waitFor(() =>
      expect(screen.getByTestId("sale-signal-feedback-status").textContent).toContain("Merci"),
    );
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = mocks.fetch.mock.calls[0];
    expect(url).toBe(`/api/sales/${saleId}/signal-feedback`);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Authorization: "Bearer token" });
    expect(lastBody()).toEqual({ signal: "market_gap_band", value: "useful" });
    expect(screen.getByRole("button", { name: "Utile" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText(/Pourquoi/)).toBeNull();
  });

  it("offers the reasons of the market gap band after « Pas pertinent », then sends the reason", async () => {
    render(<SaleSignalFeedback saleId={saleId} signal="market_gap_band" />);

    fireEvent.click(screen.getByRole("button", { name: "Pas pertinent" }));
    await screen.findByText("Pourquoi ? (facultatif)");
    expect(lastBody()).toEqual({ signal: "market_gap_band", value: "not_relevant" });
    expect(screen.getByRole("button", { name: "Estimation trop haute" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Estimation trop basse" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Un point est faux" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Estimation trop basse" }));
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
    expect(lastBody()).toEqual({
      signal: "market_gap_band",
      value: "not_relevant",
      reason: "estimate_too_low",
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Estimation trop basse" }).getAttribute("aria-pressed"),
      ).toBe("true"),
    );
  });

  it("offers the reasons of the points to verify: a wrong point, a missing point", async () => {
    render(<SaleSignalFeedback saleId={saleId} signal="points_to_verify" />);

    fireEvent.click(screen.getByRole("button", { name: "Pas pertinent" }));
    await screen.findByText("Pourquoi ? (facultatif)");
    expect(screen.getByRole("button", { name: "Un point est faux" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Un point manque" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Un point est faux" }));
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
    expect(lastBody()).toEqual({
      signal: "points_to_verify",
      value: "not_relevant",
      reason: "point_wrong",
    });
  });

  it("collects no free text: there is no field to type in", async () => {
    render(<SaleSignalFeedback saleId={saleId} signal="points_to_verify" />);
    fireEvent.click(screen.getByRole("button", { name: "Pas pertinent" }));
    await screen.findByText("Pourquoi ? (facultatif)");

    expect(document.querySelectorAll("input, textarea, [contenteditable]")).toHaveLength(0);
  });

  it("says so when the feedback could not be recorded, without marking the button", async () => {
    respond(false);
    render(<SaleSignalFeedback saleId={saleId} signal="market_gap_band" />);

    fireEvent.click(screen.getByRole("button", { name: "Utile" }));

    await waitFor(() =>
      expect(screen.getByTestId("sale-signal-feedback-status").textContent).toContain(
        "n’a pas pu être enregistré",
      ),
    );
    expect(screen.getByRole("button", { name: "Utile" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("says so when the session is missing or the network fails", async () => {
    mocks.headers.mockRejectedValue(new Error("Connexion requise."));
    render(<SaleSignalFeedback saleId={saleId} signal="market_gap_band" />);

    fireEvent.click(screen.getByRole("button", { name: "Utile" }));

    await waitFor(() =>
      expect(screen.getByTestId("sale-signal-feedback-status").textContent).toContain(
        "n’a pas pu être enregistré",
      ),
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("has no accessibility defect, with the reasons open", async () => {
    render(<SaleSignalFeedback saleId={saleId} signal="points_to_verify" />);
    fireEvent.click(screen.getByRole("button", { name: "Pas pertinent" }));
    await screen.findByText("Pourquoi ? (facultatif)");

    const result = await axe(document.body, {
      rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
    });
    expect(result.violations.map(({ id, help }) => ({ id, help }))).toEqual([]);
  });
});
