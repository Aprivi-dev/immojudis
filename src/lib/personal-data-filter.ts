/**
 * Filtre déterministe des noms de personnes physiques dans les textes d'annonces.
 *
 * Miroir TypeScript de `services/data-pipeline/src/personal_data.py` : mêmes règles, mêmes cas
 * (`services/data-pipeline/tests/fixtures/personal_data_filter_cases.json`, exécutés par
 * `personal-data-filter.test.ts` et par pytest). Toute évolution se fait des deux côtés.
 *
 * Les annonces judiciaires nomment parfois un occupant, un locataire, un propriétaire ou un
 * créancier particulier (« occupés par Monsieur X suivant bail », « À la requête de Madame Y, née
 * le … à …, demeurant … »). Le filtre remplace le nom, la date et le lieu de naissance et l'adresse
 * personnelle par un rôle générique.
 *
 * - Il ne se déclenche qu'après une formule : « occupé(e)(s) par », « locataire », « bail consenti
 *   à », « loué à », « à la requête de », « appartenant à », « propriété de », « né(e) le … »,
 *   « demeurant / domicilié / résidant », « époux / épouse », « divorcé(e) », « veuf / veuve »,
 *   « née », « consorts », « héritiers de », « succession de ».
 * - Il ne retire jamais une commune, une rue, un tribunal, une étude notariale ni une société (SCI,
 *   SARL…) : un nom n'est reconnu qu'après une civilité (Monsieur, Mme, M.…) ou sous la forme
 *   « Prénom NOM » ou « NOM Prénom » (« DUPONT Pierre » : le prénom doit figurer dans la liste
 *   `FIRST_NAMES`, sans quoi « EDF Collectivités » ou « BNP Paribas » seraient pris pour des noms).
 * - Après un rôle (« le débiteur », « propriétaire », « vendeur »… suivi de `:`, d'une virgule ou
 *   d'un espace), le nom est retiré avec ou sans civilité (« Le saisi, Paul ROY, occupe… »), sauf si
 *   le mot qui suit est « Me », « Maître » ou un nom de bien (« propriétaire Local COMMERCIAL »).
 * - « À la requête de : Madame X » (deux-points) et « À la requête de la Mme X » sont reconnus.
 * - Le statut n'est jamais déduit : « occupé(e)(s) par <nom> » devient toujours « un occupant ». « Un
 *   locataire » n'apparaît que si la formule source le dit (« loué à <nom> », « bail consenti à
 *   <nom> », « locataire <nom> » : on remplace le nom, pas le rôle).
 * - Après « loué à » et « bail consenti à » seulement, un « Prénom Nom » en casse mixte est reconnu.
 * - Les contacts professionnels (« Me X, avocat, demeurant … ») ne sont pas touchés.
 * - Idempotent : filtrer un texte déjà filtré ne le change pas.
 *
 * Module pur (aucun import serveur) : utilisable côté serveur comme dans les tests.
 */

// --- Briques de motifs (identiques au miroir Python) --------------------------------------------
const UP = "A-ZÀ-ÖØ-ÞŒ";
const LOW = "a-zß-öø-ÿœ";
const L = "A-Za-zÀ-ÖØ-öø-ÿŒœ";
const SP = String.raw`[^\S\r\n]`; // espace sans retour à la ligne
const APOS = "['’]";
// Mots en capitales qui terminent un nom écrit tout en capitales (« DUPONT PIERRE SUIVANT BAIL »).
const STOP_UP =
  "SUIVANT|SELON|EN|AUX|AU|ET|OU|QUI|DONT|POUR|PAR|SUR|DANS|AVEC|SANS|BAIL|LOCATAIRE|LOCATAIRES" +
  "|PROPRIETAIRE|PROPRIÉTAIRE|DEMEURANT|NE|NÉ|NEE|NÉE|DIVORCE|DIVORCÉ|DIVORCEE|DIVORCÉE|EPOUSE|ÉPOUSE" +
  "|EPOUX|ÉPOUX|VEUF|VEUVE|OCCUPE|OCCUPÉ|OCCUPES|OCCUPÉS|DEPUIS|ACTUELLEMENT|DOMICILIE|DOMICILIÉ";
