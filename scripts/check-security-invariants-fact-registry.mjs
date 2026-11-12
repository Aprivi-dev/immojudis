// Invariants du registre des pièces (plan du 11/11/2026 : lot R1, migrations 20261116100000 à 20261116100500, et
// lot R2a, migrations 20261117100000 à 20261117100700 ; spécifications : annexes 03-base-de-donnees-arbitrage.md,
// section 7, et 08-bascule-base-de-donnees.md de docs/equipe/annexes/2026-11-11-registre-des-pieces/).
// Appelé par scripts/check-security-invariants.mjs, qui lui passe ses lectures partagées (migrations déjà lues,
// arborescences de code en cache) : ce module ne lit aucun fichier par lui-même.
//
// 1. fact-registry-tables-closed : les quatre tables du registre sont réservées au serveur en lecture seule
//    (RLS, aucune politique, tout retiré aux rôles de l'API, SELECT seul pour service_role).
// 2. fact-registry-append-only : le journal des décisions et la file d'évènements refusent UPDATE, DELETE et
//    TRUNCATE ; auction_fact_claims refuse TRUNCATE ; aucune migration ne retire ni ne coupe ces déclencheurs
//    (« enable always »), ne passe en session_replication_role, ni n'insère une décision hors d'une fonction ;
//    les deux journaux tirent leur numéro d'ordre de la séquence commune, que rien ne déplace ni n'ouvre.
// 3. held-fields-projection-only : auction_sales.held_fields n'est écrite que par la projection et la retenue
//    (affectation, clause SET ou cible d'un INTO) ; aucun code de l'application, du pipeline, des scripts ni des
//    fonctions Edge ne la nomme ; aucun droit par colonne ne l'ouvre ; le marqueur de transaction de la projection
//    n'est nommé que par ces deux fonctions et par la garde du marqueur ; le journal des ventes vide la colonne
//    sur ses deux copies de la ligne.
// 4. hold-trigger-present-early : le déclencheur de retenue garde sa forme (BEFORE UPDATE OF, clause WHEN), reste
//    passif et précède tous les autres déclencheurs BEFORE UPDATE de auction_sales (sauf la garde « aaaa_ », la
//    garde par rôle de held_fields et la garde du marqueur) ; les gardes par rôle et la garde du marqueur
//    n'acceptent que le propriétaire de la projection ; la garde d'origine des observations couvre le triplet
//    du pont (extracteur et identifiant de fait de l'agent) ; le contrôle des déclencheurs lit leur mode ET leur
//    fonction ; un rattrapage qui écrit auction_sales ne coupe que des déclencheurs en mode ordinaire hors
//    registre et se termine par le contrôle du mode des déclencheurs.
// 5. field-projection-not-callable-by-api : la projection et les fonctions internes du registre ne sont
//    exécutables par aucun rôle de l'API (ni par un droit donné d'un coup sur le schéma public) ; les trois
//    fonctions publiques du lot R2a ne le sont que par service_role, aucune autre fonction publique ne les
//    enveloppe ni ne lit une table du registre, et dans l'application seul un module serveur les nomme ; aucun
//    code ne nomme la projection.
// 6. fact-claims-never-repointed : une observation n'est jamais rattachée à une autre vente ; sa garde
//    d'immuabilité garde la clause « détacher seulement ».
// 7. registry-no-fk-to-auction-sales : aucune clé étrangère du registre vers auction_sales (verrou sur la table
//    chaude, suppression en cascade qui perdrait l'audit).
// 8. held-fields-never-returned : aucune fonction du schéma public ne rend la ligne entière de auction_sales ;
//    seules trois fonctions de ce schéma nomment held_fields, et celle qui sert la collecte ne lit de l'entrée
//    que son état et la valeur d'annonce (jamais la valeur tenue, la pièce, la décision ni l'origine).
// 9. fact-registry-check-read-only : le contrôle quotidien n'appelle la projection qu'en simulation et ne
//    contient aucune écriture ; la fonction qui tient les alertes ne prend aucun paramètre et n'écrit que par le
//    mécanisme d'alerte, sous des clés fact_registry.*, sans rien refermer sur un rapport tronqué.
// 10. registry-neutral-surface-labels : la projection écrit des libellés de surface neutres, sans jamais y
//    joindre l'origine de la pièce, et la retenue réserve le libellé du registre à la projection.
// 11. fact-claims-generation-pattern : la vue des observations lit la génération de la collecte par sa fonction
//    (préfixe fixe, un ou deux chiffres, sans expression rationnelle) et son plafond ; l'extracteur et la version
//    écrits par la collecte se lisent et ne dépassent pas le plafond ; la vue garde security_invoker et n'est lue
//    que par service_role.
// 12. set-config-literal-name : dans toutes les migrations, tous les rattrapages et tous les fichiers de
//    maintenance, set_config n'est appelé qu'avec un nom de réglage littéral. Une fonction qui relaierait un nom
//    reçu en paramètre laisserait son appelant poser le marqueur de transaction de la projection.
// Partout : aucune instruction ALTER FUNCTION ne touche une fonction du registre (mode de sécurité, propriétaire),
// aucune instruction ne change le propriétaire d'une table, de la vue ou de la séquence du registre (OWNER TO,
// REASSIGN OWNED), et lot_ref garde son motif structurel.
//
// Échec fermé : le code est cherché tel quel (un mot interdit dans un commentaire ou dans une adresse échoue
// aussi) ; le SQL n'est débarrassé que de ses vrais commentaires (une chaîne '--' n'en ouvre pas un), puis mis
// sous une seule forme (minuscules hors des chaînes, pas d'espace autour du point d'un nom qualifié) : une
// instruction en majuscules ou « public . auction_sales » est lue comme les autres ; les droits sont cherchés
// partout, y compris dans un bloc DO ou dans le texte d'un EXECUTE. Les rattrapages (supabase/repairs/) et les
// fichiers de maintenance (supabase/maintenance/) sont lus comme des migrations.

export const factRegistryInvariantNames = [
  "fact-registry-tables-closed",
  "fact-registry-append-only",
  "held-fields-projection-only",
  "hold-trigger-present-early",
  "field-projection-not-callable-by-api",
  "fact-claims-never-repointed",
  "registry-no-fk-to-auction-sales",
  "held-fields-never-returned",
  "fact-registry-check-read-only",
  "registry-neutral-surface-labels",
  "fact-claims-generation-pattern",
  "set-config-literal-name",
];

const REGISTRY_TABLES = [
  "auction_fact_fields",
  "auction_fact_source_precedence",
  "auction_fact_claim_decisions",
  "auction_sale_field_hold_events",
];
const JOURNALS = ["auction_fact_claim_decisions", "auction_sale_field_hold_events"];
const HOLD_TRIGGER = "aaab_auction_sales_hold_projected_fields";
const INSERT_GUARD_TRIGGER = "aaab_auction_sales_held_fields_insert_guard";
const ROLE_GUARD_TRIGGER = "aaab_auction_sales_held_fields_role_guard";
const MARKER_GUARD_TRIGGER = "aaab_auction_sales_held_fields_marker_guard";
const MARKER_GUARD_FUNCTION = "app_private.refuse_sale_field_projection_marker";
const ORIGIN_GUARD_TRIGGER = "auction_fact_claims_registry_origin_guard";
const RETENTION_GUARD_TRIGGER = "aaaa_auction_sales_retention_tombstone_guard_update";
const HOLD_FUNCTION = "app_private.hold_projected_sale_fields";
const PROJECTION_FUNCTION = "app_private.project_sale_fields";
const PROJECTION_MARKER = "app.sale_field_projection";
const HELD_COLUMNS = [
  "surface_m2",
  "app_surface_m2",
  "app_surface_kind",
  "surface_source",
  "surface_confidence",
  // Colonnes voisines de la surface, jamais tenues mais surveillées contre l'écho (lot R2a).
  "habitable_surface_m2",
  "carrez_surface_m2",
  "land_surface_m2",
  "rooms_count",
  "bedrooms_count",
  "occupancy_status",
  "visit_dates",
  "held_fields",
];
// Premières migrations du lot : avant elles, les tables, la colonne et les fonctions n'existent pas.
const FACT_CLAIMS_MIGRATION = "20260928140000";
const REGISTRY_MIGRATION = "20261116100000";
const HELD_FIELDS_MIGRATION = "20261116100300";
const PROJECTION_MIGRATION = "20261116100500";
// Lot R2a : séquence commune, gardes par rôle, retenue et projection en version 2, contrôle quotidien.
const SEQUENCE_MIGRATION = "20261117100000";
const REGISTRY_SEQUENCE = "app_private.fact_registry_seq";
const ASSERT_TRIGGERS_FUNCTION = "app_private.assert_fact_registry_triggers";
const BASELINES_FUNCTION = "public.get_sale_field_baselines";
const CHECK_FUNCTION = "public.check_fact_registry_consistency";
const ALERTS_FUNCTION = "public.sync_fact_registry_alerts";
const ALERTS_FROM_REPORT_FUNCTION = "app_private.sync_fact_registry_alerts_from_report";
const HISTORY_FUNCTION = "public.log_auction_sale_change";
// Vue des observations (20261117100700) et constantes de la collecte qu'elle lit.
const CLAIMS_VIEW = "public.v_auction_fact_claims_read_model";
const GENERATION_PREFIX = "auction_fact_claims_v";
const GENERATION_FUNCTION = "app_private.fact_claims_generation";
const GENERATION_CEILING_FUNCTION = "app_private.fact_claims_generation_ceiling";
// Libellé du lot d'une décision : motif structurel (numéros de lot seulement), insensible à la casse.
const LOT_REF_CONSTRAINT = "auction_fact_claim_decisions_lot_ref_check";
const LOT_REF_PATTERN =
  "^((lots? )?(n[°º] ?)?[1-9][0-9]{0,2}[a-z]?( ?(et|,|-|à) ?[1-9][0-9]{0,2}[a-z]?){0,3}|[1-9][0-9]{0,2}(er|e|ème|eme|nd)? lot)$";
