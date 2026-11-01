import { describe, expect, it } from "vitest";
import {
  PASSWORD_RESET_EXPIRED_PATH,
  parseAuthLink,
  postConfirmationPath,
  type AuthLink,
} from "./auth-confirmation";

const ORIGIN = "https://immojudis.com";
const HASH = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";

function link(partial: Partial<AuthLink> = {}): AuthLink {
  return { tokenHash: HASH, type: "signup", redirectTo: null, ...partial };
}

describe("parseAuthLink", () => {
  it("lit le jeton, le type et l'adresse de retour du lien des gabarits", () => {
    expect(
      parseAuthLink(
        `?token_hash=${HASH}&type=signup&redirect_to=https%3A%2F%2Fimmojudis.com%2Fbienvenue`,
      ),
    ).toEqual({ tokenHash: HASH, type: "signup", redirectTo: "https://immojudis.com/bienvenue" });
  });

  it("garde l'adresse de retour entière quand {{ .RedirectTo }} n'est pas encodé (? et & compris)", () => {
    // `redirect_to` est le dernier paramètre : ses propres `?` et `&` ne le coupent pas.
    const parsed = parseAuthLink(
      `?token_hash=${HASH}&type=signup&redirect_to=https://immojudis.com/bienvenue?retour=/sales/12&etape=2`,
    );
    expect(parsed?.redirectTo).toBe("https://immojudis.com/bienvenue?retour=/sales/12&etape=2");
    expect(parsed?.tokenHash).toBe(HASH);
    expect(parsed?.type).toBe("signup");
  });

  it("décode une adresse de retour encodée avec ses paramètres", () => {
    const parsed = parseAuthLink(
      `?token_hash=${HASH}&type=signup&redirect_to=${encodeURIComponent("https://immojudis.com/bienvenue?retour=/sales/12&etape=2")}`,
    );
    expect(parsed?.redirectTo).toBe("https://immojudis.com/bienvenue?retour=/sales/12&etape=2");
  });

  it("accepte l'absence d'adresse de retour et un encodage invalide", () => {
    expect(parseAuthLink(`?token_hash=${HASH}&type=recovery`)?.redirectTo).toBeNull();
    expect(parseAuthLink(`?token_hash=${HASH}&type=recovery&redirect_to=`)?.redirectTo).toBeNull();
    expect(parseAuthLink(`?token_hash=${HASH}&type=signup&redirect_to=%E0%A4%A`)?.redirectTo).toBe(
      "%E0%A4%A",
    );
  });

  it.each(["signup", "recovery", "email_change", "magiclink", "invite"])(
    "accepte le type %s",
    (type) => {
      expect(parseAuthLink(`?token_hash=${HASH}&type=${type}`)?.type).toBe(type);
    },
  );

  it.each([
    ["sans jeton", "?type=signup"],
    ["jeton vide", "?token_hash=&type=signup"],
    ["jeton trop court", "?token_hash=abc&type=signup"],
    ["jeton avec des caractères interdits", `?token_hash=${HASH}%22%3E%3Cscript&type=signup`],
    ["sans type", `?token_hash=${HASH}`],
    ["type inconnu", `?token_hash=${HASH}&type=admin`],
    ["type email (aucun gabarit n'en émet)", `?token_hash=${HASH}&type=email`],
    ["rien du tout", ""],
  ])("refuse un lien %s", (_label, search) => {
    expect(parseAuthLink(search)).toBeNull();
  });

  it("ne confond pas un jeton qui se trouverait dans l'adresse de retour avec le sien", () => {
    const parsed = parseAuthLink(
      `?token_hash=${HASH}&type=signup&redirect_to=https://immojudis.com/x?token_hash=autre&type=recovery`,
    );
    expect(parsed).toMatchObject({ tokenHash: HASH, type: "signup" });
  });
});

