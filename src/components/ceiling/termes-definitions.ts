/**
 * Les définitions des termes du métier, chargées par `Terme` au premier survol, focus ou clic et
 * jamais au chargement de la page : aucun code client ne doit importer ce module statiquement.
 * Les libellés sont repris dans `TERME_LABELS` (`Terme.tsx`), pour le rendu initial ; un test
 * vérifie qu'ils restent identiques.
 */
import type { TermeKey } from "./Terme";

/** Une section de l'article qui compare les ventes notariales (bougie, interactive) au tribunal. */
const notaryHref = (section: string) =>
  `/ressources/ventes-notariales-domaniales-differences-tribunal#${section}`;

export type TermeEntry = {
  label: string;
  definition: string;
  /** Ancre de l'entrée dans le lexique du guide (`lexique-<terme>`) ; sans elle, le lexique entier. */
  anchor?: string;
  /**
   * Lien complet quand le terme n'est pas dans le lexique du guide, qui est judiciaire : les termes
   * des ventes notariales renvoient à l'article qui les compare au tribunal.
   */
  href?: string;
};

/**
 * Définitions courtes et neutres, alignées sur le lexique du guide. Elles n'énoncent pas de règle
 * de procédure, sauf le montant de la garantie pour enchérir en saisie immobilière : les autres
 * montants, délais et conditions exacts relèvent du cahier des conditions de vente et de l'avocat.
 */
export const TERMES: Record<TermeKey, TermeEntry> = {
  "mise-a-prix": {
    label: "mise à prix",
    definition:
      "Prix de départ de la vente aux enchères. Elle ne doit pas être confondue avec la valeur réelle du bien.",
    anchor: "lexique-mise-a-prix",
  },
  adjudication: {
    label: "adjudication",
    definition: "Attribution du bien au meilleur enchérisseur à l’issue de l’audience.",
    anchor: "lexique-adjudication",
  },
  surenchere: {
    label: "surenchère",
    definition:
      "Offre formée après une adjudication, dans les conditions et délais prévus par la loi, entraînant une nouvelle audience.",
    anchor: "lexique-surenchere",
  },
  "avocat-poursuivant": {
    label: "avocat poursuivant",
    definition:
      "Avocat qui conduit la procédure pour le compte du créancier ou de la partie à l’origine de la vente.",
    anchor: "lexique-avocat-poursuivant",
  },
  consignation: {
    label: "consignation du prix",
    definition:
      "Dépôt du prix de l’adjudication sur un compte séquestre ou à la Caisse des dépôts et consignations, après la vente. À ne pas confondre avec la garantie remise avant d’enchérir.",
    anchor: "lexique-consignation-du-prix",
  },
  "enchere-plafond": {
    label: "enchère plafond",
    definition:
      "Montant maximum à ne pas dépasser, simulé à partir du marché, des frais, des travaux et des risques. C’est une aide à la décision, pas un conseil d’achat.",
    anchor: "lexique-enchere-plafond",
  },
  "offre-plafond": {
    label: "offre plafond",
    definition:
      "Montant maximum à ne pas dépasser dans une vente par offres, simulé à partir du marché, des frais et des risques. Le vendeur n’est pas forcément tenu de retenir la meilleure offre ; lisez les conditions de la vente.",
    href: notaryHref("vente-interactive"),
  },
  "vente-bougie": {
    label: "vente à la bougie",
    definition:
      "Vente aux enchères chez le notaire, en salle : l’adjudication est prononcée quand deux feux successifs s’éteignent sans nouvelle enchère.",
    href: notaryHref("notaire"),
  },
  "vente-interactive": {
    label: "vente notariale interactive",
    definition:
      "Vente chez le notaire par offres en ligne, pendant une durée limitée. L’acheteur retenu signe un avant-contrat ; le vendeur n’est pas tenu de retenir la meilleure offre.",
    href: notaryHref("vente-interactive"),
  },
  "premiere-offre": {
    label: "première offre possible",
    definition:
      "Plus bas montant que l’on peut proposer dans une vente notariale interactive. Ce n’est pas une mise à prix : le prix de réserve n’est pas publié.",
    href: notaryHref("vente-interactive"),
  },
  liberation: {
    label: "libération du bien",
    definition:
      "Fait de faire quitter les lieux à un occupant pour pouvoir disposer du bien. Elle prend du temps et peut avoir un coût.",
  },
  portage: {
    label: "portage",
    definition:
      "Ce que coûte le bien entre l’adjudication et le moment où vous l’habitez, le louez ou le revendez : charges, taxe foncière, assurance et coût de l’argent.",
    anchor: "lexique-portage",
  },
  emoluments: {
    label: "émoluments",
    definition:
      "Rémunération de l’avocat qui conduit la vente, calculée selon un barème réglementé et payée en plus du prix.",
    anchor: "lexique-emoluments",
  },
  "garantie-encherir": {
    label: "garantie pour enchérir",
    definition:
      "Chèque de banque ou caution bancaire irrévocable remis à l’avocat avant les enchères (en saisie immobilière : 10 % de la mise à prix, 3 000 € au minimum). Elle est restituée à l’enchérisseur qui ne l’emporte pas. Le plan de trésorerie l’appelle aussi « consignation » ; ne la confondez pas avec la consignation du prix, versée après la vente.",
    anchor: "lexique-garantie-pour-encherir",
  },
  "frais-prealables": {
    label: "frais préalables",
    definition:
      "Frais de la procédure de saisie dont le montant a été fixé (taxé) par le juge. Ils sont à la charge de l’adjudicataire, en plus du prix. Leur montant est indiqué dans le cahier des conditions de vente ou annoncé avant les enchères : demandez-le à l’avocat poursuivant.",
  },
  "proces-verbal-descriptif": {
    label: "procès-verbal descriptif",
    definition:
      "Document dressé par un commissaire de justice qui décrit le bien : composition, état apparent et occupation constatés lors de sa visite.",
  },
  "cahier-conditions-vente": {
    label: "cahier des conditions de vente",
    definition:
      "Document juridique rédigé par l’avocat du créancier poursuivant, qui décrit le bien, les règles de la vente, l’occupation, les diagnostics, les servitudes et les frais. Il se consulte au greffe ou auprès de l’avocat poursuivant.",
    anchor: "lexique-cahier-des-conditions-de-vente",
  },
  "droit-preemption": {
    label: "droit de préemption",
    definition:
      "Droit, pour la commune ou un autre titulaire prévu par la loi, de se substituer à l’adjudicataire pour acquérir le bien, dans un délai fixé par la loi.",
    anchor: "lexique-droit-de-preemption",
  },
};
