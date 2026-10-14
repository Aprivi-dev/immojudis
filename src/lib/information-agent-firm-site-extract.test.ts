import { describe, expect, it } from "vitest";
import {
  chooseFirmAddress,
  emailRecallsName,
  extractFirmSiteLinks,
  extractPageEmails,
  firmSiteStartUrls,
  isChallengePage,
  isPublicFirmHostname,
  type FirmSiteSale,
} from "@/lib/information-agent/firm-site-extract";

function sale(overrides: Partial<FirmSiteSale> = {}): FirmSiteSale {
  return {
    lawyer_contact: null,
    source_blocks: null,
    source_blocks_by_source: null,
    source_url: "https://www.licitor.com/annonce/1.html",
    source_urls: null,
    ...overrides,
  };
}

describe("URL de départ tirées de l'annonce", () => {
  it("lit le site dans le champ de contact de l'avocat", () => {
    expect(
      firmSiteStartUrls(
        sale({
          lawyer_contact:
            "12 rue du Palais, 33000 Bordeaux | Tél.: 05 56 00 00 00 | www.cabinet-dupont.fr/",
        }),
      ),
    ).toEqual(["https://www.cabinet-dupont.fr/"]);
  });

  it("lit le site dans les blocs source (Avoventes, Licitor, Vench)", () => {
    const urls = firmSiteStartUrls(
      sale({
        source_blocks: { cabinet_site: "https://etude-martin.fr", description: "https://autre.fr" },
        source_blocks_by_source: {
          "licitor:primary": {
            lawyers: [{ name: "Me Dupont", website: "http://www.cabinet-dupont.fr" }],
          },
          "vench:1": { contact_avocat: "01 02 03 04 05 · https://avocats-lemoine.fr/contact" },
        },
      }),
    );
    expect(urls).toEqual([
      "https://etude-martin.fr/",
      "https://www.cabinet-dupont.fr/",
      "https://avocats-lemoine.fr/contact",
    ]);
  });

  it("n'invente aucune adresse : un texte libre ou un bloc sans site ne donne rien", () => {
    expect(firmSiteStartUrls(sale())).toEqual([]);
    expect(
      firmSiteStartUrls(
        sale({
          lawyer_contact: "Maître Dupont, cabinet-dupont.fr",
          source_blocks: { description: "Voir https://www.cabinet-dupont.fr pour le cabinet" },
        }),
      ),
    ).toEqual([]);
  });

  it("écarte réseaux sociaux, annuaires, moteurs de recherche et site de l'annonce", () => {
    expect(
      firmSiteStartUrls(
        sale({
          lawyer_contact: [
            "https://www.linkedin.com/in/dupont",
            "https://www.pagesjaunes.fr/pros/1",
            "https://www.google.com/search?q=dupont",
            "https://www.notaires.fr/fr/etude",
            "https://www.licitor.com/avocat/dupont",
            "https://annonces.licitor.com/x",
            "https://www.cabinet-dupont.fr",
          ].join(" | "),
        }),
      ),
    ).toEqual(["https://www.cabinet-dupont.fr/"]);
  });

  it("refuse les adresses IP, localhost, les ports et les identifiants dans l'URL", () => {
    expect(
      firmSiteStartUrls(
        sale({
          lawyer_contact: [
            "http://127.0.0.1/admin",
            "http://169.254.169.254/latest/meta-data",
            "http://localhost/contact",
            "https://intranet.local/contact",
            "https://cabinet.fr:8443/contact",
            "https://user:secret@cabinet.fr/contact",
            "https://[::1]/",
          ].join(" | "),
        }),
      ),
    ).toEqual([]);
    expect(isPublicFirmHostname("cabinet-dupont.fr")).toBe(true);
    expect(isPublicFirmHostname("10.0.0.1")).toBe(false);
    expect(isPublicFirmHostname("serveur")).toBe(false);
  });

  it("garde une seule page par site", () => {
    expect(
      firmSiteStartUrls(
        sale({
          lawyer_contact: "https://cabinet-dupont.fr/contact | http://www.cabinet-dupont.fr/equipe",
        }),
      ),
    ).toEqual(["https://cabinet-dupont.fr/contact"]);
  });
});

