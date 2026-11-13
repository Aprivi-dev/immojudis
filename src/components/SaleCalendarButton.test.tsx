// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SaleCalendarButton } from "./SaleCalendarButton";

const mocks = vi.hoisted(() => ({ hasSession: vi.fn() }));
vi.mock("@/integrations/supabase/lazy", () => ({
  hasSupabaseAuthHint: mocks.hasSession,
  getSupabase: async () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: "token" } } }) },
  }),
}));

const saleId = "11111111-1111-4111-8111-111111111111";

describe("SaleCalendarButton", () => {
  const createObjectURL = vi.fn(() => "blob:ics");
  const revokeObjectURL = vi.fn();
  let clicked: { href: string; download: string }[] = [];

  beforeEach(() => {
    clicked = [];
    // Sans session stockée : un visiteur anonyme.
    mocks.hasSession.mockReset();
    mocks.hasSession.mockReturnValue(false);
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ href: this.href, download: this.download });
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
  });

  it("shows the verification notice and downloads the file without any account", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", {
        status: 200,
        headers: {
          "content-type": "text/calendar; charset=utf-8",
          "content-disposition": 'attachment; filename="immojudis-audience-11111111.ics"',
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<SaleCalendarButton saleId={saleId} />);

    expect(screen.getByText(/à vérifier auprès de l’avocat poursuivant/)).toBeTruthy();
    expect(screen.getByText(/ne se met pas à jour si la date change/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ajouter à mon agenda" }));

    await waitFor(() => expect(clicked).toHaveLength(1));
    // Fichier public : sans jeton, et sans délai.
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/sales/${saleId}/calendar`,
      expect.objectContaining({ headers: {}, signal: undefined }),
    );
    expect(clicked[0].download).toBe("immojudis-audience-11111111.ics");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:ics");
    expect(screen.queryByRole("alert")).toBeNull();
    // Visiteur sans compte : le téléchargement n'envoie aucune mesure.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports the download of a signed-in account, once the file is saved", async () => {
    mocks.hasSession.mockReturnValue(true);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", {
          status: 200,
          headers: { "content-disposition": 'attachment; filename="immojudis-audience-1.ics"' },
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ recorded: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<SaleCalendarButton saleId={saleId} />);

    fireEvent.click(screen.getByRole("button", { name: "Ajouter à mon agenda" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(clicked).toHaveLength(1);
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/sales/${saleId}/calendar/exported`,
      expect.objectContaining({ method: "POST", headers: { Authorization: "Bearer token" } }),
    );
  });

  it("keeps the download working when the measure fails", async () => {
    mocks.hasSession.mockReturnValue(true);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", { status: 200 }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);
    render(<SaleCalendarButton saleId={saleId} />);

    fireEvent.click(screen.getByRole("button", { name: "Ajouter à mon agenda" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(clicked).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("explains a refusal instead of downloading a broken file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            error:
              "La date de cette audience n’est pas confirmée (report, information contradictoire ou source unique) : nous ne l’ajoutons pas à votre agenda. Vérifiez-la auprès de l’avocat poursuivant ou du greffe.",
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    render(<SaleCalendarButton saleId={saleId} />);

    fireEvent.click(screen.getByRole("button", { name: "Ajouter à mon agenda" }));

    expect((await screen.findByRole("alert")).textContent).toContain("n’est pas confirmée");
    expect(clicked).toHaveLength(0);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Ajouter à mon agenda" })).toBeTruthy();
    // Un export refusé n'est pas un export : rien n'est mesuré.
    expect(mocks.hasSession).not.toHaveBeenCalled();
  });

  it("shows a neutral message when the network fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    render(<SaleCalendarButton saleId={saleId} />);

    fireEvent.click(screen.getByRole("button", { name: "Ajouter à mon agenda" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Connexion impossible");
    expect(clicked).toHaveLength(0);
  });
});
