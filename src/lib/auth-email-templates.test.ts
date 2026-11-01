import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUTH_EMAIL_TEMPLATES,
  authEmailLink,
  buildAuthEmailTemplate,
  type AuthEmailLinkVariant,
} from "./auth-email-templates";
import { parseAuthLink } from "./auth-confirmation";

const root = process.cwd();
const config = readFileSync(join(root, "supabase/config.toml"), "utf8");
const update = process.env.UPDATE_AUTH_EMAIL_TEMPLATES === "1";

const DIRECTORIES: Record<AuthEmailLinkVariant, string> = {
  "token-hash": "supabase/templates",
  "confirmation-url": "docs/runbooks/emails-authentification/retour-arriere",
};

function file(variant: AuthEmailLinkVariant, name: string): string {
  return join(root, DIRECTORIES[variant], name);
}

if (update) {
  for (const variant of Object.keys(DIRECTORIES) as AuthEmailLinkVariant[]) {
    mkdirSync(join(root, DIRECTORIES[variant]), { recursive: true });
    for (const definition of AUTH_EMAIL_TEMPLATES) {
      writeFileSync(file(variant, definition.file), buildAuthEmailTemplate(definition, variant));
    }
  }
}

const VARIANTS = Object.keys(DIRECTORIES) as AuthEmailLinkVariant[];
const ALLOWED_VARIABLES = new Set([
  "{{ .SiteURL }}",
  "{{ .TokenHash }}",
  "{{ .RedirectTo }}",
  "{{ .ConfirmationURL }}",
  "{{ .Email }}",
  "{{ .NewEmail }}",
  "{{ .Token }}",
]);

function visibleText(html: string): string {
  return (
    html
      .replace(/<style[\s\S]*?<\/style>/g, " ")
      // Le lien de repli en clair (adresse technique : « signup », « token_hash »…) n'est pas de la prose.
      .replace(/<span[^>]*word-break:break-all[^>]*>[\s\S]*?<\/span>/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&zwnj;/g, " ")
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
  );
}