describe("liens internes utiles", () => {
  const html = `
    <nav>
      <a href="/le-cabinet">Le cabinet</a>
      <a href="/contact">Contact</a>
      <a href="https://www.cabinet-dupont.fr/mentions-legales/">Mentions légales</a>
      <a href="https://www.linkedin.com/company/dupont">Contact LinkedIn</a>
      <a href="https://autre-site.fr/contact">Contact</a>
      <a href="mailto:contact@cabinet-dupont.fr">Contact</a>
      <a href="/contact.pdf">Contact</a>
      <a href="/blog/article">Actualités</a>
      <a href="/contact#haut">Contact</a>
      <a href="#contact">Contact</a>
    </nav>`;

  it("garde contact, mentions légales et cabinet du même site, sans doublon, dans cet ordre", () => {
    expect(extractFirmSiteLinks(html, "https://www.cabinet-dupont.fr/")).toEqual([
      "https://www.cabinet-dupont.fr/contact",
      "https://www.cabinet-dupont.fr/mentions-legales/",
      "https://www.cabinet-dupont.fr/le-cabinet",
    ]);
  });

  it("ne suit jamais un lien hors du domaine ni la page courante", () => {
    const links = extractFirmSiteLinks(
      '<a href="/contact">Contact</a><a href="https://evil.example/contact">Contact</a>',
      "https://cabinet-dupont.fr/contact",
    );
    expect(links).toEqual([]);
  });
});

describe("adresses publiées en clair", () => {
  it("lit les liens mailto et le texte, sans doublon", () => {
    const html = `<p>Écrivez-nous : <a href="mailto:Contact@Cabinet-Dupont.fr?subject=Bonjour">écrire</a>
      ou contact@cabinet-dupont.fr, ou jean.dupont@cabinet-dupont.fr.</p>`;
    expect(extractPageEmails(html)).toEqual([
      { email: "contact@cabinet-dupont.fr", via: "mailto" },
      { email: "jean.dupont@cabinet-dupont.fr", via: "text" },
    ]);
  });

  it("ne décode jamais une adresse masquée par Cloudflare ni ne la devine", () => {
    const html = `<a class="__cf_email__" href="/cdn-cgi/l/email-protection" data-cfemail="1a79757474">[email&#160;protected]</a>
      <script>var x = "secret@cabinet-dupont.fr";</script>
      <!-- cache@cabinet-dupont.fr -->
      <style>.a{background:url(logo@2x.png)}</style>`;
    expect(extractPageEmails(html)).toEqual([]);
  });

  it("ignore le contenu des scripts, styles et commentaires, balises fermantes atypiques comprises", () => {
    const html = [
      '<script>var a = "script1@cabinet-dupont.fr";</script >',
      '<SCRIPT type="text/javascript">var b = "script2@cabinet-dupont.fr";</SCRIPT\n>',
      "<style>/* style@cabinet-dupont.fr */</style\t>",
      "<!-- commentaire@cabinet-dupont.fr --!>",
      "<!-- autre@cabinet-dupont.fr -->",
      "<p>contact@cabinet-dupont.fr</p>",
    ].join("\n");
    expect(extractPageEmails(html)).toEqual([{ email: "contact@cabinet-dupont.fr", via: "text" }]);
  });

  it.each([
    "greffe@tj-bordeaux.justice.fr",
    "me.dupont@avocat-conseil.fr",
    "contact@ordre-avocats-bordeaux.fr",
    "carpa@cabinet-dupont.fr",
    "noreply@cabinet-dupont.fr",
    "dpo@cabinet-dupont.fr",
    "rgpd@cabinet-dupont.fr",
    "webmaster@cabinet-dupont.fr",
    "compta@cabinet-dupont.fr",
  ])("écarte l'adresse non sollicitable %s", (email) => {
    expect(extractPageEmails(`<a href="mailto:${email}">${email}</a>`)).toEqual([]);
  });
});

