// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthLinkConfirmation } from "./AuthLinkConfirmation";

const mocks = vi.hoisted(() => ({
  verifyOtp: vi.fn(),
  resend: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("@/integrations/supabase/lazy", () => ({
  getSupabase: async () => ({ auth: { verifyOtp: mocks.verifyOtp, resend: mocks.resend } }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace }) }));
vi.mock("next/link", () => ({ default: "a" }));

const HASH = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";

function open(search: string) {
  window.history.replaceState(null, "", `/auth/confirmer${search}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyOtp.mockResolvedValue({ data: {}, error: null });
  mocks.resend.mockResolvedValue({ error: null });
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("page de confirmation des liens d'email", () => {
  it("ne vérifie rien à l'ouverture : seul le clic consomme le jeton", async () => {
    open(
      `?token_hash=${HASH}&type=signup&redirect_to=${encodeURIComponent(`${window.location.origin}/bienvenue`)}`,
    );
    render(<AuthLinkConfirmation />);
    const button = await screen.findByRole("button", { name: "Confirmer mon adresse" });
    // Une passerelle qui ouvre le lien charge la page : aucun appel à Supabase.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.verifyOtp).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(button).toBeTruthy();
    expect(screen.getByText(/rien n’est validé tant que vous n’avez pas cliqué/)).toBeTruthy();
  });

  it("prend les briques du site : carte, titre de page, bouton principal marine, sans habillage « liquid »", async () => {
    open(`?token_hash=${HASH}&type=signup`);
    const { container } = render(<AuthLinkConfirmation />);
    const button = await screen.findByRole("button", { name: "Confirmer mon adresse" });
    expect(button.className).toContain("bg-brand-navy");
    expect(screen.getByRole("heading", { level: 1 }).className).toContain("text-[2rem]");
    expect(container.innerHTML).not.toMatch(/liquid-|glass-|red-700/);
  });

  it("vérifie le jeton au clic, efface-le de l'adresse et mène vers l'adresse de retour du site", async () => {
    open(
      `?token_hash=${HASH}&type=signup&redirect_to=${encodeURIComponent(`${window.location.origin}/bienvenue?retour=%2Fsales%2F12`)}`,
    );
    render(<AuthLinkConfirmation />);
    fireEvent.click(await screen.findByRole("button", { name: "Confirmer mon adresse" }));
    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith("/bienvenue?retour=%2Fsales%2F12"),
    );
    expect(mocks.verifyOtp).toHaveBeenCalledTimes(1);
    expect(mocks.verifyOtp).toHaveBeenCalledWith({ type: "signup", token_hash: HASH });
    expect(window.location.search).toBe("");
    expect(window.location.href).not.toContain(HASH);
  });

  it("n'efface pas le jeton avant le clic : une actualisation de la page garde le lien utilisable", async () => {
    open(`?token_hash=${HASH}&type=signup`);
    render(<AuthLinkConfirmation />);
    await screen.findByRole("button", { name: "Confirmer mon adresse" });
    expect(window.location.search).toContain(HASH);
  });

  it("mène un lien de mot de passe vers la saisie du nouveau mot de passe, et ignore l'adresse de retour", async () => {
    open(`?token_hash=${HASH}&type=recovery&redirect_to=https://evil.example/x`);
    render(<AuthLinkConfirmation />);
    fireEvent.click(await screen.findByRole("button", { name: "Choisir un nouveau mot de passe" }));
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/reinitialiser-mot-de-passe"));
    expect(mocks.verifyOtp).toHaveBeenCalledWith({ type: "recovery", token_hash: HASH });
  });

  it("refuse une adresse de retour d'un autre site : retour à /bienvenue", async () => {
    open(`?token_hash=${HASH}&type=signup&redirect_to=https://evil.example/phishing`);
    render(<AuthLinkConfirmation />);
    fireEvent.click(await screen.findByRole("button", { name: "Confirmer mon adresse" }));
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/bienvenue"));
  });

  it("envoie un lien de mot de passe expiré vers la page qui sait l'expliquer", async () => {
    mocks.verifyOtp.mockResolvedValue({ data: {}, error: { code: "otp_expired", status: 403 } });
    open(`?token_hash=${HASH}&type=recovery`);
    render(<AuthLinkConfirmation />);
    fireEvent.click(await screen.findByRole("button", { name: "Choisir un nouveau mot de passe" }));
    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith("/reinitialiser-mot-de-passe?error=otp_expired"),
    );
  });

  it("explique l'échec d'une inscription et propose de renvoyer l'email de confirmation", async () => {
    mocks.verifyOtp.mockResolvedValue({ data: {}, error: { code: "otp_expired", status: 403 } });
    open(
      `?token_hash=${HASH}&type=signup&redirect_to=${encodeURIComponent(`${window.location.origin}/bienvenue`)}`,
    );
    render(<AuthLinkConfirmation />);
    fireEvent.click(await screen.findByRole("button", { name: "Confirmer mon adresse" }));
    expect((await screen.findByRole("alert")).textContent).toContain("expiré");
    expect(mocks.replace).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Adresse email du compte"), {
      target: { value: " claire@example.test " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Renvoyer l’email" }));
    await waitFor(() =>
      expect(mocks.resend).toHaveBeenCalledWith({
        type: "signup",
        email: "claire@example.test",
        options: { emailRedirectTo: `${window.location.origin}/bienvenue` },
      }),
    );
    expect((await screen.findByRole("status")).textContent).toContain(
      "Email renvoyé à claire@example.test",
    );
  });

  it("dit l'échec du renvoi sans le cacher", async () => {
    mocks.verifyOtp.mockResolvedValue({ data: {}, error: { code: "otp_expired" } });
    mocks.resend.mockResolvedValue({ error: { message: "rate limit" } });
    open(`?token_hash=${HASH}&type=signup`);
    render(<AuthLinkConfirmation />);
    fireEvent.click(await screen.findByRole("button", { name: "Confirmer mon adresse" }));
    fireEvent.change(await screen.findByLabelText("Adresse email du compte"), {
      target: { value: "claire@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Renvoyer l’email" }));
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("alert")
          .map((node) => node.textContent)
          .join(" "),
      ).toContain("Impossible de renvoyer l’email"),
    );
  });

  it("propose un nouveau lien quand un autre type de lien a échoué", async () => {
    mocks.verifyOtp.mockResolvedValue({ data: {}, error: { code: "otp_expired" } });
    open(`?token_hash=${HASH}&type=email_change`);
    render(<AuthLinkConfirmation />);
    fireEvent.click(await screen.findByRole("button", { name: "Confirmer le changement" }));
    expect((await screen.findByRole("alert")).textContent).toContain("expiré");
    expect(screen.queryByRole("button", { name: "Renvoyer l’email" })).toBeNull();
  });

  it.each([
    ["magiclink", "Me connecter", "/login", /Vous connecter/],
    ["invite", "Accepter l’invitation", "/contact", /contactez la personne/],
    ["email_change", "Confirmer le changement", "/compte", /reprenez le changement/],
  ])(
    "propose, pour un lien %s échoué, la suite qui lui convient",
    async (type, button, href, text) => {
      mocks.verifyOtp.mockResolvedValue({ data: {}, error: { code: "otp_expired" } });
      open(`?token_hash=${HASH}&type=${type}`);
      render(<AuthLinkConfirmation />);
      fireEvent.click(await screen.findByRole("button", { name: button }));
      await screen.findByRole("alert");
      expect(document.body.textContent).toMatch(text);
      expect(screen.getAllByRole("link").some((link) => link.getAttribute("href") === href)).toBe(
        true,
      );
      expect(document.body.textContent).not.toContain("mot de passe oublié");
    },
  );

  it("n'envoie pas l'email de renvoi vers un autre site", async () => {
    mocks.verifyOtp.mockResolvedValue({ data: {}, error: { code: "otp_expired" } });
    open(
      `?token_hash=${HASH}&type=signup&redirect_to=${encodeURIComponent("https://immojudis.com//evil.example")}`,
    );
    render(<AuthLinkConfirmation />);
    fireEvent.click(await screen.findByRole("button", { name: "Confirmer mon adresse" }));
    fireEvent.change(await screen.findByLabelText("Adresse email du compte"), {
      target: { value: "claire@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Renvoyer l’email" }));
    await waitFor(() => expect(mocks.resend).toHaveBeenCalled());
    const target = mocks.resend.mock.calls[0][0].options.emailRedirectTo as string;
    expect(new URL(target).origin).toBe(window.location.origin);
    expect(target).not.toContain("evil.example");
  });

  it.each([
    ["sans jeton", "?type=signup"],
    ["sans type", `?token_hash=${HASH}`],
    ["avec un type inconnu", `?token_hash=${HASH}&type=admin`],
    ["sans paramètre", ""],
  ])(
    "affiche un lien incomplet, sans bouton ni appel, quand le lien est %s",
    async (_label, search) => {
      open(search);
      render(<AuthLinkConfirmation />);
      expect((await screen.findByRole("alert")).textContent).toContain("incomplet");
      expect(screen.queryByRole("button")).toBeNull();
      expect(mocks.verifyOtp).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["signup", "Confirmer mon adresse"],
    ["recovery", "Choisir un nouveau mot de passe"],
    ["email_change", "Confirmer le changement"],
    ["magiclink", "Me connecter"],
    ["invite", "Accepter l’invitation"],
  ])("propose le bouton du type %s", async (type, label) => {
    open(`?token_hash=${HASH}&type=${type}`);
    render(<AuthLinkConfirmation />);
    expect(await screen.findByRole("button", { name: label })).toBeTruthy();
  });

  it("ne vérifie le jeton qu'une fois, même si le bouton est cliqué plusieurs fois", async () => {
    let finish: (value: unknown) => void = () => undefined;
    mocks.verifyOtp.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    open(`?token_hash=${HASH}&type=signup`);
    render(<AuthLinkConfirmation />);
    const button = await screen.findByRole("button", { name: "Confirmer mon adresse" });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    finish({ data: {}, error: null });
    await waitFor(() => expect(mocks.replace).toHaveBeenCalled());
    expect(mocks.verifyOtp).toHaveBeenCalledTimes(1);
  });
});