const NOT_STOP = `(?!(?:${STOP_UP})(?![${L}]))`;
const CAPW = `(?:[dDlLO]${APOS})?[${UP}][${LOW}]+(?:[-'’][${UP}]?[${LOW}]+)*(?![${L}])`;
const UPW = `(?:[dDlLO]${APOS})?[${UP}]{2,}(?:[-'’][${UP}]{2,})*(?![${L}])`;
const TOKEN = `(?:${UPW}|${CAPW})`;
const NOT_SENTENCE_START = `(?!(?:Le|La|Les|Un|Une|Il|Elle|Dans|Pour|Sur|Et|Ce|Cette)(?![${L}]))`;
// Mot suivant d'un nom : « Le Gall » est un nom, « Le bien est » commence une phrase.
const NEXT = `(?:(?:Le|La|Les)${SP}+${NOT_STOP}${TOKEN}|${NOT_SENTENCE_START}${NOT_STOP}${TOKEN})`;
const PARTICLE = `(?:de${SP}+la|de|du|des|d${APOS}|van|von|der|den|ben|el|al|di|da|dos|del|della)`;
const INITIAL = `[${UP}]\\.${SP}*`;
// Prénoms usuels (liste partagée mot pour mot avec `_FIRST_NAMES` du miroir Python ; un test compare
// les deux). Sert uniquement à reconnaître « NOM Prénom » (« DUPONT Pierre ») sans civilité : sans
// liste, tout « SIGLE Mot » (« EDF Collectivités », « BNP Paribas ») serait pris pour une personne.
// Un prénom absent de la liste n'est pas reconnu sans civilité ; il l'est après « Monsieur », « Mme »…
const FIRST_NAMES =
  "Marie Nathalie Isabelle Sylvie Catherine Françoise Martine Christine Monique Valérie " +
  "Sandrine Patricia Brigitte Nicole Véronique Annie Jacqueline Stéphanie Céline Chantal " +
  "Julie Sophie Anne Laurence Corinne Michèle Dominique Claire Florence Marguerite Danielle " +
  "Hélène Pascale Karine Béatrice Christiane Thérèse Odile Fabienne Sabrina Virginie " +
  "Aurélie Émilie Laetitia Nadia Samira Fatima Léa Camille Chloé Manon Emma Inès Sarah " +
  "Laura Lucie Marine Pauline Mélanie Delphine Agnès Colette Josette Paulette Yvette " +
  "Ginette Odette Simone Suzanne Denise Geneviève Évelyne Josiane Régine Maryse Muriel " +
  "Cécile Élodie Charlotte Audrey Alice Eva Lina Anaïs Juliette Mathilde Louise Jeanne " +
  "Madeleine Yvonne Raymonde Andrée Arlette Bernadette Liliane Gisèle Huguette Nadine Sonia " +
  "Amandine Magali Ghislaine Roselyne Rose Maud Élisabeth Lydie Carole Cathy Jessica Élise " +
  "Aline Alexandra Angélique Adeline Estelle Gaëlle Armelle Solange Mireille Marlène Noémie " +
  "Margaux Clémence Océane Morgane Lisa Anna Clara Zoé Jade Mona Leïla Yasmine Khadija " +
  "Aïcha Malika Naima Latifa Samia Houria Karima Rachida Ana Maria Carmen Rosa Isabel " +
  "Marion Roxane Justine Johanna Séverine Stella Vanessa Wendy Tiphaine Sylviane Reine Jean " +
  "Pierre Michel André Philippe René Louis Alain Jacques Bernard Marcel Daniel Roger Robert " +
  "Paul Claude Christian Henri Georges Nicolas François Patrick Gérard Christophe Joseph " +
  "Yves Éric Frédéric Laurent Stéphane David Pascal Olivier Thierry Sébastien Julien " +
  "Alexandre Maxime Thomas Antoine Mathieu Guillaume Romain Kevin Jérôme Franck Didier " +
  "Denis Gilles Serge Bruno Marc Luc Hervé Raymond Lucien Maurice Albert Fernand Gaston " +
  "Émile Roland Rémy Rémi Vincent Anthony Benoît Cédric Damien Fabrice Fabien Gaël Grégory " +
  "Jonathan Lionel Ludovic Mickaël Nathan Hugo Lucas Théo Enzo Ahmed Mohamed Mohammed Karim " +
  "Youssef Rachid Abdel Samir Hassan Omar Ali Mehdi Nabil Saïd Farid Manuel José Antonio " +
  "Carlos Miguel João Jorge Luis Paulo Giuseppe Mario Marco Stefano Gabriel Adrien Arnaud " +
  "Baptiste Bastien Clément Corentin Dylan Étienne Florian Jordan Léo Loïc Mathis Nolan " +
  "Quentin Raphaël Sylvain Tristan Valentin Victor Xavier Yann Yannick Régis Rodolphe " +
  "Gilbert Gérald Jocelyn Aimé Auguste Édouard Eugène Félix Léon Armand Alfred Noël Max Sam " +
  "Tom Jules Hubert Guy Francis Joël Jacky Jackie Thibault Thibaut Cyril Cyrille Dimitri " +
  "Mathias Matthieu Ibrahim Moussa Mamadou Abdelkader Mustapha Brahim Idriss Anis Amine " +
  "Bilal Yanis Bertrand Gaétan Géraud Josselin Maël Ronan Tanguy Erwan Gwenaël Hugues " +
  "Ludwig Sacha Ulysse Marius Aurélien Pierrick Johan Steven Teddy Stan Rodrigue Léopold " +
  "Basile";