describe("gabarits des emails d'authentification Supabase", () => {
  it("couvre les six gabarits de Supabase, chacun déclaré dans supabase/config.toml avec son objet", () => {
    expect(AUTH_EMAIL_TEMPLATES.map((definition) => definition.id).sort()).toEqual([
      "confirmation",
      "email_change",
      "invite",
      "magic_link",
      "reauthentication",
      "recovery",
    ]);
    for (const definition of AUTH_EMAIL_TEMPLATES) {
      const start = config.indexOf(`[auth.email.template.${definition.id}]`);
      expect(start, definition.id).toBeGreaterThanOrEqual(0);
      const section = config.slice(start).split(/\n\[/)[0];
      expect(section).toContain(`subject = "${definition.subject}"`);
      expect(section).toContain(`content_path = "./supabase/templates/${definition.file}"`);
    }
  });

  it("garde les objets validés par le propriétaire", () => {
    const subjects = Object.fromEntries(
      AUTH_EMAIL_TEMPLATES.map((definition) => [definition.id, definition.subject]),
    );
    expect(subjects.confirmation).toBe("Confirmez votre adresse email pour accéder à Immojudis");
    expect(subjects.recovery).toBe("Réinitialisation de votre mot de passe Immojudis");
    expect(subjects.email_change).toBe("Confirmez votre nouvelle adresse email Immojudis");
  });

  it.each(VARIANTS)(
    "les fichiers (%s) sont ceux que génère src/lib/auth-email-templates.ts",
    (variant) => {
      for (const definition of AUTH_EMAIL_TEMPLATES) {
        expect(
          readFileSync(file(variant, definition.file), "utf8"),
          `${DIRECTORIES[variant]}/${definition.file} : relancer avec UPDATE_AUTH_EMAIL_TEMPLATES=1`,
        ).toBe(buildAuthEmailTemplate(definition, variant));
      }
    },
  );

  describe.each(VARIANTS)("variante %s", (variant) => {
    const templates = AUTH_EMAIL_TEMPLATES.map((definition) => ({
      definition,
      html: buildAuthEmailTemplate(definition, variant),
    }));

    it("suit le modèle unique : doctype, langue, viewport, titre, schéma de couleurs, mode sombre, logo", () => {
      for (const { definition, html } of templates) {
        expect(html, definition.id).toMatch(/^<!doctype html>/);
        expect(html).toContain('<html lang="fr">');
        expect(html).toContain('<meta charset="utf-8">');
        expect(html).toContain('<meta name="viewport"');
        expect(html).toContain('<meta name="color-scheme" content="light dark">');
        expect(html).toContain(`<title>${definition.subject}</title>`);
        expect(html).toContain("@media (prefers-color-scheme: dark)");
        expect(html).toContain("https://immojudis.com/brand/email/immojudis-logo-email-v1.png");
        expect(html).toContain(
          "https://immojudis.com/brand/email/immojudis-logo-email-dark-v1.png",
        );
        expect(html).toContain('alt="Immojudis"');
        expect(html).toContain('<table role="presentation"');
        expect(html).not.toContain("<div");
        expect(html).toContain("border-top:1px solid #e1d8ca"); // filet du pied
        expect(html).toContain("#c98d45"); // filet or de la carte
        expect(html).not.toMatch(/ImmoJudis|IMMOJUDIS/);
      }
    });

    it("n'emploie que les variables Go prévues, bien formées (aucun « {{ » ni « }} » égaré, CSS compris)", () => {
      for (const { definition, html } of templates) {
        const used = html.match(/\{\{[^{}]*\}\}/g) ?? [];
        for (const variable of used) {
          expect(ALLOWED_VARIABLES.has(variable), `${definition.id} : ${variable}`).toBe(true);
        }
        expect(html.replace(/\{\{[^{}]*\}\}/g, "")).not.toMatch(/\{\{|\}\}/);
      }
    });

    it("est en français, sans anglais ni contenu commercial, signé « L’équipe Immojudis »", () => {
      for (const { definition, html } of templates) {
        const text = visibleText(html);
        expect(text, definition.id).not.toMatch(
          /\b(the|your|click|confirm your|reset your|password reset|hello|thanks|please|sign ?up|log ?in|link|account)\b/i,
        );
        expect(text.replace("Il ne contient aucune offre commerciale.", "")).not.toMatch(
          /offre|abonnement|promo|gratuit|tarif|prix|remise|découvrez|nouveauté|newsletter/i,
        );
        expect(text).toContain("Cordialement, L’équipe Immojudis");
        expect(text).toContain(
          "Message de sécurité lié à votre compte Immojudis (immojudis.com). Il ne contient aucune offre commerciale.",
        );
        expect(text).toContain("Immojudis · immojudis.com · contact@immojudis.com");
        // Apostrophes typographiques : aucune apostrophe droite dans le texte visible hors variables.
        expect(text.replace(/\{\{[^{}]*\}\}/g, "")).not.toMatch(/\p{L}'\p{L}/u);
      }
    });

    it("n'a pas de couleur de texte blanche ou noire hors bouton", () => {
      for (const { html } of templates) {
        // Le seul bloc <style> est dans <head> : on ne contrôle que le corps du message.
        expect(html.indexOf("<style")).toBeLessThan(html.indexOf("<body"));
        const body = html.slice(html.indexOf("<body"));
        const withoutButton = body.replace(/<a [^>]*class="ej-btn-a"[^>]*>/g, "");
        const colors = [...withoutButton.matchAll(/[^-]color:\s*(#[0-9a-f]{3,6})/gi)].map((match) =>
          match[1].toLowerCase(),
        );
        for (const color of colors) {
          expect(["#000", "#000000", "#fff", "#ffffff"]).not.toContain(color);
        }
        // Le texte du bouton principal est le seul blanc, et il est sur fond marine.
        expect(body.match(/(?<![-\w])color:#ffffff/g)?.length ?? 0).toBe(
          body.includes('class="ej-btn-a"') ? 1 : 0,
        );
      }
    });
  });

  it("confirmation, mot de passe, changement d'adresse : textes et boutons validés", () => {
    const html = (id: string) =>
      visibleText(
        buildAuthEmailTemplate(
          AUTH_EMAIL_TEMPLATES.find((definition) => definition.id === id)!,
          "token-hash",
        ),
      );
    expect(html("confirmation")).toContain(
      "Vous venez de créer un compte Immojudis avec l’adresse {{ .Email }}. Pour l’activer, confirmez cette adresse. Ce lien est temporaire ; s’il a expiré, demandez-en un nouveau depuis la page de connexion. Si vous n’êtes pas à l’origine de cette inscription, ignorez ce message : aucun compte ne sera activé.",
    );
    expect(html("confirmation")).toContain("Confirmer mon adresse");
    expect(html("recovery")).toContain(
      "Nous avons reçu une demande de réinitialisation du mot de passe du compte Immojudis associé à {{ .Email }}. Ce lien ne peut servir qu’une fois. Si vous n’êtes pas à l’origine de cette demande, ignorez ce message : votre mot de passe actuel reste valable. Ne transmettez ce lien à personne.",
    );
    expect(html("recovery")).toContain("Choisir un nouveau mot de passe");
    expect(html("email_change")).toContain(
      "Vous avez demandé à remplacer l’adresse {{ .Email }} par {{ .NewEmail }} sur votre compte Immojudis. Le changement ne sera effectif qu’après confirmation. Si vous n’êtes pas à l’origine de cette demande, ignorez ce message et changez votre mot de passe.",
    );
    expect(html("email_change")).toContain("Confirmer le changement");
    for (const id of ["confirmation", "recovery", "email_change", "invite", "magic_link"]) {
      expect(html(id)).toContain(
        "Le bouton ne fonctionne pas ? Copiez ce lien dans votre navigateur :",
      );
    }
  });

  it("préheaders validés", () => {
    const preheader = (id: string) =>
      AUTH_EMAIL_TEMPLATES.find((definition) => definition.id === id)!.preheader;
    expect(preheader("confirmation")).toBe("Un clic pour activer votre compte.");
    expect(preheader("recovery")).toBe("Choisissez un nouveau mot de passe.");
    expect(preheader("email_change")).toBe("Votre adresse ne changera qu’après confirmation.");
  });

  describe("liens", () => {
    it("la variante principale renvoie vers /auth/confirmer avec le jeton, le type et l'adresse de retour en dernier", () => {
      expect(authEmailLink("token-hash", "signup")).toBe(
        "{{ .SiteURL }}/auth/confirmer?token_hash={{ .TokenHash }}&type=signup&redirect_to={{ .RedirectTo }}",
      );
      for (const definition of AUTH_EMAIL_TEMPLATES.filter((entry) => entry.button)) {
        const html = buildAuthEmailTemplate(definition, "token-hash");
        const href = `{{ .SiteURL }}/auth/confirmer?token_hash={{ .TokenHash }}&amp;type=${definition.button!.type}&amp;redirect_to={{ .RedirectTo }}`;
        expect(html, definition.id).toContain(`href="${href}"`);
        expect(html).not.toContain("ConfirmationURL");
        expect(html).not.toContain("/auth/v1/verify");
        // Lien de repli affiché en clair : le même, coupé n'importe où.
        expect(html).toContain(`>${href}</span>`);
      }
    });

    it("la page lit ce que les gabarits écrivent, une fois les variables Go remplacées", () => {
      for (const redirectTo of [
        "https://immojudis.com/bienvenue?retour=%2Fsales%2F12",
        encodeURIComponent("https://immojudis.com/bienvenue?retour=/sales/12&x=1"),
      ]) {
        for (const definition of AUTH_EMAIL_TEMPLATES.filter((entry) => entry.button)) {
          const url = authEmailLink("token-hash", definition.button!.type)
            .replace("{{ .SiteURL }}", "https://immojudis.com")
            .replace("{{ .TokenHash }}", "9f2c3d4e5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f")
            .replace("{{ .RedirectTo }}", redirectTo);
          const parsed = parseAuthLink(new URL(url).search);
          expect(parsed?.type, definition.id).toBe(definition.button!.type);
          expect(parsed?.tokenHash).toBe(
            "9f2c3d4e5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f",
          );
          expect(parsed?.redirectTo).toBeTruthy();
        }
      }
    });

    it("la variante de retour arrière n'emploie que {{ .ConfirmationURL }}", () => {
      for (const definition of AUTH_EMAIL_TEMPLATES.filter((entry) => entry.button)) {
        const html = buildAuthEmailTemplate(definition, "confirmation-url");
        expect(html, definition.id).toContain('href="{{ .ConfirmationURL }}"');
        expect(html).not.toContain("token_hash");
        expect(html).not.toContain("/auth/confirmer");
        expect(html).not.toContain("{{ .SiteURL }}");
      }
    });

    it("la réauthentification n'envoie qu'un code, sans lien de vérification", () => {
      const definition = AUTH_EMAIL_TEMPLATES.find((entry) => entry.id === "reauthentication")!;
      for (const variant of VARIANTS) {
        const html = buildAuthEmailTemplate(definition, variant);
        expect(html).toContain("{{ .Token }}");
        expect(html).not.toContain("ConfirmationURL");
        expect(html).not.toContain("token_hash");
        expect(html).not.toContain('class="ej-btn-a"');
      }
    });
  });
});
