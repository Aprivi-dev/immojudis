import Link from "next/link";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import CheckCircle2 from "lucide-react/dist/esm/icons/check-circle-2.js";
import { CloudBackgroundPreload } from "@/components/CloudBackgroundPreload";
import { SaleTypesOverview } from "@/components/SaleTypesOverview";
import ExternalLink from "lucide-react/dist/esm/icons/external-link.js";
import { jsonLdString } from "@/lib/json-ld";
import { GUIDE_LAST_UPDATED, GUIDE_READING_MINUTES } from "@/lib/guide-dates";
import { getResourceArticle } from "@/lib/resource-articles";

/**
 * Date de la dernière révision éditoriale du guide : elle est définie dans `@/lib/guide-dates`
 * (source unique) et alimente la mention « Mis à jour le » de la page, le `dateModified` de ses
 * données structurées et l'entrée du guide dans le sitemap (`src/app/sitemap.ts`).
 */
export { GUIDE_LAST_UPDATED, GUIDE_READING_MINUTES };

/** « 2026-10-13 » devient « 13/10/2026 ». */
export function formatGuideDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-");
  return `${day}/${month}/${year}`;
}

/** Vitesse de lecture retenue pour un texte d'information en français (mots par minute). */
export const READING_WORDS_PER_MINUTE = 230;

