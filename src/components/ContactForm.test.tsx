// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/contact/actions", () => ({ sendContactMessage: vi.fn() }));

import { ContactForm } from "./ContactForm";
import type { ContactState } from "@/lib/contact-message";

afterEach(cleanup);

describe("ContactForm", () => {
  it("propose nom, email, sujet et message avec des libellés visibles", () => {
    render(<ContactForm action={vi.fn()} />);
    for (const label of ["Nom", "Adresse email", "Sujet", "Message"]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: "Envoyer le message" })).toBeTruthy();
  });

  it("informe sur le traitement des données avec les liens vers la politique et Mes droits", () => {
    render(<ContactForm action={vi.fn()} />);
    const notice = screen.getByText(/pour répondre à votre demande/);
    expect(notice.textContent).toContain("Immojudis");
    expect(notice.textContent).toContain("conservés le temps du traitement");
    expect(
      screen.getByRole("link", { name: "politique de confidentialité" }).getAttribute("href"),
    ).toBe("/privacy");
    expect(screen.getByRole("link", { name: "Mes droits" }).getAttribute("href")).toBe(
      "/mes-droits",
    );
  });

  it("affiche l'erreur sous le champ concerné", async () => {
    const action = vi.fn(
      async (): Promise<ContactState> => ({
        status: "error",
        message: "Vérifiez les champs signalés.",
        fieldErrors: { email: "Cette adresse email n’est pas valide." },
        values: { name: "Claire" },
      }),
    );
    render(<ContactForm action={action} />);
    fireEvent.submit(screen.getByRole("form", { name: "Formulaire de contact" }));
    expect(await screen.findByText("Cette adresse email n’est pas valide.")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Vérifiez les champs signalés.");
    expect(screen.getByLabelText("Adresse email").getAttribute("aria-invalid")).toBe("true");
  });

  it("confirme l'envoi", async () => {
    const action = vi.fn(
      async (): Promise<ContactState> => ({ status: "sent", message: "Merci, c’est envoyé." }),
    );
    render(<ContactForm action={action} />);
    fireEvent.submit(screen.getByRole("form", { name: "Formulaire de contact" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Message envoyé"));
  });
});
