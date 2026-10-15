// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SaleCalendarButton } from "./SaleCalendarButton";

const saleId = "11111111-1111-4111-8111-111111111111";

describe("SaleCalendarButton", () => {
  const createObjectURL = vi.fn(() => "blob:ics");
  const revokeObjectURL = vi.fn();
  let clicked: { href: string; download: string }[] = [];

  beforeEach(() => {
    clicked = [];
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
    fireEvent.click(screen.getByRole("button", { name: "Ajouter à mon agenda" }));

    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledWith(`/api/sales/${saleId}/calendar`);
    expect(clicked[0].download).toBe("immojudis-audience-11111111.ics");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:ics");
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
              "La date de cette audience n’est pas assez sûre pour être ajoutée à un agenda. Consultez la fiche de la vente.",
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    render(<SaleCalendarButton saleId={saleId} />);

    fireEvent.click(screen.getByRole("button", { name: "Ajouter à mon agenda" }));

    expect((await screen.findByRole("alert")).textContent).toContain("pas assez sûre");
    expect(clicked).toHaveLength(0);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Ajouter à mon agenda" })).toBeTruthy();
  });

  it("shows a neutral message when the network fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    render(<SaleCalendarButton saleId={saleId} />);

    fireEvent.click(screen.getByRole("button", { name: "Ajouter à mon agenda" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Connexion impossible");
    expect(clicked).toHaveLength(0);
  });
});