/** Slug stable d'un terme du lexique : minuscules, sans accents, espaces et apostrophes en tirets. */
export function lexiqueSlug(term: string): string {
  return term
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Identifiant (ancre) d'un terme du lexique : `lexique-<slug>`. */
export function lexiqueAnchor(term: string): string {
  return `lexique-${lexiqueSlug(term)}`;
}

const FAQ: Array<{ q: string; a: string }> = [
  {
    q: "Immojudis référence-t-il uniquement des ventes au tribunal ?",
    a: "Non. Immojudis réunit les ventes au tribunal et les enchères notariales référencées, ainsi que les ventes domaniales selon les sources disponibles. Le catalogue n’est pas exhaustif. Le type, le cadre juridique et le mode de participation sont distingués sur chaque dossier.",
  },
  {
    q: "Une vente en ligne est-elle un type de vente à part ?",
    a: "Non. En ligne décrit la façon de participer, pas le cadre juridique. Il faut toujours identifier l’organisateur et lire les conditions de la vente. Attention : chez un notaire, la vente interactive en ligne fonctionne par offres et avant-contrat, pas par enchères avec adjudication (voir l’article sur les ventes notariales et domaniales).",
  },
  {
    q: "Qui peut acheter un bien aux enchères au tribunal ?",
    a: "En principe, toute personne qui justifie de garanties de paiement peut enchérir (art. L. 322-7 du Code des procédures civiles d’exécution). Au tribunal, elle doit être représentée par un avocat. Certaines personnes ne peuvent pas enchérir, ni directement ni par personne interposée : le débiteur saisi, les auxiliaires de justice intervenus dans la procédure et les magistrats de la juridiction (art. R. 322-39). Une personne condamnée à certaines peines liées au logement ne peut pas, pendant la durée de la peine, enchérir pour acquérir un bien d’habitation, sauf pour l’occuper elle-même (art. L. 322-7-1). L’article 1596 du Code civil interdit enfin, sous peine de nullité, à certaines personnes de se rendre adjudicataires des biens qu’elles gèrent ou doivent vendre : un tuteur pour les biens de la personne protégée, un mandataire pour les biens qu’il est chargé de vendre, par exemple. En cas de doute sur votre situation, interrogez votre avocat.",
  },
  {
    q: "Un avocat est-il toujours obligatoire ?",
    a: "Cela dépend du type de vente. En saisie immobilière au tribunal, oui : les enchères sont portées par un avocat inscrit au barreau du tribunal où se tient la vente, et il ne peut porter qu’un seul mandat (art. R. 322-40). Pour une vente par licitation (partage judiciaire), les règles de la saisie sont largement reprises, mais lorsque les enchères sont reçues par un notaire, elles peuvent être faites sans avocat (art. 1377 et 1278 du Code de procédure civile). Pour une vente notariale volontaire ou une vente domaniale, les pages officielles consultées ne mentionnent pas d’obligation d’avocat : le cahier des conditions de vente ou des charges fait foi, demandez-le à l’organisateur.",
  },
  {
    q: "Peut-on obtenir un prêt bancaire ?",
    a: "Oui, mais le financement doit être préparé avant l’audience. Contrairement à une vente classique, l’adjudication n’est pas soumise à une condition suspensive d’obtention de prêt : le prix et les frais doivent être payés dans les deux mois de l’adjudication définitive (art. R. 322-56 et R. 322-58). L’hypothèque de la banque peut être inscrite avant le paiement du prix, mais le bien ne peut pas être revendu avant (art. L. 322-9). L’acheteur doit donc être certain de sa capacité à payer. Voir l’article « Financer un achat aux enchères ».",
  },
  {
    q: "Le bien peut-il être occupé ?",
    a: "Oui. Le bien peut être libre, loué, occupé par l'ancien propriétaire ou par un tiers. L'occupation doit être analysée avant l'audience, car elle peut modifier fortement la valeur et le calendrier du projet.",
  },
  {
    q: "Où consulter le cahier des conditions de vente ?",
    a: "Il peut être consulté au greffe du juge de l’exécution du tribunal judiciaire ou au cabinet de l’avocat du créancier poursuivant (art. R. 322-11). Immojudis aide à identifier les informations clés à extraire de ce document : voir l’article « Lire le cahier des conditions de vente et préparer la visite ».",
  },
  {
    q: "Une mise à prix basse signifie-t-elle une bonne affaire ?",
    a: "Non. La mise à prix est seulement le point de départ des enchères. La qualité de l'opération dépend du prix final, des frais, des travaux, de l'occupation, du marché local et des risques juridiques ou techniques.",
  },
  {
    q: "Peut-on se rétracter après avoir gagné l'enchère ?",
    a: "Non : les textes ne prévoient pas de faculté de rétractation. L’adjudication peut toutefois être remise en cause par une surenchère ou annulée dans les cas prévus par la loi. En cas de défaut de paiement, le bien est remis en vente (réitération des enchères) et l’adjudicataire défaillant peut devoir la différence de prix (art. L. 322-12).",
  },
  {
    q: "Que se passe-t-il en cas de surenchère ?",
    a: "En saisie immobilière, toute personne peut former une surenchère d’au moins un dixième du prix principal, par acte d’avocat déposé au greffe du juge de l’exécution dans les dix jours qui suivent l’adjudication (art. R. 322-50 et R. 322-51). Une nouvelle audience a alors lieu deux à quatre mois plus tard, et l’adjudication initiale n’est pas définitive. La surenchère du dixième dans les dix jours est une règle légale en saisie immobilière (art. R. 322-50 et R. 322-51 du CPCE) et en licitation judiciaire (art. 1377 et 1279 du CPC ; devant notaire, elle se forme par requête au greffe, art. 1280). Dans une vente notariale volontaire, elle n’est pas prévue par la loi : seul le cahier des charges peut la prévoir (Notaires de France décrit 10\u00a0% dans les 10 jours pour la vente « à la bougie »). Dans une vente domaniale, tout dépend du cahier des charges. Lisez-le avant d’enchérir.",
  },
  {
    q: "Quels frais s’ajoutent au prix d’adjudication ?",
    a: "Les frais de poursuite taxés et les droits de mutation sont payés en sus du prix (art. R. 322-58) ; s’y ajoutent les émoluments d’avocat (art. A. 444-191 du Code de commerce) et les honoraires convenus avec votre avocat. À titre d’ordre de grandeur, les hypothèses par défaut du simulateur Immojudis donnent environ 12\u00a0% du prix pour un bien à 150\u202f000\u00a0€ ; ces valeurs sont à vérifier sur le cahier des conditions de vente et auprès de l’avocat. Voir l’article « Frais d’une vente aux enchères judiciaire ».",
  },
  {
    q: "Immojudis remplace-t-il un avocat ?",
    a: "Non. Immojudis est un outil de référencement, de lecture et d’aide à la décision. Il ne fournit ni conseil juridique, ni promesse de gain, et ne remplace pas votre avocat, seul habilité à porter les enchères et qui peut vous conseiller sur la procédure.",
  },
];

const TOC: Array<{ href: string; label: string }> = [
  { href: "#differences", label: "Tribunal, notaire ou État : quelle différence ?" },
  { href: "#definition", label: "Qu'est-ce qu'une vente immobilière judiciaire ?" },
  { href: "#origine", label: "Pourquoi un bien est-il vendu aux enchères ?" },
  { href: "#immojudis", label: "Immojudis : décider avant d'enchérir" },
  { href: "#recherche", label: "Comment trouver une vente judiciaire ?" },
  { href: "#deroulement", label: "Comment se déroule une vente judiciaire ?" },
  { href: "#frais", label: "Quels frais prévoir ?" },
  { href: "#avantages", label: "Quels sont les avantages ?" },
  { href: "#risques", label: "Quels sont les risques ?" },
  { href: "#methode", label: "La méthode Immojudis" },
  { href: "#articles-associes", label: "Pour aller plus loin : nos articles" },
  { href: "#lexique", label: "Lexique" },
  { href: "#liens-institutionnels", label: "Liens institutionnels utiles" },
  { href: "#faq", label: "Questions fréquentes" },
];

const METHOD: Array<{ n: string; title: string; text: string }> = [
  {
    n: "1",
    title: "Identifier le bien",
    text: "Localisation, type de bien, surface, étage, dépendances, copropriété, environnement, accès, destination et potentiel d'usage.",
  },
  {
    n: "2",
    title: "Lire les pièces",
    text: "Annonce, cahier des conditions de vente, procès-verbal descriptif, diagnostics, documents de copropriété, informations d'urbanisme, occupation, servitudes et mentions particulières.",
  },
  {
    n: "3",
    title: "Repérer les risques",
    text: "Occupation, travaux, humidité, copropriété, charges, contentieux, servitudes, accès, état locatif, financement, liquidité à la revente.",
  },
  {
    n: "4",
    title: "Comparer au marché",
    text: "Analyse des ventes comparables, niveau de prix local, tension locative, liquidité à la revente, décote à appliquer, marge de sécurité.",
  },
  {
    n: "5",
    title: "Calculer le coût complet",
    text: "Prix d’adjudication estimé, frais, droits, honoraires, travaux, charges, portage (intérêts, taxe foncière et charges tant que le bien ne rapporte rien), délais, financement, fiscalité et imprévus.",
  },
  {
    n: "6",
    title: "Fixer une enchère plafond",
    text: "L’enchère plafond est la limite à ne pas dépasser. Elle doit être définie avant l’audience et respectée strictement.",
  },
];

const LEXIQUE: Array<{ term: string; def: string }> = [
  {
    term: "Adjudicataire",
    def: "Personne qui remporte la vente et devient acquéreur du bien, sous réserve des suites de la procédure.",
  },
  {
    term: "Adjudication",
    def: "Attribution du bien au meilleur enchérisseur à l’issue de l’audience.",
  },
  {
    term: "Avocat poursuivant",
    def: "Avocat qui conduit la procédure pour le compte du créancier ou de la partie à l’origine de la vente.",
  },
  {
    term: "Cahier des conditions de vente",
    def: "Document juridique décrivant le bien, les règles de la vente, les conditions d’occupation, les diagnostics, les servitudes et les frais. Il se consulte au greffe ou auprès de l’avocat poursuivant.",
  },
  {
    term: "Consignation du prix",
    def: "Dépôt du prix de l’adjudication sur un compte séquestre ou à la Caisse des dépôts et consignations, après la vente, dans les deux mois de l’adjudication définitive (art. L. 322-9 et R. 322-56). À ne pas confondre avec la garantie remise avant d’enchérir.",
  },
  {
    term: "Débiteur saisi",
    def: "Personne dont le bien est vendu pour payer ses dettes. Il ne peut pas enchérir (art. R. 322-39).",
  },
  {
    term: "Débours",
    def: "Sommes qu’un professionnel (avocat, notaire) avance pour votre compte, par exemple des droits ou des frais de formalités, et qu’il vous refacture au réel.",
  },
  {
    term: "Droit de préemption",
    def: "Droit, pour la commune ou un autre titulaire prévu par la loi, d’acquérir en priorité un bien situé dans un périmètre déterminé. Lorsque l’adjudication est autorisée ou ordonnée par un juge, il s’exerce par substitution à l’adjudicataire, au prix de la dernière enchère ou de la surenchère, dans les trente jours de l’adjudication (art. L. 213-1 et R. 213-15 du Code de l’urbanisme).",
  },
  {
    term: "Émoluments",
    def: "Rémunération des avocats fixée par un barème réglementaire et proportionnelle au prix d’adjudication (art. A. 444-191 du Code de commerce). Elle est distincte des honoraires, librement convenus avec l’avocat.",
  },
  {
    term: "Enchère plafond",
    def: "Montant maximum à ne pas dépasser, calculé à partir du marché, des frais, des travaux, des risques et de la stratégie de l’acheteur.",
  },
  {
    term: "Frais taxés",
    def: "Frais de la procédure dont le juge a fixé le montant et qui sont annoncés avant l’ouverture des enchères (art. R. 322-42). L’adjudicataire les paie en plus du prix.",
  },
  {
    term: "Garantie pour enchérir",
    def: "Chèque de banque ou caution bancaire irrévocable remis à l’avocat avant les enchères : 10\u00a0% de la mise à prix, avec un minimum de 3\u202f000\u00a0€ en saisie immobilière (art. R. 322-41). Elle est restituée à l’enchérisseur qui ne gagne pas.",
  },
  {
    term: "Jouissance",
    def: "Droit d’utiliser le bien, de l’occuper ou d’en percevoir les loyers. La date à laquelle l’acquéreur en dispose dépend notamment de l’occupation et du cahier des conditions de vente.",
  },
  {
    term: "Mise à prix",
    def: "Prix de départ de la vente aux enchères. Elle ne doit pas être confondue avec la valeur réelle du bien.",
  },
  {
    term: "Portage",
    def: "Coûts supportés tant que le bien ne sert pas ou ne rapporte rien : intérêts d’emprunt, taxe foncière, charges, assurance.",
  },
  {
    term: "Réitération des enchères",
    def: "Remise en vente du bien lorsque l’adjudicataire ne paie pas le prix ou les frais dans les délais (art. R. 322-66 et suivants). L’adjudicataire défaillant peut devoir la différence de prix.",
  },
  {
    term: "Saisie immobilière",
    def: "Procédure permettant à un créancier de faire vendre un bien immobilier afin d’obtenir le paiement d’une dette.",
  },
  {
    term: "Séquestre",
    def: "Tiers désigné par le cahier des conditions de vente pour détenir le prix en attendant sa répartition entre les créanciers.",
  },
  {
    term: "Surenchère",
    def: "Offre supérieure d’au moins un dixième du prix principal, formée dans les dix jours qui suivent l’adjudication en saisie immobilière, entraînant une nouvelle audience (art. R. 322-50 et R. 322-51).",
  },
  {
    term: "Tantièmes",
    def: "Part de parties communes attachée à chaque lot d’une copropriété, qui sert notamment à répartir les charges.",
  },
  {
    term: "Titre de vente",
    def: "Document qui prouve la propriété de l’adjudicataire : l’expédition du cahier des conditions de vente, suivie du jugement d’adjudication (art. R. 322-61).",
  },
  {
    term: "Titre opposable",
    def: "Droit, par exemple un bail, que l’acheteur doit respecter. Le titre d’expulsion issu du jugement vise le saisi et les occupants de son chef sans droit opposable, pas un locataire dont le bail s’impose à l’acheteur (art. R. 322-64).",
  },
  {
    term: "Vente à la barre",
    def: "Expression couramment utilisée pour désigner une vente aux enchères judiciaires devant le tribunal.",
  },
];

const INSTITUTIONAL_LINKS: Array<{ href: string; label: string }> = [
  {
    href: "https://www.service-public.gouv.fr/particuliers/vosdroits/F16987",
    label: "Service-Public.fr — Saisie immobilière",
  },
  {
    href: "https://www.legifrance.gouv.fr/codes/section_lc/LEGITEXT000025024948/LEGISCTA000025939111/",
    label: "Légifrance — Code des procédures civiles d'exécution, vente par adjudication",
  },
  {
    href: "https://www.legifrance.gouv.fr/codes/id/LEGISCTA000025939177",
    label: "Légifrance — Surenchère",
  },
  {
    href: "https://www.justice.fr/",
    label: "Justice.fr — Portail officiel du ministère de la Justice",
  },
  { href: "https://www.cnb.avocat.fr/", label: "Conseil national des barreaux" },
  {
    href: "https://commissaire-justice.fr/",
    label: "Chambre nationale des commissaires de justice",
  },
  {
    href: "https://consignations.caissedesdepots.fr/professionnel-du-droit/difficultes-financieres/saisie-immobiliere",
    label: "Caisse des Dépôts — Saisie immobilière et consignations",
  },
  {
    href: "https://www.notaires.fr/fr/immobilier-fiscalite/vente-rapide/les-ventes-aux-encheres-immobilieres-notariales",
    label: "Notaires de France — Ventes aux enchères immobilières notariales",
  },
];

const RELATED_SLUGS = [
  "ventes-notariales-domaniales-differences-tribunal",
  "saisie-immobiliere-etapes-vente-forcee-acheteur",
  "licitation-vente-bien-indivis-encheres-acheteur",
  "lire-cahier-conditions-vente-preparer-visite",
  "avocat-obligatoire-encherir-tribunal-choisir-mandat-cout",
  "jour-audience-encheres-role-avocat",
  "apres-adjudication-surenchere-paiement-titre-vente",
  "frais-vente-encheres-judiciaire",
  "financer-achat-encheres-pret-delais",
  "acheter-bien-occupe-encheres",
  "prix-plafond-encheres-immobilieres",
  "analyser-opportunite-encheres",
  "immeuble-rapport-encheres",
  "droit-de-preemption-encheres-commune-acheteur",
  "garantie-10-pourcent-cheque-banque-caution-encheres",
  "copropriete-encheres-charges-assemblees",
] as const;

/**
 * Frise de la procédure. Les descriptions reprennent ce que le guide dit plus bas (sections
 * « Comment se déroule une vente… » et « Quels frais prévoir… »), sans règle nouvelle.
 * « Remettre la garantie » désigne la garantie remise à l'avocat avant les enchères (art.
 * R. 322-41), pas la consignation du prix, qui se fait après la vente (voir le lexique) : le
 * titre évite le verbe « consigner » pour ne pas confondre les deux.
 */
const PROCEDURE_STEPS: Array<{ title: string; text: string; href: string }> = [
  {
    title: "Visiter",
    text: "Les visites sont généralement organisées avant l’audience, souvent avec un commissaire de justice.",
    href: "#visite",
  },
  {
    title: "Remettre la garantie",
    text: "Remettre à l’avocat, avant les enchères, la garantie (chèque de banque ou caution bancaire irrévocable) : 10 % de la mise à prix, avec un minimum de 3 000 € en saisie immobilière (art. R. 322-41). Elle est restituée si vous ne gagnez pas.",
    href: "#garanties",
  },
  {
    title: "Enchérir",
    text: "À l’audience, les enchères sont portées par l’avocat, qui ne peut porter qu’un seul mandat.",
    href: "#audience",
  },
  {
    title: "Surenchère possible (10 jours)",
    text: "En saisie immobilière, une surenchère d’au moins un dixième du prix principal peut être formée dans les 10 jours qui suivent l’adjudication.",
    href: "#apres-adjudication",
  },
  {
    title: "Payer",
    text: "Le prix est versé ou consigné, et les frais payés, dans les deux mois qui suivent l’adjudication définitive.",
    href: "#apres-adjudication",
  },
];

/**
 * Encadrés « À retenir » du début des grandes parties : chaque ligne reprend une phrase ou une
 * règle déjà énoncée plus bas dans la même partie.
 */
const KEY_POINTS = {
  deroulement: [
    "La vente se déroule en trois temps : l’analyse avant la vente, l’audience d’adjudication, puis les formalités après l’enchère.",
    "Pour enchérir, il faut être représenté par un avocat inscrit au barreau du tribunal compétent : l’acheteur ne porte pas lui-même les enchères.",
    "Le Code impose de remettre à l’avocat, avant les enchères, une garantie de 10 % de la mise à prix, avec un minimum de 3 000 €.",
    "En saisie immobilière, une surenchère d’au moins un dixième du prix principal peut être formée dans les 10 jours qui suivent l’adjudication : l’adjudication n’est définitive qu’à l’expiration de ce délai.",
  ],
  frais: [
    "Le budget d’une vente judiciaire ne doit jamais être limité au prix d’adjudication.",
    "Les frais de poursuite taxés et les droits de mutation se paient en plus du prix.",
    "Les émoluments des avocats sont fixés par un barème ; les honoraires sont librement convenus avec l’avocat.",
    "Travaux, portage et marge de sécurité entrent aussi dans le coût complet.",
  ],
  risques: [
    "Une mise à prix basse ne garantit pas une bonne affaire.",
    "Une servitude, une occupation, une procédure en cours, une copropriété fragile ou un diagnostic défavorable peuvent modifier fortement la valeur du bien.",
    "Il n’y a pas de condition suspensive d’obtention de prêt : si le financement n’est pas sécurisé, l’adjudicataire peut se retrouver dans l’incapacité de payer le prix.",
    "En audience, la concurrence peut pousser à dépasser son enchère plafond : c’est ce qu’il faut éviter.",
  ],
} as const;

/** Index A–Z du lexique : la première entrée de chaque lettre présente, dans l'ordre du lexique. */
const LEXIQUE_INDEX: Array<{ letter: string; anchor: string }> = LEXIQUE.reduce<
  Array<{ letter: string; anchor: string }>
>((index, entry) => {
  const letter = lexiqueSlug(entry.term).charAt(0).toUpperCase();
  if (!index.some((item) => item.letter === letter)) {
    index.push({ letter, anchor: lexiqueAnchor(entry.term) });
  }
  return index;
}, []);

const FAQ_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  dateModified: GUIDE_LAST_UPDATED,
  mainEntity: FAQ.map((item) => ({
    "@type": "Question",
    name: item.q,
    acceptedAnswer: { "@type": "Answer", text: item.a },
  })),
};