const FIRST_NAME_FORMS = (() => {
  const forms = new Set<string>();
  for (const name of FIRST_NAMES.split(" ")) {
    const bare = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    for (const form of [name, bare]) {
      forms.add(form);
      forms.add(form.toUpperCase());
    }
  }
  return [...forms].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0)).join("|");
})();
// Un ou plusieurs prénoms de la liste, composés avec un trait d'union : « Jean-Pierre », « MARIE-CLAIRE ».
const FIRST_NAME = `(?:${FIRST_NAME_FORMS})(?:-(?:${FIRST_NAME_FORMS}))*(?![${L}])`;
// Prénom(s) puis NOM(S) en capitales : « Jean-Pierre DUPONT ».
const BARE_FORENAME_FIRST =
  `${CAPW}(?:${SP}+${CAPW}){0,2}${SP}+${NOT_STOP}${UPW}` +
  `(?:${SP}+(?:${PARTICLE}${SP}*)?${NOT_STOP}${UPW}){0,2}`;
// NOM(S) en capitales puis prénom(s) de la liste : « DUPONT Pierre », « DE LA FONTAINE Claire »,
// « DUPONT PIERRE ».
const BARE_SURNAME_FIRST =
  `${NOT_STOP}${UPW}(?:${SP}+(?:${PARTICLE}${SP}*)?${NOT_STOP}${UPW}){0,2}` +
  `${SP}+${FIRST_NAME}(?:${SP}+${FIRST_NAME}){0,2}`;
const BARE = `(?:${BARE_FORENAME_FIRST}|${BARE_SURNAME_FIRST})`;
const NAMESEQ = `(?:${INITIAL})*${TOKEN}(?:${SP}+(?:${PARTICLE}${SP}+)?${NEXT}){0,4}`;
const NAME_SINGLE = `${TOKEN}(?:${SP}+(?:${PARTICLE}${SP}+)?${NEXT}){0,2}`;
// « Pierre Martin » en casse mixte, sans civilité : deux à trois mots, jamais un début de phrase.
// N'est utilisé qu'après « loué à » et « bail consenti à » (`lease`).
const NAME_MIXED = `${NOT_SENTENCE_START}${NOT_STOP}${TOKEN}(?:${SP}+(?:${PARTICLE}${SP}+)?${NEXT}){1,2}`;
const CIV =
  `(?:(?:Monsieur|Madame|MONSIEUR|MADAME|M\\.|Mme)${SP}+(?:et|ou|ET|OU)${SP}+)?` +
  "(?:(?:Monsieur|Madame|Mademoiselle|Messieurs|Mesdames|MONSIEUR|MADAME|MADEMOISELLE|MESSIEURS|MESDAMES" +
  `|Mmes|Mme|MME|Mlle|MLLE|Melle|Mr|MM?)${SP}+|MM?\\.${SP}*)`;

/** Variante « collante » : `matchAt(regex, text, pos)` ne réussit qu'à la position `pos`. */
function sticky(source: string, flags = ""): RegExp {
  return new RegExp(source, `${flags}y`);
}

function matchAt(regex: RegExp, text: string, pos: number): RegExpExecArray | null {
  regex.lastIndex = pos;
  return regex.exec(text);
}