describe("choix d'une seule adresse", () => {
  const choose = (
    emails: string[],
    lawyerName = "Maître Jean Dupont",
    siteHostname = "www.cabinet-dupont.fr",
  ) => chooseFirmAddress({ emails, siteHostname, lawyerName });

  it("retient l'unique adresse générique du domaine du cabinet", () => {
    expect(choose(["contact@cabinet-dupont.fr"])).toEqual({
      status: "retained",
      email: "contact@cabinet-dupont.fr",
      reason: "generic",
    });
  });

  it("préfère l'adresse qui porte le nom et le prénom de l'avocat", () => {
    for (const named of [
      "jean.dupont@cabinet-dupont.fr",
      "dupont.jean@cabinet-dupont.fr",
      "jean-dupont@cabinet-dupont.fr",
      "jeandupont@cabinet-dupont.fr",
      "jdupont@cabinet-dupont.fr",
      "j.dupont@cabinet-dupont.fr",
      "dupont.j@cabinet-dupont.fr",
    ]) {
      expect(
        choose(["contact@cabinet-dupont.fr", named, "marie.martin@cabinet-dupont.fr"]),
      ).toEqual({ status: "retained", email: named, reason: "name" });
    }
  });

  it("à défaut, retient contact@ ou cabinet@ s'il n'y en a qu'un", () => {
    expect(choose(["marie.martin@cabinet-dupont.fr", "cabinet@cabinet-dupont.fr"])).toEqual({
      status: "retained",
      email: "cabinet@cabinet-dupont.fr",
      reason: "generic",
    });
  });

  it("ambiguïté : rien n'est retenu", () => {
    // Deux adresses génériques.
    expect(choose(["contact@cabinet-dupont.fr", "cabinet@cabinet-dupont.fr"]).status).toBe(
      "ambiguous",
    );
    // Aucune ne désigne l'avocat ni le cabinet.
    expect(choose(["marie.martin@cabinet-dupont.fr", "paul.durand@cabinet-dupont.fr"]).status).toBe(
      "ambiguous",
    );
    // Deux adresses qui portent son nom.
    expect(choose(["jean.dupont@cabinet-dupont.fr", "j.dupont@cabinet-dupont.fr"]).status).toBe(
      "ambiguous",
    );
    // Une seule adresse, mais celle d'une autre personne.
    expect(choose(["marie.martin@cabinet-dupont.fr"]).status).toBe("ambiguous");
    expect(choose([])).toEqual({ status: "none" });
  });

  it("une adresse unique non générique exige le nom ET le prénom", () => {
    // Le nom de famille seul, ou le prénom seul, ne suffit pas.
    expect(choose(["dupont@cabinet-dupont.fr"]).status).toBe("ambiguous");
    expect(choose(["jean@cabinet-dupont.fr"]).status).toBe("ambiguous");
    expect(choose(["jean.dupont@cabinet-dupont.fr"])).toMatchObject({
      status: "retained",
      reason: "name",
    });
  });

  it("une adresse hors du domaine du site est écartée (messagerie grand public, agence web)", () => {
    expect(choose(["jean.dupont@gmail.com"])).toEqual({ status: "none" });
    expect(choose(["contact@agence-web.fr"])).toEqual({ status: "none" });
    expect(choose(["jean.dupont@gmail.com", "j.dupont@orange.fr"])).toEqual({ status: "none" });
    // Le domaine du cabinet prime : l'adresse grand public ne compte pas.
    expect(choose(["jean.dupont@gmail.com", "contact@cabinet-dupont.fr"])).toMatchObject({
      status: "retained",
      email: "contact@cabinet-dupont.fr",
    });
  });

  it("n'admet que le domaine exact du site ou un sous-domaine, jamais le domaine parent", () => {
    const blog = (emails: string[]) =>
      choose(emails, "Maître Jean Dupont", "cabinet-dupont.over-blog.com");
    expect(blog(["contact@over-blog.com"])).toEqual({ status: "none" });
    expect(blog(["jean.dupont@over-blog.com"])).toEqual({ status: "none" });
    expect(choose(["contact@wix.com"], "Jean Dupont", "cabinet.wixsite.com")).toEqual({
      status: "none",
    });
    // Domaine exact, `www.` ôté, ou sous-domaine du site.
    expect(blog(["contact@cabinet-dupont.over-blog.com"]).status).toBe("retained");
    expect(
      choose(["contact@cabinet-dupont.fr"], "Jean Dupont", "www.cabinet-dupont.fr").status,
    ).toBe("retained");
    expect(choose(["contact@mail.cabinet-dupont.fr"]).status).toBe("retained");
    expect(choose(["contact@cabinet-dupont.fr.evil.example"]).status).toBe("none");
    expect(choose(["contact@evilcabinet-dupont.fr"]).status).toBe("none");
  });

  it("compare des segments entiers : luc n'est pas lucie, anne n'est pas jeanne", () => {
    const named = (email: string, name: string) =>
      chooseFirmAddress({
        emails: [email, "marie.martin@cabinet-x.fr", "paul.durand@cabinet-x.fr"],
        siteHostname: "cabinet-x.fr",
        lawyerName: name,
      }).status;
    expect(named("lucie.dupont@cabinet-x.fr", "Luc Dupont")).toBe("ambiguous");
    expect(named("luc.dupont@cabinet-x.fr", "Luc Dupont")).toBe("retained");
    expect(named("jeanne.durand@cabinet-x.fr", "Anne Durand")).toBe("ambiguous");
    expect(named("anne.durand@cabinet-x.fr", "Anne Durand")).toBe("retained");
    expect(named("dupontluc@cabinet-x.fr", "Luc Dupont")).toBe("retained");
    expect(named("ldupont@cabinet-x.fr", "Luc Dupont")).toBe("retained");
    expect(named("adupont@cabinet-x.fr", "Luc Dupont")).toBe("ambiguous");
    expect(emailRecallsName("lucie.dupont@x.fr", "Luc Dupont")).toBe(false);
    expect(emailRecallsName("luc_dupont@x.fr", "Luc Dupont")).toBe(true);
  });
});

