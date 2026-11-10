// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  search: {} as { mode?: "investor" | "professional"; redirect?: string; reason?: string },
  launch: { active: false, pending: false },
  checkoutOpen: false as boolean | null,
  replace: vi.fn(),
  signIn: vi.fn(),
  signUp: vi.fn(),
  resend: vi.fn(),
  toastError: vi.fn(),
  track: vi.fn(),
}));
vi.mock("@/lib/product-events", () => ({ trackProductEvent: mocks.track }));

vi.mock("@/hooks/use-launch-offer", () => ({ useLaunchOffer: () => mocks.launch }));
vi.mock("@/hooks/use-analysis-checkout-open", () => ({
  useAnalysisCheckoutOpen: () => mocks.checkoutOpen,
}));
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

import {
  LAUNCH_OFFER_DURATION_TEXT,
  LAUNCH_OFFER_SIGNUP_LINE,
  LAUNCH_OFFER_VISITOR_TEXT,
} from "@/lib/launch-offer";
import { LoginPage } from "./login-page";

function fillName(first = "Claire", last = "Martin") {
  fireEvent.change(screen.getByLabelText("Prénom"), { target: { value: first } });
  fireEvent.change(screen.getByLabelText("Nom"), { target: { value: last } });
}

beforeEach(() => {
  mocks.search = {};
  mocks.launch = { active: false, pending: false };
  mocks.checkoutOpen = false;
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
    fillName();
    fireEvent.click(screen.getByRole("button", { name: /Créer mon compte gratuit/ }));
    await waitFor(() => expect(mocks.signUp).toHaveBeenCalledTimes(1));
    const options = mocks.signUp.mock.calls[0][0].options.data;
    expect(options.terms_version).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    expect(options.privacy_version).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    expect(typeof options.terms_accepted_at).toBe("string");
    expect(mocks.track).toHaveBeenCalledTimes(1);
    expect(mocks.track).toHaveBeenCalledWith("signup_submitted", { entry: "direct" });
  });

  it("counts the sign-up with the reason of the detour, and not an address that already exists", async () => {
    mocks.search = { mode: "investor", reason: "exemple" };
    mocks.signUp.mockResolvedValueOnce({
      data: { session: null, user: { identities: [] } },
      error: null,
    });
    render(<LoginPage />);
    fireEvent.change(screen.getByPlaceholderText("vous@exemple.fr"), {
      target: { value: "deja.inscrit@example.test" },
    });
    fireEvent.change(screen.getByPlaceholderText("12 caractères minimum"), {
      target: { value: "un-mot-de-passe-solide" },
    });
    fillName();
    fireEvent.click(screen.getByRole("button", { name: /Créer mon compte gratuit/ }));
    await waitFor(() => expect(mocks.signUp).toHaveBeenCalledTimes(1));
    await screen.findByText(/Un compte existe déjà avec cette adresse/);
    expect(mocks.track).not.toHaveBeenCalled();
  });

  function fillCredentials() {
    fireEvent.change(screen.getByPlaceholderText("vous@exemple.fr"), {
      target: { value: "nouvel.utilisateur@example.test" },
    });
    fireEvent.change(screen.getByPlaceholderText("12 caractères minimum"), {
      target: { value: "un-mot-de-passe-solide" },
    });
  }

  it("demande un prénom et un nom, tous deux obligatoires, et les enregistre", async () => {
    mocks.search = { mode: "investor" };
    mocks.signUp.mockResolvedValue({ error: null });
    render(<LoginPage />);
    const first = screen.getByLabelText("Prénom") as HTMLInputElement;
    const last = screen.getByLabelText("Nom") as HTMLInputElement;
    expect(first.required).toBe(true);
    expect(last.required).toBe(true);
    fillCredentials();
    fillName("  Claire ", " Martin  ");
    fireEvent.click(screen.getByRole("button", { name: /Créer mon compte gratuit/ }));
    await waitFor(() => expect(mocks.signUp).toHaveBeenCalledTimes(1));
    const data = mocks.signUp.mock.calls[0][0].options.data;
    expect(data.full_name).toBe("Claire Martin");
    expect(data.first_name).toBe("Claire");
    expect(data.last_name).toBe("Martin");
  });

  it("refuse une inscription sans prénom ou sans nom, et le dit sur le champ", async () => {
    mocks.search = { mode: "investor" };
    render(<LoginPage />);
    fillCredentials();
    const first = screen.getByLabelText("Prénom");
    const last = screen.getByLabelText("Nom");

    fillName("   ", "Martin");
    fireEvent.click(screen.getByRole("button", { name: /Créer mon compte gratuit/ }));
    let alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Renseignez votre prénom.");
    expect(first.getAttribute("aria-invalid")).toBe("true");
    expect(first.getAttribute("aria-describedby")).toBe(alert.id);
    expect(document.activeElement).toBe(first);

    // Un champ vide est déjà arrêté par la validation du navigateur (`required`) ; seul un nom fait
    // d'espaces arrive jusqu'au contrôle du formulaire.
    fillName("Claire", "  ");
    fireEvent.click(screen.getByRole("button", { name: /Créer mon compte gratuit/ }));
    await waitFor(() => expect(last.getAttribute("aria-invalid")).toBe("true"));
    alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Renseignez votre nom.");
    expect(first.getAttribute("aria-invalid")).toBeNull();
    expect(mocks.signUp).not.toHaveBeenCalled();
  });

  it("signale l'organisation manquante sur le champ, sans notification", async () => {
    mocks.search = { mode: "professional" };
    render(<LoginPage />);
    fillCredentials();
    fillName();
    const organization = screen.getByPlaceholderText("Cabinet, étude, office, tribunal...");
    fireEvent.change(organization, { target: { value: " A " } });
    fireEvent.click(screen.getByRole("button", { name: "Demander mon accès pro" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Renseignez votre cabinet, étude, office ou tribunal.");
    expect(organization.getAttribute("aria-invalid")).toBe("true");
    expect(organization.getAttribute("aria-describedby")).toBe(alert.id);
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.signUp).not.toHaveBeenCalled();
  });

  it("garde le libellé « Professionnel » sur une ligne, dans une colonne plus large", () => {
    render(<LoginPage />);
    const professional = screen.getByRole("button", { name: "Professionnel" });
    expect(professional.className).toContain("whitespace-nowrap");
    expect(professional.className).toContain("px-2");
    expect(professional.parentElement?.className).toContain("grid-cols-[1fr_1fr_1.3fr]");
  });

  it("dit une seule fois « sans carte bancaire » et fusionne le repère dans le chapô", () => {
    mocks.search = { mode: "investor" };
    render(<LoginPage />);
    expect(screen.queryByText("Compte Découverte")).toBeNull();
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("Explorer gratuitement");
    const description = heading.nextElementSibling as HTMLElement;
    expect(description.textContent).toContain("Compte Découverte : consultez les fiches");
    const promise = screen.getByTestId("login-free-promise");
    const formText = document.querySelector("main")?.textContent ?? "";
    // Mobile (promesse) et bureau (chapô) : un seul des deux est lu à une largeur donnée.
    expect(promise.className).toContain("lg:hidden");
    expect(description.querySelector("span")?.className).toContain("hidden lg:inline");
    expect(formText).toContain("sans carte bancaire");
  });

  it("dit ce qui reste après les 7 jours d'essai : 3 déblocages, 1 alerte, 10 favoris", () => {
    mocks.search = { mode: "investor" };
    mocks.launch = { active: true, pending: false };
    render(<LoginPage />);
    expect(screen.getByTestId("login-after-trial").textContent).toBe(
      "Après les 7 jours, votre compte reste gratuit en Découverte : 3 déblocages par mois, 1 alerte et 10 favoris.",
    );
  });

  it("n'ajoute pas de ligne sur l'après-essai quand l'essai est fermé", () => {
    mocks.search = { mode: "investor" };
    render(<LoginPage />);
    expect(screen.queryByTestId("login-after-trial")).toBeNull();
    expect(screen.queryByTestId("login-trial-conditions")).toBeNull();
  });

  it("informe de l'usage du prénom et du nom à l'inscription seulement", () => {
    mocks.search = { mode: "investor" };
    const signup = render(<LoginPage />);
    expect(signup.container.textContent).toContain(
      "Votre prénom et votre nom servent à personnaliser votre compte",
    );
    signup.unmount();
    mocks.search = {};
    const login = render(<LoginPage />);
    expect(login.container.textContent).not.toContain("Votre prénom et votre nom");
    expect(screen.queryByLabelText("Prénom")).toBeNull();
  });

  it("sends the reason of the detour as the origin of a new sign-up", async () => {
    mocks.search = { mode: "investor", reason: "exemple" };
    mocks.signUp.mockResolvedValue({ error: null });
    render(<LoginPage />);
    fireEvent.change(screen.getByPlaceholderText("vous@exemple.fr"), {
      target: { value: "nouvel.utilisateur@example.test" },
    });
    fireEvent.change(screen.getByPlaceholderText("12 caractères minimum"), {
      target: { value: "un-mot-de-passe-solide" },
    });
    fillName();
    fireEvent.click(screen.getByRole("button", { name: /Créer mon compte gratuit/ }));
    await waitFor(() => expect(mocks.track).toHaveBeenCalledTimes(1));
    expect(mocks.track).toHaveBeenCalledWith("signup_submitted", { entry: "exemple" });
  });

  it("explains the detour from the fees simulator and counts it as the origin of the sign-up", async () => {
    mocks.search = { mode: "investor", reason: "simulateur" };
    mocks.signUp.mockResolvedValue({ error: null });
    render(<LoginPage />);
    expect(screen.getByText(/pour appliquer ce calcul de frais à une vente réelle/)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("vous@exemple.fr"), {
      target: { value: "nouvel.utilisateur@example.test" },
    });
    fireEvent.change(screen.getByPlaceholderText("12 caractères minimum"), {
      target: { value: "un-mot-de-passe-solide" },
    });
    fillName();
    fireEvent.click(screen.getByRole("button", { name: /Créer mon compte gratuit/ }));
    await waitFor(() => expect(mocks.track).toHaveBeenCalledTimes(1));
    expect(mocks.track).toHaveBeenCalledWith("signup_submitted", { entry: "simulateur" });
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
    // Une seule annonce : l'alerte du formulaire, pas l'alerte et un toast.
    expect(mocks.toastError).not.toHaveBeenCalled();
    // Repasse n° 12 et 19 : erreur aux jetons « danger », bouton principal marine.
    expect(alert.className).toContain("text-danger");
    expect(alert.className).not.toMatch(/red-\d/);
    expect(submit!.className).toContain("bg-brand-navy");
    expect(document.body.innerHTML).not.toMatch(/liquid-|glass-shell|cinematic-grid/);
  });

  it("parle à l'avocat dans la colonne de gauche du mode professionnel (repasse n° 35)", () => {
    mocks.search = { mode: "professional" };
    render(<LoginPage />);
    const column = screen.getByTestId("login-professional-column");
    expect(column.textContent).toContain("Déposez et suivez vos ventes.");
    expect(column.textContent).toContain("Déposer une vente");
    expect(column.textContent).toContain("Suivre vos demandes");
    expect(column.textContent).not.toContain("Préparez votre achat aux enchères.");
    expect(screen.getByRole("link", { name: "Présenter mon cabinet" }).getAttribute("href")).toBe(
      "/contact?sujet=avocat",
    );
  });

  it("garde la colonne de l'acquéreur hors du mode professionnel", () => {
    mocks.search = { mode: "investor" };
    render(<LoginPage />);
    expect(screen.queryByTestId("login-professional-column")).toBeNull();
    expect(screen.getByText("Préparez votre achat aux enchères.")).toBeTruthy();
  });

  it("relie l'erreur aux champs email et mot de passe (aria-invalid, aria-describedby)", async () => {
    mocks.signIn.mockResolvedValue({ error: new Error("Invalid login credentials") });
    render(<LoginPage />);
    const email = screen.getByPlaceholderText("vous@exemple.fr");
    const password = screen.getByPlaceholderText("Votre mot de passe");
    expect(email.getAttribute("aria-invalid")).toBeNull();
    expect(password.getAttribute("aria-describedby")).toBeNull();
    fireEvent.change(email, { target: { value: "quelquun@example.test" } });
    fireEvent.change(password, { target: { value: "mauvais-mot-de-passe" } });
    const submit = screen
      .getAllByRole("button", { name: "Se connecter" })
      .find((button) => button.getAttribute("type") === "submit");
    fireEvent.click(submit!);
    const alert = await screen.findByRole("alert");
    for (const field of [email, password]) {
      expect(field.getAttribute("aria-invalid")).toBe("true");
      expect(field.getAttribute("aria-describedby")).toContain(alert.id);
    }
  });

  it("garde la règle des 12 caractères ET l'erreur dans la description du mot de passe", async () => {
    mocks.search = { mode: "investor" };
    mocks.signUp.mockResolvedValue({ data: null, error: new Error("Password is too short") });
    render(<LoginPage />);
    fireEvent.change(screen.getByPlaceholderText("vous@exemple.fr"), {
      target: { value: "a@example.test" },
    });
    fireEvent.change(screen.getByPlaceholderText("12 caractères minimum"), {
      target: { value: "123456789012" },
    });
    fillName();
    fireEvent.click(screen.getByRole("button", { name: /Créer mon compte gratuit/ }));
    const alert = await screen.findByRole("alert");
    const description = screen
      .getByPlaceholderText("12 caractères minimum")
      .getAttribute("aria-describedby");
    expect(description).toContain("login-password-rule");
    expect(description).toContain(alert.id);
  });

  it("affiche le refus de la base quand l'inscription est rejetée faute de prénom ou de nom", async () => {
    mocks.search = { mode: "investor" };
    const refusal = Object.assign(new Error("Database error saving new user"), {
      status: 500,
      code: "unexpected_failure",
    });
    mocks.signUp.mockResolvedValue({ data: null, error: refusal });
    render(<LoginPage />);
    fireEvent.change(screen.getByPlaceholderText("vous@exemple.fr"), {
      target: { value: "a@example.test" },
    });
    fireEvent.change(screen.getByPlaceholderText("12 caractères minimum"), {
      target: { value: "un-mot-de-passe-solide" },
    });
    fillName();
    fireEvent.click(screen.getByRole("button", { name: /Créer mon compte gratuit/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Vérifiez votre prénom et votre nom");
    expect(alert.textContent).not.toContain("Database error");
  });

  it("affiche tel quel le message détaillé du déclencheur quand l'API le renvoie", async () => {
    mocks.search = { mode: "investor" };
    const detailed = "Le prénom et le nom sont obligatoires pour créer un compte.";
    mocks.signUp.mockResolvedValue({
      data: null,
      error: Object.assign(new Error(detailed), { status: 500 }),
    });
    render(<LoginPage />);
    fireEvent.change(screen.getByPlaceholderText("vous@exemple.fr"), {
      target: { value: "a@example.test" },
    });
    fireEvent.change(screen.getByPlaceholderText("12 caractères minimum"), {
      target: { value: "un-mot-de-passe-solide" },
    });
    fillName();
    fireEvent.click(screen.getByRole("button", { name: /Créer mon compte gratuit/ }));
    expect((await screen.findByRole("alert")).textContent).toContain(detailed);
  });

  it("propose l'autocomplétion du nom et de l'organisation à l'inscription", () => {
    mocks.search = { mode: "professional" };
    render(<LoginPage />);
    expect(screen.getByLabelText("Prénom").getAttribute("autocomplete")).toBe("given-name");
    expect(screen.getByLabelText("Nom").getAttribute("autocomplete")).toBe("family-name");
    expect(
      screen
        .getByPlaceholderText("Cabinet, étude, office, tribunal...")
        .getAttribute("autocomplete"),
    ).toBe("organization");
    expect(screen.getByPlaceholderText("vous@exemple.fr").getAttribute("autocomplete")).toBe(
      "email",
    );
  });

  it("lets visitors reveal the password they typed", () => {
    render(<LoginPage />);
    const field = screen.getByPlaceholderText("Votre mot de passe") as HTMLInputElement;
    expect(field.type).toBe("password");
    const toggle = screen.getByRole("button", { name: "Afficher le mot de passe" });
    // Le libellé change avec l'état : pas d'aria-pressed en plus (double signal).
    expect(toggle.hasAttribute("aria-pressed")).toBe(false);
    fireEvent.click(toggle);
    expect(field.type).toBe("text");
    const hide = screen.getByRole("button", { name: "Masquer le mot de passe" });
    expect(hide.hasAttribute("aria-pressed")).toBe(false);
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
      "Créez votre compte gratuit pour voir l'adresse, les photos et la fourchette de valeur de cette vente, avec 3 déblocages par mois : un déblocage ouvre votre plafond pour cette vente (enchère ou offre), frais estimés compris (contenu selon la vente).",
    );
    // Formule sobre du plafond, en attendant l'arbitrage sur « l'enchère à ne pas dépasser ».
    expect(screen.getByTestId("login-reason").textContent).not.toContain("ne pas dépasser");
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
      "Gratuit : 3 déblocages par mois (enchère plafond ou offre plafond, lecture des pièces, historique, selon la vente), sans carte bancaire",
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

  it("explique le détour depuis le simulateur de frais, sans promettre l'essai quand il est fermé", () => {
    mocks.search = { mode: "investor", reason: "simulateur" };
    const { unmount } = render(<LoginPage />);
    expect(screen.getByTestId("login-reason").textContent).toBe(
      "Créez votre compte gratuit, sans carte bancaire, pour appliquer ce calcul de frais à une vente réelle.",
    );
    unmount();

    mocks.search = { reason: "simulateur" };
    render(<LoginPage />);
    expect(screen.getByTestId("login-reason").textContent).toBe(
      "Connectez-vous pour appliquer ce calcul de frais à une vente réelle.",
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
    expect(screen.getByTestId("login-reason").textContent).toContain(
      "offerte pendant 7 jours à l’inscription",
    );
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

  it("essai gratuit : la mention du visiteur remplace la promesse des 3 ventes", () => {
    mocks.search = { mode: "investor" };
    mocks.launch = { active: true, pending: false };
    render(<LoginPage />);

    // Mobile : une ligne visible, les conditions dans un repli (le texte complet précédait le champ).
    const promise = screen.getByTestId("login-free-promise");
    expect(LAUNCH_OFFER_SIGNUP_LINE).toBe(
      "Inscription gratuite : 7 jours d’accès à l’offre Analyse, sans carte bancaire ni prélèvement ensuite.",
    );
    expect(promise.querySelector("p")?.textContent).toBe(LAUNCH_OFFER_SIGNUP_LINE);
    const conditions = screen.getByTestId("login-trial-conditions") as HTMLDetailsElement;
    expect(conditions?.open).toBe(false);
    expect(conditions?.querySelector("summary")?.textContent).toBe("Conditions de l’essai gratuit");
    expect(conditions?.textContent).toContain(LAUNCH_OFFER_DURATION_TEXT);
    expect(promise.textContent).not.toBe(LAUNCH_OFFER_VISITOR_TEXT);
    // Bureau : le texte complet reste inchangé.
    expect(screen.getByTestId("login-launch-offer").textContent).toBe(LAUNCH_OFFER_VISITOR_TEXT);
    expect(screen.getByTestId("login-launch-offer-column").textContent).toBe(
      LAUNCH_OFFER_VISITOR_TEXT,
    );
  });

  it("essai gratuit : motifs « offre » et « fiche » sans promesse de quota", () => {
    mocks.launch = { active: true, pending: false };
    mocks.search = { mode: "investor", reason: "fiche" };
    const { unmount } = render(<LoginPage />);
    expect(screen.getByTestId("login-reason").textContent).toContain("pendant les 7 jours d’essai");
    expect(screen.getByTestId("login-reason").textContent).toContain(
      "votre plafond pour cette vente (enchère ou offre), frais estimés compris",
    );
    expect(screen.getByTestId("login-reason").textContent).not.toContain("3 en détail");
    unmount();

    mocks.search = { mode: "investor", reason: "offre" };
    render(<LoginPage />);
    expect(screen.getByTestId("login-reason").textContent).toBe(
      "Créez votre compte gratuit : il bénéficie de l’offre Analyse pendant 7 jours, sans carte bancaire.",
    );
    // La connexion ne promet rien : l'essai d'un compte existant peut être fini.
    cleanup();
    mocks.search = { reason: "offre" };
    render(<LoginPage />);
    expect(screen.getByTestId("login-reason").textContent).toBe(
      "Connectez-vous pour voir votre offre.",
    );
  });

  it("motif « offre » : n'annonce pas une souscription possible quand l'offre n'est pas ouverte", () => {
    mocks.search = { mode: "investor", reason: "offre" };
    render(<LoginPage />);
    expect(screen.getByTestId("login-reason").textContent).toBe(
      "Créez votre compte gratuit. L’offre Analyse n’est pas encore ouverte à la souscription : vous pourrez demander à être prévenu de son ouverture.",
    );
    expect(screen.getByTestId("login-reason").textContent).not.toContain("quand vous le souhaitez");
  });

  it("motif « offre » : invite à souscrire quand la garde d'ouverture du paiement est ouverte", () => {
    mocks.search = { mode: "investor", reason: "offre" };
    mocks.checkoutOpen = true;
    const open = render(<LoginPage />);
    expect(screen.getByTestId("login-reason").textContent).toBe(
      "Créez votre compte gratuit, puis souscrivez à l’offre Analyse depuis la page Offres (abonnement à 59\u00a0€\u00a0TTC / mois, prélevé automatiquement chaque mois jusqu’à résiliation, résiliable à tout moment).",
    );
    expect(open.container.textContent).toContain(
      "(abonnement à 59\u00a0€\u00a0TTC / mois, prélevé automatiquement chaque mois jusqu’à résiliation, résiliable à tout moment).",
    );
    expect(open.container.textContent).not.toContain("pas encore");
    open.unmount();

    // Garde encore inconnue : ni « pas encore ouverte », ni invitation à acheter.
    mocks.checkoutOpen = null;
    const unknown = render(<LoginPage />);
    expect(screen.getByTestId("login-reason").textContent).toBe(
      "Créez votre compte gratuit, sans carte bancaire, pour découvrir l’offre Analyse.",
    );
    expect(unknown.container.textContent).not.toContain("pas encore");
    expect(unknown.container.textContent).not.toContain("souscrivez");
  });

  it("colonne d'accueil : le tarif prévu remplace « sur abonnement résiliable »", () => {
    mocks.search = { mode: "investor" };
    const closed = render(<LoginPage />);
    expect(closed.container.textContent).toContain(
      "tarif prévu : 59\u00a0€\u00a0TTC / mois, pas encore souscriptible",
    );
    expect(closed.container.textContent).not.toContain("sur abonnement résiliable");
    closed.unmount();

    mocks.launch = { active: true, pending: false };
    const active = render(<LoginPage />);
    expect(active.container.textContent).toContain(
      "À l’inscription, l’offre Analyse est offerte pendant 7 jours",
    );
    // Pendant l'essai à l'inscription, la page d'inscription ne met pas le tarif en avant.
    expect(active.container.textContent).not.toMatch(/59[ \u00a0]€/);
    expect(active.container.textContent).not.toContain("sur abonnement résiliable");
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

  it("emploie « enchère plafond » et « offre plafond » au singulier", () => {
    render(<LoginPage />);
    expect(document.body.textContent).not.toMatch(/enchères plafonds|offres plafonds/);
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
      fillName();
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

    it("déplace le focus sur le titre du panneau qui remplace le formulaire, puis au retour", async () => {
      await signUpWithoutSession();
      const title = screen.getByRole("heading", { level: 1 });
      expect(title.textContent).toBe("Confirmez votre adresse email");
      expect(title.getAttribute("tabindex")).toBe("-1");
      await waitFor(() => expect(document.activeElement).toBe(title));

      fireEvent.click(screen.getByRole("button", { name: "Changer d'adresse" }));
      const formTitle = screen.getByRole("heading", { level: 1 });
      expect(formTitle.getAttribute("tabindex")).toBe("-1");
      await waitFor(() => expect(document.activeElement).toBe(formTitle));
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
      fillName();
      fireEvent.click(screen.getByRole("button", { name: /Créer mon compte gratuit/ }));
      await waitFor(() => expect(mocks.signUp).toHaveBeenCalled());
      expect(screen.queryByRole("status")).toBeNull();
    });
  });
});