const PERSON_CIV = sticky(`${CIV}${NAMESEQ}`);
const PERSON_BARE = sticky(BARE);
const PERSON_SINGLE = sticky(NAME_SINGLE);
const PERSON_MIXED = sticky(NAME_MIXED);
const CIV_PREFIX = new RegExp(`^${CIV}`);
const ALIAS = sticky(
  `(?:${SP}*,)?${SP}*(?:née|épouse|époux|veuve|veuf|divorcée|divorcé)(?![${L}])${SP}+` +
    `(?:(?:de|d${APOS}|du)${SP}*)?`,
);
const SEPARATOR = sticky(
  `(?:${SP}*,${SP}*|${SP}+(?:et|ou|ainsi${SP}+que)${SP}+(?:(?:de|d${APOS})${SP}*)?)(?:(?:son|sa|ses|leurs?)` +
    `${SP}+(?:épouse|époux|compagne|compagnon|conjoint|conjointe)${SP}+)?`,
);
const LIST_SEPARATOR = sticky(`(?:${SP}*,${SP}*|${SP}+et${SP}+)`);

// Premiers mots qui ne commencent jamais un nom de personne (début de phrase, voies, saints…).
const STOP_FIRST = new Set(
  (
    "Un Une Ce Cette Ces Dans Pour Sur Et Il Elle Son Sa Ses Aux Au Du De Des Les Rue Avenue Boulevard Place " +
    "Impasse Chemin Route Allée Quai Cours Square Passage Saint Sainte Mont Port Grand Grande Val Ville Parc " +
    "Résidence Lotissement Bâtiment Hameau Immeuble Copropriété Cabinet Étude Maître Tribunal"
  ).split(" "),
);
const STOP_FIRST_SINGLE = new Set(
  [...STOP_FIRST].filter((word) => !["Du", "De", "Des"].includes(word)),
);
const ORG_RE = new RegExp(
  `(?<![${L}])(?:sci|sarl|sas|sasu|eurl|sa|snc|scp|selarl|selas|scm|sccv|sc|société|societe|banque|caisse` +
    "|crédit|credit|syndicat|association|commune|mairie|ville|département|departement|région|region|état|etat" +
    "|trésor|tresor|fonds|compagnie|mutuelle|cabinet|étude|etude|agence|foncière|fonciere|immobilière" +
    "|immobiliere|groupe|union|fédération|federation|communauté|communaute|métropole|metropole|office|centre" +
    "|établissement|etablissement|hôpital|hopital|copropriété|copropriete|copropriétaires|syndic|tribunal" +
    "|préfecture|prefecture|ministère|ministere|direction|service|services|administration|domaine|domaines" +
    "|finances|publiques|impôts|impots|urssaf|habitat|logement|logements|patrimoine|gestion|résidence" +
    `|residence|hotel|hôtel|restaurant|pharmacie|garage|france)(?![${L}])`,
  "i",
);
const TITLE_RE = new RegExp(
  `^(?:(?:le|la|les|du|des)${SP}+|l${APOS})(?:maire|préfet|préfète|prefet|procureur|directeur|directrice` +
    "|président|présidente|president|ministre|juge|syndic|receveur|trésorier|tresorier|comptable|notaire" +
    "|greffier|commissaire|huissier|liquidateur|mandataire|administrateur|gérant|gérante|gerant" +
    "|représentant|responsable|chef|délégué|delegue|conservateur|bâtonnier|secrétaire)" +
    `(?![${L}])`,
  "i",
);

const QUICK = new RegExp(
  "occup|locataire|bail|requête|requete|appartenant|appartien|propriété|propriete|\\bné|demeur|domicili" +
    "|résida|residan|époux|épouse|epou|divorc|veuf|veuve|\\bnée|consort|héritier|heritier|succession|loué|loue" +
    "|d[ée]biteur|saisi|propri[ée]taire|vendeur|bailleur|cr[ée]ancier|poursuivant|d[ée]fendeur|demandeur" +
    "|requ[ée]rant|int[ée]ress|indivisaire",
  "i",
);

const MONTHS =
  "janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre";
