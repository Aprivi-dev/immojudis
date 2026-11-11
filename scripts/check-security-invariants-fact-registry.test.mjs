// Invariants du registre des pièces (scripts/check-security-invariants-fact-registry.mjs, lot R1) et verrous
// ajoutés pour lui à information-agent-no-automatic-publication-path.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { removeSandboxes, runInvariants } from "./check-security-invariants-harness.mjs";

// Chaque passage lance le script d'invariants sur un dépôt factice : 20 s pour tout le fichier.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

afterAll(removeSandboxes);

describe("invariants de sécurité : registre des pièces (lot R1)", () => {
  const heldColumns =
    "surface_m2, app_surface_m2, app_surface_kind, surface_source, surface_confidence, land_surface_m2, rooms_count, bedrooms_count, occupancy_status, visit_dates, held_fields";
  const holdWhen =
    "when (old.held_fields is not null or new.held_fields is distinct from old.held_fields)";
  const always = (table, trigger) =>
    `alter table public.${table} enable always trigger ${trigger};`;
  const holdTrigger = (columns, when) => `
create or replace trigger aaab_auction_sales_hold_projected_fields
  before update of ${columns}
  on public.auction_sales
  for each row
  ${when}
  execute function app_private.hold_projected_sale_fields();
${always("auction_sales", "aaab_auction_sales_hold_projected_fields")}`;
  const triggerFunction = (name, body, options = "security definer set search_path = ''") => `
create or replace function ${name}()
returns trigger language plpgsql ${options} as $$
begin
  ${body}
end;
$$;`;
  const decision = (columns, values) =>
    `insert into public.auction_fact_claim_decisions (claim_id, sale_id, decision, lot_attachment, actor_kind${columns}) ${values};`;
  const inFunction = (sql) =>
    triggerFunction("app_private.registry_test_writer", `${sql} return null;`);
  const migration = (slug) => `99990101000000_${slug}.sql`;

  // Un contournement par fichier : chaque échec nomme son fichier, un seul passage du script suffit donc à les
  // vérifier un par un (content nul : même fichier que l'entrée précédente, autre échec attendu). Les contrôles
  // qui lisent la DERNIÈRE définition d'un objet (forme d'un déclencheur, fonctions) portent ici sur des objets
  // différents ; le seul autre cas du déclencheur de retenue a son propre passage, plus bas.
  // where : dossier du fichier ; prefix : ce qui sépare son nom du message (nul : l'échec ne nomme pas de fichier).
  const bypasses = [
    {
      label: "une écriture accordée au rôle de service sur le journal des décisions",
      file: migration("registry_grant_write"),
      content: "grant insert, update on table public.auction_fact_claim_decisions to service_role;",
      message:
        "grants on public.auction_fact_claim_decisions something else than SELECT to service_role alone",
    },
    {
      label: "une lecture des champs accordée à un rôle du navigateur",
      file: migration("registry_grant_browser"),
      content: "grant select on public.auction_fact_fields to authenticated;",
      message:
        "grants on public.auction_fact_fields something else than SELECT to service_role alone",
    },
    {
      label: "un droit donné dans un bloc DO",
      file: migration("registry_grant_in_do"),
      content: "do $$ begin grant select on public.auction_fact_source_precedence to anon; end $$;",
      message:
        "grants on public.auction_fact_source_precedence something else than SELECT to service_role alone",
    },
    {
      label: "un droit donné par EXECUTE FORMAT sur une table nommée",
      file: migration("registry_grant_format"),
      content:
        "do $$ begin execute format('grant select on %I.%I to %I', 'public', 'auction_sale_field_hold_events', 'authenticated'); end $$;",
      message:
        "grants on public.auction_sale_field_hold_events something else than SELECT to service_role alone",
    },
    {
      label: "un droit donné par du SQL dynamique dont la cible ne se lit pas",
      file: migration("registry_grant_dynamic"),
      content:
        "do $$ declare v_table text := 'x'; begin execute 'grant select on ' || v_table || ' to anon'; end $$;",
      message: "grants a privilege through dynamic SQL (execute)",
    },
    {
      label: "toutes les tables du schéma public accordées d'un coup",
      file: migration("public_grant_all_tables"),
      content: "grant all on all tables in schema public to authenticated;",
      message: "grants every table of the public schema at once",
    },
    {
      label: "une politique sur la file des évènements",
      file: migration("registry_policy"),
      content:
        "create policy events_read on public.auction_sale_field_hold_events for select to authenticated using (true);",
      message: "opens public.auction_sale_field_hold_events with a policy",
    },
    {
      label: "la RLS désactivée sur la préséance",
      file: migration("registry_rls_off"),
      content: "alter table public.auction_fact_source_precedence disable row level security;",
      message: "disables row level security on public.auction_fact_source_precedence",
    },
    {
      label: "le déclencheur d'ajout seul du journal supprimé",
      file: migration("journal_drop_guard"),
      content:
        "drop trigger if exists auction_fact_claim_decisions_append_only on public.auction_fact_claim_decisions;",
      message:
        "drops the trigger auction_fact_claim_decisions_append_only of public.auction_fact_claim_decisions without recreating it",
    },
    {
      label: "le déclencheur de validation des décisions supprimé",
      file: migration("journal_drop_validation"),
      content:
        "drop trigger auction_fact_claim_decisions_validate on public.auction_fact_claim_decisions;",
      message:
        "drops the trigger auction_fact_claim_decisions_validate of public.auction_fact_claim_decisions without recreating it",
    },
    {
      label: "un déclencheur d'ajout seul recréé sans « enable always »",
      file: migration("journal_guard_not_always"),
      content:
        "create or replace trigger auction_fact_claim_decisions_no_truncate before truncate on public.auction_fact_claim_decisions for each statement execute function app_private.fact_registry_append_only();",
      message:
        "creates the trigger auction_fact_claim_decisions_no_truncate of public.auction_fact_claim_decisions without enabling it always",
    },
    {
      label: "les déclencheurs de la file des évènements désactivés",
      file: migration("events_disable_triggers"),
      content: "alter table public.auction_sale_field_hold_events disable trigger all;",
      message:
        "disables the trigger auction_sale_field_hold_events_no_truncate of public.auction_sale_field_hold_events",
    },
    {
      label: "le vidage des observations de nouveau permis",
      file: migration("claims_drop_truncate_guard"),
      content: "drop trigger auction_fact_claims_no_truncate on public.auction_fact_claims;",
      message:
        "drops the trigger auction_fact_claims_no_truncate of public.auction_fact_claims without recreating it",
    },
    {
      label: "une migration qui passe en session_replication_role",
      file: migration("replica_mode"),
      content:
        "set local session_replication_role = replica; delete from public.auction_sales where false;",
      message: "sets session_replication_role",
    },
    {
      label: "une décision insérée par une migration, hors d'une fonction",
      file: migration("decision_backfill"),
      content: decision(
        "",
        "select claim.id, claim.auction_sale_id, 'rejected', 'unknown', 'system' from public.auction_fact_claims claim",
      ),
      message: "inserts into public.auction_fact_claim_decisions outside a function",
    },
    {
      label: "une migration qui vide held_fields",
      file: migration("held_fields_update"),
      content: "update public.auction_sales set held_fields = null where held_fields is not null;",
      message: "writes auction_sales.held_fields outside a function",
    },
    {
      label: "une écriture de held_fields cachée derrière une chaîne '--'",
      file: migration("held_fields_after_dashes"),
      content: "select '--'; update public.auction_sales set held_fields = null;",
      message: "writes auction_sales.held_fields outside a function",
    },
    {
      label: "une écriture de held_fields cachée derrière un « -- » de SQL dynamique",
      file: migration("held_fields_after_dynamic_comment"),
      content:
        "do $$ begin execute $q$select 1 -- $q$; update public.auction_sales set held_fields = null; end $$;",
      message: "writes auction_sales.held_fields outside a function",
    },
    {
      label: "une autre fonction qui écrit held_fields",
      file: migration("held_fields_function"),
      content: triggerFunction(
        "app_private.release_every_field",
        "update public.auction_sales set held_fields = null; return null;",
      ),
      message: "writes auction_sales.held_fields in app_private.release_every_field",
    },
    {
      label: "le marqueur de la projection posé par une migration",
      file: migration("marker_in_migration"),
      content:
        "select set_config('app.sale_field_projection', sale.id::text, true) from public.auction_sales sale;",
      message: "names the transaction marker of the projection outside a function",
    },
    {
      label: "le marqueur de la projection posé par une autre fonction",
      file: migration("marker_in_function"),
      content: triggerFunction(
        "app_private.pretend_to_project",
        "perform set_config('app.sale_field_projection', new.id::text, true); return new;",
      ),
      message: "names the transaction marker of the projection in app_private.pretend_to_project",
    },
    {
      label: "une vente insérée avec held_fields",
      file: migration("held_fields_insert"),
      content:
        "insert into public.auction_sales (source_name, source_url, held_fields) values ('licitor', 'https://example.test/forged', '{}'::jsonb);",
      message: "inserts auction_sales.held_fields",
    },
    {
      label: "un droit par colonne sur held_fields",
      file: migration("held_fields_column_grant"),
      content: "grant select (id, held_fields) on public.auction_sales to authenticated;",
      message: "grants a column privilege on auction_sales.held_fields",
    },
    {
      label: "held_fields dans les colonnes lisibles (liste des colonnes internes)",
      file: migration("held_fields_column_grant"),
      content: null,
      prefix: ": ",
      message: "auction_sales column grant exposes internal column held_fields",
    },
    {
      label: "une lecture de toute la table donnée à un rôle du navigateur",
      file: migration("sales_table_grant"),
      content: "grant select on table public.auction_sales to anon, authenticated;",
      message: "grants a table-wide read of auction_sales to a browser role",
    },
    {
      label: "le déclencheur de retenue supprimé",
      file: migration("hold_trigger_drop"),
      content:
        "drop trigger if exists aaab_auction_sales_hold_projected_fields on public.auction_sales;",
      message:
        "drops the trigger aaab_auction_sales_hold_projected_fields of public.auction_sales without recreating it",
    },
    {
      label: "la garde par rôle de held_fields supprimée",
      file: migration("role_guard_drop"),
      content: "drop trigger aaab_auction_sales_held_fields_role_guard on public.auction_sales;",
      message:
        "drops the trigger aaab_auction_sales_held_fields_role_guard of public.auction_sales without recreating it",
    },
    {
      label: "les déclencheurs de la fiche désactivés le temps d'un rattrapage",
      file: migration("sales_disable_triggers"),
      content:
        "alter table public.auction_sales disable trigger user; update public.auction_sales set rooms_count = 1; alter table public.auction_sales enable trigger user;",
      message:
        "disables the trigger aaab_auction_sales_hold_projected_fields of public.auction_sales",
    },
    {
      label: "les déclencheurs de la fiche remis dans un mode que le mode replica saute",
      file: migration("sales_disable_triggers"),
      content: null,
      message:
        "puts the trigger aaab_auction_sales_held_fields_role_guard of public.auction_sales back to a mode that replica sessions skip",
    },
    {
      label: "le déclencheur de retenue renommé pour passer après les autres",
      file: migration("hold_trigger_rename"),
      content:
        "alter trigger aaab_auction_sales_hold_projected_fields on public.auction_sales rename to zzzz_auction_sales_hold_projected_fields;",
      message:
        "renames the trigger aaab_auction_sales_hold_projected_fields of public.auction_sales",
    },
    {
      label: "un déclencheur BEFORE UPDATE qui passerait avant la retenue",
      file: migration("earlier_trigger"),
      content:
        "create or replace trigger aaaa_auction_sales_rewrite before insert or update on public.auction_sales for each row execute function app_private.stamp_auction_sale_content_changed_at();",
      message:
        "creates the BEFORE UPDATE trigger aaaa_auction_sales_rewrite on auction_sales, which runs before aaab_auction_sales_hold_projected_fields",
    },
    {
      label: "la projection exécutable par le rôle de service",
      file: migration("projection_grant"),
      content:
        "grant execute on function app_private.project_sale_fields(uuid, text[], boolean) to service_role;",
      message: "grants a privilege on app_private.project_sale_fields",
    },
    {
      label: "la projection accordée par GRANT … ON ROUTINE",
      file: migration("projection_grant_routine"),
      content:
        "grant execute on routine app_private.project_sale_fields(uuid, text[], boolean) to service_role;",
      message: "grants a privilege on app_private.project_sale_fields",
    },
    {
      label: "toutes les fonctions de app_private accordées d'un coup",
      file: migration("app_private_grant_all"),
      content: "grant execute on all routines in schema app_private to service_role;",
      message: "grants every function of app_private at once",
    },
    {
      label: "une observation rattachée à une autre vente",
      file: migration("claims_repoint"),
      content:
        "update public.auction_fact_claims claim set auction_sale_id = merge.canonical_sale_id from app_private.auction_sale_merges merge where claim.auction_sale_id = merge.old_sale_id;",
      message: "re-points a fact claim to another sale",
    },
    {
      label: "la garde d'immuabilité des observations supprimée",
      file: migration("claims_guard_drop"),
      content: "drop trigger auction_fact_claims_guard_mutation on public.auction_fact_claims;",
      message:
        "drops the trigger auction_fact_claims_guard_mutation of public.auction_fact_claims without recreating it",
    },
    {
      label: "la garde d'immuabilité redéfinie sans sa clause « détacher seulement »",
      file: migration("claims_guard_relaxed"),
      content: triggerFunction(
        "app_private.guard_auction_fact_claim_mutation",
        "return new;",
        "set search_path = ''",
      ),
      message:
        "redefines app_private.guard_auction_fact_claim_mutation without its detach-only clause",
    },
    {
      label: "une clé étrangère du journal vers auction_sales",
      file: migration("registry_fk"),
      content:
        "alter table public.auction_fact_claim_decisions add constraint decisions_sale_fk foreign key (sale_id) references public.auction_sales(id) on delete cascade;",
      message: "gives public.auction_fact_claim_decisions a foreign key to auction_sales",
    },
    {
      label: "une colonne de la file des évènements qui référence auction_sales, dans un bloc DO",
      file: migration("registry_fk_column"),
      content:
        "do $$ begin alter table public.auction_sale_field_hold_events add column sale_ref uuid references auction_sales (id); end $$;",
      message: "gives public.auction_sale_field_hold_events a foreign key to auction_sales",
    },
    {
      label: "le verrou des décisions automatiques retiré",
      file: migration("decisions_unlock"),
      content:
        "alter table public.auction_fact_claim_decisions drop constraint auction_fact_claim_decisions_auto_locked;",
      message: "drops the automatic publication lock auction_fact_claim_decisions_auto_locked",
    },
    {
      label: "la contrainte « acceptation par un administrateur » retirée",
      file: migration("accepted_by_admin_dropped"),
      content:
        "alter table public.auction_fact_claim_decisions drop constraint auction_fact_claim_decisions_accepted_by_admin;",
      message:
        "drops the automatic publication lock auction_fact_claim_decisions_accepted_by_admin",
    },
    {
      label: "la contrainte « administrateur nommé » retirée",
      file: migration("admin_actor_dropped"),
      content:
        "alter table public.auction_fact_claim_decisions drop constraint if exists auction_fact_claim_decisions_admin_actor;",
      message: "drops the automatic publication lock auction_fact_claim_decisions_admin_actor",
    },
    {
      label: "la contrainte « l'annonce ne tient jamais » retirée",
      file: migration("listing_holds"),
      content:
        "alter table public.auction_fact_source_precedence drop constraint if exists auction_fact_source_precedence_listing_never_holds;",
      message:
        "drops the automatic publication lock auction_fact_source_precedence_listing_never_holds",
    },
    {
      label: "une décision insérée en mode automatique",
      file: migration("decision_auto"),
      content: inFunction(
        decision(
          ", publication_mode",
          "values (gen_random_uuid(), gen_random_uuid(), 'accepted', 'single_lot', 'admin', 'auto')",
        ),
      ),
      message:
        "inserts into public.auction_fact_claim_decisions with a publication_mode that is not the literal 'manual'",
    },
    {
      label: "une décision dont le mode vient d'une variable",
      file: migration("decision_variable"),
      content: inFunction(
        decision(
          ", publication_mode",
          "select claim.id, claim.auction_sale_id, 'accepted', 'single_lot', 'admin', tg_argv[0] from public.auction_fact_claims claim",
        ),
      ),
      message:
        "inserts into public.auction_fact_claim_decisions with a publication_mode that is not the literal 'manual'",
    },
    {
      label: "une seconde ligne en mode automatique derrière une ligne manuelle",
      file: migration("decision_second_row"),
      content: inFunction(
        decision(
          ", publication_mode",
          "values (gen_random_uuid(), gen_random_uuid(), 'accepted', 'single_lot', 'admin', 'manual'), (gen_random_uuid(), gen_random_uuid(), 'accepted', 'single_lot', 'admin', 'auto')",
        ),
      ),
      message:
        "inserts into public.auction_fact_claim_decisions with a publication_mode that is not the literal 'manual'",
    },
    {
      label: "le mode par défaut des décisions changé",
      file: migration("decision_default"),
      content:
        "alter table public.auction_fact_claim_decisions alter column publication_mode set default 'auto';",
      message: "changes the default publication_mode of public.auction_fact_claim_decisions",
    },
    {
      label: "le déclencheur de retenue recréé sans sa clause WHEN",
      file: migration("hold_trigger_without_when"),
      content: holdTrigger(heldColumns, ""),
      prefix: null,
      message:
        "the hold trigger aaab_auction_sales_hold_projected_fields is missing or lost its shape",
    },
    {
      label: "une fonction de retenue qui lit toute la ligne",
      file: migration("hold_function_active"),
      content: triggerFunction(
        "app_private.hold_projected_sale_fields",
        "if to_jsonb(new) <> to_jsonb(old) then new.raw_payload := old.raw_payload; perform app_private.project_sale_fields(new.id, null, true); end if; return new;",
      ),
      prefix: ": ",
      message: "app_private.hold_projected_sale_fields converts the whole row",
    },
    {
      label: "une fonction de retenue qui lit raw_payload",
      file: migration("hold_function_active"),
      content: null,
      prefix: ": ",
      message: "app_private.hold_projected_sale_fields reads raw_payload",
    },
    {
      label: "une fonction de retenue qui appelle la projection",
      file: migration("hold_function_active"),
      content: null,
      prefix: ": ",
      message: "app_private.hold_projected_sale_fields calls the projection",
    },
    {
      label: "une fonction de retenue qui ne refuse plus une écriture de held_fields",
      file: migration("hold_function_active"),
      content: null,
      prefix: ": ",
      message:
        "app_private.hold_projected_sale_fields no longer refuses (42501) a write of held_fields outside the projection",
    },
    {
      label:
        "une garde par rôle redéfinie en SECURITY DEFINER (elle ne verrait plus le rôle appelant)",
      file: migration("role_guard_definer"),
      content: triggerFunction(
        "app_private.refuse_api_role_held_fields_write",
        "if current_user in ('anon', 'authenticated', 'service_role') then raise exception using errcode = '42501'; end if; return new;",
      ),
      prefix: ": ",
      message:
        "app_private.refuse_api_role_held_fields_write no longer refuses (42501) the API roles as the calling role",
    },
    {
      label: "une projection qui n'est plus SECURITY DEFINER à chemin de recherche vide",
      file: migration("projection_invoker"),
      content:
        "create or replace function app_private.project_sale_fields(p_sale_id uuid, p_fields text[] default null, p_apply boolean default false) returns jsonb language sql security invoker as $$ select '{}'::jsonb $$;",
      prefix: ": ",
      message: "app_private.project_sale_fields is not SECURITY DEFINER with an empty search_path",
    },
    {
      label: "une fonction d'ajout seul qui laisse passer",
      file: migration("append_only_relaxed"),
      content: triggerFunction(
        "app_private.fact_registry_append_only",
        "if tg_op = 'DELETE' then return old; end if; raise exception using errcode = '55000', message = 'ajout seul';",
      ),
      prefix: ": ",
      message: "app_private.fact_registry_append_only no longer refuses every write",
    },
    {
      label: "un déclencheur d'ajout seul recréé pour la seule suppression",
      file: migration("events_guard_delete_only"),
      content: `create or replace trigger auction_sale_field_hold_events_append_only before delete on public.auction_sale_field_hold_events for each row execute function app_private.fact_registry_append_only(); ${always("auction_sale_field_hold_events", "auction_sale_field_hold_events_append_only")}`,
      prefix: null,
      message:
        "the append-only trigger auction_sale_field_hold_events_append_only of public.auction_sale_field_hold_events is missing or no longer refuses every row and statement",
    },
    {
      label: "un rattrapage qui vide held_fields",
      where: "repair",
      file: "repairs/99990101000000_release_fields.sql",
      content: "update public.auction_sales set held_fields = null;",
      message: "writes auction_sales.held_fields outside a function",
    },
    {
      label: "un rattrapage qui passe en session_replication_role",
      where: "repair",
      file: "repairs/99990101000001_replica.sql",
      content: "set session_replication_role = replica;",
      message: "sets session_replication_role",
    },
    {
      label: "un rattrapage qui coupe les déclencheurs de la fiche",
      where: "repair",
      file: "repairs/99990101000002_disable_triggers.sql",
      content:
        "alter table public.auction_sales disable trigger user; alter table public.auction_sales enable trigger user;",
      message:
        "disables the trigger aaab_auction_sales_hold_projected_fields of public.auction_sales",
    },
    {
      label: "un rattrapage qui pose le marqueur de la projection",
      where: "repair",
      file: "repairs/99990101000003_marker.sql",
      content:
        "select set_config('app.sale_field_projection', sale.id::text, true) from public.auction_sales sale;",
      message: "names the transaction marker of the projection outside a function",
    },
    {
      label: "un rattrapage qui insère des décisions",
      where: "repair",
      file: "repairs/99990101000004_decisions.sql",
      content: decision(
        "",
        "select claim.id, claim.auction_sale_id, 'rejected', 'unknown', 'system' from public.auction_fact_claims claim",
      ),
      message: "inserts into public.auction_fact_claim_decisions outside a function",
    },
    {
      label: "un module de l'application qui nomme la colonne",
      where: "source",
      file: "src/lib/registre-colonne.ts",
      content: 'export const column = "held_fields";\n',
      message: "names auction_sales.held_fields",
    },
    {
      label: "une adresse REST qui demande la colonne",
      where: "source",
      file: "src/lib/registre-adresse.ts",
      content:
        'export const url = "https://example.supabase.co/rest/v1/auction_sales?select=held_fields";\n',
      message: "names auction_sales.held_fields",
    },
    {
      label: "un commentaire qui nomme la colonne (le code est cherché tel quel)",
      where: "source",
      file: "src/lib/registre-commentaire.ts",
      content: "// held_fields est écrite par la base seule.\nexport const nothing = 1;\n",
      message: "names auction_sales.held_fields",
    },
    {
      label: "un module de l'application qui nomme la projection",
      where: "source",
      file: "src/lib/registre-projection.ts",
      content: 'export const rpc = "project_sale_fields";\n',
      message: "names app_private.project_sale_fields",
    },
    {
      label: "un module de l'application qui nomme le marqueur",
      where: "source",
      file: "src/lib/registre-marqueur.ts",
      content: 'export const marker = "app.sale_field_projection";\n',
      message: "names the transaction marker of the projection",
    },
    {
      label: "un script qui nomme la colonne",
      where: "extra",
      file: "scripts/registre-rattrapage.mjs",
      content: "await sql`update auction_sales set held_fields = null`;\n",
      message: "names auction_sales.held_fields",
    },
    {
      label: "une fonction Edge qui nomme la projection",
      where: "extra",
      file: "supabase/functions/registre/index.ts",
      content: 'export const rpc = "project_sale_fields";\n',
      message: "names app_private.project_sale_fields",
    },
  ];
  const filesOf = (where) =>
    Object.fromEntries(
      bypasses
        .filter((entry) => (entry.where ?? "migration") === where && entry.content !== null)
        .map(({ file, content }) => [file, content]),
    );

  let refused;
  beforeAll(() => {
    refused = runInvariants(filesOf("migration"), [], filesOf("source"), {
      ...filesOf("extra"),
      ...Object.fromEntries(
        Object.entries(filesOf("repair")).map(([file, content]) => [`supabase/${file}`, content]),
      ),
    });
  });

  it("le script échoue sur ces fichiers", () => {
    expect(refused.status).toBe(1);
  });

  it.each(bypasses)("refuse $label", ({ file, prefix = " ", message }) => {
    expect(refused.stderr).toContain(prefix === null ? message : `${file}${prefix}${message}`);
  });

  it("refuse un déclencheur de retenue qui ne se déclenche plus sur une colonne tenue", () => {
    const result = runInvariants({
      [migration("hold_trigger_without_rooms")]: holdTrigger(
        heldColumns.replace(" rooms_count,", ""),
        holdWhen,
      ),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "the hold trigger aaab_auction_sales_hold_projected_fields no longer fires on a write of rooms_count",
    );
  });

  it("accepte les formes permises et annonce les sept invariants", () => {
    const result = runInvariants(
      {
        [migration("accepted_recreated_guard")]:
          `create or replace trigger auction_fact_claim_decisions_append_only before update or delete on public.auction_fact_claim_decisions for each row execute function app_private.fact_registry_append_only(); ${always("auction_fact_claim_decisions", "auction_fact_claim_decisions_append_only")}`,
        [migration("accepted_dropped_and_recreated_guard")]:
          `drop trigger if exists auction_fact_claims_no_truncate on public.auction_fact_claims; create trigger auction_fact_claims_no_truncate before truncate on public.auction_fact_claims for each statement execute function app_private.refuse_auction_fact_claims_truncate(); ${always("auction_fact_claims", "auction_fact_claims_no_truncate")}`,
        [migration("accepted_recreated_hold")]: holdTrigger(heldColumns, holdWhen),
        [migration("accepted_detach")]:
          "update public.auction_fact_claims set auction_sale_id = null where auction_sale_id = '00000000-0000-4000-8000-000000000001';",
        [migration("accepted_manual_decisions")]: inFunction(
          decision(
            ", publication_mode",
            "values (gen_random_uuid(), gen_random_uuid(), 'accepted', 'single_lot', 'admin', 'manual'), (gen_random_uuid(), gen_random_uuid(), 'accepted', 'single_lot', 'admin', 'manual')",
          ) +
            decision(
              "",
              "select claim.id, claim.auction_sale_id, 'accepted', 'single_lot', 'admin' from public.auction_fact_claims claim",
            ),
        ),
        [migration("accepted_later_trigger")]:
          "create trigger zzzz_auction_sales_other before update on public.auction_sales for each row execute function app_private.stamp_auction_sale_content_changed_at();",
        [migration("accepted_registry_read")]:
          "grant select on table public.auction_fact_fields to service_role;",
        // Un vrai commentaire n'est pas du code (une chaîne, elle, est lue : elle peut être du SQL dynamique).
        [migration("accepted_comments")]:
          "-- update public.auction_sales set held_fields = null; set session_replication_role = replica;\nselect 1; /* grant all on all tables in schema public to anon; */",
        [migration("accepted_projection_writes")]:
          "create or replace function app_private.project_sale_fields(p_sale_id uuid, p_fields text[] default null, p_apply boolean default false) returns jsonb language plpgsql security definer set search_path = '' as $$ begin perform set_config('app.sale_field_projection', p_sale_id::text, true); update public.auction_sales set held_fields = null where id = p_sale_id; return '{}'::jsonb; end; $$;",
      },
      [],
      {},
      {
        "supabase/repairs/99990101000000_accepted_repair.sql":
          "select app_private.project_sale_fields(sale.id, null, false) from public.auction_sales sale where false;",
      },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const checked = JSON.parse(result.stdout).checked;
    expect(checked).toEqual(
      expect.arrayContaining([
        "fact-registry-tables-closed",
        "fact-registry-append-only",
        "held-fields-projection-only",
        "hold-trigger-present-early",
        "field-projection-not-callable-by-api",
        "fact-claims-never-repointed",
        "registry-no-fk-to-auction-sales",
      ]),
    );
  });
});