describe("postConfirmationPath", () => {
  it("mène toujours le mot de passe oublié vers la saisie du nouveau mot de passe", () => {
    expect(postConfirmationPath(link({ type: "recovery" }), ORIGIN)).toBe(
      "/reinitialiser-mot-de-passe",
    );
    // Même avec une adresse de retour : la session de récupération doit être consommée là.
    expect(
      postConfirmationPath(
        link({ type: "recovery", redirectTo: "https://immojudis.com/compte" }),
        ORIGIN,
      ),
    ).toBe("/reinitialiser-mot-de-passe");
    expect(PASSWORD_RESET_EXPIRED_PATH).toBe("/reinitialiser-mot-de-passe?error=otp_expired");
  });

  it("reprend l'adresse de retour du site, réduite à son chemin, sa requête et son fragment", () => {
    expect(
      postConfirmationPath(
        link({ redirectTo: "https://immojudis.com/bienvenue?retour=%2Fsales%2F12#haut" }),
        ORIGIN,
      ),
    ).toBe("/bienvenue?retour=%2Fsales%2F12#haut");
    expect(postConfirmationPath(link({ redirectTo: "/compte" }), ORIGIN)).toBe("/compte");
  });

  it("retombe sur /bienvenue sans adresse de retour", () => {
    expect(postConfirmationPath(link(), ORIGIN)).toBe("/bienvenue");
    expect(postConfirmationPath(link({ type: "email_change" }), ORIGIN)).toBe("/bienvenue");
  });

  it("garde les pages du site demandées par l'inscription (alerte à créer, fiche)", () => {
    for (const path of ["/alertes/creer?department=62", "/sales/12", "/alertes/creer?x=1#haut"]) {
      expect(postConfirmationPath(link({ redirectTo: path }), ORIGIN)).toBe(path);
      expect(postConfirmationPath(link({ redirectTo: `${ORIGIN}${path}` }), ORIGIN)).toBe(path);
    }
  });

  it("propriété : quelle que soit l'entrée, le chemin retourné reste sur le site", () => {
    const pieces = [
      "/",
      "\\",
      ".",
      "..",
      "%2e",
      "%2f",
      "%5c",
      "a",
      "evil.example",
      "?",
      "#",
      "https:",
      "\t",
      "@",
      ":",
      "auth",
      "confirmer",
    ];
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    for (let i = 0; i < 4000; i += 1) {
      const length = 1 + (next() % 8);
      let candidate = next() % 2 ? "/" : "";
      for (let j = 0; j < length; j += 1) candidate += pieces[next() % pieces.length];
      for (const redirectTo of [candidate, `${ORIGIN}${candidate}`]) {
        const path = postConfirmationPath(link({ redirectTo }), ORIGIN);
        expect(new URL(path, ORIGIN).origin, redirectTo).toBe(ORIGIN);
        expect(path.startsWith("//"), redirectTo).toBe(false);
        expect(path.startsWith("/\\"), redirectTo).toBe(false);
      }
    }
  });

  it.each([
    "https://evil.example/phishing",
    "https://immojudis.com.evil.example/",
    "//evil.example/x",
    "/\\evil.example/x",
    "\\\\evil.example",
    "https://evil.example@immojudis.com.evil.example/",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "https://immojudis.com:8443/bienvenue",
    "http://immojudis.com/bienvenue",
    "/auth/confirmer?token_hash=x",
    "/auth/confirmer",
    "https://immojudis.com/auth/confirmer/",
    "/AUTH/confirmer",
    "/auth//confirmer",
    "/Auth///Confirmer/x",
    // Redirections ouvertes : normalisés par URL, ces chemins deviennent « //evil.example… ».
    "/.//evil.example/x",
    "/a/..//evil.example/x",
    "/..//evil.example",
    "/%2e//evil.example",
    "/./\\evil.example",
    "https://immojudis.com//evil.example",
    "https://immojudis.com/\\evil.example",
    "",
  ])("refuse l'adresse de retour %j (autre origine, boucle ou schéma)", (redirectTo) => {
    expect(postConfirmationPath(link({ redirectTo }), ORIGIN)).toBe("/bienvenue");
  });
});