const DATE = `(?:\\d{1,2}(?:er)?${SP}+(?:${MONTHS})${SP}+\\d{4}|\\d{1,2}[/.\\-]\\d{1,2}[/.\\-]\\d{2,4})`;
const PLACE = sticky(
  `${SP}+(?:à|a|au|en)${SP}+(?:(?:Le|La|Les)${SP}+|L${APOS})?${TOKEN}` +
    `(?:(?:${SP}+|-)(?:(?:de|du|des|sur|sous|en|lès|aux|la|le|les)(?:${SP}+|-)|d${APOS})?` +
    `${NOT_STOP}${NOT_SENTENCE_START}${TOKEN}){0,4}` +
    `(?:${SP}+\\d{1,2}(?:er|e|ème))?(?:${SP}*\\([^)\\n]{1,20}\\))?`,
);
const PROFESSIONAL = new RegExp(
  `(?<![${L}])(?:ma[iî]tre|me|avocats?|notaires?|huissiers?|scp|selarl|cabinet|étude|etude)(?![${L}])`,
  "i",
);
const STREET_WORDS =
  "rue|avenue|av|boulevard|bd|bld|chemin|ch|impasse|imp|route|rte|allée|allee|place|pl|quai|cours|passage" +
  "|square|lotissement|résidence|residence|hameau|lieu-dit|lieudit|bâtiment|batiment|bât|bat|appartement" +
  "|app|apt|étage|etage|escalier|esc|villa|cité|cite|domaine|faubourg|fg|mail|parvis|sentier|traverse" +
  "|zone|zac|cedex|bp|chez|clos|rond-point|esplanade|promenade|ruelle|venelle";
const ABBREVIATIONS = "av|bd|bld|bvd|ch|imp|rte|pl|app|apt|esc|fg|bât|bat|st|ste|dr|pr";
const ADDRESS_FILLER = sticky(`(?:ensemble|actuellement|également|egalement|toujours|alors)${SP}+`);
const ADDRESS_CONNECTOR = sticky(`(?:de|du|des|la|le|les|sur|sous|en|aux|au|à)(?![${L}\\d])`);
const ADDRESS_TOKEN = sticky(
  `(?:\\d+(?:[-/]\\d+)*(?:er|ère|ème|e|bis|ter|quater|[A-Za-z])?(?![${L}\\d])|[nN]°|[A-Z](?![${L}\\d])` +
    `|(?:${ABBREVIATIONS})\\.|(?:${STREET_WORDS})(?![${L}])|${TOKEN}|\\([^)\\n]{1,25}\\))`,
);
const ADDRESS_SEPARATOR = sticky(`(?:${SP}*,${SP}*|${SP}+|-)`);
const MAX_ADDRESS_TOKENS = 30;

const NO_BEFORE = `(?<![${L}\\d])`;
// « À LA REQUETE DE : Madame X » (deux-points) et « à la requête de la Mme X » (article devant la
// civilité) : le « la » n'est consommé que devant une civilité.
const REQUETE = new RegExp(
  `${NO_BEFORE}([àa]${SP}+la${SP}+requ[êe]te)(${SP}+(?:des|de|du|d${APOS}))(?:${SP}*:)?${SP}*` +
    `(?:(?:la|le)${SP}+(?=${CIV}))?`,
  "gi",
);
const OCCUPIED = new RegExp(`${NO_BEFORE}occup[ée](?:e|s|es)?${SP}+par${SP}+`, "gi");
// « le locataire en place, Madame X » : le qualificatif reste, le nom part.
const ROLE_QUALIFIER = `(?:${SP}+(?:en${SP}+place|en${SP}+titre|actuel(?:le)?s?|principa(?:l|le|ux|les)))?`;
const TENANT = new RegExp(
  `${NO_BEFORE}(locataires?)(${ROLE_QUALIFIER})(${SP}*[:,\\-–]${SP}*|${SP}+)`,
  "gi",
);
const LEASE = new RegExp(
  `${NO_BEFORE}(?:bail(?:${SP}+[${L}'’-]+){0,4}?${SP}+consenti(?:e|s|es)?${SP}+(?:à|a|au|aux)` +
    `|lou[ée](?:e|s|es)?${SP}+(?:à|a))${SP}+`,
  "gi",
);
const OWNER_AT = new RegExp(`${NO_BEFORE}appartien(?:t|nent)|${NO_BEFORE}appartenant`, "gi");
const OWNER_AT_TAIL = sticky(`${SP}+(?:à|a|aux)${SP}+`, "i");
const PROPERTY = new RegExp(
  `${NO_BEFORE}(propri[ée]t[ée])(${SP}+(?:des|de|du)|${SP}+d${APOS})${SP}*`,
  "gi",
);
const HEIRS = new RegExp(
  `${NO_BEFORE}(h[ée]ritiers?|succession)(${SP}+(?:de|d${APOS}|du)${SP}*)` +
    `(?:(?:feu|d[ée]funt|regrett[ée])${SP}+)?`,
  "gi",
);
const CONSORTS = new RegExp(`${NO_BEFORE}(consorts?)${SP}+`, "gi");
const MARITAL = new RegExp(
  `${NO_BEFORE}([ée]pouses?|[ée]poux|veuf|veuve|divorc[ée]e?s?|n[ée]e)(?![${L}])`,
  "gi",
);
const ROLE = new RegExp(
  `${NO_BEFORE}(débiteurs?|saisis?|saisies?|occupants?|occupantes?|propriétaires?|vendeurs?|bailleurs?` +
    `|créanciers?|poursuivants?|défendeurs?|demandeurs?|requérants?|intéressés?|indivisaires?` +
    `|copropriétaires?)(${ROLE_QUALIFIER})(${SP}*[:,]${SP}*|${SP}+)`,
  "gi",
);
const MARITAL_LINK = sticky(`${SP}+(?:(?:de|d${APOS}|du)${SP}*)?`);
// Ces deux motifs commencent par leur mot-clé : un préfixe d'espaces non ancré (`SP*,?SP*`) serait
// quadratique sur une longue suite d'espaces. L'espace et la virgule qui précèdent le mot-clé sont
// rattachés ensuite, en remontant (`withLeadingSeparator`).
const BIRTH = new RegExp(
  `(?<![${L}])n[ée](?:e|\\(e\\))?(?![${L}])${SP}+(?:le${SP}+${DATE}|en${SP}+\\d{4})`,
  "gi",
);
const RESIDENCE = new RegExp(
  `${NO_BEFORE}(?:demeurant|demeurante|demeurants|domicili[ée](?:e|s|es)?` +
    `|r[ée]sidant|r[ée]sidante)(?![${L}])`,
  "gi",
);
const SP_CHAR = sticky(SP);

