// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: "" }));

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(mocks.query) }));
vi.mock("@/app/contact/actions", () => ({ sendContactMessage: vi.fn() }));

import { ContactPrefilledForm } from "./ContactPrefilledForm";
import { contactReportPath } from "@/lib/contact-message";

afterEach(cleanup);

const SALE = "4655881c-249d-4eab-beba-f2624d8a1af0";

describe("ContactPrefilledForm", () => {
  it("prérempli le sujet et le message d'un signalement depuis une fiche", () => {
    mocks.query = contactReportPath(SALE, "prix").split("?")[1];
    render(<ContactPrefilledForm />);
    expect((screen.getByLabelText("Sujet") as HTMLSelectElement).value).toBe("erreur");
    const message = (screen.getByLabelText("Message") as HTMLTextAreaElement).value;
    expect(message).toContain(`Vente concernée : ${SALE}`);
    expect(message).toContain("Rubrique : Mise à prix");
  });

  it("reste le formulaire habituel sans paramètre", () => {
    mocks.query = "";
    render(<ContactPrefilledForm />);
    expect((screen.getByLabelText("Sujet") as HTMLSelectElement).value).toBe("");
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("");
  });
});