const PIPELINE_FACT_CLAIMS = "../services/data-pipeline/src/fact_claims.py";
// Fonctions internes du lot R2a : aucune n'est exécutable par un rôle de l'API.
const INTERNAL_FUNCTIONS = [
  "app_private.fact_registry_triggers_not_always",
  ASSERT_TRIGGERS_FUNCTION,
  "app_private.sale_field_echo_memory",
  "app_private.sale_field_echo_prune",
  "app_private.sale_field_echo_matches",
  "app_private.sale_field_echo_add",
  "app_private.sale_field_incoming_class",
  "app_private.sale_field_value_leaks",
  MARKER_GUARD_FUNCTION,
  ALERTS_FROM_REPORT_FUNCTION,
];
// Fonctions du registre qu'aucune instruction ALTER FUNCTION ne touche (mode de sécurité, propriétaire, chemin
// de recherche) : les gardes lisent le rôle appelant, la liste blanche lit le propriétaire de la projection.
const UNALTERABLE_FUNCTIONS = [
  PROJECTION_FUNCTION,
  HOLD_FUNCTION,
  ...INTERNAL_FUNCTIONS,
  "app_private.refuse_api_role_held_fields_write",
  "app_private.refuse_api_role_registry_origin",
  "app_private.refuse_inserted_held_fields",
  "app_private.fact_registry_append_only",
  "app_private.refuse_auction_fact_claims_truncate",
  "app_private.validate_auction_fact_claim_decision",
  "app_private.stamp_fact_registry_event",
  BASELINES_FUNCTION,
  CHECK_FUNCTION,
  ALERTS_FUNCTION,
  HISTORY_FUNCTION,
  GENERATION_FUNCTION,
  GENERATION_CEILING_FUNCTION,
];
// Objets du registre dont aucune instruction ne change le propriétaire : le propriétaire d'une table en coupe les
// déclencheurs, et les gardes par rôle ne laissent passer que le propriétaire de la projection. Cherchés par leur
// nom nu : « set search_path » puis un nom sans schéma ne passe pas.
const OWNED_OBJECTS = [
  ...REGISTRY_TABLES,
  "auction_fact_claims",
  "auction_sales",
  "v_auction_fact_claims_read_model",
  "fact_registry_seq",
];
// Fonctions publiques du lot R2a : exécutables par service_role seul.
const SERVER_ONLY_RPCS = [BASELINES_FUNCTION, CHECK_FUNCTION, ALERTS_FUNCTION];
// Dans src/, seul ce module serveur (et les types générés) nomme ces fonctions.
const SERVER_RPC_CALLERS = new Set([
  "src/lib/fact-registry-check.ts",
  "src/integrations/supabase/types.ts",
]);
// Clés d'une entrée de held_fields que la fonction des valeurs d'annonce ne lit jamais.
const ENTRY_KEYS_NEVER_SERVED = [
  "value",
  "claim_id",
  "decision_id",
  "source_kind",
  "rank",
  "received_on",
  "recipient_kind",
  "publication_mode",
  "echo",
  "released_by",
];
// Les rattrapages (supabase/repairs/) sont analysés comme des migrations postérieures au lot, sauf ceux qui
// existaient avant lui, nommés ici un par un. Le rattrapage 20261029100200, qui coupait puis rétablissait tous
// les déclencheurs de auction_sales, a été réécrit au lot R2a : il n'est plus dans cette liste. Les fichiers de
// maintenance (supabase/maintenance/) sont lus de la même façon ; le seul à remettre un mode de déclencheur est
// celui qui les repasse tous en « always ».
const REPAIRS_PREFIX = "repairs/";
const MAINTENANCE_PREFIX = "maintenance/";
const HISTORICAL_MAINTENANCE = new Set([
  "20260929124000_quarantine_agrasc_seller_and_close_excluded_jobs.sql",
]);
const HISTORICAL_REPAIRS = new Set([
  "20261020130001_repair_sale_department_and_coordinates.sql",
  "20261020130002_clear_info_encheres_phantom_point.sql",
  "20261020130003_quarantine_licitor_multi_lot_annonces.sql",
  "20261025100001_repair_doubled_tribunal_names.sql",
  "20261029110000_backfill_account_email_identity.sql",
  "20261030100001_count_workspace_status_not_in_dossier.sql",
  "20261101110100_clear_points_outside_their_department.sql",
  "20261108202100_delete_empty_listings.sql",
]);

const REGISTRY_OBJECT =
  /auction_fact_|auction_sale_field_hold_events|held_fields|project_sale_fields|hold_projected_sale_fields|fact_registry_append_only|sale_field_projection/;
