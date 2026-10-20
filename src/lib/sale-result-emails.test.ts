import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emailClickPath, readEmailClickToken } from "@/lib/email-click-token";
import { verifyUnsubscribeToken } from "@/lib/email-unsubscribe-token";
import {
  SALE_RESULT_DETAILS,
  SALE_RESULT_HEADLINES,
  buildSaleResultMessage,
  saleResultSubject,
  surenchereLines,
  type SaleResultItem,
  type SaleResultKind,
} from "@/lib/sale-result-emails";
import { surenchereWindow } from "@/lib/surenchere-window";

const env = { SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key" };
const userId = "7d335032-e935-4550-9347-ed22b0f63449";
const saleId = "A1B2C3D4-0000-4000-8000-000000000001";
const now = new Date("2026-11-04T10:15:00Z");

function item(kind: SaleResultKind, overrides: Partial<SaleResultItem> = {}): SaleResultItem {
  return {
    kind,
    saleId,
    title: "Maison à Bordeaux",
    location: "Tribunal judiciaire de Bordeaux",
    headline: SALE_RESULT_HEADLINES[kind],
    detail: SALE_RESULT_DETAILS[kind].sale,
    surenchere: null,
    link: "sale",
    ...overrides,
  };
}

function build(items: SaleResultItem[], internal = false) {
  return buildSaleResultMessage({
    userId,
    items,
    recipientEmail: "investisseur@example.test",
    from: "Immojudis <alertes@immojudis.com>",
    appUrl: "https://immojudis.com",
    internal,
    now,
    env,
  });
}

const window = (overrides: { adjudicationConfirmed?: boolean; now?: Date } = {}) =>
  surenchereWindow({
    saleDate: "2026-11-03T13:00:00Z",
    venueType: "tribunal",
    adjudicationConfirmed: overrides.adjudicationConfirmed ?? true,
    now: overrides.now ?? now,
  });

describe("surenchereLines", () => {
  it("reprend la formulation prudente : date indicative, report possible, avocat, garantie", () => {
    const text = (surenchereLines(window()) ?? []).join(" ");
    expect(text).toContain("date indicative : le 13 novembre 2026. Si ce jour tombe");
    expect(text).toContain(
      "Si ce jour tombe un samedi, un dimanche ou un jour férié, le délai peut être prolongé jusqu’au premier jour ouvrable suivant ; ne comptez pas dessus sans l’avis d’un avocat.",
    );
    expect(text).toContain(
      "calculée à partir de la date d’audience connue d’Immojudis, qui peut avoir changé",
    );
    expect(text).toContain(
      "par acte d’avocat déposé au greffe du juge de l’exécution, avec une garantie d’un dixième du prix principal (chèque de banque ou caution bancaire irrévocable, art. R. 322-51 du CPCE)",
    );
    expect(text).toContain(
      "de préférence inscrit au barreau du tribunal concerné ; le choix vous appartient (l’annuaire d’Immojudis signale les profils mis en avant contre rémunération)",
    );
    expect(text).not.toContain("Le résultat n’est pas connu");
  });

  it("dit que la surenchère n'existe que si le bien est adjugé quand le résultat n'est pas connu", () => {
    const text = (surenchereLines(window({ adjudicationConfirmed: false })) ?? []).join(" ");
    expect(text).toContain(
      "Le résultat n’est pas connu : la surenchère n’existe que si le bien a été adjugé.",
    );
  });

  it("ne dit jamais « fenêtre échue », « il reste N jours » ni « dernier jour »", () => {
    const later = new Date("2026-12-20T10:00:00Z");
    for (const info of [
      window(),
      window({ now: later }),
      window({ adjudicationConfirmed: false }),
    ]) {
      const text = (surenchereLines(info) ?? []).join(" ");
      expect(text).not.toMatch(/échue|il reste|jours? restants?|dernier jour|délai expiré/i);
      expect(text).not.toMatch(/€/);
    }
    const expired = (surenchereLines(window({ now: later })) ?? []).join(" ");
    expect(expired).toContain(
      "Cette date indicative est passée : le délai a pu expirer, ou être prolongé. Si vous êtes concerné, consultez sans attendre un avocat, seul à pouvoir le confirmer.",
    );
  });

  it("renvoie à un avocat sans date d'audience, et ne dit rien d'une vente non judiciaire", () => {
    const none = surenchereWindow({
      saleDate: null,
      venueType: "tribunal",
      adjudicationConfirmed: true,
      now,
    });
    expect((surenchereLines(none) ?? []).join(" ")).toContain(
      "Interrogez un avocat de votre choix",
    );
    const notary = surenchereWindow({
      saleDate: "2026-11-03T13:00:00Z",
      venueType: "notaire",
      adjudicationConfirmed: true,
      now,
    });
    expect(surenchereLines(notary)).toBeNull();
  });

  it("garde les mêmes phrases que l'écran « Ventes passées » (formulation validée)", () => {
    const screen = readFileSync(join(process.cwd(), "src/components/PastFollowedSales.tsx"), "utf8")
      .replace(/\s+/g, " ")
      .replace(/\{" "\}/g, " ");
    for (const phrase of [
      "Si ce jour tombe un samedi, un dimanche ou un jour férié, le délai peut être prolongé jusqu’au premier jour ouvrable suivant ; ne comptez pas dessus sans l’avis d’un avocat.",
      "Elle est calculée à partir de la date d’audience connue d’Immojudis, qui peut avoir changé.",
      "Cette date indicative est passée : le délai a pu expirer, ou être prolongé. Si vous êtes concerné, consultez sans attendre un avocat, seul à pouvoir le confirmer.",
      "la surenchère n’existe que si le bien a été adjugé",
      "La surenchère se forme par acte d’avocat déposé au greffe du juge de l’exécution, avec une garantie d’un dixième du prix principal (chèque de banque ou caution bancaire irrévocable, art. R. 322-51 du CPCE).",
      "Faites confirmer la date et les conditions par un avocat, de préférence inscrit au barreau du tribunal concerné ; le choix vous appartient (",
      "signale les profils mis en avant contre rémunération).",
    ]) {
      expect(screen, phrase).toContain(phrase);
    }
  });
});

describe("email de l'alerte de résultat", () => {
  it("n'affiche aucun prix, quel que soit le type d'alerte", () => {
    const items = (["result_known", "result_unknown", "withdrawn", "relisted"] as const).map(
      (kind) => item(kind, { surenchere: window() }),
    );
    const message = build(items);
    // Seule exception : la garantie de la surenchère est dite « un dixième du prix principal » (texte
    // de la relecture juridique), sans aucun montant ; tout autre « prix » reste interdit.
    const content = `${message.subject}\n${message.text}\n${message.html}`.replaceAll(
      "d’un dixième du prix principal",
      "",
    );
    expect(content).not.toMatch(/€|euros?\b|prix|mise à prix|adjugé à/i);
  });

  it("n'emploie aucun libellé « non adjugée »", () => {
    for (const headline of Object.values(SALE_RESULT_HEADLINES)) {
      expect(headline).not.toMatch(/non adjug/i);
    }
    expect(SALE_RESULT_HEADLINES.result_unknown).toBe(
      "La vente que vous suivez a eu lieu : résultat non connu",
    );
  });

  it("met la mention de surenchère dans le texte et le HTML d'un instantané, vers Mes favoris", () => {
    const message = build([
      item("result_known", {
        link: "favorites",
        detail: SALE_RESULT_DETAILS.result_known.favorites,
        surenchere: window(),
      }),
    ]);
    expect(message.subject).toBe(
      "La vente que vous suivez a eu lieu : un résultat est connu — Maison à Bordeaux (Tribunal judiciaire de Bordeaux)",
    );
    expect(message.text).toContain("Surenchère, date indicative : le 13 novembre 2026");
    expect(message.html).toContain("le choix vous appartient");
    expect(message.text).toContain("Voir mes favoris : https://immojudis.com/favoris");
    expect(message.html).toContain(">Voir mes favoris</a>");
    expect(message.text).toContain("auprès de l’avocat poursuivant");
  });

  it("suit le lien d'une fiche par la redirection signée de type « result »", () => {
    const message = build([item("relisted")]);
    const url = /https:\/\/immojudis\.com\/api\/email\/click\?token=\S+/.exec(message.text)?.[0];
    const read = readEmailClickToken(new URL(url!).searchParams.get("token"), { now, env });
    expect(read?.claims).toMatchObject({ userId, kind: "result", target: "sale" });
    expect(emailClickPath(read!.claims)).toBe("/sales/a1b2c3d4-0000-4000-8000-000000000001");
    expect(message.text).toContain("Voir l'annonce : ");
  });

  it("garde un lien direct pour un identifiant de vente qui n'est pas un UUID", () => {
    const message = build([item("withdrawn", { saleId: "pas-un-uuid" })]);
    expect(message.text).toContain("https://immojudis.com/sales/pas-un-uuid");
  });

  it("met le lien de désinscription signé, de portée dédiée, dans le texte, le HTML et l'en-tête", () => {
    const message = build([item("withdrawn")]);
    const claims = verifyUnsubscribeToken(
      new URL(message.unsubscribeUrl).searchParams.get("token"),
      { now, env },
    );
    expect(claims).toMatchObject({ userId, scope: { kind: "sale-results" } });
    expect(message.text).toContain(
      `Se désinscrire des alertes de résultat : ${message.unsubscribeUrl}`,
    );
    expect(message.html).toContain("Se désinscrire des alertes de résultat");
    expect(message.oneClickUnsubscribe).toBe(true);
  });

  it("préfixe l'objet en mode interne, et compte les éléments quand il y en a plusieurs", () => {
    expect(saleResultSubject([item("withdrawn")], true).startsWith("[Test interne] ")).toBe(true);
    expect(saleResultSubject([item("withdrawn"), item("relisted")], false)).toBe(
      "Vos ventes suivies : 2 résultats et mises à jour",
    );
  });

  it("refuse de construire un email vide et échappe le contenu", () => {
    expect(() => build([])).toThrow();
    const message = build([item("withdrawn", { title: "<script>alert(1)</script>" })]);
    expect(message.html).not.toContain("<script>");
    expect(message.html).toContain("&lt;script&gt;");
  });
});