describe("documents hostiles de 1 Mio : analyse linéaire", () => {
  const MEGABYTE = 1_048_576;
  const timed = (action: () => unknown) => {
    const started = performance.now();
    action();
    return performance.now() - started;
  };

  it.each([
    ["balises <script> jamais fermées", "<script ".repeat(MEGABYTE / 8)],
    ["balises <style> jamais fermées", "<style ".repeat(MEGABYTE / 7)],
    ["commentaires jamais fermés", "<!-- ".repeat(MEGABYTE / 5)],
    ["fermetures </script sans >", "<script>x</script ".repeat(MEGABYTE / 18)],
    ["chevrons ouvrants sans fin", "<".repeat(MEGABYTE)],
    ["liens jamais fermés", "<a href='/contact'>".repeat(MEGABYTE / 19)],
    ["balises <title> jamais fermées", "<title ".repeat(MEGABYTE / 7)],
  ])("%s", (_label, html) => {
    const duration = timed(() => {
      extractPageEmails(html);
      extractFirmSiteLinks(html, "https://www.cabinet-dupont.fr/");
      isChallengePage(html);
    });
    expect(duration).toBeLessThan(1_500);
  });

  it("une balise ouvrante sans fermeture retire le reste du document (aucune adresse après)", () => {
    expect(
      extractPageEmails("<p>a@cabinet-dupont.fr</p><script>var x; b@cabinet-dupont.fr"),
    ).toEqual([{ email: "a@cabinet-dupont.fr", via: "text" }]);
  });
});

describe("page d'obstacle", () => {
  it("reconnaît un défi anti-robot ou un captcha plein écran", () => {
    expect(isChallengePage("<html><head><title>Just a moment...</title></head></html>")).toBe(true);
    expect(isChallengePage('<script src="/cdn-cgi/challenge-platform/h/b"></script>')).toBe(true);
    expect(isChallengePage('<div class="g-recaptcha"></div><p>Êtes-vous humain ?</p>')).toBe(true);
  });

  it("un formulaire de contact avec captcha n'est pas un obstacle", () => {
    const content = `<html><head><title>Contact</title></head><body>${"<p>Cabinet de Maître Dupont, avocat au barreau de Bordeaux. </p>".repeat(30)}<div class="g-recaptcha"></div></body></html>`;
    expect(isChallengePage(content)).toBe(false);
  });
});