const TRIGGER_CREATION = /create\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s/i;
const CREATE_TRIGGER = "create\\s+(?:or\\s+replace\\s+)?trigger";
// Mots qu'aucun code ne doit nommer, cherchés tels quels (commentaires et chaînes compris).
const FORBIDDEN_IN_CODE = [
  [
    "held_fields",
    "names auction_sales.held_fields (written and read by the database only at this stage)",
  ],
  [
    "project_sale_fields",
    `names ${PROJECTION_FUNCTION} (no application, pipeline or script code calls the projection)`,
  ],
  [PROJECTION_MARKER, "names the transaction marker of the projection"],
];
// Fichiers qui nomment ces mots par nature : les types générés depuis le schéma, et ces invariants.
const CODE_EXEMPTIONS = new Set([
  "src/integrations/supabase/types.ts",
  "scripts/check-security-invariants.mjs",
  "scripts/check-security-invariants-fact-registry.mjs",
  "scripts/check-security-invariants.test.mjs",
  "scripts/check-security-invariants-fact-registry.test.mjs",
]);
// Textes admis mot pour mot dans un fichier précis, et rien d'autre de ce fichier : la liste blanche des index
// concurrents recopie la définition revue de l'index partiel des ventes du registre (migration 20261117100450).
// Elle ne lit ni n'écrit la colonne.
const CODE_ALLOWED_FRAGMENTS = new Map([
  [
    "scripts/apply-supabase-concurrent-index-operations.mjs",
    [
      '"20261117100450:auction_sales_held_fields_idx"',
      '"auction_sales_held_fields_idx"',
      '\'create index concurrently if not exists "auction_sales_held_fields_idx" on "public"."auction_sales" ("id") where ("held_fields" is not null)\'',
      '"(held_fields IS NOT NULL)"',
      '"held_fields is not null"',
    ],
  ],
]);

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Retire les commentaires SQL, et eux seuls : une chaîne entre apostrophes est gardée telle quelle (« '--' »
 * n'ouvre pas un commentaire), un corps entre dollars est du code dont on retire aussi les commentaires, et sa
 * fin est cherchée par sa balise (un « -- » dans une chaîne dynamique ne cache pas ce qui suit la balise).
 * Le code, hors des chaînes, est rendu en minuscules : une instruction écrite en majuscules se lit comme les
 * autres. Les chaînes gardent leur casse (messages, valeurs comparées).
 */
function stripSqlComments(text) {
  const token = /'|--|\/\*|\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/g;
  let out = "";
  let index = 0;
  while (index < text.length) {
    token.lastIndex = index;
    const match = token.exec(text);
    if (!match) {
      out += text.slice(index).toLowerCase();
      break;
    }
    out += text.slice(index, match.index).toLowerCase();
    if (match[0] === "'") {
      // E'...' : la barre oblique inverse protège le caractère suivant.
      const escaped = /(?:^|[^A-Za-z0-9_])[eE]$/.test(
        text.slice(Math.max(0, match.index - 2), match.index),
      );
      let end = match.index + 1;
      while (end < text.length) {
        if (escaped && text[end] === "\\") end += 2;
        else if (text[end] !== "'") end += 1;
        else if (text[end + 1] === "'") end += 2;
        else break;
      }
      end = Math.min(end + 1, text.length);
      out += text.slice(match.index, end);
      index = end;
    } else if (match[0] === "--") {
      const end = text.indexOf("\n", match.index);
      index = end < 0 ? text.length : end;
    } else if (match[0] === "/*") {
      let depth = 1;
      let end = match.index + 2;
      while (end < text.length && depth > 0) {
        if (text.startsWith("/*", end)) {
          depth += 1;
          end += 2;
        } else if (text.startsWith("*/", end)) {
          depth -= 1;
          end += 2;
        } else {
          end += 1;
        }
      }
      out += " ";
      index = end;
    } else {
      const bodyStart = match.index + match[0].length;
      const close = text.indexOf(match[0], bodyStart);
      if (close < 0) {
        // Corps non fermé : tout est gardé (rien n'est caché).
        out += text.slice(match.index);
        break;
      }
      out +=
        match[0].toLowerCase() +
        stripSqlComments(text.slice(bodyStart, close)) +
        match[0].toLowerCase();
      index = close + match[0].length;
    }
  }
  return out;
}

// Une seule forme pour tout le SQL lu : commentaires retirés, code en minuscules, identifiants sans guillemets,
// aucun espace autour du point d'un nom qualifié (« public . auction_sales », « "public"."auction_sales" »).
const stripSql = (text) =>
  stripSqlComments(text)
    .replace(/"([A-Za-z_][A-Za-z0-9_$]*)"/g, (_quoted, identifier) => identifier.toLowerCase())
    .replace(/\b([A-Za-z_][A-Za-z0-9_$]*)\s*\.\s*(?=[A-Za-z_])/g, "$1.");

/** Définitions `create [or replace] function` d'un fichier : nom qualifié, en-tête, corps, bornes. */
function functionDefinitions(sql) {
  const definitions = [];
  const header =
    /create\s+(?:or\s+replace\s+)?function\s+([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?)\s*\(/gi;
  const bodyOpening = /\bas\s+(\$[a-z_]*\$)/gi;
  for (const match of sql.matchAll(header)) {
    bodyOpening.lastIndex = match.index;
    const opening = bodyOpening.exec(sql);
    if (!opening) continue;
    const bodyStart = opening.index + opening[0].length;
    const bodyEnd = sql.indexOf(opening[1], bodyStart);
    if (bodyEnd < 0) continue;
    definitions.push({
      name: match[1].toLowerCase(),
      head: sql.slice(match.index, bodyStart),
      body: sql.slice(bodyStart, bodyEnd),
      start: match.index,
      end: bodyEnd + opening[1].length,
    });
  }
  return definitions;
}

/**
 * @param {object} context
 * @param {Map<string, string>} context.migrationSources migrations déjà lues (nom de fichier -> SQL)
 * @param {(url: URL) => Promise<string[]>} context.readSourceTree lecture partagée d'une arborescence
 * @param {(url: URL) => Promise<string>} context.readSourceText lecture partagée d'un fichier
 * @param {string[]} context.failures liste des échecs du script appelant
 * @param {string} context.baseUrl adresse du script appelant (import.meta.url)
 */
export async function checkFactRegistryInvariants({
  migrationSources,
  readSourceTree,
  readSourceText,
  failures,
  baseUrl,
}) {
  // Seules les migrations qui peuvent toucher le registre sont analysées : celles qui nomment un de ses objets,
  // celles qui créent un déclencheur sur auction_sales (ordre des déclencheurs), et toutes celles qui suivent
  // le début du lot (droits donnés en bloc, mode replica). Les autres (plus de neuf sur dix) ne sont pas relues.
  const all = [];
  for (const [name, source] of migrationSources) {
    if (
      name >= REGISTRY_MIGRATION ||
      REGISTRY_OBJECT.test(source) ||
      (source.includes("auction_sales") && TRIGGER_CREATION.test(source))
    ) {
      all.push([name, stripSql(source)]);
    }
  }
  // Rattrapages : tous lus (ils s'appliquent à la main, hors de l'ordre des migrations).
  try {
    const repairsUrl = new URL("../supabase/repairs/", baseUrl);
    const repairs = (await readSourceTree(repairsUrl))
      .map(String)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const name of repairs) {
      all.push([
        `${REPAIRS_PREFIX}${name}`,
        stripSql(await readSourceText(new URL(name, repairsUrl))),
      ]);
    }
  } catch (error) {
    failures.push(
      `supabase/repairs/ cannot be read to check the fact registry (${error.code ?? "error"})`,
    );
  }
  // Fichiers de maintenance : lus eux aussi (lancés à la main, hors de l'ordre des migrations).
  try {
    const maintenanceUrl = new URL("../supabase/maintenance/", baseUrl);
    const maintenance = (await readSourceTree(maintenanceUrl))
      .map(String)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const name of maintenance) {
      all.push([
        `${MAINTENANCE_PREFIX}${name}`,
        stripSql(await readSourceText(new URL(name, maintenanceUrl))),
      ]);
    }
  } catch (error) {
    failures.push(
      `supabase/maintenance/ cannot be read to check the fact registry (${error.code ?? "error"})`,
    );
  }
  const sinceLot = (name, since) => {
    if (name.startsWith(REPAIRS_PREFIX)) {
      return !HISTORICAL_REPAIRS.has(name.slice(REPAIRS_PREFIX.length));
    }
    if (name.startsWith(MAINTENANCE_PREFIX)) {
      return !HISTORICAL_MAINTENANCE.has(name.slice(MAINTENANCE_PREFIX.length));
    }
    return name >= since;
  };
  // Les filtres « ce fichier nomme-t-il tel objet » lisent aussi les chaînes (SQL dynamique) sans leur casse.
  const lowered = new Map(all.map(([name, sql]) => [name, sql.toLowerCase()]));
  const mentions = (name, word) => lowered.get(name).includes(word);
  const allSql = all.map(([, sql]) => sql).join("\n");
  const definitions = all.flatMap(([name, sql]) =>
    functionDefinitions(sql).map((definition) => ({ ...definition, migration: name })),
  );
  const lastDefinition = (name) => definitions.filter((entry) => entry.name === name).at(-1);
  const lastStatement = (pattern) => [...allSql.matchAll(new RegExp(pattern, "gi"))].at(-1);

  // Un déclencheur protégé n'est ni désactivé, ni renommé, ni supprimé sans être recréé dans la même migration,
  // et chaque migration qui le (re)crée le repasse en « enable always » (create or replace le remet en mode
  // ordinaire). `since` : première migration qui le crée (avant elle, des rattrapages coupaient les déclencheurs
  // de la table le temps d'une réécriture, quand celui-ci n'existait pas).
  const checkTriggerKept = (trigger, table, invariant, since, always = true) => {
    const qualified = `(?:public\\.)?${table}`;
    const alterTable = `alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${qualified}\\s+`;
    for (const [name, sql] of all) {
      // Seules les migrations qui nomment la table peuvent toucher un de ses déclencheurs.
      if (!sinceLot(name, since) || !mentions(name, table)) continue;
      const creation = new RegExp(
        `create\\s+(?:or\\s+replace\\s+)?(?:constraint\\s+)?trigger\\s+${trigger}\\b`,
        "gi",
      );
      const drop = new RegExp(
        `drop\\s+trigger\\s+(?:if\\s+exists\\s+)?${trigger}\\s+on\\s+${qualified}\\b`,
        "gi",
      );
      for (const match of sql.matchAll(drop)) {
        creation.lastIndex = match.index;
        if (!creation.test(sql)) {
          failures.push(
            `${name} drops the trigger ${trigger} of public.${table} without recreating it (${invariant})`,
          );
        }
      }
      if (
        new RegExp(`${alterTable}disable\\s+trigger\\s+(?:${trigger}|all|user)\\b`, "i").test(sql)
      ) {
        failures.push(`${name} disables the trigger ${trigger} of public.${table} (${invariant})`);
      }
      if (
        new RegExp(`alter\\s+trigger\\s+${trigger}\\s+on\\s+${qualified}\\s+rename\\b`, "i").test(
          sql,
        )
      ) {
        failures.push(`${name} renames the trigger ${trigger} of public.${table} (${invariant})`);
      }
      if (!always) continue;
      if (
        new RegExp(
          `${alterTable}enable\\s+(?:replica\\s+)?trigger\\s+(?:${trigger}|all|user)\\b`,
          "i",
        ).test(sql)
      ) {
        failures.push(
          `${name} puts the trigger ${trigger} of public.${table} back to a mode that replica sessions skip (${invariant})`,
        );
      }
      creation.lastIndex = 0;
      const created = [...sql.matchAll(creation)].at(-1);
      if (
        created &&
        !new RegExp(`${alterTable}enable\\s+always\\s+trigger\\s+${trigger}\\b`, "i").test(
          sql.slice(created.index),
        )
      ) {
        failures.push(
          `${name} creates the trigger ${trigger} of public.${table} without enabling it always (${invariant})`,
        );
      }
    }
  };

  // 1. fact-registry-tables-closed ----------------------------------------------------------------------------
  for (const table of REGISTRY_TABLES) {
    const qualified = `public\\.${table}`;
    if (
      !new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?${qualified}\\b`, "i").test(
        allSql,
      )
    ) {
      failures.push(`public.${table} is not created by a migration (fact registry)`);
      continue;
    }
    if (
      !new RegExp(`alter\\s+table\\s+${qualified}\\s+enable\\s+row\\s+level\\s+security`, "i").test(
        allSql,
      ) ||
      !new RegExp(
        `revoke\\s+all\\s+on\\s+table\\s+${qualified}\\s+from\\s+public,\\s*anon,\\s*authenticated,\\s*service_role`,
        "i",
      ).test(allSql)
    ) {
      failures.push(`public.${table} is not closed to the API roles (RLS and revoke all)`);
    }
    for (const [name, sql] of all) {
      if (!mentions(name, table)) continue;
      if (
        new RegExp(
          `alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(?:public\\.)?${table}\\s+disable\\s+row\\s+level\\s+security`,
          "i",
        ).test(sql)
      ) {
        failures.push(`${name} disables row level security on public.${table}`);
      }
      if (new RegExp(`create\\s+policy[^;]*\\b(?:public\\.)?${table}\\b`, "i").test(sql)) {
        failures.push(`${name} opens public.${table} with a policy`);
      }
      // Tout « grant » qui nomme la table, où qu'il soit (instruction, bloc DO, texte d'un EXECUTE).
      for (const grant of sql.matchAll(/\bgrant\b[^;]*/gi)) {
        if (!new RegExp(`\\b${table}\\b`, "i").test(grant[0])) continue;
        if (
          !new RegExp(
            `^grant\\s+select\\s+on\\s+(?:table\\s+)?${qualified}\\s+to\\s+service_role\\s*$`,
            "i",
          ).test(grant[0])
        ) {
          failures.push(
            `${name} grants on public.${table} something else than SELECT to service_role alone (the fact registry is written only by its functions)`,
          );
        }
      }
    }
  }
  for (const [name, sql] of all) {
    if (!sinceLot(name, REGISTRY_MIGRATION)) continue;
    if (/\bgrant\b[^;]*\bon\s+all\s+tables\s+in\s+schema\s+[^;]*\bpublic\b/i.test(sql)) {
      failures.push(
        `${name} grants every table of the public schema at once: it would open the fact registry`,
      );
    }
    // Un droit donné par du SQL dynamique ne se lit pas : refusé depuis ce lot.
    if (
      /(?<!grant\s|revoke\s)\bexecute\b(?!\s+(?:function|procedure|on)\b)[^;]*\bgrant\b/i.test(sql)
    ) {
      failures.push(
        `${name} grants a privilege through dynamic SQL (execute): the fact registry checks cannot read it`,
      );
    }
  }

  // 2. fact-registry-append-only --------------------------------------------------------------------------------
  const appendOnly = [
    {
      table: "auction_fact_claim_decisions",
      trigger: "auction_fact_claim_decisions_append_only",
      events: "before\\s+update\\s+or\\s+delete",
      scope: "for\\s+each\\s+row",
      fn: "app_private.fact_registry_append_only",
      since: REGISTRY_MIGRATION,
    },
    {
      table: "auction_fact_claim_decisions",
      trigger: "auction_fact_claim_decisions_no_truncate",
      events: "before\\s+truncate",
      scope: "for\\s+each\\s+statement",
      fn: "app_private.fact_registry_append_only",
      since: REGISTRY_MIGRATION,
    },
    {
      table: "auction_fact_claim_decisions",
      trigger: "auction_fact_claim_decisions_validate",
      events: "before\\s+insert",
      scope: "for\\s+each\\s+row",
      fn: "app_private.validate_auction_fact_claim_decision",
      since: REGISTRY_MIGRATION,
    },
    {
      table: "auction_sale_field_hold_events",
      trigger: "auction_sale_field_hold_events_append_only",
      events: "before\\s+update\\s+or\\s+delete",
      scope: "for\\s+each\\s+row",
      fn: "app_private.fact_registry_append_only",
      since: REGISTRY_MIGRATION,
    },
    {
      table: "auction_sale_field_hold_events",
      trigger: "auction_sale_field_hold_events_no_truncate",
      events: "before\\s+truncate",
      scope: "for\\s+each\\s+statement",
      fn: "app_private.fact_registry_append_only",
      since: REGISTRY_MIGRATION,
    },
    {
      table: "auction_fact_claims",
      trigger: "auction_fact_claims_no_truncate",
      events: "before\\s+truncate",
      scope: "for\\s+each\\s+statement",
      fn: "app_private.refuse_auction_fact_claims_truncate",
      since: REGISTRY_MIGRATION,
    },
  ];
  for (const guard of appendOnly) {
    const created = lastStatement(`${CREATE_TRIGGER}\\s+${guard.trigger}\\s+([^;]*)`);
    if (
      !created ||
      !new RegExp(
        `^${guard.events}\\s+on\\s+public\\.${guard.table}\\s+${guard.scope}\\s+execute\\s+function\\s+${escapeRegExp(guard.fn)}\\(\\)\\s*$`,
        "i",
      ).test(created[1].trim())
    ) {
      failures.push(
        `the append-only trigger ${guard.trigger} of public.${guard.table} is missing or no longer refuses every row and statement`,
      );
    }
    checkTriggerKept(guard.trigger, guard.table, "append-only fact registry", guard.since);
  }
  for (const fn of [
    "app_private.fact_registry_append_only",
    "app_private.refuse_auction_fact_claims_truncate",
  ]) {
    const definition = lastDefinition(fn);
    if (
      !definition ||
      !/raise\s+exception\s+using\s+errcode\s*=\s*'55000'/i.test(definition.body) ||
      /\breturn\b/i.test(definition.body)
    ) {
      failures.push(
        `${definition?.migration ?? "no migration"}: ${fn} no longer refuses every write (it must only raise 55000)`,
      );
    }
  }
  // Séquence commune aux deux journaux (lot R2a) : les deux déclencheurs BEFORE INSERT imposent le numéro, et
  // rien ne déplace, ne modifie, ne supprime ni n'ouvre la séquence.
  if (
    !new RegExp(
      `create\\s+sequence\\s+(?:if\\s+not\\s+exists\\s+)?${escapeRegExp(REGISTRY_SEQUENCE)}\\b`,
      "i",
    ).test(allSql) ||
    !new RegExp(
      `revoke\\s+all\\s+on\\s+sequence\\s+${escapeRegExp(REGISTRY_SEQUENCE)}\\s+from\\s+public,\\s*anon,\\s*authenticated,\\s*service_role`,
      "i",
    ).test(allSql)
  ) {
    failures.push(
      `${REGISTRY_SEQUENCE} is not created and revoked from public, anon, authenticated and service_role`,
    );
  }
  for (const fn of [
    "app_private.validate_auction_fact_claim_decision",
    "app_private.stamp_fact_registry_event",
  ]) {
    const definition = lastDefinition(fn);
    if (
      !definition ||
      !new RegExp(
        `new\\.seq\\s*:=\\s*(?:pg_catalog\\.)?nextval\\(\\s*'${escapeRegExp(REGISTRY_SEQUENCE)}'`,
        "i",
      ).test(definition.body)
    ) {
      failures.push(
        `${definition?.migration ?? "no migration"}: ${fn} no longer takes the order number from ${REGISTRY_SEQUENCE} (the writer would choose it)`,
      );
    }
  }
  for (const [name, sql] of all) {
    if (!mentions(name, "fact_registry_seq")) continue;
    if (/\bsetval\s*\([^;]*\bfact_registry_seq\b/i.test(sql)) {
      failures.push(
        `${name} moves ${REGISTRY_SEQUENCE} with setval: the order of the two journals is never rewritten by a migration or a repair`,
      );
    }
    if (/\b(?:alter|drop)\s+sequence\s+[^;]*\bfact_registry_seq\b/i.test(sql)) {
      failures.push(`${name} alters or drops ${REGISTRY_SEQUENCE}`);
    }
    if (/\bgrant\b[^;]*\bon\s+sequence\s+[^;]*\bfact_registry_seq\b/i.test(sql)) {
      failures.push(`${name} grants a privilege on ${REGISTRY_SEQUENCE}`);
    }
  }
  for (const [name, sql] of all) {
    if (
      sinceLot(name, SEQUENCE_MIGRATION) &&
      /\bgrant\b[^;]*\bon\s+all\s+sequences\s+in\s+schema\s+[^;]*\bapp_private\b/i.test(sql)
    ) {
      failures.push(
        `${name} grants every sequence of app_private at once: it would open ${REGISTRY_SEQUENCE}`,
      );
    }
  }
  for (const [name, sql] of all) {
    if (!sinceLot(name, REGISTRY_MIGRATION)) continue;
    if (/\bsession_replication_role\b/i.test(sql)) {
      failures.push(
        `${name} sets session_replication_role: no migration or repair switches the ordinary triggers off since the fact registry`,
      );
    }
    const inFile = definitions.filter((entry) => entry.migration === name);
    for (const journal of JOURNALS) {
      for (const match of sql.matchAll(
        new RegExp(`insert\\s+into\\s+(?:public\\.)?${journal}\\b`, "gi"),
      )) {
        if (!inFile.some((entry) => match.index >= entry.start && match.index < entry.end)) {
          failures.push(
            `${name} inserts into public.${journal} outside a function: a journal that cannot be erased is never filled by a migration or a repair`,
          );
        }
      }
    }
  }

  // 3. held-fields-projection-only ------------------------------------------------------------------------------
  const allowedWriters = new Set([PROJECTION_FUNCTION, HOLD_FUNCTION]);
  // Le marqueur est posé par la projection, lu par la retenue et par la garde du marqueur.
  const markerReaders = new Set([PROJECTION_FUNCTION, HOLD_FUNCTION, MARKER_GUARD_FUNCTION]);
  for (const [name, sql] of all) {
    if (!sinceLot(name, HELD_FIELDS_MIGRATION) && !mentions(name, "held_fields")) continue;
    const inFile = definitions.filter((entry) => entry.migration === name);
    const ownerAt = (index) => inFile.find((entry) => index >= entry.start && index < entry.end);
    for (const match of sql.matchAll(/\bheld_fields\s*(?::=|=(?!=))/gi)) {
      const owner = ownerAt(match.index);
      // Le journal des ventes vide la colonne sur ses deux copies locales de la ligne (new_row, old_row) pour
      // ne jamais la recopier dans l'historique : seules ces deux affectations à NULL y sont admises.
      if (
        owner?.name === HISTORY_FUNCTION &&
        /\b(?:new_row|old_row)\.$/.test(sql.slice(Math.max(0, match.index - 8), match.index)) &&
        /^held_fields\s*:=\s*null\s*;/i.test(sql.slice(match.index))
      ) {
        continue;
      }
      if (!owner || !allowedWriters.has(owner.name)) {
        failures.push(
          `${name} writes auction_sales.held_fields ${owner ? `in ${owner.name}` : "outside a function"}: only ${PROJECTION_FUNCTION} and ${HOLD_FUNCTION} may`,
        );
      }
    }
    // Cible d'un INTO (select … into new.held_fields, returning … into …) : même règle, sans exception.
    for (const match of sql.matchAll(
      /\binto\s+(?:strict\s+)?((?:[a-z_][a-z0-9_.]*\s*,\s*)*[a-z_][a-z0-9_.]*)/gi,
    )) {
      if (!/(?:^|[\s,.])held_fields\s*(?:,|$)/i.test(match[1])) continue;
      const owner = ownerAt(match.index);
      if (!owner || !allowedWriters.has(owner.name)) {
        failures.push(
          `${name} writes auction_sales.held_fields through INTO ${owner ? `in ${owner.name}` : "outside a function"}: only ${PROJECTION_FUNCTION} and ${HOLD_FUNCTION} may`,
        );
      }
    }
    for (const match of sql.matchAll(new RegExp(escapeRegExp(PROJECTION_MARKER), "g"))) {
      const owner = ownerAt(match.index);
      if (
        name.startsWith(REPAIRS_PREFIX) ||
        name.startsWith(MAINTENANCE_PREFIX) ||
        !owner ||
        !markerReaders.has(owner.name)
      ) {
        failures.push(
          `${name} names the transaction marker of the projection ${owner ? `in ${owner.name}` : "outside a function"}: only ${PROJECTION_FUNCTION} sets it, ${HOLD_FUNCTION} and ${MARKER_GUARD_FUNCTION} read it`,
        );
      }
    }
    for (const match of sql.matchAll(
      /insert\s+into\s+(?:public\.)?auction_sales\s*(?:as\s+[a-z_]+\s*)?\(([^)]*)\)/gi,
    )) {
      if (/\bheld_fields\b/i.test(match[1])) {
        failures.push(`${name} inserts auction_sales.held_fields: a new sale holds no field`);
      }
    }
    if (
      /\bgrant\b[^;]*\([^)]*\bheld_fields\b[^)]*\)\s+on\s+(?:table\s+)?(?:public\.)?auction_sales\b/i.test(
        sql,
      )
    ) {
      failures.push(`${name} grants a column privilege on auction_sales.held_fields`);
    }
    if (
      sinceLot(name, HELD_FIELDS_MIGRATION) &&
      /\bgrant\s+(?:select|all)(?:\s+privileges)?\s+on\s+(?:table\s+)?(?:public\.)?auction_sales\s+to\s+[^;]*\b(?:anon|authenticated|public)\b/i.test(
        sql,
      )
    ) {
      failures.push(
        `${name} grants a table-wide read of auction_sales to a browser role (it would expose held_fields)`,
      );
    }
  }
  if (
    !/alter\s+table\s+public\.auction_sales\s+add\s+column\s+if\s+not\s+exists\s+held_fields\s+jsonb\s*;/i.test(
      allSql,
    )
  ) {
    failures.push(
      "auction_sales.held_fields is not added as a nullable jsonb column without default",
    );
  }
  // Le journal des ventes ne recopie jamais la colonne interne dans l'historique : sa dernière définition la
  // vide sur ses deux copies de la ligne et l'écarte des clés comparées.
  const history = lastDefinition(HISTORY_FUNCTION);
  if (
    !history ||
    !/\bnew_row\.held_fields\s*:=\s*null\s*;/i.test(history.body) ||
    !/\bold_row\.held_fields\s*:=\s*null\s*;/i.test(history.body) ||
    !history.body.includes("'held_fields'")
  ) {
    failures.push(
      `${history?.migration ?? "no migration"}: ${HISTORY_FUNCTION} no longer empties held_fields on both copies of the row (new_row, old_row) nor ignores the key: the sale history would receive the internal column`,
    );
  }

  // 4. hold-trigger-present-early -------------------------------------------------------------------------------
  const holdTrigger = lastStatement(`${CREATE_TRIGGER}\\s+${HOLD_TRIGGER}\\s+([^;]*)`);
  const holdShape =
    /^before\s+update\s+of\s+([a-z0-9_,\s]+?)\s+on\s+public\.auction_sales\s+for\s+each\s+row\s+when\s*\(\s*old\.held_fields\s+is\s+not\s+null\s+or\s+new\.held_fields\s+is\s+distinct\s+from\s+old\.held_fields\s+or\s+new\.surface_source\s*=\s*'fact_registry'\s*\)\s+execute\s+function\s+app_private\.hold_projected_sale_fields\(\)\s*$/i.exec(
      holdTrigger?.[1].trim() ?? "",
    );
  if (!holdShape) {
    failures.push(
      `the hold trigger ${HOLD_TRIGGER} is missing or lost its shape (before update of the held columns, with its WHEN clause)`,
    );
  } else {
    const columns = holdShape[1].split(",").map((column) => column.trim().toLowerCase());
    for (const column of HELD_COLUMNS) {
      if (!columns.includes(column)) {
        failures.push(`the hold trigger ${HOLD_TRIGGER} no longer fires on a write of ${column}`);
      }
    }
  }
  const insertGuard = lastStatement(`${CREATE_TRIGGER}\\s+${INSERT_GUARD_TRIGGER}\\s+([^;]*)`);
  if (
    !/^before\s+insert\s+on\s+public\.auction_sales\s+for\s+each\s+row\s+when\s*\(\s*new\.held_fields\s+is\s+not\s+null\s*\)\s+execute\s+function\s+app_private\.refuse_inserted_held_fields\(\)\s*$/i.test(
      insertGuard?.[1].trim() ?? "",
    )
  ) {
    failures.push(`the insert guard ${INSERT_GUARD_TRIGGER} is missing or lost its shape`);
  }
  const roleGuard = lastStatement(`${CREATE_TRIGGER}\\s+${ROLE_GUARD_TRIGGER}\\s+([^;]*)`);
  if (
    !/^before\s+update\s+of\s+held_fields\s+on\s+public\.auction_sales\s+for\s+each\s+row\s+when\s*\(\s*new\.held_fields\s+is\s+distinct\s+from\s+old\.held_fields\s*\)\s+execute\s+function\s+app_private\.refuse_api_role_held_fields_write\(\)\s*$/i.test(
      roleGuard?.[1].trim() ?? "",
    )
  ) {
    failures.push(`the role guard ${ROLE_GUARD_TRIGGER} is missing or lost its shape`);
  }
  // Garde du marqueur (lot R2a) : mêmes colonnes que la retenue sauf held_fields, pour toute vente du registre
  // et pour toute écriture qui apporte le libellé réservé.
  const markerGuard = lastStatement(`${CREATE_TRIGGER}\\s+${MARKER_GUARD_TRIGGER}\\s+([^;]*)`);
  const markerShape =
    /^before\s+update\s+of\s+([a-z0-9_,\s]+?)\s+on\s+public\.auction_sales\s+for\s+each\s+row\s+when\s*\(\s*old\.held_fields\s+is\s+not\s+null\s+or\s+new\.surface_source\s*=\s*'fact_registry'\s*\)\s+execute\s+function\s+app_private\.refuse_sale_field_projection_marker\(\)\s*$/i.exec(
      markerGuard?.[1].trim() ?? "",
    );
  if (!markerShape) {
    failures.push(`the marker guard ${MARKER_GUARD_TRIGGER} is missing or lost its shape`);
  } else {
    const columns = markerShape[1].split(",").map((column) => column.trim().toLowerCase());
    for (const column of HELD_COLUMNS) {
      if (column !== "held_fields" && !columns.includes(column)) {
        failures.push(
          `the marker guard ${MARKER_GUARD_TRIGGER} no longer fires on a write of ${column}`,
        );
      }
    }
  }
  const markerFunction = lastDefinition(MARKER_GUARD_FUNCTION);
  if (
    !markerFunction ||
    !new RegExp(
      `current_setting\\(\\s*'${escapeRegExp(PROJECTION_MARKER)}'\\s*,\\s*true\\s*\\)\\s*,\\s*''\\s*\\)\\s*=\\s*new\\.id::text`,
      "i",
    ).test(markerFunction.body)
  ) {
    failures.push(
      `${markerFunction?.migration ?? "no migration"}: ${MARKER_GUARD_FUNCTION} no longer compares the projection marker to the sale written`,
    );
  }
  // Garde d'origine des observations : les trois natures réservées, et le triplet du pont (extracteur de
  // l'agent, identifiant de fait), que le classement range aussi en origine professionnelle.
  const originGuard = lastStatement(`${CREATE_TRIGGER}\\s+${ORIGIN_GUARD_TRIGGER}\\s+([^;]*)`);
  if (
    !/^before\s+insert\s+on\s+public\.auction_fact_claims\s+for\s+each\s+row\s+when\s*\(\s*new\.evidence_kind\s+in\s*\(\s*'professional_email'\s*,\s*'professional_form'\s*,\s*'admin_entry'\s*\)\s+or\s+new\.extractor_name\s*=\s*'information_agent'\s+or\s+new\.evidence_locator\s*\?\s*'information_agent_fact_id'\s*\)\s+execute\s+function\s+app_private\.refuse_api_role_registry_origin\(\)\s*$/i.test(
      originGuard?.[1].trim() ?? "",
    )
  ) {
    failures.push(
      `the origin guard ${ORIGIN_GUARD_TRIGGER} is missing or lost its shape (reserved kinds, extractor and fact identifier of the information agent)`,
    );
  }
  // Les gardes par rôle (held_fields, origines réservées des observations) et la garde du marqueur : SECURITY
  // INVOKER, liste d'exclusion gardée, et liste blanche depuis le lot R2a (seul le propriétaire de la projection
  // passe).
  for (const guard of [
    "app_private.refuse_api_role_held_fields_write",
    "app_private.refuse_api_role_registry_origin",
    MARKER_GUARD_FUNCTION,
  ]) {
    const roleGuardFunction = lastDefinition(guard);
    if (
      !roleGuardFunction ||
      !/security\s+invoker/i.test(roleGuardFunction.head) ||
      !/current_user\s+in\s*\(\s*'anon'\s*,\s*'authenticated'\s*,\s*'service_role'/i.test(
        roleGuardFunction.body,
      ) ||
      !/raise\s+exception\s+using\s+errcode\s*=\s*'42501'/i.test(roleGuardFunction.body)
    ) {
      failures.push(
        `${roleGuardFunction?.migration ?? "no migration"}: ${guard} no longer refuses (42501) the API roles as the calling role (security invoker)`,
      );
    } else if (
      !/proname\s*=\s*'project_sale_fields'/i.test(roleGuardFunction.body) ||
      !/pg_get_userbyid\s*\(\s*[a-z_]+\.proowner\s*\)\s+is\s+distinct\s+from\s+current_user/i.test(
        roleGuardFunction.body,
      ) ||
      !/\bnot\s+exists\s*\(/i.test(roleGuardFunction.body)
    ) {
      failures.push(
        `${roleGuardFunction.migration}: ${guard} no longer accepts only the owner of ${PROJECTION_FUNCTION} (a role created later would pass)`,
      );
    }
  }
  for (const trigger of [HOLD_TRIGGER, INSERT_GUARD_TRIGGER, ROLE_GUARD_TRIGGER]) {
    checkTriggerKept(trigger, "auction_sales", "hold of projected fields", PROJECTION_MIGRATION);
  }
  checkTriggerKept(
    MARKER_GUARD_TRIGGER,
    "auction_sales",
    "hold of projected fields",
    SEQUENCE_MIGRATION,
  );
  checkTriggerKept(
    ORIGIN_GUARD_TRIGGER,
    "auction_fact_claims",
    "reserved origins of fact claims",
    REGISTRY_MIGRATION,
  );
  checkTriggerKept(
    "auction_sale_field_hold_events_stamp",
    "auction_sale_field_hold_events",
    "order of the fact registry journals",
    REGISTRY_MIGRATION,
  );
  // Contrôle du mode des déclencheurs : il lève 55000 dès qu'un déclencheur du registre manque, n'est plus
  // « always » ou n'appelle plus sa fonction, et la liste qu'il lit nomme les douze déclencheurs.
  const assertTriggers = lastDefinition(ASSERT_TRIGGERS_FUNCTION);
  const triggerList = lastDefinition("app_private.fact_registry_triggers_not_always");
  if (
    !assertTriggers ||
    !/fact_registry_triggers_not_always\s*\(\s*\)/i.test(assertTriggers.body) ||
    !/raise\s+exception\s+using\s+errcode\s*=\s*'55000'\s*,\s*message\s*=\s*'registry_unavailable'/i.test(
      assertTriggers.body,
    )
  ) {
    failures.push(
      `${assertTriggers?.migration ?? "no migration"}: ${ASSERT_TRIGGERS_FUNCTION} no longer raises 55000 registry_unavailable when a registry trigger is not enabled always`,
    );
  }
  if (
    triggerList &&
    (!/\.tgfoid\b/i.test(triggerList.body) ||
      !/\.proname\s*=\s*expected\.function_name/i.test(triggerList.body))
  ) {
    failures.push(
      `${triggerList.migration}: app_private.fact_registry_triggers_not_always no longer checks the function bound to each trigger (tgfoid)`,
    );
  }
  if (
    triggerList &&
    (!/pg_get_triggerdef\s*\(/i.test(triggerList.body) ||
      !/\.prosecdef\s*=\s*expected\.security_definer/i.test(triggerList.body) ||
      !/\.tgtype\s*=\s*expected\.trigger_type/i.test(triggerList.body) ||
      !/\.tgattr\b/i.test(triggerList.body) ||
      !/=\s*expected\.when_clause/i.test(triggerList.body))
  ) {
    failures.push(
      `${triggerList.migration}: app_private.fact_registry_triggers_not_always no longer compares the definition of each trigger (events, columns, WHEN clause) and the security mode of its function`,
    );
  }
  for (const trigger of [
    HOLD_TRIGGER,
    INSERT_GUARD_TRIGGER,
    ROLE_GUARD_TRIGGER,
    MARKER_GUARD_TRIGGER,
    "auction_fact_claim_decisions_append_only",
    "auction_fact_claim_decisions_no_truncate",
    "auction_fact_claim_decisions_validate",
    "auction_fact_claims_no_truncate",
    "auction_fact_claims_registry_origin_guard",
    "auction_sale_field_hold_events_append_only",
    "auction_sale_field_hold_events_no_truncate",
    "auction_sale_field_hold_events_stamp",
  ]) {
    if (
      !triggerList ||
      !triggerList.body.includes(`'${trigger}'`) ||
      !/tgenabled\s*=\s*'A'/.test(triggerList.body)
    ) {
      failures.push(
        `${triggerList?.migration ?? "no migration"}: app_private.fact_registry_triggers_not_always no longer checks that ${trigger} is enabled always`,
      );
    }
  }
  // Rattrapages postérieurs au lot qui écrivent auction_sales : un déclencheur ne s'y coupe que par son nom,
  // pris parmi ceux qui sont en mode ordinaire et hors registre, et le fichier se termine par le contrôle.
  for (const [name, sql] of all) {
    if (!name.startsWith(REPAIRS_PREFIX) || !sinceLot(name, REGISTRY_MIGRATION)) continue;
    const writesSales =
      /\b(?:update\s+(?:only\s+)?(?:public\.)?auction_sales\b|delete\s+from\s+(?:only\s+)?(?:public\.)?auction_sales\b|insert\s+into\s+(?:public\.)?auction_sales\b|alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?auction_sales\b)/i.test(
        sql,
      );
    if (!writesSales) continue;
    if (
      /\b(?:dis|en)able\s+(?:always\s+|replica\s+)?trigger\s+%/i.test(sql) &&
      (!/tgenabled\s*=\s*'O'/.test(sql) || !/tgname\s+not\s+like\s+'aaab\\_%'/i.test(sql))
    ) {
      failures.push(
        `${name} switches triggers of auction_sales by a computed name without keeping to the ordinary-mode triggers outside the fact registry (tgenabled = 'O', tgname not like 'aaab\\_%')`,
      );
    }
    const lastCommit = [...sql.matchAll(/\bcommit\s*;/gi)].at(-1);
    const lastAssert = [
      ...sql.matchAll(/select\s+app_private\.assert_fact_registry_triggers\s*\(\s*\)\s*;/gi),
    ].at(-1);
    if (
      !lastCommit ||
      !lastAssert ||
      lastAssert.index > lastCommit.index ||
      /\b(?:update|delete|insert|alter)\b/i.test(
        sql.slice(lastAssert.index + lastAssert[0].length, lastCommit.index),
      )
    ) {
      failures.push(
        `${name} writes auction_sales without ending by select ${ASSERT_TRIGGERS_FUNCTION}(); before its commit`,
      );
    }
  }
  for (const [name, sql] of all) {
    for (const match of sql.matchAll(
      /create\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+([a-z0-9_]+)\s+before\s+([^;]*?)\s+on\s+(?:public\.)?auction_sales\b/gi,
    )) {
      const trigger = match[1].toLowerCase();
      if (!/\bupdate\b/i.test(match[2])) continue;
      if (
        trigger < HOLD_TRIGGER &&
        trigger !== RETENTION_GUARD_TRIGGER &&
        trigger !== ROLE_GUARD_TRIGGER &&
        trigger !== MARKER_GUARD_TRIGGER
      ) {
        failures.push(
          `${name} creates the BEFORE UPDATE trigger ${trigger} on auction_sales, which runs before ${HOLD_TRIGGER}: it would judge values that the hold then restores`,
        );
      }
    }
  }
  const holdFunction = lastDefinition(HOLD_FUNCTION);
  if (!holdFunction) {
    failures.push(`${HOLD_FUNCTION} is not defined by a migration`);
  } else {
    const passive = [
      [
        /to_jsonb\s*\(\s*(?:new|old)\s*\)/i,
        "converts the whole row (to_jsonb(new) or to_jsonb(old))",
      ],
      [/\braw_payload\b/i, "reads raw_payload"],
      [
        /\bauction_fact_claims\b|\bauction_fact_claim_decisions\b|\bauction_fact_source_precedence\b/i,
        "reads the claims, the decisions or the precedence",
      ],
      [/\bproject_sale_fields\s*\(/i, "calls the projection"],
    ];
    for (const [pattern, reason] of passive) {
      if (pattern.test(holdFunction.body)) {
        failures.push(
          `${holdFunction.migration}: ${HOLD_FUNCTION} ${reason}: the hold trigger must stay passive`,
        );
      }
    }
    if (
      !/raise\s+exception\s+using\s+errcode\s*=\s*'42501'/i.test(holdFunction.body) ||
      !/new\.held_fields\s+is\s+distinct\s+from\s+old\.held_fields/i.test(holdFunction.body)
    ) {
      failures.push(
        `${holdFunction.migration}: ${HOLD_FUNCTION} no longer refuses (42501) a write of held_fields outside the projection`,
      );
    }
  }

  // 5. field-projection-not-callable-by-api ---------------------------------------------------------------------
  const projection = lastDefinition(PROJECTION_FUNCTION);
  if (!projection) {
    failures.push(`${PROJECTION_FUNCTION} is not defined by a migration`);
  } else if (
    !/security\s+definer/i.test(projection.head) ||
    !/set\s+search_path\s*=\s*''/i.test(projection.head)
  ) {
    failures.push(
      `${projection.migration}: ${PROJECTION_FUNCTION} is not SECURITY DEFINER with an empty search_path`,
    );
  }
  // Fonctions publiques du lot R2a : fermées aux rôles du navigateur, ouvertes à service_role seul.
  for (const fn of SERVER_ONLY_RPCS) {
    const signature = `${escapeRegExp(fn)}\\([^)]*\\)`;
    const definition = lastDefinition(fn);
    if (
      !definition ||
      !/security\s+definer/i.test(definition.head) ||
      !/set\s+search_path\s*=\s*''/i.test(definition.head)
    ) {
      failures.push(
        `${definition?.migration ?? "no migration"}: ${fn} is not SECURITY DEFINER with an empty search_path`,
      );
    }
    if (
      !new RegExp(
        `revoke\\s+all\\s+on\\s+function\\s+${signature}\\s+from\\s+public,\\s*anon,\\s*authenticated\\s*;`,
        "i",
      ).test(allSql)
    ) {
      failures.push(`${fn} is not revoked from public, anon and authenticated`);
    }
    for (const [name, sql] of all) {
      for (const grant of sql.matchAll(/\bgrant\b[^;]*/gi)) {
        if (!new RegExp(`\\b${escapeRegExp(fn)}\\b`, "i").test(grant[0])) continue;
        if (
          !new RegExp(
            `^grant\\s+execute\\s+on\\s+function\\s+${signature}\\s+to\\s+service_role\\s*$`,
            "i",
          ).test(grant[0])
        ) {
          failures.push(
            `${name} grants on ${fn} something else than EXECUTE to service_role alone (no browser role may call it)`,
          );
        }
      }
    }
  }
  for (const fn of [PROJECTION_FUNCTION, HOLD_FUNCTION, ...INTERNAL_FUNCTIONS]) {
    const signature = `${escapeRegExp(fn)}\\([^)]*\\)`;
    if (
      !new RegExp(
        `revoke\\s+all\\s+on\\s+function\\s+${signature}\\s+from\\s+public,\\s*anon,\\s*authenticated,\\s*service_role`,
        "i",
      ).test(allSql)
    ) {
      failures.push(`${fn} is not revoked from public, anon, authenticated and service_role`);
    }
    for (const [name, sql] of all) {
      if (
        new RegExp(
          `\\bgrant\\b[^;]*\\bon\\s+(?:function|routine|procedure)\\s+[^;]*\\b${escapeRegExp(fn)}\\b`,
          "i",
        ).test(sql)
      ) {
        failures.push(`${name} grants a privilege on ${fn}: no API role may execute it`);
      }
    }
  }
  for (const [name, sql] of all) {
    if (
      sinceLot(name, PROJECTION_MIGRATION) &&
      /\bgrant\s+(?:execute|all)(?:\s+privileges)?\s+on\s+all\s+(?:functions|routines|procedures)\s+in\s+schema\s+[^;]*\bapp_private\b/i.test(
        sql,
      )
    ) {
      failures.push(
        `${name} grants every function of app_private at once: it would open ${PROJECTION_FUNCTION}`,
      );
    }
    // Même chose pour le schéma public, vers un rôle du navigateur : les trois fonctions du lot R2a sont
    // réservées à service_role.
    if (
      sinceLot(name, SEQUENCE_MIGRATION) &&
      /\bgrant\s+(?:execute|all)(?:\s+privileges)?\s+on\s+all\s+(?:functions|routines|procedures)\s+in\s+schema\s+[^;]*\bpublic\b[^;]*\bto\b[^;]*\b(?:anon|authenticated|public)\b/i.test(
        sql,
      )
    ) {
      failures.push(
        `${name} grants every function of the public schema to a browser role: it would open ${SERVER_ONLY_RPCS.join(", ")}`,
      );
    }
  }

  // Aucune instruction ALTER FUNCTION sur une fonction du registre : « security definer » sur une garde lui
  // ferait lire le propriétaire au lieu du rôle appelant, « owner to » sur la projection changerait le seul rôle
  // que les gardes acceptent. Une fonction se redéfinit par CREATE OR REPLACE, que ces invariants relisent.
  for (const [name, sql] of all) {
    if (!sinceLot(name, REGISTRY_MIGRATION)) continue;
    for (const statement of sql.matchAll(/\balter\s+(?:function|routine|procedure)\b[^;]*/gi)) {
      for (const fn of UNALTERABLE_FUNCTIONS) {
        if (new RegExp(`\\b${escapeRegExp(fn)}\\b`, "i").test(statement[0])) {
          failures.push(
            `${name} alters ${fn} (security mode, owner or settings): a function of the fact registry is only redefined by create or replace`,
          );
        }
      }
    }
  }
  // Propriétaire des tables, de la vue et de la séquence du registre : aucune instruction OWNER TO ne les nomme,
  // et aucun fichier ne contient REASSIGN OWNED (qui change tous les propriétaires d'un rôle d'un coup).
  for (const [name, sql] of all) {
    if (!sinceLot(name, REGISTRY_MIGRATION)) continue;
    if (/\breassign\s+owned\b/i.test(sql)) {
      failures.push(
        `${name} reassigns owned objects (reassign owned): the tables of the fact registry and auction_sales keep the owner of ${PROJECTION_FUNCTION}`,
      );
    }
    for (const statement of sql.matchAll(/\balter\s[^;]*?\bowner\s+to\b[^;]*/gi)) {
      for (const object of OWNED_OBJECTS) {
        if (new RegExp(`\\b${object}\\b`, "i").test(statement[0])) {
          failures.push(
            `${name} changes the owner of ${object}: the objects of the fact registry keep the owner of ${PROJECTION_FUNCTION}`,
          );
        }
      }
    }
  }
  // 12. set-config-literal-name : toutes les migrations sont lues ici (pas seulement celles du registre), avec
  // les rattrapages et les fichiers de maintenance. Le premier argument est une constante, suivie d'une virgule.
  const settingSources = new Map(all);
  for (const [name, source] of migrationSources) {
    if (!settingSources.has(name) && /set_config/i.test(source)) {
      settingSources.set(name, stripSql(source));
    }
  }
  for (const [name, sql] of settingSources) {
    for (const call of sql.matchAll(/\bset_config\s*\(/gi)) {
      if (!/^\s*'[a-z_][a-z0-9_.]*'\s*,/i.test(sql.slice(call.index + call[0].length))) {
        failures.push(
          `${name} calls set_config with a first argument that is not a literal setting name: a relayed name could set the transaction marker ${PROJECTION_MARKER}`,
        );
      }
    }
  }
  // La fonction interne qui synchronise les alertes à partir d'un rapport n'est appelée que par la fonction
  // publique sans paramètre : toute autre fonction lui passerait un rapport de son choix.
  for (const definition of definitions) {
    if (
      definition.name !== ALERTS_FUNCTION &&
      definition.name !== ALERTS_FROM_REPORT_FUNCTION &&
      /\bsync_fact_registry_alerts_from_report\s*\(/i.test(definition.body)
    ) {
      failures.push(
        `${definition.migration}: ${definition.name} calls ${ALERTS_FROM_REPORT_FUNCTION}: only ${ALERTS_FUNCTION} may hand it a report`,
      );
    }
  }
  // lot_ref : la dernière définition de la contrainte porte le motif structurel, et aucun fichier ne la retire
  // sans la reposer telle quelle.
  const lotRefExact = new RegExp(
    `add\\s+constraint\\s+${LOT_REF_CONSTRAINT}\\s+check\\s*\\(\\s*lot_ref\\s+is\\s+null\\s+or\\s+lot_ref\\s*~\\*\\s*'${escapeRegExp(LOT_REF_PATTERN)}'\\s*\\)`,
    "i",
  );
  const lastLotRef = lastStatement(`add\\s+constraint\\s+${LOT_REF_CONSTRAINT}\\b[^;]*`);
  if (!lastLotRef || !lotRefExact.test(lastLotRef[0])) {
    failures.push(
      `the constraint ${LOT_REF_CONSTRAINT} is missing or no longer bounds lot_ref by its structural pattern (lot numbers only)`,
    );
  }
  for (const [name, sql] of all) {
    if (!mentions(name, LOT_REF_CONSTRAINT)) continue;
    const drop = new RegExp(
      `drop\\s+constraint\\s+(?:if\\s+exists\\s+)?${LOT_REF_CONSTRAINT}\\b`,
      "gi",
    );
    for (const match of sql.matchAll(drop)) {
      if (!lotRefExact.test(sql.slice(match.index))) {
        failures.push(
          `${name} drops the constraint ${LOT_REF_CONSTRAINT} without restoring its structural pattern`,
        );
      }
    }
    if (new RegExp(`rename\\s+constraint\\s+${LOT_REF_CONSTRAINT}\\b`, "i").test(sql)) {
      failures.push(`${name} renames the constraint ${LOT_REF_CONSTRAINT}`);
    }
  }

  // 3 et 5, côté code : ni l'application, ni le pipeline, ni un script, ni une fonction Edge ne nomment la
  // colonne, la projection ou son marqueur. Le texte est cherché tel quel, commentaires compris.
  const codeRoots = [
    { url: "../src/", path: "src/" },
    { url: "../services/data-pipeline/src/", path: "services/data-pipeline/src/" },
    { url: "../scripts/", path: "scripts/" },
    { url: "../supabase/functions/", path: "supabase/functions/" },
  ];
  for (const root of codeRoots) {
    let entries;
    try {
      entries = await readSourceTree(new URL(root.url, baseUrl));
    } catch (error) {
      failures.push(
        `${root.path} cannot be read to check the fact registry (${error.code ?? "error"})`,
      );
      continue;
    }
    for (const entry of entries) {
      const name = String(entry);
      if (!/\.(?:ts|tsx|mjs|cjs|js|py)$/.test(name)) continue;
      if (/\.test\.[cm]?[jt]sx?$/.test(name) || /(?:^|\/)test_[^/]*\.py$/.test(name)) continue;
      const relative = `${root.path}${name}`;
      if (CODE_EXEMPTIONS.has(relative)) continue;
      let source = await readSourceText(new URL(`${root.url}${name}`, baseUrl));
      // Textes admis mot pour mot dans ce fichier : retirés avant la recherche, le reste est lu tel quel.
      // (le plus long d'abord : un texte admis peut en contenir un autre.)
      const allowedFragments = [...(CODE_ALLOWED_FRAGMENTS.get(relative) ?? [])].sort(
        (left, right) => right.length - left.length,
      );
      for (const fragment of allowedFragments) {
        source = source.split(fragment).join("");
      }
      for (const [word, reason] of FORBIDDEN_IN_CODE) {
        if (source.includes(word)) failures.push(`${relative} ${reason}`);
      }
      // Dans l'application, les fonctions publiques du registre ne sont nommées que par un module serveur :
      // rien de ce lot n'entre dans un bundle servi au navigateur.
      if (root.path === "src/" && !SERVER_RPC_CALLERS.has(relative)) {
        for (const fn of SERVER_ONLY_RPCS) {
          const rpc = fn.slice("public.".length);
          if (source.includes(rpc)) {
            failures.push(
              `${relative} names ${fn}: in the application only src/lib/fact-registry-check.ts (server-only) may`,
            );
          }
        }
      }
    }
  }
  try {
    const caller = await readSourceText(new URL("../src/lib/fact-registry-check.ts", baseUrl));
    if (!/^import "server-only";$/m.test(caller)) {
      failures.push(
        'src/lib/fact-registry-check.ts does not import "server-only": the fact registry check must never be bundled for the browser',
      );
    }
  } catch (error) {
    failures.push(
      `src/lib/fact-registry-check.ts cannot be read to check the fact registry (${error.code ?? "error"})`,
    );
  }

  // 6. fact-claims-never-repointed ------------------------------------------------------------------------------
  for (const [name, sql] of all) {
    if (!mentions(name, "auction_fact_claims")) continue;
    for (const statement of sql.split(";")) {
      const update = /\bupdate\s+(?:only\s+)?(?:public\.)?auction_fact_claims\b([\s\S]*)$/i.exec(
        statement,
      );
      if (!update) continue;
      for (const assignment of update[1].matchAll(/\bauction_sale_id\s*=\s*([^\s,;)]+)/gi)) {
        const before = update[1].slice(0, assignment.index);
        // Une affectation est dans la clause SET, avant le WHERE ou le FROM de l'instruction.
        if (
          !/\bset\b/i.test(before) ||
          /\b(?:where|from)\b/i.test(before.split(/\bset\b/i).at(-1))
        ) {
          continue;
        }
        if (!/^null$/i.test(assignment[1])) {
          failures.push(
            `${name} re-points a fact claim to another sale (auction_fact_claims.auction_sale_id = ${assignment[1]}): a claim is only ever detached`,
          );
        }
      }
    }
  }
  const guards = definitions.filter(
    (entry) => entry.name === "app_private.guard_auction_fact_claim_mutation",
  );
  if (!guards.length) {
    failures.push("app_private.guard_auction_fact_claim_mutation is not defined by a migration");
  }
  for (const guard of guards) {
    if (
      !/old\.auction_sale_id\s+is\s+not\s+null\s+and\s+new\.auction_sale_id\s+is\s+null/i.test(
        guard.body,
      ) ||
      !/Fact claim observations and provenance are immutable\./.test(guard.body)
    ) {
      failures.push(
        `${guard.migration} redefines app_private.guard_auction_fact_claim_mutation without its detach-only clause`,
      );
    }
  }
  checkTriggerKept(
    "auction_fact_claims_guard_mutation",
    "auction_fact_claims",
    "immutable fact claims",
    FACT_CLAIMS_MIGRATION,
    false,
  );

  // 7. registry-no-fk-to-auction-sales --------------------------------------------------------------------------
  for (const table of REGISTRY_TABLES) {
    for (const [name, sql] of all) {
      if (!mentions(name, table)) continue;
      for (const statement of sql.split(";")) {
        if (
          !new RegExp(
            `(?:create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?|alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?)(?:public\\.)?${table}\\b`,
            "i",
          ).test(statement)
        ) {
          continue;
        }
        if (/\breferences\s+(?:public\.)?auction_sales\b/i.test(statement)) {
          failures.push(
            `${name} gives public.${table} a foreign key to auction_sales (lock on the hot table, and a cascade would lose the audit trail)`,
          );
        }
      }
    }
  }

  // 8. held-fields-never-returned -------------------------------------------------------------------------------
  // Dernière définition de chaque fonction du schéma public (les fonctions app_private ne sont pas exposées).
  const publicFunctions = new Map();
  for (const definition of definitions) {
    if (definition.name.startsWith("public.")) publicFunctions.set(definition.name, definition);
  }
  const HELD_FIELDS_READERS = new Set([BASELINES_FUNCTION, CHECK_FUNCTION, HISTORY_FUNCTION]);
  for (const [fn, definition] of publicFunctions) {
    if (
      /\breturns\s+(?:setof\s+)?(?:public\.)?auction_sales\b/i.test(definition.head) ||
      /\breturns\s+table\b[^$]*\bauction_sales%rowtype/i.test(definition.head)
    ) {
      failures.push(
        `${definition.migration}: ${fn} returns a whole auction_sales row (it would hand held_fields and raw_payload to its caller)`,
      );
    }
    if (
      /\b(?:update|insert\s+into|delete\s+from)\s+(?:only\s+)?(?:public\.)?auction_sales\b[^;]*\breturning\s+(?:[a-z_]+\.)?\*/i.test(
        definition.body,
      )
    ) {
      failures.push(
        `${definition.migration}: ${fn} writes auction_sales with RETURNING *: name the columns it needs`,
      );
    }
    if (/\bheld_fields\b/i.test(definition.body) && !HELD_FIELDS_READERS.has(fn)) {
      failures.push(
        `${definition.migration}: ${fn} names auction_sales.held_fields: in the public schema only ${[...HELD_FIELDS_READERS].join(", ")} may`,
      );
    }
    // Une fonction exposée ne lit aucune table du registre et n'enveloppe aucune de ses trois fonctions : elle
    // les rendrait à ses propres appelants, quels que soient les droits des fonctions enveloppées.
    if (!SERVER_ONLY_RPCS.includes(fn)) {
      for (const table of REGISTRY_TABLES) {
        if (new RegExp(`\\b${table}\\b`, "i").test(definition.body)) {
          failures.push(
            `${definition.migration}: ${fn} reads public.${table}: in the public schema only ${SERVER_ONLY_RPCS.join(", ")} read the fact registry`,
          );
        }
      }
      for (const rpc of SERVER_ONLY_RPCS) {
        if (
          new RegExp(`\\b${escapeRegExp(rpc.slice("public.".length))}\\s*\\(`, "i").test(
            definition.body,
          )
        ) {
          failures.push(
            `${definition.migration}: ${fn} wraps ${rpc}: no other function of the public schema may call it`,
          );
        }
      }
    }
  }
  const baselines = lastDefinition(BASELINES_FUNCTION);
  if (!baselines) {
    failures.push(`${BASELINES_FUNCTION} is not defined by a migration`);
  } else {
    for (const key of ENTRY_KEYS_NEVER_SERVED) {
      if (baselines.body.includes(`'${key}'`)) {
        failures.push(
          `${baselines.migration}: ${BASELINES_FUNCTION} reads the key '${key}' of a held entry: it only serves the listing value of held fields`,
        );
      }
    }
    // L'entrée n'est jamais rendue entière : chaque lecture de entry.value prend une clé (-> ou ->>).
    if (
      /\bentry\.value\b(?!\s*->)/i.test(baselines.body) ||
      /\bto_jsonb\s*\(\s*(?:sale|entry)\s*\)|\b(?:sale|entry)\.\*/i.test(baselines.body) ||
      !/entry\.value\s*->>\s*'state'\s+in\s*\(\s*'held'\s*,\s*'conflicted'\s*\)/i.test(
        baselines.body,
      )
    ) {
      failures.push(
        `${baselines.migration}: ${BASELINES_FUNCTION} must read a held entry key by key, for held fields only (state held or conflicted)`,
      );
    }
  }

  // 9. fact-registry-check-read-only ----------------------------------------------------------------------------
  const WRITE_STATEMENT =
    /\binsert\s+into\b|\bupdate\s+(?:only\s+)?[a-z_.]+\s+(?:(?:as\s+)?[a-z_]+\s+)?set\b|\bdelete\s+from\b|\btruncate\b|\bset_config\s*\(|\bnextval\s*\(|\bsetval\s*\(|\balter\s+table\b/i;
  const check = lastDefinition(CHECK_FUNCTION);
  if (!check) {
    failures.push(`${CHECK_FUNCTION} is not defined by a migration`);
  } else {
    const projectionCalls = [...check.body.matchAll(/project_sale_fields\s*\(([^()]*)\)/gi)];
    // Deux appels : la passe, puis le rejeu des ventes en dérive ; tous deux en simulation.
    if (
      projectionCalls.length !== 2 ||
      projectionCalls.some((call) => !/^\s*[a-z_.]+\s*,\s*null\s*,\s*false\s*$/i.test(call[1]))
    ) {
      failures.push(
        `${check.migration}: ${CHECK_FUNCTION} must call the projection as a simulation only (third argument false, written literally), once in its pass and once in its replay`,
      );
    }
    if (WRITE_STATEMENT.test(check.body) || !/\bstable\b/i.test(check.head)) {
      failures.push(
        `${check.migration}: ${CHECK_FUNCTION} is not a stable function without any write statement`,
      );
    }
    if (/\b(?:to_jsonb\s*\(\s*sale\s*\)|sale\.\*)/i.test(check.body)) {
      failures.push(`${check.migration}: ${CHECK_FUNCTION} converts the whole sale row`);
    }
  }
  // La fonction publique ne prend aucun paramètre (ni borne, ni rapport) : elle lance le contrôle avec sa borne
  // par défaut et passe le rapport à la fonction interne, seule à toucher les alertes.
  const alerts = lastDefinition(ALERTS_FUNCTION);
  const alertsFromReport = lastDefinition(ALERTS_FROM_REPORT_FUNCTION);
  if (!alerts) {
    failures.push(`${ALERTS_FUNCTION} is not defined by a migration`);
  } else if (
    !/sync_fact_registry_alerts\s*\(\s*\)\s*returns\b/i.test(alerts.head) ||
    WRITE_STATEMENT.test(alerts.body) ||
    /project_sale_fields|sync_operational_alert/i.test(alerts.body) ||
    !/check_fact_registry_consistency\s*\(\s*\)/i.test(alerts.body) ||
    !/app_private\.sync_fact_registry_alerts_from_report\s*\(/i.test(alerts.body)
  ) {
    failures.push(
      `${alerts.migration}: ${ALERTS_FUNCTION} must take no parameter and only run the check, with its default bound, then hand its report to ${ALERTS_FROM_REPORT_FUNCTION}`,
    );
  }
  if (!alertsFromReport) {
    failures.push(`${ALERTS_FROM_REPORT_FUNCTION} is not defined by a migration`);
  } else if (
    WRITE_STATEMENT.test(alertsFromReport.body) ||
    /project_sale_fields/i.test(alertsFromReport.body) ||
    !/app_private\.sync_operational_alert\s*\(\s*'fact_registry\.'\s*\|\|/i.test(
      alertsFromReport.body,
    ) ||
    [...alertsFromReport.body.matchAll(/sync_operational_alert\s*\(/gi)].length !== 1
  ) {
    failures.push(
      `${alertsFromReport.migration}: ${ALERTS_FROM_REPORT_FUNCTION} must only open or close fact_registry.* alerts through app_private.sync_operational_alert`,
    );
  } else if (
    !/continue\s+when\s+v_truncated\s+and\s+not\s+v_active\s*;/i.test(alertsFromReport.body) ||
    alertsFromReport.body.search(/continue\s+when\s+v_truncated/i) >
      alertsFromReport.body.search(/sync_operational_alert\s*\(/i)
  ) {
    failures.push(
      `${alertsFromReport.migration}: ${ALERTS_FROM_REPORT_FUNCTION} no longer skips the inactive checks of a truncated report (a partial report would close an alert)`,
    );
  }

  // 10. registry-neutral-surface-labels -------------------------------------------------------------------------
  if (projection) {
    if (
      /'fact_registry[^']*'\s*\|\||\|\|\s*'fact_registry|'fact_registry_/i.test(projection.body) ||
      !/t_surface_source\s*:=\s*'fact_registry'\s*;/i.test(projection.body) ||
      !/t_app_surface_kind\s*:=\s*'built'\s*;/i.test(projection.body) ||
      /t_(?:surface_source|app_surface_kind)\s*:=\s*[^;]*v_winner_source_kind/i.test(
        projection.body,
      )
    ) {
      failures.push(
        `${projection.migration}: ${PROJECTION_FUNCTION} must write neutral surface labels (surface_source 'fact_registry', app_surface_kind 'built'), never the origin of the piece`,
      );
    }
  }
  // Le libellé du registre est réservé à la projection : hors d'elle, la retenue le refuse sur une surface non
  // tenue (la clause WHEN du déclencheur, contrôlée plus haut, l'appelle pour ce cas).
  if (
    holdFunction &&
    !/new\.surface_source\s+is\s+not\s+distinct\s+from\s+'fact_registry'\s+and\s+old\.surface_source\s+is\s+distinct\s+from\s+'fact_registry'/i.test(
      holdFunction.body,
    )
  ) {
    failures.push(
      `${holdFunction.migration}: ${HOLD_FUNCTION} no longer reserves the surface label 'fact_registry' to the projection`,
    );
  }

  // 11. fact-claims-generation-pattern ------------------------------------------------------------------------
  // La vue ne masque une ancienne génération que si elle lit la version par sa fonction ; la collecte doit écrire
  // un extracteur et une version que cette fonction lit, sous le plafond, sinon rien ne serait masqué (ou tout).
  const viewName = CLAIMS_VIEW.slice("public.".length);
  const viewDefinition = lastStatement(
    `create\\s+or\\s+replace\\s+view\\s+${escapeRegExp(CLAIMS_VIEW)}\\b([^;]*)`,
  );
  const extractorsInView = [
    ...(viewDefinition?.[1] ?? "").matchAll(/extractor_name\s*=\s*'([^']+)'/gi),
  ].map((match) => match[1]);
  const extractorInView = extractorsInView[0];
  const generation = lastDefinition(GENERATION_FUNCTION);
  const ceiling = lastDefinition(GENERATION_CEILING_FUNCTION);
  const ceilingValue = /^\s*select\s+([0-9]{1,2})\s*;?\s*$/i.exec(ceiling?.body ?? "")?.[1];
  for (const [name, sql] of all) {
    if (!mentions(name, viewName)) continue;
    if (
      new RegExp(`alter\\s+view\\s+(?:if\\s+exists\\s+)?(?:public\\.)?${viewName}\\b`, "i").test(
        sql,
      )
    ) {
      failures.push(
        `${name} alters ${CLAIMS_VIEW} (its security_invoker option or its owner): the view is only redefined by create or replace view, with security_invoker = true`,
      );
    }
    for (const grant of sql.matchAll(/\bgrant\b[^;]*/gi)) {
      if (!new RegExp(`\\b${viewName}\\b`, "i").test(grant[0])) continue;
      if (
        !new RegExp(
          `^grant\\s+select\\s+on\\s+(?:table\\s+)?${escapeRegExp(CLAIMS_VIEW)}\\s+to\\s+service_role\\s*$`,
          "i",
        ).test(grant[0])
      ) {
        failures.push(
          `${name} grants on ${CLAIMS_VIEW} something else than SELECT to service_role alone (claim evidence is not readable by a browser role)`,
        );
      }
    }
  }
  if (
    !viewDefinition ||
    !/with\s*\(\s*security_invoker\s*=\s*true\s*\)/i.test(viewDefinition[1]) ||
    extractorsInView.length !== 2 ||
    extractorsInView[1] !== extractorInView ||
    !/app_private\.fact_claims_generation\s*\(\s*claim\.extractor_version\s*\)\s*<\s*latest\.generation/i.test(
      viewDefinition[1],
    ) ||
    !/app_private\.fact_claims_generation_ceiling\s*\(\s*\)/i.test(viewDefinition[1]) ||
    /regexp|extractor_version\s*[<>]/i.test(viewDefinition[1])
  ) {
    failures.push(
      `${CLAIMS_VIEW} no longer reads the generation of the pipeline claims through ${GENERATION_FUNCTION}, under its ceiling, for one extractor, with security_invoker = true`,
    );
  } else if (
    !generation ||
    !generation.body.includes(`'${GENERATION_PREFIX}'`) ||
    !/length\s*\(\s*p_version\s*\)\s+in\s*\(\s*22\s*,\s*23\s*\)/i.test(generation.body) ||
    !/translate\s*\(/i.test(generation.body) ||
    /regexp/i.test(generation.body) ||
    ceilingValue === undefined
  ) {
    failures.push(
      `${GENERATION_FUNCTION} and ${GENERATION_CEILING_FUNCTION} must read one or two digits after '${GENERATION_PREFIX}' without a regular expression, under a literal ceiling`,
    );
  } else {
    try {
      const pipeline = await readSourceText(new URL(PIPELINE_FACT_CLAIMS, baseUrl));
      const version = /^FACT_CLAIMS_VERSION\s*=\s*"([^"]*)"\s*$/m.exec(pipeline)?.[1];
      const extractor = /^FACT_CLAIMS_EXTRACTOR\s*=\s*"([^"]*)"\s*$/m.exec(pipeline)?.[1];
      const written = new RegExp(`^${escapeRegExp(GENERATION_PREFIX)}([0-9]{1,2})$`).exec(
        version ?? "",
      )?.[1];
      if (written === undefined) {
        failures.push(
          `services/data-pipeline/src/fact_claims.py: FACT_CLAIMS_VERSION (${version ?? "missing"}) is not '${GENERATION_PREFIX}' followed by one or two digits: ${CLAIMS_VIEW} could not order its generation`,
        );
      } else if (Number(written) > Number(ceilingValue)) {
        failures.push(
          `services/data-pipeline/src/fact_claims.py: FACT_CLAIMS_VERSION (${version}) is above the generation ceiling (${ceilingValue}) of ${GENERATION_CEILING_FUNCTION}: its claims would be hidden; raise the ceiling by a migration first`,
        );
      }
      if (extractor !== extractorInView) {
        failures.push(
          `services/data-pipeline/src/fact_claims.py: FACT_CLAIMS_EXTRACTOR (${extractor ?? "missing"}) is not the extractor that ${CLAIMS_VIEW} filters (${extractorInView})`,
        );
      }
    } catch (error) {
      failures.push(
        `services/data-pipeline/src/fact_claims.py cannot be read to check the fact claims generation (${error.code ?? "error"})`,
      );
    }
  }
}