type Edit = [start: number, end: number, replacement: string];
type Handler = (text: string, match: RegExpExecArray) => Edit | null;

function matchEnd(match: RegExpExecArray): number {
  return match.index + match[0].length;
}

function substitute(text: string, pattern: RegExp, handler: Handler): string {
  const regex = new RegExp(pattern.source, pattern.flags);
  let out = "";
  let cursor = 0;
  for (let match = regex.exec(text); match; match = regex.exec(text)) {
    if (match[0] === "") {
      regex.lastIndex += 1;
      continue;
    }
    if (match.index < cursor) continue;
    const edit = handler(text, match);
    if (!edit) continue;
    const [start, end, replacement] = edit;
    out += text.slice(cursor, start) + replacement;
    cursor = end;
  }
  return out + text.slice(cursor);
}

function skipSpacesBack(text: string, index: number): number {
  let start = index;
  while (start > 0 && matchAt(SP_CHAR, text, start - 1)) start -= 1;
  return start;
}

/** Début de `(?:SP*,)?SP*` juste avant `index`, en temps linéaire. */
function withLeadingSeparator(text: string, index: number): number {
  let start = skipSpacesBack(text, index);
  if (start > 0 && text[start - 1] === ",") start = skipSpacesBack(text, start - 1);
  return start;
}

// --- Reconnaissance d'une personne ---------------------------------------------------------------
type PersonKind = "civ" | "bare" | "single";

