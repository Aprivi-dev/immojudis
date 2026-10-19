// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  search: {} as { mode?: "investor" | "professional"; redirect?: string; reason?: string },
  launch: { active: false, pending: false },
  replace: vi.fn(),
  signIn: vi.fn(),
  signUp: vi.fn(),
  resend: vi.fn(),
  toastError: vi.fn(),
  track: vi.fn(),
}));
vi.mock("@/lib/product-events", () => ({ trackProductEvent: mocks.track }));

vi.mock("@/hooks/use-launch-offer", () => ({ useLaunchOffer: () => mocks.launch }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: null, profile: null, loading: false }),
}));
vi.mock("@/integrations/supabase/client", () => ({
  isSupabaseConfigured: true,
  supabase: {
    auth: { signInWithPassword: mocks.signIn, signUp: mocks.signUp, resend: mocks.resend },
  },
}));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: mocks.toastError } }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/login",
  useRouter: () => ({ push: vi.fn(), replace: mocks.replace, refresh: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(mocks.search),
}));

import { LAUNCH_OFFER_VISITOR_TEXT } from "@/lib/launch-offer";
import { LoginPage } from "./login-page";

beforeEach(() => {
  mocks.search = {};
  mocks.launch = { active: false, pending: false };
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
    // The sentence quotes the exact label of the button that triggers the sign-up.
    const submit = screen.getByRole("button", { name: /Créer mon compte gratuit/ });
    expect(
      screen
        .getByText(/vous acceptez les/)
        .textContent?.startsWith(
          `En cliquant sur « ${submit.textContent?.trim()} », vous acceptez les`,
        ),
    ).toBe(true);
    expect(screen.queryByText(/En créant un compte/)).toBeNull();
    expect(
      screen.getByText(/vous reconnaissez avoir pris connaissance de la/).textContent,
    ).toContain("les conditions générales et vous reconnaissez avoir pris connaissance de la");
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
    fireEvent.change(screen.getByPlaceholderText("12 caractères minimum"), {
      target: { value: "un-mot-de-passe-solide" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Créer mon compte gratuit/ }));
    await waitFor(() => expect(mocks.signUp).toHaveBeenCalledTimes(1));
    const options = mocks.signUp.mock.calls[0][0].options.data;
    expect(options.terms_version).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    expect(options.privacy_version).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    expect(typeof options.terms_accepted_at).toBe("string");
    expect(mocks.track).toHaveBeenCalledTimes(1);
    expect(mocks.track).toHaveBeenCalledWith("signup_completed");
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

  it("change de mode en gardant l'adresse de retour dans la requête", () => {
    mocks.search = { redirect: "/sales?city=Bordeaux" };
    render(<LoginPage />);
    fireEvent.click(screen.getByRole("button", { name: "Créer un compte" }));
    expect(mocks.replace).toHaveBeenLastCalledWith(
      "/login?redirect=%2Fsales%3Fcity%3DBordeaux&mode=investor",
    );
    fireEvent.click(screen.getByRole("button", { name: "Professionnel" }));
    expect(mocks.replace).toHaveBeenLastCalledWith(
      "/login?redirect=%2Fsales%3Fcity%3DBordeaux&mode=professional",
    );
  });

  it("revient au mode connexion en retirant seulement le paramètre mode", () => {
    mocks.search = { mode: "investor", redirect: "/sales" };
    render(<LoginPage />);
    fireEvent.click(screen.getAllByRole("button", { name: "Se connecter" })[0]);
    expect(mocks.replace).toHaveBeenLastCalledWith("/login?redirect=%2Fsales");
  });

  it("ignore une adresse de retour extérieure au site", () => {
    mocks.search = { redirect: "https://evil.example/phish" };
    render(<LoginPage />);
    fireEvent.click(screen.getByRole("button", { name: "Créer un compte" }));
    // La requête brute est conservée telle quelle ; seule la destination après connexion est filtrée.
    expect(mocks.replace).toHaveBeenLastCalledWith(
      "/login?redirect=https%3A%2F%2Fevil.example%2Fphish&mode=investor",
    );
  });

  it("explique pourquoi on arrive ici : bandeau du motif, en création de compte et en connexion", () => {
    mocks.search = { mode: "investor", reason: "alerte" };
    const { unmount } = render(<LoginPage />);
    expect(screen.getByTestId("login-reason").textContent).toBe(
      "Créez votre compte gratuit pour enregistrer cette alerte, sans carte bancaire.",
    );
    unmount();

    mocks.search = { reason: "favori" };
    render(<LoginPage />);
    expect(screen.getByTestId("login-reason").textContent).toBe(
      "Connectez-vous pour garder cette vente en favori.",
    );
  });

  it("explique le détour depuis une fiche : ce que le compte gratuit ouvre, ou la simple connexion", () => {
    mocks.search = { mode: "investor", reason: "fiche" };
    const { unmount } = render(<LoginPage />);
    expect(screen.getByTestId("login-reason").textContent).toBe(
      "Créez votre compte gratuit pour voir l'adresse, les photos et la fourchette de valeur de cette vente, et en débloquer 3 en détail chaque mois (contenu selon la vente).",
    );
    unmount();

    mocks.search = { reason: "fiche" };
    render(<LoginPage />);
    expect(screen.getByTestId("login-reason").textContent).toBe(
      "Connectez-vous pour consulter cette vente.",
    );
  });

  it("répète la promesse du compte gratuit là où la colonne d'explication est masquée (mobile)", () => {
    mocks.search = { mode: "investor" };
    const { unmount } = render(<LoginPage />);
    const promise = screen.getByTestId("login-free-promise");
    expect(promise.textContent).toBe(
      "Gratuit : 3 ventes en détail par mois (enchère plafond, lecture des pièces, historique, selon la vente), sans carte bancaire",
    );
    // Visible sous le point de rupture « lg », où la colonne d'explication prend le relais.
    expect(promise.className).toContain("lg:hidden");
    unmount();

    mocks.search = {};
    render(<LoginPage />);
    expect(screen.queryByTestId("login-free-promise")).toBeNull();
  });

  it("explique le détour depuis l'espace personnel : favoris et alertes", () => {
    mocks.search = { reason: "mes-favoris" };
    const { unmount } = render(<LoginPage />);
    expect(screen.getByTestId("login-reason").textContent).toBe(
      "Connectez-vous pour retrouver vos favoris.",
    );
    unmount();

    mocks.search = { reason: "mes-alertes" };
    render(<LoginPage />);
    expect(screen.getByTestId("login-reason").textContent).toBe(
      "Connectez-vous pour retrouver vos alertes.",
    );
  });

  it("l'export n'est promis au compte gratuit que si c'est vrai : exact dans les deux états", () => {
    mocks.search = { mode: "investor", reason: "export" };
    const { unmount } = render(<LoginPage />);
    // Offre de lancement coupée : l'export est réservé à Analyse.
    expect(screen.getByTestId("login-reason").textContent).toBe(
      "Créez votre compte gratuit, sans carte bancaire. L’export des résultats est réservé à l’offre Analyse.",
    );
    unmount();

    mocks.launch = { active: true, pending: false };
    const active = render(<LoginPage />);
    expect(screen.getByTestId("login-reason").textContent).toContain(
      "Créez votre compte gratuit pour exporter ces résultats",
    );
    expect(screen.getByTestId("login-reason").textContent).toContain("offre de lancement");
    active.unmount();

    mocks.search = { reason: "export" };
    render(<LoginPage />);
    expect(screen.getByTestId("login-reason").textContent).toBe(
      "Connectez-vous pour exporter ces résultats.",
    );
  });

  it("annonce 10 favoris offerts et le motif « ouverture » de la liste d'attente", () => {
    mocks.search = { mode: "investor", reason: "favori" };
    const { unmount } = render(<LoginPage />);
    expect(screen.getByTestId("login-reason").textContent).toContain("(10 favoris offerts)");
    unmount();

    mocks.search = { mode: "investor", reason: "ouverture" };
    const signup = render(<LoginPage />);
    expect(screen.getByTestId("login-reason").textContent).toBe(
      "Créez votre compte gratuit pour être prévenu de l’ouverture de l’offre Analyse.",
    );
    signup.unmount();

    mocks.search = { reason: "ouverture" };
    render(<LoginPage />);
    expect(screen.getByTestId("login-reason").textContent).toBe(
      "Connectez-vous pour être prévenu de l’ouverture de l’offre Analyse.",
    );
  });

  it("offre de lancement : la mention du visiteur remplace la promesse des 3 ventes", () => {
    mocks.search = { mode: "investor" };
    mocks.launch = { active: true, pending: false };
    render(<LoginPage />);

    expect(screen.getByTestId("login-free-promise").textContent).toBe(LAUNCH_OFFER_VISITOR_TEXT);
    expect(screen.getByTestId("login-launch-offer").textContent).toBe(LAUNCH_OFFER_VISITOR_TEXT);
    expect(screen.getByTestId("login-launch-offer-column").textContent).toBe(
      LAUNCH_OFFER_VISITOR_TEXT,
    );
  });

  it("offre de lancement : motifs « offre » et « fiche » sans promesse de quota", () => {
    mocks.launch = { active: true, pending: false };
    mocks.search = { mode: "investor", reason: "fiche" };
    const { unmount } = render(<LoginPage />);
    expect(screen.getByTestId("login-reason").textContent).toContain("offre de lancement");
    expect(screen.getByTestId("login-reason").textContent).not.toContain("3 en détail");
    unmount();

    mocks.search = { mode: "investor", reason: "offre" };
    render(<LoginPage />);
    expect(screen.getByTestId("login-reason").textContent).toBe(
      "Créez votre compte gratuit : pendant l’offre de lancement, il bénéficie des avantages de l’offre Analyse.",
    );
  });

  it("sans offre de lancement, aucune mention de l'offre n'apparaît", () => {
    mocks.search = { mode: "investor" };
    render(<LoginPage />);
    expect(screen.queryByTestId("login-launch-offer")).toBeNull();
    expect(screen.queryByTestId("login-launch-offer-column")).toBeNull();
  });

  it("n'affiche aucun bandeau pour un motif inconnu", () => {
    mocks.search = { mode: "investor", reason: "inconnu" };
    render(<LoginPage />);
    expect(screen.queryByTestId("login-reason")).toBeNull();
  });

  it("signale le mode actif aux lecteurs d'écran et affiche la règle des 12 caractères", () => {
    mocks.search = { mode: "investor" };
    render(<LoginPage />);
    expect(
      screen.getByRole("button", { name: "Créer un compte" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getAllByRole("button", { name: "Se connecter" })[0].getAttribute("aria-pressed"),
    ).toBe("false");
    const field = screen.getByPlaceholderText("12 caractères minimum");
    const rule = document.getElementById(field.getAttribute("aria-describedby")!);
    expect(rule?.textContent).toMatch(/Au moins 12 caractères/);
  });

  it("n'affiche pas la règle des 12 caractères en connexion", () => {
    render(<LoginPage />);
    expect(
      screen.getByPlaceholderText("Votre mot de passe").getAttribute("aria-describedby"),
    ).toBeNull();
  });

  it("emploie « enchère plafond » au singulier", () => {
    render(<LoginPage />);
    expect(document.body.textContent).not.toMatch(/enchères plafonds/);
  });

  describe("confirmation de l'adresse après l'inscription", () => {
    // Le temps avance aussi tout seul : `waitFor` et `findBy` continuent de fonctionner.
    beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
    afterEach(() => vi.useRealTimers());

    async function signUpWithoutSession(user: Record<string, unknown> = { id: "u1" }) {
      mocks.search = { mode: "investor", redirect: "/sales?city=Lyon" };
      mocks.signUp.mockResolvedValue({ data: { user, session: null }, error: null });
      render(<LoginPage />);
      fireEvent.change(screen.getByPlaceholderText("vous@exemple.fr"), {
        target: { value: "nouvelle@example.test" },
      });
      fireEvent.change(screen.getByPlaceholderText("12 caractères minimum"), {
        target: { value: "un-mot-de-passe-solide" },
      });
      fireEvent.click(screen.getByRole("button", { name: /Créer mon compte gratuit/ }));
      return screen.findByRole("status");
    }

    /** Fait passer du temps (le minuteur du compte à rebours démarre dans un effet). */
    async function elapse(milliseconds: number) {
      await act(async () => {});
      act(() => {
        vi.advanceTimersByTime(milliseconds);
      });
    }

    it("remplace le formulaire par un panneau de statut quand il n'y a pas de session", async () => {
      const panel = await signUpWithoutSession();
      expect(panel.textContent).toContain(
        "Un email de confirmation a été envoyé à nouvelle@example.test, cliquez sur le lien pour continuer.",
      );
      expect(screen.queryByPlaceholderText("vous@exemple.fr")).toBeNull();
      expect(screen.getByRole("button", { name: /Renvoyer l'email/ })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Changer d'adresse" })).toBeTruthy();
    });

    it("aide à retrouver l'email ou le compte existant sous le message", async () => {
      await signUpWithoutSession();
      const help = screen.getByTestId("signup-help");
      expect(help.textContent).toBe(
        "Vous ne recevez rien ? Vérifiez vos courriers indésirables. Si vous avez déjà un compte avec cette adresse, connectez-vous ou réinitialisez votre mot de passe.",
      );
      expect(
        screen.getByRole("link", { name: "réinitialisez votre mot de passe" }).getAttribute("href"),
      ).toBe("/mot-de-passe-oublie");
    });

    it("« connectez-vous » ramène au formulaire de connexion avec l'adresse saisie", async () => {
      await signUpWithoutSession();
      fireEvent.click(screen.getByRole("button", { name: "connectez-vous" }));
      expect(mocks.replace).toHaveBeenLastCalledWith("/login?redirect=%2Fsales%3Fcity%3DLyon");
      expect(screen.queryByRole("status")).toBeNull();
      expect((screen.getByPlaceholderText("vous@exemple.fr") as HTMLInputElement).value).toBe(
        "nouvelle@example.test",
      );
    });

    it("signale un compte existant quand la réponse ne crée aucune identité", async () => {
      const panel = await signUpWithoutSession({ id: "u1", identities: [] });
      expect(panel.textContent).toContain("Un compte existe déjà avec cette adresse.");
      expect(panel.textContent).not.toContain("Un email de confirmation a été envoyé");
      // Aucun email n'est parti : renvoyer n'aurait aucun effet.
      expect(screen.queryByRole("button", { name: /Renvoyer l'email/ })).toBeNull();
      expect(screen.getByTestId("signup-help")).toBeTruthy();
    });

    it("garde le panneau de confirmation quand l'utilisateur a bien une identité", async () => {
      const panel = await signUpWithoutSession({ id: "u1", identities: [{ id: "i1" }] });
      expect(panel.textContent).toContain("Un email de confirmation a été envoyé");
      expect(panel.textContent).not.toContain("Un compte existe déjà");
    });

    it("bloque « Renvoyer l'email » 30 secondes avec un compte à rebours", async () => {
      await signUpWithoutSession();
      const resend = screen.getByRole("button", { name: /Renvoyer l'email/ }) as HTMLButtonElement;
      expect(resend.disabled).toBe(true);
      expect(resend.textContent).toBe("Renvoyer l'email (30 s)");
      await elapse(10_000);
      expect(resend.textContent).toBe("Renvoyer l'email (20 s)");
      fireEvent.click(resend);
      expect(mocks.resend).not.toHaveBeenCalled();
      await elapse(20_000);
      expect(resend.disabled).toBe(false);
      expect(resend.textContent).toBe("Renvoyer l'email");
    });

    it("renvoie l'email de confirmation vers la même adresse, puis bloque à nouveau 30 secondes", async () => {
      mocks.resend.mockResolvedValue({ error: null });
      const panel = await signUpWithoutSession();
      await elapse(30_000);
      fireEvent.click(screen.getByRole("button", { name: "Renvoyer l'email" }));
      await waitFor(() => expect(mocks.resend).toHaveBeenCalledTimes(1));
      expect(mocks.resend.mock.calls[0][0]).toMatchObject({
        type: "signup",
        email: "nouvelle@example.test",
      });
      await waitFor(() =>
        expect(panel.textContent).toContain("Email renvoyé à nouvelle@example.test"),
      );
      expect(
        (screen.getByRole("button", { name: /Renvoyer l'email/ }) as HTMLButtonElement).disabled,
      ).toBe(true);
    });

    it("affiche une erreur en français quand le renvoi échoue", async () => {
      mocks.resend.mockResolvedValue({ error: new Error("rate limit") });
      await signUpWithoutSession();
      await elapse(30_000);
      fireEvent.click(screen.getByRole("button", { name: "Renvoyer l'email" }));
      expect((await screen.findByRole("alert")).textContent).toBeTruthy();
    });

    it("revient au formulaire avec l'adresse saisie quand on change d'adresse", async () => {
      await signUpWithoutSession();
      fireEvent.click(screen.getByRole("button", { name: "Changer d'adresse" }));
      const email = screen.getByPlaceholderText("vous@exemple.fr") as HTMLInputElement;
      expect(email.value).toBe("nouvelle@example.test");
      expect(screen.queryByRole("status")).toBeNull();
    });

    it("ne montre pas le panneau quand une session est ouverte tout de suite", async () => {
      mocks.search = { mode: "investor" };
      mocks.signUp.mockResolvedValue({
        data: { user: { id: "u1" }, session: { access_token: "t" } },
        error: null,
      });
      render(<LoginPage />);
      fireEvent.change(screen.getByPlaceholderText("vous@exemple.fr"), {
        target: { value: "nouvelle@example.test" },
      });
      fireEvent.change(screen.getByPlaceholderText("12 caractères minimum"), {
        target: { value: "un-mot-de-passe-solide" },
      });
      fireEvent.click(screen.getByRole("button", { name: /Créer mon compte gratuit/ }));
      await waitFor(() => expect(mocks.signUp).toHaveBeenCalled());
      expect(screen.queryByRole("status")).toBeNull();
    });
  });
});
