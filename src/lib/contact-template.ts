import type { AuctionSale } from "./types";
import { formatDate, formatPrice, formatSurface, propertyTypeLabel, occupancyLabel } from "./format";

export type ContactTemplate = {
  subject: string;
  body: string;
};

export function buildContactTemplate(sale: AuctionSale): ContactTemplate {
  const ville = sale.city ?? sale.department ?? "—";
  const dateVente = sale.sale_date ? formatDate(sale.sale_date) : "à préciser";
  const adresse = [sale.address, sale.postal_code, sale.city].filter(Boolean).join(", ") || "adresse non communiquée";
  const type = propertyTypeLabel(sale.property_type);
  const surface = formatSurface(sale.app_surface_m2 ?? sale.habitable_surface_m2 ?? sale.carrez_surface_m2);
  const mise = sale.starting_price_eur != null ? formatPrice(sale.starting_price_eur) : "à préciser";
  const tribunal = sale.tribunal_name ?? sale.tribunal ?? "le tribunal compétent";
  const occupation = sale.occupancy_status ? occupancyLabel(sale.occupancy_status) : null;
  const isCopro = sale.property_type === "apartment" || /appartement|copropri/i.test(sale.title ?? "");

  const subject = `Demande d'informations — Vente aux enchères du ${dateVente} — ${ville}`;

  const lignes: string[] = [
    `Madame, Monsieur,`,
    ``,
    `Je me permets de vous contacter au sujet de la vente aux enchères ci-dessous, pour laquelle j'envisage de porter une enchère :`,
    ``,
    `• Bien : ${type}${surface !== "—" ? ` d'environ ${surface}` : ""}`,
    `• Adresse : ${adresse}`,
    `• Date de l'audience : ${dateVente}`,
    `• Mise à prix : ${mise}`,
    `• Juridiction : ${tribunal}`,
  ];
  if (occupation) lignes.push(`• Occupation indiquée : ${occupation}`);
  if (sale.source_url) lignes.push(`• Annonce source : ${sale.source_url}`);

  lignes.push(
    ``,
    `Afin de préparer sereinement ma décision, je souhaiterais obtenir les éléments suivants :`,
    ``,
    `1. Le cahier des conditions de vente complet (avec ses annexes).`,
    `2. L'ensemble des diagnostics techniques obligatoires (DPE, amiante, plomb, termites, électricité, gaz, ERP).`,
    `3. Le détail de l'état d'occupation du bien (libre, occupé, bail en cours, montant du loyer, dépôt de garantie, durée restante).`,
    `4. Les modalités et créneaux de visite éventuels.`,
    `5. Le montant de la consignation à déposer ainsi que les modalités pratiques de participation à l'audience (en personne, par avocat, etc.).`,
    `6. Le détail des frais préalables et des frais à la charge de l'adjudicataire (émoluments, publicité, frais de poursuite).`,
    `7. Le montant de la taxe foncière et, le cas échéant, des autres taxes locales.`,
  );

  if (isCopro) {
    lignes.push(
      `8. Pour la copropriété : les trois derniers procès-verbaux d'assemblée générale, les comptes des trois derniers exercices, l'état daté, le montant des charges courantes, les travaux votés ou à prévoir, et l'existence éventuelle d'une procédure ou d'un fonds de travaux.`,
    );
  }

  lignes.push(
    ``,
    `Je vous remercie par avance pour les informations que vous pourrez me communiquer, et reste à votre disposition pour tout échange complémentaire.`,
    ``,
    `Bien cordialement,`,
  );

  return { subject, body: lignes.join("\n") };
}

export function buildMailtoUrl(to: string, t: ContactTemplate): string {
  const params = new URLSearchParams({ subject: t.subject, body: t.body });
  return `mailto:${to}?${params.toString().replace(/\+/g, "%20")}`;
}

export function buildGmailUrl(to: string, t: ContactTemplate): string {
  const params = new URLSearchParams({
    view: "cm",
    fs: "1",
    to,
    su: t.subject,
    body: t.body,
  });
  return `https://mail.google.com/mail/?${params.toString()}`;
}