export function ResourcesPage() {
  return (
    <main id="contenu" className="liquid-page min-h-screen bg-background pb-24 text-foreground">
      <CloudBackgroundPreload />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdString(FAQ_JSON_LD) }}
      />

      <article className="mx-auto max-w-5xl px-4 pt-10 sm:px-6">
        <Link
          href="/ressources"
          className="mb-6 inline-flex text-sm text-gold-text underline underline-offset-4"
        >
          ← Tous les articles du blog
        </Link>
        {/* ── Hero ─────────────────────────────────────────────────────── */}
        <header className="glass-shell rounded-lg p-6 sm:p-9">
          <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-gold-text">
            Immojudis · Ressources ventes judiciaires
          </p>
          <h1 className="mt-4 max-w-3xl font-display text-4xl leading-[1.08] text-foreground sm:text-5xl md:text-6xl">
            Ventes immobilières judiciaires : trouvez, analysez et décidez avant d'enchérir
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
            Acheter un bien lors d'une vente immobilière judiciaire peut être une opportunité. Mais
            ce n'est jamais un achat immobilier classique. Avant d'enchérir, il faut comprendre la
            procédure, lire les pièces, évaluer les risques, intégrer les frais et fixer une limite
            à ne pas dépasser.
          </p>
          <p className="mt-4 text-xs text-muted-foreground">
            Mis à jour le{" "}
            <time dateTime={GUIDE_LAST_UPDATED}>{formatGuideDate(GUIDE_LAST_UPDATED)}</time>
            <span aria-hidden> · </span>
            <span data-reading-time>Temps de lecture : environ {GUIDE_READING_MINUTES} min</span>
          </p>

          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            <IntroCard title="Annonces centralisées">
              Repérez les ventes judiciaires à venir par localisation, tribunal, type de bien, date
              d'audience et mise à prix.
            </IntroCard>
            <IntroCard title="Analyse du dossier">
              Identifiez les éléments clés : occupation, cahier des conditions de vente,
              diagnostics, frais, travaux et contraintes.
            </IntroCard>
            <IntroCard title="Enchère plafond">
              Décidez avec méthode grâce à une approche en coût complet, intégrant les frais, les
              risques et la valeur de marché.
            </IntroCard>
          </div>
        </header>

        {/* ── Frise de la procédure ────────────────────────────────────── */}
        <section
          aria-labelledby="frise-procedure"
          className="liquid-panel mt-6 rounded-lg p-5 sm:p-6"
        >
          <h2 id="frise-procedure" className="font-display text-xl text-foreground">
            La vente à la barre du tribunal en 5 étapes
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Cette frise décrit une saisie immobilière jugée au tribunal. Chez un notaire ou pour une
            vente de l’État, les règles diffèrent : voir{" "}
            <a
              href="#differences"
              className="text-gold-text underline underline-offset-4 transition-colors hover:text-gold-text"
            >
              «&nbsp;Tribunal, notaire ou État : quelle différence&nbsp;?&nbsp;»
            </a>
            .
          </p>
          <ol className="mt-4 grid list-none gap-3 p-0 lg:grid-cols-5 lg:gap-4">
            {PROCEDURE_STEPS.map((step, index) => (
              <li
                key={step.title}
                className="liquid-panel-soft flex gap-3 rounded-lg p-4 lg:flex-col"
              >
                <span
                  aria-hidden
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-gold text-xs font-bold text-brand-navy"
                >
                  {index + 1}
                </span>
                <div>
                  <a
                    href={step.href}
                    className="text-base font-semibold text-foreground underline-offset-4 hover:text-gold-text hover:underline"
                  >
                    {step.title}
                  </a>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{step.text}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* ── Sommaire ─────────────────────────────────────────────────── */}
        <nav aria-labelledby="sommaire" className="liquid-panel mt-6 rounded-lg p-5 sm:p-6">
          <h2 id="sommaire" className="font-display text-xl text-foreground">
            Sommaire
          </h2>
          <ul className="mt-4 grid gap-x-8 gap-y-2 sm:grid-cols-2">
            {TOC.map((item) => (
              <li key={item.href}>
                <a
                  href={item.href}
                  className="text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-gold-text hover:underline"
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {/* ── Corps ────────────────────────────────────────────────────── */}
        <div className="mt-10 space-y-2">
          <Section id="differences" title="Tribunal, notaire ou État : quelle différence ?">
            <P>
              Immojudis ne se limite pas aux ventes au tribunal. Le catalogue rassemble les ventes
              judiciaires et les enchères notariales référencées ; les ventes domaniales disposent
              aussi de leur catégorie, selon les annonces disponibles.
            </P>
            <SaleTypesOverview detailed />
            <div className="mt-5 rounded-md border border-brand-navy/15 bg-white p-5">
              <h3 className="font-semibold text-brand-navy">
                Trois informations à ne pas confondre
              </h3>
              <ul className="mt-3 space-y-2 text-sm leading-relaxed text-brand-navy/80">
                <li>
                  <strong>L’organisateur :</strong> tribunal, office notarial ou organisme de
                  l’État.
                </li>
                <li>
                  <strong>Le cadre juridique :</strong> saisie, partage judiciaire, liquidation ou
                  vente volontaire, selon le dossier.
                </li>
                <li>
                  <strong>La participation :</strong> sur place, en ligne ou les deux. « En ligne »
                  n’est pas un type de vente.
                </li>
              </ul>
            </div>
            <P>
              Toutes les enchères ne sont donc pas judiciaires. Inversement, une vente organisée par
              un notaire peut avoir une origine judiciaire. Les règles de représentation, de
              garantie, de financement et de paiement doivent être vérifiées dans les conditions
              propres à la vente.
            </P>
            <P>
              Sources officielles :{" "}
              <Ext href="https://www.justice.fr/fiche/saisie-immobiliere">
                Justice.fr — saisie immobilière
              </Ext>
              ,{" "}
              <Ext href="https://www.immobilier.notaires.fr/fr/articles/conseils-et-actualites/achat-vente/les-ventes-aux-encheres-notariales">
                Notaires de France — enchères notariales
              </Ext>{" "}
              et{" "}
              <Ext href="https://www.economie.gouv.fr/particuliers/mes-droits-conso/bien-consommer/ventes-aux-encheres-publiques-vous-pouvez-y-participer">
                Ministère de l’Économie — ventes publiques
              </Ext>
              .
            </P>
            <P>La suite de ce guide détaille les ventes judiciaires à la barre du tribunal.</P>
          </Section>

          <Section id="definition" title="Qu'est-ce qu'une vente immobilière judiciaire ?">
            <P>
              Une vente immobilière judiciaire est une vente aux enchères d'un bien immobilier
              organisée dans un cadre judiciaire. Ce guide traite des ventes à la barre du tribunal,
              sous le contrôle du juge ; certaines ventes d’origine judiciaire sont organisées par
              un notaire.
            </P>
            <P>
              Le bien est attribué au plus offrant. Cette attribution s'appelle l'adjudication.
              L'acheteur qui remporte l'enchère devient l'adjudicataire, sous réserve notamment de
              l'absence de surenchère dans le délai légal.
            </P>
            <P>
              Les ventes judiciaires peuvent concerner de nombreux types de biens : appartement,
              maison, immeuble, local commercial, terrain, cave, parking, garage, lot de copropriété
              ou actif immobilier issu d'une procédure collective.
            </P>
            <P>
              Contrairement à une vente classique, l'acheteur ne signe pas un compromis avec un
              vendeur. Il participe à une procédure encadrée, avec des règles strictes, des délais
              courts et des conséquences importantes en cas de mauvaise préparation.
            </P>
            <P>
              Pour consulter le cadre général de la saisie immobilière, vous pouvez vous référer à
              la page officielle de Service-Public :{" "}
              <Ext href="https://www.service-public.gouv.fr/particuliers/vosdroits/F16987">
                Saisie immobilière – Service-Public.fr
              </Ext>
              .
            </P>
          </Section>

          <Section id="origine" title="Pourquoi un bien est-il vendu aux enchères judiciaires ?">
            <P>
              Un bien immobilier peut être vendu judiciairement dans plusieurs situations. La plus
              connue est la saisie immobilière. Lorsqu'un débiteur ne paie pas sa dette, un
              créancier peut engager une procédure visant à faire vendre le bien afin de récupérer
              tout ou partie des sommes dues.
            </P>
            <P>
              Une vente judiciaire peut aussi intervenir dans le cadre d'une liquidation judiciaire,
              d'un partage judiciaire entre indivisaires, d'une succession conflictuelle, d'un
              divorce ou d'une décision de justice ordonnant la vente d'un immeuble.
            </P>
            <P>
              Dans tous les cas, l'acheteur doit comprendre que la vente est liée à une procédure.
              Cela explique la présence du tribunal, des avocats, du greffe, du commissaire de
              justice et de documents juridiques spécifiques.
            </P>
          </Section>

          <Section id="immojudis" title="Immojudis : décider avant d'enchérir">
            <P>
              Immojudis est conçu pour les acheteurs qui veulent aller plus loin qu'une simple
              annonce. Une annonce de vente judiciaire donne des informations de base : adresse du
              bien, mise à prix, date d'audience, tribunal compétent, avocat poursuivant, modalités
              de visite. Mais elle ne suffit pas pour décider.
            </P>
            <P>
              Ce qui compte réellement, c'est l'analyse du dossier. Immojudis aide à structurer
              cette analyse autour de plusieurs questions essentielles.
            </P>
            <Checklist
              items={[
                "Le bien est-il libre ou occupé ?",
                "Le cahier des conditions de vente mentionne-t-il des servitudes, contraintes, charges ou particularités ?",
                "Les diagnostics révèlent-ils des risques techniques ?",
                "Le procès-verbal descriptif permet-il d'identifier des travaux importants ?",
                "La mise à prix est-elle réellement attractive par rapport au marché local ?",
                "Quel budget total faut-il prévoir après frais, travaux et marge de sécurité ?",
                "Quelle est l’enchère plafond à ne pas dépasser pour que l’opération reste rationnelle ?",
              ]}
            />
            <Callout>
              L'enjeu est simple : ne pas enchérir parce que la mise à prix semble basse, mais parce
              que le dossier a été lu, compris et chiffré.
            </Callout>
          </Section>

          <Section id="recherche" title="Comment trouver une vente immobilière judiciaire ?">
            <P>
              Les ventes immobilières judiciaires font l'objet de publicités obligatoires. Elles
              peuvent être publiées dans des journaux d'annonces légales, affichées au tribunal,
              relayées par des avocats, par certains sites spécialisés ou par des plateformes de
              référencement.
            </P>
            <P>
              En pratique, l'information est souvent fragmentée. Une vente peut être connue
              localement, mais difficile à repérer pour un acheteur qui surveille plusieurs
              départements ou plusieurs tribunaux.
            </P>
            <P>
              Immojudis centralise les annonces et facilite la recherche par critères :
              localisation, tribunal, date d'audience, type de bien, mise à prix, surface,
              occupation ou niveau de risque.
            </P>
            <P>
              L'objectif est de permettre une veille efficace sur les ventes judiciaires à venir,
              sans perdre de temps à consulter manuellement des sources dispersées.
            </P>
          </Section>

          <Section id="deroulement" title="Comment se déroule une vente immobilière judiciaire ?">
            <P>
              La vente immobilière judiciaire se déroule en trois temps : l'analyse avant la vente,
              l'audience d'adjudication, puis les formalités après l'enchère.
            </P>
            <KeyPoints part="déroulement" items={KEY_POINTS.deroulement} />

            <SubTitle>1. Avant la vente : analyser le dossier</SubTitle>
            <P>
              La phase préparatoire est la plus importante. C'est avant l'audience que se prépare la
              décision d'enchérir.
            </P>

            <SubTitle>Lire l'annonce de vente</SubTitle>
            <P>
              L'annonce permet d'identifier rapidement le bien et les principales informations
              pratiques : adresse, désignation sommaire, mise à prix, date et heure d'audience,
              tribunal, avocat poursuivant, visites, références du dossier.
            </P>
            <P>
              La mise à prix doit être interprétée avec prudence. Elle correspond au prix de départ
              des enchères, pas à la valeur de marché du bien. Une mise à prix faible peut attirer
              de nombreux enchérisseurs. Elle peut aussi traduire des contraintes : occupation,
              travaux lourds, procédure complexe, faible liquidité ou incertitude juridique.
            </P>

            <SubTitle>Consulter le cahier des conditions de vente</SubTitle>
            <P>
              Le cahier des conditions de vente est le document central d'une vente judiciaire. Il
              décrit le bien, les conditions de la vente, l'origine de propriété, les éventuelles
              servitudes, les inscriptions, les diagnostics, la situation d'occupation, les
              informations d'urbanisme, les frais et les règles applicables à l'adjudication.
            </P>
            <P>
              Il peut être consulté au greffe du tribunal judiciaire ou auprès de l'avocat
              poursuivant. Dans certains dossiers, des extraits ou documents associés peuvent être
              accessibles en ligne.
            </P>
            <P>
              Immojudis accorde une importance particulière à ce document, car il contient souvent
              les informations qui changent complètement la lecture d'une opportunité : bail en
              cours, occupation incertaine, procédure d'expulsion à prévoir, servitude, copropriété
              en difficulté, état du bien, contraintes de jouissance (la jouissance est le droit
              d’utiliser le bien et d’en percevoir les loyers) ou charges particulières. Pour une
              copropriété, repérez aussi les tantièmes, c’est-à-dire la part de parties communes
              attachée à chaque lot, qui sert notamment à répartir les charges.
            </P>
            <P>
              Notre article{" "}
              <ArticleLink slug="lire-cahier-conditions-vente-preparer-visite">
                Lire le cahier des conditions de vente et préparer la visite
              </ArticleLink>{" "}
              détaille la lecture rubrique par rubrique.
            </P>
            <P>
              Pour consulter les textes applicables à la vente par adjudication, vous pouvez vous
              référer à Légifrance :{" "}
              <Ext href="https://www.legifrance.gouv.fr/codes/section_lc/LEGITEXT000025024948/LEGISCTA000025939111/">
                Code des procédures civiles d'exécution – Vente par adjudication
              </Ext>
              .
            </P>

            <SubTitle>Étudier l'occupation du bien</SubTitle>
            <P>
              L'occupation est l'un des points les plus sensibles. Un bien peut être libre, loué,
              occupé par son propriétaire, occupé par un tiers, ou faire l'objet d'une situation peu
              claire.
            </P>
            <P>
              L'impact est majeur : délai de prise de possession, possibilité de louer, coût d'une
              procédure, décote à appliquer, stratégie de revente ou de travaux. Un appartement
              occupé avec un bail opposable (un droit que l’acheteur doit respecter) ne se valorise
              pas comme un appartement libre.
            </P>
            <P>
              Le jugement d’adjudication constitue un titre d’expulsion contre le débiteur saisi
              (art. L. 322-13 du Code des procédures civiles d’exécution). L’adjudicataire peut
              aussi l’invoquer contre les occupants de son chef qui n’ont aucun droit opposable,
              après paiement du prix ou consignation et paiement des frais, sauf si le cahier
              prévoit le maintien dans les lieux du saisi (art. R. 322-64). Il ne vise pas un
              locataire dont le bail s’impose à l’acheteur. Voir{" "}
              <ArticleLink slug="acheter-bien-occupe-encheres">
                Acheter un bien occupé aux enchères
              </ArticleLink>
              .
            </P>
            <P>
              Avant toute enchère, il faut donc vérifier précisément la situation d'occupation dans
              les pièces du dossier, et ne pas se contenter d'une simple mention dans l'annonce.
            </P>

            <SubTitle id="visite">Visiter le bien</SubTitle>
            <P>
              Les visites sont généralement organisées avant l'audience, sur un ou plusieurs
              créneaux. Elles sont souvent collectives et encadrées par un commissaire de justice.
            </P>
            <P>
              Il est fortement recommandé d'y assister. Les photos et descriptifs ne suffisent pas.
              Lors de la visite, il faut observer l'état général, les travaux visibles, les
              installations, les traces d'humidité, la luminosité, les accès, les parties communes,
              le voisinage immédiat et les contraintes pratiques.
            </P>
            <P>
              Pour les biens à rénover, il peut être utile de se faire accompagner par un
              professionnel du bâtiment. Une estimation trop optimiste des travaux peut transformer
              une enchère intéressante en mauvaise opération.
            </P>
            <P>
              Pour mieux comprendre le rôle des commissaires de justice, vous pouvez consulter le
              site institutionnel de la profession :{" "}
              <Ext href="https://commissaire-justice.fr/">
                Chambre nationale des commissaires de justice
              </Ext>
              .
            </P>

            <SubTitle>Évaluer le marché local</SubTitle>
            <P>
              Une vente judiciaire doit être comparée au marché réel. La bonne question n'est pas :
              « la mise à prix est-elle basse ? » mais : « à quel prix total ce bien reste-t-il
              intéressant, compte tenu des frais, travaux et risques ? »
            </P>
            <P>
              Immojudis raisonne en coût complet. Le prix d'adjudication n'est qu'un élément du
              calcul. Il faut ajouter les frais préalables (ou frais taxés, dont le juge a fixé le
              montant), droits de mutation, émoluments (la rémunération tarifée des avocats),
              honoraires d’avocat, frais de publication, débours (les sommes que l’avocat avance
              pour votre compte), travaux, charges, portage (intérêts, taxe foncière et charges tant
              que le bien ne rapporte rien), financement et marge de sécurité.
            </P>
            <P>
              Cette approche permet de fixer une enchère plafond rationnelle avant l’audience. Voir{" "}
              <ArticleLink slug="prix-plafond-encheres-immobilieres">
                Fixer son enchère plafond : raisonner par le coût complet avant d’enchérir
              </ArticleLink>
              .
            </P>

            <SubTitle>Préparer le financement</SubTitle>
            <P>
              L'achat aux enchères judiciaires ne fonctionne pas comme une vente classique avec
              condition suspensive d'obtention de prêt. Si vous remportez l'enchère, vous êtes
              engagé.
            </P>
            <P>
              Il est donc nécessaire de sécuriser son financement avant l'audience : accord bancaire
              solide, apport disponible, capacité à payer les frais et délai de déblocage compatible
              avec les exigences de la procédure.
            </P>
            <P>
              Un refus de prêt après adjudication ne permet pas de se désengager simplement. Le
              défaut de paiement entraîne la remise en vente du bien et peut coûter la garantie
              versée avant l’audience ainsi que la différence de prix (art. L. 322-12 et R. 322-41).
              Voir{" "}
              <ArticleLink slug="financer-achat-encheres-pret-delais">
                Financer un achat aux enchères : prêt, délais, pas de condition suspensive
              </ArticleLink>
              .
            </P>

            <SubTitle>Être représenté par un avocat</SubTitle>
            <P>
              Pour enchérir lors d'une vente immobilière judiciaire, l'acheteur doit être représenté
              par un avocat inscrit au barreau du tribunal compétent, qui ne peut porter qu’un seul
              mandat (art. R. 322-40). L’acheteur ne porte pas lui-même les enchères.
            </P>
            <P>
              Avant l'audience, l'avocat prépare le pouvoir d'enchérir, vérifie les garanties
              financières, porte les enchères à la barre et accompagne l'adjudicataire dans les
              formalités après la vente.
            </P>
            <P>
              Pour trouver un avocat ou vérifier les informations institutionnelles relatives à la
              profession, vous pouvez consulter le site du Conseil national des barreaux :{" "}
              <Ext href="https://www.cnb.avocat.fr/">Conseil national des barreaux</Ext>.
            </P>

            <SubTitle id="garanties">Prévoir les garanties et frais avant l'audience</SubTitle>
            <P>
              Avant de porter les enchères, l’avocat se fait remettre par son client, contre
              récépissé, une garantie : une caution bancaire irrévocable ou un chèque de banque
              représentant 10&nbsp;% de la mise à prix, avec un minimum de 3&#8239;000&nbsp;€. C’est
              le Code des procédures civiles d’exécution qui l’impose (art. R. 322-41) ; le cahier
              des conditions de vente précise seulement à l’ordre de qui le chèque est rédigé
              (séquestre ou Caisse des dépôts). Pour un immeuble d’habitation, l’avocat reçoit aussi
              une attestation sur l’honneur (art. R. 322-41-1).
            </P>
            <P>
              Ces éléments doivent être préparés avant l’audience. Sans dossier complet, l’avocat ne
              pourra pas porter les enchères. La garantie est restituée à l’enchérisseur qui ne
              gagne pas.
            </P>
            <P>
              Le détail des autres frais doit être demandé à l’avocat. Il est indispensable de les
              intégrer dans l’enchère plafond (voir la section « Quels frais prévoir ? » plus bas).
            </P>

            <SubTitle id="audience">2. Le jour de l'audience : enchérir au tribunal</SubTitle>
            <P>
              L'audience d'adjudication se tient au tribunal judiciaire. Elle est publique, mais les
              enchères sont portées par les avocats.
            </P>
            <P>
              Le juge rappelle la vente, la mise à prix et les éléments essentiels du dossier. Les
              avocats portent ensuite les enchères pour leurs clients. Chaque enchère engage
              l'enchérisseur.
            </P>
            <P>
              Les enchères sont arrêtées lorsque quatre-vingt-dix secondes se sont écoulées depuis
              la dernière : celle-ci emporte l’adjudication (art. R. 322-45). Le dernier
              enchérisseur est déclaré adjudicataire.
            </P>
            <P>
              Pour un premier achat, il peut être utile d'assister à une audience sans enchérir.
              Cela permet de comprendre le rythme, la procédure, le rôle des avocats et l'ambiance
              de la salle de vente. Voir{" "}
              <ArticleLink slug="jour-audience-encheres-role-avocat">
                Le jour de l’audience : déroulé et rôle de l’avocat
              </ArticleLink>
              .
            </P>

            <SubTitle id="apres-adjudication">
              3. Après l'adjudication : surenchère, paiement et propriété
            </SubTitle>
            <P>
              Remporter l'audience ne signifie pas toujours que l'achat est immédiatement définitif.
            </P>
            <P>
              Après l’adjudication, une surenchère peut être formée dans le délai légal de dix
              jours. Elle doit respecter les conditions prévues par les textes, notamment être
              déposée par acte d’avocat au greffe du juge de l’exécution et porter sur au moins un
              dixième du prix principal (art. R. 322-50 et R. 322-51). La surenchère du dixième dans
              les dix jours est une règle légale en saisie immobilière et en licitation judiciaire
              (art. 1377 et 1279 du CPC ; devant notaire, elle se forme par requête au greffe, art.
              1280). Dans une vente notariale volontaire, elle n’est pas prévue par la loi : seul le
              cahier des charges peut la prévoir (Notaires de France décrit 10&nbsp;% dans les 10
              jours pour la vente « à la bougie »). Dans une vente domaniale, tout dépend du cahier
              des charges. Lisez-le avant d’enchérir.
            </P>
            <P>
              Vous pouvez consulter le texte officiel sur Légifrance :{" "}
              <Ext href="https://www.legifrance.gouv.fr/codes/id/LEGISCTA000025939177">
                Code des procédures civiles d'exécution – Surenchère
              </Ext>
              .
            </P>
            <P>
              Si aucune surenchère n'est formée, l'adjudication devient définitive. L'adjudicataire
              doit alors payer le prix et les frais dans les délais prévus.
            </P>
            <P>
              Dans le cadre d’une vente forcée, l’adjudicataire verse le prix sur un compte
              séquestre ou le consigne auprès de la Caisse des dépôts et consignations (art. L.
              322-9). Si le prix ou les frais ne sont pas payés dans les délais, le bien est remis
              en vente : c’est la réitération des enchères, et l’adjudicataire défaillant peut
              devoir la différence de prix (art. L. 322-12). Pour plus d’informations, consultez la
              page officielle :{" "}
              <Ext href="https://consignations.caissedesdepots.fr/professionnel-du-droit/difficultes-financieres/saisie-immobiliere">
                Caisse des Dépôts – Saisie immobilière et consignations
              </Ext>
              .
            </P>
            <P>
              Le titre de vente réunit le cahier des conditions de vente, muni de la formule
              exécutoire, et le jugement d’adjudication transcrit à sa suite. Il est délivré par le
              greffe puis publié au fichier immobilier selon les formalités applicables. Voir les{" "}
              <Ext href="https://www.legifrance.gouv.fr/codes/section_lc/LEGITEXT000025024948/LEGISCTA000025939111/">
                articles R. 322-61 à R. 322-63 du Code des procédures civiles d’exécution
              </Ext>{" "}
              et l’article{" "}
              <ArticleLink slug="apres-adjudication-surenchere-paiement-titre-vente">
                Après l’adjudication : surenchère, paiement, consignation et titre de vente
              </ArticleLink>
              .
            </P>

            <SubTitle>Ce qui vous engage quand vous enchérissez</SubTitle>
            <P>
              Une enchère n'est pas un simple essai. Avant d'enchérir, retenez ces règles qui
              s'imposent à l'acheteur :
            </P>
            <Checklist
              items={[
                "en saisie immobilière, une surenchère d’au moins un dixième du prix principal peut être formée dans les 10 jours qui suivent l’adjudication : l’adjudication n’est définitive qu’à l’expiration de ce délai ;",
                "le Code impose de remettre à l’avocat, avant les enchères, une garantie de 10\u00a0% de la mise à prix, avec un minimum de 3\u202f000\u00a0€, sous forme de chèque de banque ou de caution bancaire irrévocable (art. R. 322-41) ;",
                "le prix doit être versé ou consigné dans les deux mois qui suivent l’adjudication définitive ; au-delà, des intérêts sont dus (art. R. 322-56) ;",
                "les frais de poursuite taxés et les droits de mutation se paient en plus du prix, dans le même délai fixé par le Code : le justificatif doit être remis au greffe avant l’expiration de deux mois à compter de l’adjudication définitive (art. R. 322-58) ;",
                "l’avocat qui porte les enchères doit être inscrit au barreau du tribunal judiciaire où se tient la vente (art. R. 322-40).",
              ]}
            />
            <P>
              Ces règles résument les textes consultés le 13/10/2026. Elles ne remplacent pas le
              cahier des conditions de vente du dossier ni l'avis de votre avocat, qui confirmera
              les montants et les délais de votre vente.
            </P>
          </Section>

          <Section id="frais" title="Quels frais prévoir lors d'une vente immobilière judiciaire ?">
            <KeyPoints part="frais" items={KEY_POINTS.frais} />
            <P>
              Le budget d'une vente judiciaire ne doit jamais être limité au prix d'adjudication. Il
              faut généralement prévoir :
            </P>
            <Checklist
              items={[
                "les frais préalables de vente ;",
                "les droits de mutation ;",
                "les émoluments ;",
                "les frais de publication ;",
                "les honoraires de l'avocat ;",
                "les frais de financement ;",
                "les charges de copropriété éventuellement dues ;",
                "les travaux ;",
                "les frais liés à l'occupation ou à la libération du bien ;",
                "une marge de sécurité.",
              ]}
            />
            <P>
              Trois termes à connaître : les frais taxés sont ceux dont le juge a fixé le montant
              avant les enchères ; les émoluments sont la rémunération des avocats fixée par un
              barème ; les débours sont les sommes que l’avocat avance pour votre compte et vous
              refacture au réel. Le détail, avec des ordres de grandeur datés et à vérifier, figure
              dans l’article{" "}
              <ArticleLink slug="frais-vente-encheres-judiciaire">
                Frais d’une vente aux enchères judiciaire
              </ArticleLink>
              .
            </P>
            <P>
              Pour chiffrer ces frais selon votre département, essayez le{" "}
              <Link
                href="/simulateur-frais-encheres"
                className="text-gold-text underline underline-offset-4 transition-colors hover:text-gold-text"
              >
                simulateur de frais d’enchères
              </Link>
              .
            </P>
            <P>
              Immojudis met l'accent sur cette logique de coût complet. Un bien adjugé sous le prix
              du marché peut rester une mauvaise opération si les frais, travaux ou délais de
              libération sont sous-estimés.
            </P>
          </Section>

          <Section
            id="avantages"
            title="Quels sont les avantages des ventes immobilières judiciaires ?"
          >
            <P>
              Les ventes immobilières judiciaires peuvent donner accès à des biens peu visibles sur
              le marché classique. Certaines ventes présentent une mise à prix attractive, des biens
              à rénover, des emplacements recherchés ou des opportunités adaptées à une stratégie
              d'investissement.
            </P>
            <P>
              La procédure est publique et encadrée. Tous les enchérisseurs participent selon les
              mêmes règles. Le prix final se forme en audience, par confrontation directe entre les
              offres.
            </P>
            <P>
              Pour un investisseur préparé, ce marché peut donc offrir des opportunités. Mais la
              préparation doit être méthodique.
            </P>
          </Section>

          <Section id="risques" title="Quels sont les risques ?">
            <KeyPoints part="risques" items={KEY_POINTS.risques} />
            <P>
              Les risques sont réels. Le premier risque est de se focaliser sur la mise à prix. Une
              mise à prix basse ne garantit pas une bonne affaire.
            </P>
            <P>
              Le deuxième risque est de mal lire le dossier. Une servitude, une occupation, une
              procédure en cours, une copropriété fragile ou un diagnostic défavorable peuvent
              modifier fortement la valeur du bien.
            </P>
            <P>
              Le troisième risque est financier. Si le financement n'est pas sécurisé,
              l'adjudicataire peut se retrouver dans l'incapacité de payer le prix.
            </P>
            <P>
              Le quatrième risque concerne les travaux. Une visite rapide ne permet pas toujours
              d'identifier précisément le coût de remise en état.
            </P>
            <P>
              Le cinquième risque est émotionnel. En audience, la concurrence peut pousser à
              dépasser son enchère plafond. C'est précisément ce qu'il faut éviter.
            </P>
            <Callout>
              Immojudis a été pensé pour aider à repérer ces risques en donnant une lecture
              structurée du dossier avant l'enchère ; il ne les supprime pas.
            </Callout>
          </Section>

          <Section id="methode" title="La méthode Immojudis pour analyser une vente judiciaire">
            <P>Pour chaque opportunité, l'analyse doit suivre une méthode rigoureuse.</P>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              {METHOD.map((step) => (
                <div key={step.n} className="liquid-panel-soft rounded-lg p-5">
                  <div className="flex items-center gap-2.5">
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-gold text-xs font-bold text-brand-navy">
                      {step.n}
                    </span>
                    <h3 className="text-base font-semibold text-foreground">{step.title}</h3>
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{step.text}</p>
                </div>
              ))}
            </div>
            <P className="mt-6">
              C'est le cœur de l'approche Immojudis : analyser, décider, enchérir — dans cet ordre.
            </P>
          </Section>

          <Section id="articles-associes" title="Pour aller plus loin : nos articles">
            <P>
              Chaque étape de ce guide a son article détaillé. Ils s’appuient sur des textes
              officiels et sont à confronter au cahier des conditions de vente de votre dossier.
            </P>
            <ul className="mt-4 grid gap-2.5">
              {RELATED_SLUGS.map((slug) => {
                const article = getResourceArticle(slug);
                return article ? (
                  <li key={slug}>
                    <ArticleLink slug={slug}>{article.title}</ArticleLink>
                  </li>
                ) : null;
              })}
            </ul>
          </Section>

          <Section id="lexique" title="Lexique des ventes immobilières judiciaires">
            <nav aria-label="Index alphabétique du lexique" className="mt-2">
              <ul className="flex flex-wrap gap-1.5">
                {LEXIQUE_INDEX.map((item) => (
                  <li key={item.letter}>
                    <a
                      href={`#${item.anchor}`}
                      className="grid h-8 w-8 place-items-center rounded-md border border-white/10 text-sm font-semibold text-gold-text transition-colors hover:bg-gold/10"
                    >
                      {item.letter}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
            <dl className="mt-4 divide-y divide-white/10 border-y border-white/10">
              {LEXIQUE.map((entry) => (
                <div key={entry.term} className="grid gap-1 py-4 sm:grid-cols-[14rem_1fr] sm:gap-6">
                  <dt
                    id={lexiqueAnchor(entry.term)}
                    className="scroll-mt-24 font-semibold text-foreground"
                  >
                    {entry.term}
                  </dt>
                  <dd className="text-sm leading-relaxed text-muted-foreground">{entry.def}</dd>
                </div>
              ))}
            </dl>
          </Section>

          <Section id="liens-institutionnels" title="Liens institutionnels utiles">
            <P>
              Pour compléter votre compréhension des ventes immobilières judiciaires, voici les
              principaux sites institutionnels à consulter.
            </P>
            <ul className="mt-4 grid gap-2.5">
              {INSTITUTIONAL_LINKS.map((link) => (
                <li key={link.href}>
                  <Ext href={link.href}>{link.label}</Ext>
                </li>
              ))}
            </ul>
          </Section>

          <Section id="faq" title="Questions fréquentes sur les ventes immobilières judiciaires">
            <div className="mt-2 divide-y divide-white/10 border-y border-white/10">
              {FAQ.map((item) => (
                <details key={item.q} className="group py-4">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-sm font-semibold text-foreground">
                    {item.q}
                    <span className="text-gold-text transition-transform group-open:rotate-45">
                      +
                    </span>
                  </summary>
                  <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{item.a}</p>
                </details>
              ))}
            </div>
          </Section>
        </div>

        {/* ── CTA ──────────────────────────────────────────────────────── */}
        <section className="liquid-panel relative mt-12 overflow-hidden rounded-lg p-7 sm:p-9">
          <span className="absolute -top-px left-9 h-px w-16 bg-gold" />
          <h2 className="font-display text-2xl text-foreground sm:text-3xl">
            Consultez les ventes judiciaires avec Immojudis
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Immojudis vous aide à repérer les ventes immobilières judiciaires, lire les informations
            utiles, identifier les risques et construire votre enchère plafond avant l'audience.
            Avant d'enchérir, ne vous arrêtez pas à la mise à prix : analysez le dossier, vérifiez
            l'occupation, estimez les frais, comparez le marché, sécurisez votre financement, fixez
            votre limite.
          </p>
          <Link
            href="/sales"
            className="liquid-button mt-6 inline-flex items-center gap-2 rounded-lg px-5 py-3 text-xs font-bold uppercase tracking-[0.18em] transition hover:brightness-105"
          >
            Accéder aux ventes référencées <ArrowRight className="h-4 w-4" />
          </Link>
        </section>
      </article>
    </main>
  );
}

function IntroCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    // Not a heading: these three cards sit between the h1 and the first h2 ("Sommaire"), and an
    // h3 there would skip a level in the outline of the page.
    <div className="liquid-panel-soft rounded-lg p-5">
      <p className="text-base font-semibold text-foreground">{title}</p>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{children}</p>
    </div>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 py-8">
      <header className="mb-4 flex items-baseline gap-4">
        <span className="liquid-hairline h-px w-8 shrink-0 translate-y-[-0.4rem]" />
        <h2 className="font-display text-2xl text-foreground sm:text-3xl">{title}</h2>
      </header>
      <div className="max-w-3xl">{children}</div>
    </section>
  );
}

function P({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={`mt-4 text-[15px] leading-relaxed text-muted-foreground ${className ?? ""}`}>
      {children}
    </p>
  );
}

function SubTitle({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <h3 id={id} className="mt-8 scroll-mt-24 text-lg font-semibold text-gold-text">
      {children}
    </h3>
  );
}

/** Encadré « À retenir » : 3 à 4 lignes qui reprennent ce que la partie dit plus bas. */
function KeyPoints({ part, items }: { part: string; items: readonly string[] }) {
  return (
    <div
      role="note"
      aria-label={`À retenir : ${part}`}
      data-key-points={part}
      className="mt-4 rounded-lg border-l-4 border-gold bg-gold/[0.07] px-5 py-4"
    >
      <p className="text-sm font-semibold uppercase tracking-[0.14em] text-gold-text">À retenir</p>
      <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-foreground">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function Checklist({ items }: { items: string[] }) {
  return (
    <ul className="mt-4 grid gap-2.5">
      {items.map((item) => (
        <li
          key={item}
          className="flex items-start gap-2.5 text-[15px] leading-relaxed text-muted-foreground"
        >
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-gold-text" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function Callout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-5 rounded-lg border-l-4 border-gold bg-gold/[0.07] px-5 py-4 text-[15px] leading-relaxed text-foreground">
      {children}
    </div>
  );
}

function ArticleLink({ slug, children }: { slug: string; children: React.ReactNode }) {
  return (
    <Link
      href={`/ressources/${slug}`}
      className="text-gold-text underline underline-offset-4 transition-colors hover:text-gold-text"
    >
      {children}
    </Link>
  );
}

function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-gold-text underline underline-offset-4 transition-colors hover:text-gold-text"
    >
      {children}
      <ExternalLink className="h-3 w-3 shrink-0" />
    </a>
  );
}
