// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  search: {} as { mode?: "investor" | "professional"; redirect?: string },
  signIn: vi.fn(),
  signUp: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: null, profile: null, loading: false }),
}));
vi.mock("@/integrations/supabase/client", () => ({
  isSupabaseConfigured: true,
  supabase: {
    auth: { signInWithPassword: mocks.signIn, signUp: mocks.signUp },
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: mocks.toastError } }));
vi.mock("@/lib/router-compat", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useSearch: () => mocks.search,
  }),
  useNavigate: () => vi.fn(),
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

import { LoginPage } from "./login";

beforeEach(() => {
  mocks.search = {};
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("login page", () => {
  it("has a single page heading and no administration entry point", () => {
    render(<LoginPage />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.queryByText(/Piloter les annonces, scans et accès/)).toBeNull();
    expect(screen.getByRole("button", { name: "Créer un compte" })).toBeTruthy();
  });

  it("mentions the terms and the privacy policy when creating an account", () => {
    mocks.search = { mode: "investor" };
    render(<LoginPage />);
    expect(screen.getByText(/En créant un compte, vous acceptez/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "conditions générales" }).getAttribute("href")).toBe(
      "/conditions-generales",
    );
    expect(
      screen.getByRole("link", { name: "politique de confidentialité" }).getAttribute("href"),
    ).toBe("/privacy");
  });

  it("records the accepted document versions with the sign-up", async () => {
    mocks.search = { mode: "investor" };
    mocks.signUp.mockResolvedValue({ error: null });
    render(<LoginPage />);
    fireEvent.change(screen.getByPlaceholderText("vous@exemple.fr"), {
      target: { value: "nouvel.utilisateur@example.test" },
    });
    fireEvent.change(screen.getByPlaceholderText("8 caractères minimum"), {
      target: { value: "un-mot-de-passe-solide" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Créer mon compte gratuit/ }));
    await waitFor(() => expect(mocks.signUp).toHaveBeenCalledTimes(1));
    const options = mocks.signUp.mock.calls[0][0].options.data;
    expect(options.terms_version).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    expect(options.privacy_version).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    expect(typeof options.terms_accepted_at).toBe("string");
  });

  it("shows a French error inside the form instead of the raw Supabase message", async () => {
    mocks.signIn.mockResolvedValue({ error: new Error("Invalid login credentials") });
    render(<LoginPage />);
    fireEvent.change(screen.getByPlaceholderText("vous@exemple.fr"), {
      target: { value: "quelquun@example.test" },
    });
    fireEvent.change(screen.getByPlaceholderText("Votre mot de passe"), {
      target: { value: "mauvais-mot-de-passe" },
    });
    const submit = screen
      .getAllByRole("button", { name: "Se connecter" })
      .find((button) => button.getAttribute("type") === "submit");
    fireEvent.click(submit!);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Email ou mot de passe incorrect.");
    expect(mocks.toastError).toHaveBeenCalledWith("Email ou mot de passe incorrect.");
  });

  it("lets visitors reveal the password they typed", () => {
    render(<LoginPage />);
    const field = screen.getByPlaceholderText("Votre mot de passe") as HTMLInputElement;
    expect(field.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Afficher le mot de passe" }));
    expect(field.type).toBe("text");
  });
});