function acceptable(span: string, kind: PersonKind): boolean {
  if (ORG_RE.test(span)) return false;
  if (kind === "civ") return !TITLE_RE.test(span.replace(CIV_PREFIX, ""));
  if (CIV_PREFIX.test(span)) return false; // « Madame Le MAIRE » : la civilité écartée n'est pas un prénom
  const first = span.trim().split(/[\s'’-]/)[0];
  return !(kind === "single" ? STOP_FIRST_SINGLE : STOP_FIRST).has(first);
}

function onePerson(text: string, pos: number, single = false, mixed = false): number | null {
  let match = matchAt(PERSON_CIV, text, pos);
  if (match && acceptable(match[0], "civ")) return matchEnd(match);
  match = matchAt(PERSON_BARE, text, pos);
  if (match && acceptable(match[0], "bare")) return matchEnd(match);
  if (single) {
    match = matchAt(PERSON_SINGLE, text, pos);
    if (match && acceptable(match[0], "single")) return matchEnd(match);
  }
  if (mixed) {
    match = matchAt(PERSON_MIXED, text, pos);
    if (match && acceptable(match[0], "bare")) return matchEnd(match);
  }
  return null;
}

/** Fin d'une ou plusieurs personnes (« M. X et Mme Y, née Z ») commençant en `pos`. */
function personEnd(text: string, pos: number, mixed = false): number | null {
  let end = onePerson(text, pos, false, mixed);
  if (end === null) return null;
  for (;;) {
    let extended = false;
    const alias = matchAt(ALIAS, text, end);
    if (alias) {
      const after = onePerson(text, matchEnd(alias), true);
      if (after !== null) {
        end = after;
        extended = true;
      }
    }
    const separator = matchAt(SEPARATOR, text, end);
    if (separator) {
      const after = onePerson(text, matchEnd(separator), false, mixed);
      if (after !== null) {
        end = after;
        extended = true;
      }
    }
    if (!extended) return end;
  }
}

// --- Règles --------------------------------------------------------------------------------------
const requete: Handler = (text, match) => {
  const end = personEnd(text, matchEnd(match));
  if (end === null) return null;
  return [match.index + match[1].length, end, " du créancier poursuivant"];
};

const occupied: Handler = (text, match) => {
  const start = matchEnd(match);
  const end = personEnd(text, start);
  if (end === null) return null;
  // Le statut (locataire, occupant sans titre, ancien locataire…) n'est jamais déduit du voisinage.
  return [start, end, "un occupant"];
};

const tenant: Handler = (text, match) => {
  const end = personEnd(text, matchEnd(match));
  if (end === null) return null;
  return [match.index + match[1].length + match[2].length, end, ""];
};

// Après un rôle sans civilité, ces mots ne commencent pas un nom (avocat, bien décrit en capitales).
const ROLE_NOT_A_NAME = new Set(
  (
    "me maître maitre mtre appartement maison local locaux lot lots bien biens terrain studio garage " +
    "parking cave villa pavillon entrepôt entrepot bâtiment batiment commerce parcelle logement fonds"
  ).split(" "),
);

const role: Handler = (text, match) => {
  const civil = matchAt(PERSON_CIV, text, matchEnd(match));
  if (civil) {
    if (!acceptable(civil[0], "civ")) return null;
  } else {
    // Sans civilité : « Le saisi, Paul ROY », « propriétaire : DUPONT Pierre ».
    const bare = matchAt(PERSON_BARE, text, matchEnd(match));
    if (!bare || !acceptable(bare[0], "bare")) return null;
    if (ROLE_NOT_A_NAME.has(bare[0].split(/[\s'’-]/)[0].toLowerCase())) return null;
  }
  const end = personEnd(text, matchEnd(match));
  if (end === null) return null;
  return [match.index + match[1].length + match[2].length, end, ""];
};

const lease: Handler = (text, match) => {
  const start = matchEnd(match);
  const end = personEnd(text, start, true);
  if (end === null) return null;
  return [start, end, "un locataire"];
};

const ownerAt: Handler = (text, match) => {
  const tail = matchAt(OWNER_AT_TAIL, text, matchEnd(match));
  if (!tail) return null;
  const start = matchEnd(tail);
  const end = personEnd(text, start);
  if (end === null) return null;
  return [start, end, "un particulier"];
};

const property: Handler = (text, match) => {
  const end = personEnd(text, matchEnd(match));
  if (end === null) return null;
  return [match.index + match[1].length, end, " d'un particulier"];
};

const heirs: Handler = (text, match) => {
  const end = personEnd(text, matchEnd(match));
  if (end === null) return null;
  return [match.index + match[1].length, end, " du défunt"];
};

const consorts: Handler = (text, match) => {
  const first = matchAt(PERSON_SINGLE, text, matchEnd(match));
  if (!first || !acceptable(first[0], "single")) return null;
  let end = matchEnd(first);
  for (;;) {
    const separator = matchAt(LIST_SEPARATOR, text, end);
    const following = separator ? matchAt(PERSON_SINGLE, text, matchEnd(separator)) : null;
    if (!following || !acceptable(following[0], "single")) break;
    end = matchEnd(following);
  }
  return [match.index + match[1].length, end, ""];
};

const marital: Handler = (text, match) => {
  const link = matchAt(MARITAL_LINK, text, matchEnd(match));
  if (!link) return null;
  const end = onePerson(text, matchEnd(link), true);
  if (end === null) return null;
  const word = match[1];
  if (["née", "nee"].includes(word.toLowerCase())) {
    // « , née DURAND » : le mot lui-même n'a plus d'objet.
    let start = match.index;
    while (start > 0 && " \t ".includes(text[start - 1])) start -= 1;
    if (start > 0 && text[start - 1] === ",") start -= 1;
    return [start, end, ""];
  }
  return [match.index + word.length, end, ""];
};

const birth: Handler = (text, match) => {
  const place = matchAt(PLACE, text, matchEnd(match));
  return [withLeadingSeparator(text, match.index), place ? matchEnd(place) : matchEnd(match), ""];
};

function skipSeparators(text: string, pos: number): number {
  const separator = matchAt(ADDRESS_SEPARATOR, text, pos);
  return separator ? matchEnd(separator) : pos;
}

/** Fin de l'adresse qui suit « demeurant » : jeton par jeton, sans manger la suite de la phrase. */
function addressEnd(text: string, pos: number): number | null {
  let cursor = pos;
  const filler = matchAt(ADDRESS_FILLER, text, skipSeparators(text, cursor));
  if (filler) cursor = matchEnd(filler);
  let end: number | null = null;
  for (let count = 0; count < MAX_ADDRESS_TOKENS; count += 1) {
    cursor = skipSeparators(text, cursor);
    const token = matchAt(ADDRESS_TOKEN, text, cursor);
    if (token) {
      cursor = matchEnd(token);
      end = cursor;
      continue;
    }
    const connector = matchAt(ADDRESS_CONNECTOR, text, cursor);
    if (connector) {
      cursor = matchEnd(connector); // n'est conservé que si un jeton d'adresse le suit
      continue;
    }
    break;
  }
  return end;
}

function clauseWindow(text: string, index: number): string {
  const before = text.slice(Math.max(0, index - 60), index);
  const boundary = Math.max(
    before.lastIndexOf("."),
    before.lastIndexOf(";"),
    before.lastIndexOf("\n"),
  );
  return before.slice(boundary + 1);
}

/** « demeurant » doit qualifier quelqu'un : pas en début de phrase. */
function hasSubject(text: string, index: number): boolean {
  const before = text.slice(0, index).trimEnd();
  return before !== "" && !".:;!?".includes(before[before.length - 1]);
}

const residence: Handler = (text, match) => {
  const start = withLeadingSeparator(text, match.index);
  if (!hasSubject(text, start) || PROFESSIONAL.test(clauseWindow(text, start))) return null;
  const end = addressEnd(text, matchEnd(match));
  if (end === null) return null;
  return [start, end, ""];
};

const RULES: ReadonlyArray<readonly [RegExp, Handler]> = [
  [REQUETE, requete],
  [OCCUPIED, occupied],
  [TENANT, tenant],
  [ROLE, role],
  [LEASE, lease],
  [OWNER_AT, ownerAt],
  [PROPERTY, property],
  [HEIRS, heirs],
  [CONSORTS, consorts],
  [MARITAL, marital],
  [BIRTH, birth],
  [RESIDENCE, residence],
];

/** Remplace par un rôle générique le nom d'une personne physique dans un texte libre. */
export function redactPersonalText(text: string): string;
export function redactPersonalText(text: string | null | undefined): string | null | undefined;
export function redactPersonalText(text: string | null | undefined): string | null | undefined {
  if (typeof text !== "string" || !text || !QUICK.test(text)) return text;
  let result = text;
  for (const [pattern, handler] of RULES) result = substitute(result, pattern, handler);
  return result;
}

/** Applique le filtre à toutes les chaînes d'une valeur JSON (liste, objet, chaîne). */
export function redactPersonalData<T>(value: T, depth = 0): T {
  if (depth > 12) return value;
  if (typeof value === "string") return redactPersonalText(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactPersonalData(item, depth + 1)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactPersonalData(item, depth + 1)]),
    ) as T;
  }
  return value;
}

const SALE_TEXT_FIELDS = [
  "description",
  "source_description",
  "llm_display_description",
  "about_description",
  "risk_notes",
  "investment_summary",
  "surface_evidence",
] as const;
const SALE_JSON_FIELDS = ["source_blocks", "source_blocks_by_source", "risks"] as const;

/**
 * Filtre les textes libres d'une fiche avant qu'elle ne quitte le serveur (rapports partagés,
 * exports). La lecture directe du catalogue par le navigateur n'y passe pas : elle est protégée
 * par les données stockées, filtrées à la collecte.
 */
export function redactSaleTexts<T extends object>(sale: T): T {
  const record: Record<string, unknown> = { ...(sale as Record<string, unknown>) };
  for (const field of SALE_TEXT_FIELDS) {
    const value = record[field];
    if (typeof value === "string") record[field] = redactPersonalText(value);
  }
  for (const field of SALE_JSON_FIELDS) {
    const value = record[field];
    if (value && typeof value === "object") record[field] = redactPersonalData(value);
  }
  return record as T;
}
