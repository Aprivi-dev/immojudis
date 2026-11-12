// Invariants du registre des pièces (scripts/check-security-invariants-fact-registry.mjs, lots R1, R2a, R2b et
// R2c) et
// verrous ajoutés pour lui à information-agent-no-automatic-publication-path.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { removeSandboxes, repo, runInvariants } from "./check-security-invariants-harness.mjs";

// Chaque passage lance le script d'invariants sur un dépôt factice : 20 s pour tout le fichier.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

afterAll(removeSandboxes);

describe("invariants de sécurité : registre des pièces (lot R1)", () => {
  const heldColumns =
    "surface_m2, app_surface_m2, app_surface_kind, surface_source, surface_confidence, habitable_surface_m2, carrez_surface_m2, land_surface_m2, rooms_count, bedrooms_count, occupancy_status, visit_dates, held_fields";
  const holdWhen =
    "when (old.held_fields is not null or new.held_fields is distinct from old.held_fields or new.surface_source = 'fact_registry')";
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
    // Lot R2a ----------------------------------------------------------------------------------------------------
    {
      label: "la séquence commune déplacée par une migration",
      file: migration("sequence_setval"),
      content: "select setval('app_private.fact_registry_seq', 1, false);",
      message: "moves app_private.fact_registry_seq with setval",
    },
    {
      label: "la séquence commune redémarrée",
      file: migration("sequence_restart"),
      content: "alter sequence app_private.fact_registry_seq restart with 1;",
      message: "alters or drops app_private.fact_registry_seq",
    },
    {
      label: "la séquence commune ouverte au rôle de service",
      file: migration("sequence_grant"),
      content: "grant usage on sequence app_private.fact_registry_seq to service_role;",
      message: "grants a privilege on app_private.fact_registry_seq",
    },
    {
      label: "un déclencheur de datation qui laisse l'écrivain choisir le numéro d'ordre",
      file: migration("stamp_without_sequence"),
      content: triggerFunction(
        "app_private.stamp_fact_registry_event",
        "new.created_at := clock_timestamp(); return new;",
      ),
      prefix: ": ",
      message:
        "app_private.stamp_fact_registry_event no longer takes the order number from app_private.fact_registry_seq",
    },
    {
      label: "une écriture de held_fields par la cible d'un INTO",
      file: migration("held_fields_into"),
      content: triggerFunction(
        "app_private.release_by_into",
        "select null::jsonb into new.held_fields; return new;",
      ),
      message: "writes auction_sales.held_fields through INTO in app_private.release_by_into",
    },
    {
      label: "un journal des ventes qui vide held_fields sur la ligne écrite, pas sur sa copie",
      file: migration("history_writes_row"),
      content: triggerFunction(
        "public.log_auction_sale_change",
        "new.held_fields := null; return new;",
        "set search_path = ''",
      ),
      message: "writes auction_sales.held_fields in public.log_auction_sale_change",
    },
    {
      label: "une garde des origines réservées revenue à la seule liste d'exclusion",
      file: migration("origin_guard_exclusion_only"),
      content: triggerFunction(
        "app_private.refuse_api_role_registry_origin",
        "if current_user in ('anon', 'authenticated', 'service_role', 'authenticator') then raise exception using errcode = '42501'; end if; return new;",
        "security invoker set search_path = ''",
      ),
      prefix: ": ",
      message:
        "app_private.refuse_api_role_registry_origin no longer accepts only the owner of app_private.project_sale_fields",
    },
    {
      label: "une liste des déclencheurs du registre qui en oublie un",
      file: migration("trigger_list_short"),
      content:
        "create or replace function app_private.fact_registry_triggers_not_always() returns text[] language sql stable security definer set search_path = '' as $$ select array[]::text[] from pg_catalog.pg_trigger trigger_row where trigger_row.tgname = 'aaab_auction_sales_hold_projected_fields' and trigger_row.tgenabled = 'A' $$;",
      prefix: ": ",
      message:
        "app_private.fact_registry_triggers_not_always no longer checks that auction_sale_field_hold_events_stamp is enabled always",
    },
    {
      label: "un contrôle du mode des déclencheurs qui ne lève plus",
      file: migration("assert_triggers_silent"),
      content:
        "create or replace function app_private.assert_fact_registry_triggers() returns void language plpgsql stable security definer set search_path = '' as $$ begin perform app_private.fact_registry_triggers_not_always(); end; $$;",
      prefix: ": ",
      message:
        "app_private.assert_fact_registry_triggers no longer raises 55000 registry_unavailable",
    },
    {
      label: "le contrôle du mode des déclencheurs ouvert au rôle de service",
      file: migration("assert_triggers_grant"),
      content:
        "grant execute on function app_private.assert_fact_registry_triggers() to service_role;",
      message:
        "grants a privilege on app_private.assert_fact_registry_triggers: no API role may execute it",
    },
    {
      label: "le contrôle quotidien ouvert à un rôle du navigateur",
      file: migration("check_grant_browser"),
      content:
        "grant execute on function public.check_fact_registry_consistency(integer) to authenticated;",
      message:
        "grants on public.check_fact_registry_consistency something else than EXECUTE to service_role alone",
    },
    {
      label: "une fonction publique qui rend la ligne entière d'une vente",
      file: migration("public_whole_row"),
      content:
        "create or replace function public.read_whole_sale(p_sale_id uuid) returns public.auction_sales language sql security definer set search_path = '' as $$ select sale from public.auction_sales sale where sale.id = p_sale_id $$;",
      prefix: ": ",
      message: "public.read_whole_sale returns a whole auction_sales row",
    },
    {
      label: "une fonction publique qui écrit une vente avec RETURNING *",
      file: migration("public_returning_star"),
      content:
        "create or replace function public.touch_sale(p_sale_id uuid) returns jsonb language plpgsql security definer set search_path = '' as $$ declare v_row record; begin update public.auction_sales sale set updated_at = now() where sale.id = p_sale_id returning * into v_row; return to_jsonb(v_row); end; $$;",
      prefix: ": ",
      message: "public.touch_sale writes auction_sales with RETURNING *",
    },
    {
      label: "une fonction publique qui lit la colonne interne",
      file: migration("public_reads_held_fields"),
      content:
        "create or replace function public.peek_registry(p_sale_id uuid) returns jsonb language sql security definer set search_path = '' as $$ select sale.held_fields from public.auction_sales sale where sale.id = p_sale_id $$;",
      prefix: ": ",
      message: "public.peek_registry names auction_sales.held_fields",
    },
    {
      label: "des valeurs d'annonce qui servent aussi la valeur tenue",
      file: migration("baselines_serve_value"),
      content:
        "create or replace function public.get_sale_field_baselines(p_sale_ids uuid[] default null) returns table (sale_id uuid, field_key text, columns text[], listing jsonb) language sql stable security definer set search_path = '' as $$ select sale.id, entry.key, array[]::text[], jsonb_build_object('listing', entry.value -> 'listing', 'held', entry.value -> 'value') from public.auction_sales sale cross join lateral jsonb_each(sale.held_fields) entry where entry.value ->> 'state' in ('held', 'conflicted') $$;",
      prefix: ": ",
      message: "public.get_sale_field_baselines reads the key 'value' of a held entry",
    },
    {
      label: "un contrôle quotidien qui applique la projection",
      file: migration("check_applies"),
      content:
        "create or replace function public.check_fact_registry_consistency(p_limit integer default 500) returns jsonb language plpgsql stable security definer set search_path = '' as $$ declare v_sale_id uuid; begin return app_private.project_sale_fields(v_sale_id, null, true); end; $$;",
      prefix: ": ",
      message: "public.check_fact_registry_consistency applies the projection",
    },
    {
      label:
        "une fonction d'alertes qui reprend une borne en paramètre et écrit la table des alertes",
      file: migration("alerts_direct_write"),
      content:
        "create or replace function public.sync_fact_registry_alerts(p_limit integer default 500) returns jsonb language plpgsql security definer set search_path = '' as $$ declare v_report jsonb := public.check_fact_registry_consistency(p_limit); begin insert into public.operational_alerts (alert_key, category, severity) values ('anything', 'import', 'critical'); return v_report; end; $$;",
      prefix: ": ",
      message:
        "public.sync_fact_registry_alerts must take no parameter and only run the check, page by page",
    },
    {
      label: "une projection qui n'écrit plus les libellés de surface neutres",
      file: migration("projection_invoker"),
      content: null,
      prefix: ": ",
      message: "app_private.project_sale_fields must write neutral surface labels",
    },
    {
      label: "un rattrapage qui écrit les ventes sans finir par le contrôle des déclencheurs",
      where: "repair",
      file: "repairs/99990101000005_without_assert.sql",
      content:
        "begin; update public.auction_sales set city = btrim(city) where city <> btrim(city); commit;",
      message:
        "writes auction_sales without ending by select app_private.assert_fact_registry_triggers(); before its commit",
    },
    {
      label:
        "un rattrapage qui coupe des déclencheurs par un nom calculé, sans épargner le registre",
      where: "repair",
      file: "repairs/99990101000006_dynamic_disable.sql",
      content:
        "begin; do $$ declare v_trigger name; begin for v_trigger in select tgname from pg_trigger where tgrelid = 'public.auction_sales'::regclass and not tgisinternal loop execute format('alter table public.auction_sales disable trigger %I', v_trigger); end loop; end $$; update public.auction_sales set city = btrim(city); select app_private.assert_fact_registry_triggers(); commit;",
      message: "switches triggers of auction_sales by a computed name without keeping to",
    },
    {
      label:
        "un module de l'application, hors du module serveur, qui nomme une fonction du registre",
      where: "source",
      file: "src/lib/registre-controle.ts",
      content: 'export const rpc = "sync_fact_registry_alerts";\n',
      message: "names public.sync_fact_registry_alerts",
    },
    // Relectures du lot R2a : un cas par contournement relevé.
    {
      label: "une désactivation des déclencheurs de la fiche écrite en majuscules",
      file: migration("uppercase_disable"),
      content: "ALTER TABLE PUBLIC.AUCTION_SALES DISABLE TRIGGER USER;",
      message:
        "disables the trigger aaab_auction_sales_hold_projected_fields of public.auction_sales",
    },
    {
      label: "un droit sur le journal des décisions écrit en majuscules",
      file: migration("uppercase_grant"),
      content: "GRANT ALL ON PUBLIC.AUCTION_FACT_CLAIM_DECISIONS TO AUTHENTICATED;",
      message:
        "grants on public.auction_fact_claim_decisions something else than SELECT to service_role alone",
    },
    {
      label: "la garde d'insertion supprimée en majuscules",
      file: migration("uppercase_drop"),
      content: "DROP TRIGGER AAAB_AUCTION_SALES_HELD_FIELDS_INSERT_GUARD ON PUBLIC.AUCTION_SALES;",
      message:
        "drops the trigger aaab_auction_sales_held_fields_insert_guard of public.auction_sales without recreating it",
    },
    {
      label: "une désactivation derrière un nom qualifié écrit avec des espaces",
      file: migration("spaced_disable"),
      content:
        "alter table public . auction_sales disable trigger aaab_auction_sales_held_fields_role_guard;",
      message:
        "disables the trigger aaab_auction_sales_held_fields_role_guard of public.auction_sales",
    },
    {
      label: "un droit sur la file derrière un nom qualifié écrit avec des espaces",
      file: migration("spaced_grant"),
      content: 'grant insert on "public" . "auction_sale_field_hold_events" to service_role;',
      message:
        "grants on public.auction_sale_field_hold_events something else than SELECT to service_role alone",
    },
    {
      label: "un droit sur la préséance dans une chaîne de SQL dynamique en majuscules",
      file: migration("uppercase_dynamic_grant"),
      content:
        "do $$ begin execute 'GRANT SELECT ON PUBLIC.AUCTION_FACT_SOURCE_PRECEDENCE TO ANON'; end $$;",
      message:
        "grants on public.auction_fact_source_precedence something else than SELECT to service_role alone",
    },
    {
      label: "le verrou des dates de visite retiré",
      file: migration("visit_dates_unlocked"),
      content:
        "alter table public.auction_fact_fields drop constraint auction_fact_fields_visit_dates_locked;",
      message: "drops the automatic publication lock auction_fact_fields_visit_dates_locked",
    },
    {
      label: "toutes les fonctions du schéma public accordées d'un coup à un rôle du navigateur",
      file: migration("public_grant_all_functions"),
      content: "grant execute on all functions in schema public to anon, authenticated;",
      message: "grants every function of the public schema to a browser role",
    },
    {
      label: "une fonction publique SECURITY DEFINER qui lit le journal des décisions",
      file: migration("public_reads_journal"),
      content:
        "create function public.read_registry(p_sale_id uuid) returns jsonb language sql security definer set search_path = '' as $$ select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(decision)) from public.auction_fact_claim_decisions decision where decision.sale_id = p_sale_id $$; grant execute on function public.read_registry(uuid) to authenticated;",
      prefix: ": ",
      message: "public.read_registry reads public.auction_fact_claim_decisions",
    },
    {
      label: "une fonction publique SECURITY DEFINER qui lit la file des évènements",
      file: migration("public_reads_events"),
      content:
        "create function public.read_events(p_sale_id uuid) returns bigint language sql security definer set search_path = '' as $$ select count(*) from public.auction_sale_field_hold_events event where event.sale_id = p_sale_id $$;",
      prefix: ": ",
      message: "public.read_events reads public.auction_sale_field_hold_events",
    },
    {
      label: "une fonction publique qui enveloppe le contrôle quotidien pour un rôle du navigateur",
      file: migration("public_wraps_check"),
      content:
        "create function public.registry_report() returns jsonb language sql security definer set search_path = '' as $$ select public.check_fact_registry_consistency(500) $$; grant execute on function public.registry_report() to anon;",
      prefix: ": ",
      message: "public.registry_report wraps public.check_fact_registry_consistency",
    },
    {
      label: "une fonction publique qui enveloppe les valeurs d'annonce",
      file: migration("public_wraps_baselines"),
      content:
        "create function public.listing_values() returns bigint language sql security definer set search_path = '' as $$ select count(*) from public.get_sale_field_baselines(null) $$;",
      prefix: ": ",
      message: "public.listing_values wraps public.get_sale_field_baselines",
    },
    {
      label: "un journal des ventes redéfini sans vider held_fields sur ses deux copies",
      file: migration("history_writes_row"),
      content: null,
      prefix: ": ",
      message: "public.log_auction_sale_change no longer empties held_fields on both copies",
    },
    {
      label: "un fichier de maintenance qui pose le marqueur de la projection",
      where: "maintenance",
      file: "maintenance/99990101000007_marker.sql",
      content:
        "begin; select set_config('app.sale_field_projection', id::text, true) from public.auction_sales; update public.auction_sales set held_fields = null, rooms_count = 9; commit;",
      message: "names the transaction marker of the projection outside a function",
    },
    {
      label: "un fichier de maintenance qui écrit held_fields",
      where: "maintenance",
      file: "maintenance/99990101000007_marker.sql",
      content: null,
      message: "writes auction_sales.held_fields outside a function",
    },
    {
      label: "un fichier de maintenance qui remet les déclencheurs de la fiche en mode ordinaire",
      where: "maintenance",
      file: "maintenance/99990101000008_enable_user.sql",
      content: "begin; alter table public.auction_sales enable trigger user; commit;",
      message:
        "puts the trigger aaab_auction_sales_hold_projected_fields of public.auction_sales back to a mode that replica sessions skip",
    },
    {
      label: "une garde d'origine des observations revenue à une seule nature",
      file: migration("origin_guard_narrowed"),
      content: `create or replace trigger auction_fact_claims_registry_origin_guard before insert on public.auction_fact_claims for each row when (new.evidence_kind in ('professional_email', 'professional_form', 'admin_entry')) execute function app_private.refuse_api_role_registry_origin(); ${always("auction_fact_claims", "auction_fact_claims_registry_origin_guard")}`,
      prefix: null,
      message:
        "the origin guard auction_fact_claims_registry_origin_guard is missing or lost its shape",
    },
    {
      label: "une garde du marqueur recréée avec une clause WHEN toujours fausse",
      file: migration("marker_guard_never"),
      content: `create or replace trigger aaab_auction_sales_held_fields_marker_guard before update of ${heldColumns.replace(", held_fields", "")} on public.auction_sales for each row when (false) execute function app_private.refuse_sale_field_projection_marker(); ${always("auction_sales", "aaab_auction_sales_held_fields_marker_guard")}`,
      prefix: null,
      message:
        "the marker guard aaab_auction_sales_held_fields_marker_guard is missing or lost its shape",
    },
    {
      label: "une garde du marqueur revenue à la seule liste d'exclusion",
      file: migration("marker_guard_exclusion_only"),
      content: triggerFunction(
        "app_private.refuse_sale_field_projection_marker",
        "if coalesce(pg_catalog.current_setting('app.sale_field_projection', true), '') = new.id::text and current_user in ('anon', 'authenticated', 'service_role', 'authenticator') then raise exception using errcode = '42501'; end if; return new;",
        "security invoker set search_path = ''",
      ),
      prefix: ": ",
      message:
        "app_private.refuse_sale_field_projection_marker no longer accepts only the owner of app_private.project_sale_fields",
    },
    {
      label: "une liste des déclencheurs du registre qui ne lit plus leur fonction",
      file: migration("trigger_list_short"),
      content: null,
      prefix: ": ",
      message:
        "app_private.fact_registry_triggers_not_always no longer checks the function bound to each trigger (tgfoid)",
    },
    {
      label: "une synchronisation des alertes qui referme sur un rapport tronqué",
      file: migration("alerts_close_on_truncated"),
      content:
        "create or replace function app_private.sync_fact_registry_alerts_from_report(p_report jsonb) returns void language plpgsql security definer set search_path = '' as $$ declare v_check text := 'projection_drift'; begin perform app_private.sync_operational_alert('fact_registry.' || v_check, 'import', 'critical', '{}'::jsonb, (p_report #>> array['checks', v_check, 'active'])::boolean); end; $$;",
      prefix: ": ",
      message:
        "app_private.sync_fact_registry_alerts_from_report no longer skips the inactive checks of a truncated report",
    },
    {
      label: "une fonction de retenue qui ne réserve plus le libellé du registre",
      file: migration("hold_function_active"),
      content: null,
      prefix: ": ",
      message:
        "app_private.hold_projected_sale_fields no longer reserves the surface label 'fact_registry' to the projection",
    },
    {
      label: "une vue des observations qui filtre un autre extracteur que celui de la collecte",
      file: migration("claims_view_other_extractor"),
      content:
        "create or replace view public.v_auction_fact_claims_read_model with (security_invoker = true) as select claim.id as claim_id from public.auction_fact_claims claim left join (select peer.auction_sale_id, max(app_private.fact_claims_generation(peer.extractor_version)) filter (where app_private.fact_claims_generation(peer.extractor_version) <= app_private.fact_claims_generation_ceiling()) as generation from public.auction_fact_claims peer where peer.extractor_name = 'another.extractor' group by peer.auction_sale_id) latest on latest.auction_sale_id = claim.auction_sale_id where not coalesce(claim.extractor_name = 'another.extractor' and app_private.fact_claims_generation(claim.extractor_version) < latest.generation, false);",
      prefix: null,
      message:
        "FACT_CLAIMS_EXTRACTOR (immojudis.pipeline.fact_claims) is not the extractor that public.v_auction_fact_claims_read_model filters (another.extractor)",
    },
    // Contre-vérification du lot R2a : nouvelles surfaces.
    {
      label: "une garde de held_fields passée en SECURITY DEFINER par ALTER FUNCTION",
      file: migration("alter_guards"),
      content:
        "alter function app_private.refuse_api_role_held_fields_write() security definer; alter function app_private.refuse_api_role_registry_origin() security definer; ALTER FUNCTION app_private.refuse_sale_field_projection_marker() SECURITY DEFINER; alter function app_private.refuse_inserted_held_fields() security definer;",
      message: "alters app_private.refuse_api_role_held_fields_write",
    },
    {
      label: "la garde d'origine passée en SECURITY DEFINER par ALTER FUNCTION",
      file: migration("alter_guards"),
      content: null,
      message: "alters app_private.refuse_api_role_registry_origin",
    },
    {
      label: "la garde du marqueur passée en SECURITY DEFINER par ALTER FUNCTION",
      file: migration("alter_guards"),
      content: null,
      message: "alters app_private.refuse_sale_field_projection_marker",
    },
    {
      label: "la garde d'insertion passée en SECURITY DEFINER par ALTER FUNCTION",
      file: migration("alter_guards"),
      content: null,
      message: "alters app_private.refuse_inserted_held_fields",
    },
    {
      label: "la projection donnée à un autre propriétaire",
      file: migration("projection_owner"),
      content:
        "alter function app_private.project_sale_fields(uuid, text[], boolean, jsonb) owner to service_role;",
      message: "alters app_private.project_sale_fields",
    },
    {
      label:
        "une fonction publique qui passe son paramètre à la synchronisation interne des alertes",
      file: migration("public_feeds_alert_report"),
      content:
        "create function public.close_registry_alerts(p_report jsonb) returns void language sql security definer set search_path = '' as $$ select app_private.sync_fact_registry_alerts_from_report(p_report) $$;",
      prefix: ": ",
      message:
        "public.close_registry_alerts calls app_private.sync_fact_registry_alerts_from_report",
    },
    {
      label: "la contrainte du libellé de lot retirée",
      file: migration("lot_ref_dropped"),
      content:
        "alter table public.auction_fact_claim_decisions drop constraint auction_fact_claim_decisions_lot_ref_check;",
      message:
        "drops the constraint auction_fact_claim_decisions_lot_ref_check without restoring its structural pattern",
    },
    {
      label: "la contrainte du libellé de lot assouplie",
      file: migration("lot_ref_relaxed"),
      content:
        "alter table public.auction_fact_claim_decisions drop constraint auction_fact_claim_decisions_lot_ref_check; alter table public.auction_fact_claim_decisions add constraint auction_fact_claim_decisions_lot_ref_check check (lot_ref is null or char_length(lot_ref) <= 40);",
      prefix: null,
      message:
        "the constraint auction_fact_claim_decisions_lot_ref_check is missing or no longer bounds lot_ref by its structural pattern",
    },
    {
      label: "la vue des observations privée de security_invoker par ALTER VIEW",
      file: migration("claims_view_definer"),
      content: "alter view public.v_auction_fact_claims_read_model set (security_invoker = false);",
      message: "alters public.v_auction_fact_claims_read_model",
    },
    {
      label: "la vue des observations ouverte à un rôle du navigateur",
      file: migration("claims_view_grant"),
      content: "grant select on public.v_auction_fact_claims_read_model to authenticated;",
      message:
        "grants on public.v_auction_fact_claims_read_model something else than SELECT to service_role alone",
    },
    {
      label: "une liste des déclencheurs du registre qui ne compare plus leur définition",
      file: migration("trigger_list_short"),
      content: null,
      prefix: ": ",
      message:
        "app_private.fact_registry_triggers_not_always no longer compares the definition of each trigger",
    },
    {
      label: "un plafond de génération ramené sous la version que la collecte écrit",
      file: migration("generation_ceiling_low"),
      content:
        "create or replace function app_private.fact_claims_generation_ceiling() returns integer language sql immutable parallel safe as $$ select 1; $$;",
      prefix: null,
      message: "is above the generation ceiling (1) of app_private.fact_claims_generation_ceiling",
    },
    // Dernière contre-vérification du lot R2a : propriétaires, fonctions de génération, set_config relayé.
    {
      label: "le journal des décisions donné à un autre propriétaire",
      file: migration("journal_owner"),
      content: "alter table public.auction_fact_claim_decisions owner to service_role;",
      message: "changes the owner of auction_fact_claim_decisions",
    },
    {
      label: "la table des ventes donnée à un autre propriétaire, nommée sans son schéma",
      file: migration("sales_owner"),
      content: "set local search_path = public; ALTER TABLE auction_sales OWNER TO service_role;",
      message: "changes the owner of auction_sales",
    },
    {
      label: "la vue des observations donnée à un autre propriétaire par ALTER TABLE",
      file: migration("claims_view_owner"),
      content: "alter table public.v_auction_fact_claims_read_model owner to service_role;",
      message: "changes the owner of v_auction_fact_claims_read_model",
    },
    {
      label: "tous les objets d'un rôle donnés à un autre (REASSIGN OWNED)",
      file: migration("reassign_owned"),
      content: "reassign owned by postgres to service_role;",
      message: "reassigns owned objects (reassign owned)",
    },
    {
      label: "la fonction de génération modifiée par ALTER FUNCTION",
      file: migration("alter_generation"),
      content:
        "alter function app_private.fact_claims_generation(text) set search_path = public; alter function app_private.fact_claims_generation_ceiling() owner to service_role;",
      message: "alters app_private.fact_claims_generation (security mode",
    },
    {
      label: "le plafond de génération modifié par ALTER FUNCTION",
      file: migration("alter_generation"),
      content: null,
      message: "alters app_private.fact_claims_generation_ceiling (security mode",
    },
    // Lot R2b : fonctions de décision, report à la fusion, relance planifiée.
    {
      label:
        "une fonction de décision ouverte aux comptes connectés hors de la migration des droits",
      file: migration("decision_rpc_granted"),
      content:
        "grant execute on function public.accept_auction_fact_claim(uuid, text, text, uuid) to authenticated;",
      message:
        "grants a privilege on public.accept_auction_fact_claim: the only grant admitted is EXECUTE to authenticated alone, in 20261119100400_fact_claim_decision_grants.sql",
    },
    {
      label: "la fonction de décision interne ouverte au rôle de service",
      file: migration("decide_granted"),
      content:
        "grant execute on function app_private.decide_auction_fact_claim(uuid, text, text, text, text, uuid) to service_role;",
      message:
        "grants a privilege on app_private.decide_auction_fact_claim: no API role may execute it",
    },
    {
      label:
        "une fonction de décision qui reçoit son auteur en paramètre et relaie le détail d'une erreur",
      file: migration("decide_actor_parameter"),
      content:
        "create or replace function app_private.decide_auction_fact_claim(p_claim_id uuid, p_decision text, p_reason_code text, p_lot_attachment text, p_lot_ref text, p_supersedes_decision_id uuid, p_actor_id uuid) returns jsonb language plpgsql security definer set search_path = '' as $$ declare v_detail text; begin insert into public.auction_fact_claim_decisions (claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id) values (p_claim_id, p_claim_id, 'property.rooms_count', p_decision, 'single_lot', 'admin', p_actor_id); return '{}'::jsonb; exception when others then get stacked diagnostics v_detail = pg_exception_detail; raise exception using message = 'failed', detail = v_detail; end; $$;",
      prefix: ": ",
      message:
        "app_private.decide_auction_fact_claim must take the author from (select auth.uid()), never from a parameter",
    },
    {
      label: "la même fonction : le détail de l'erreur relayé",
      file: migration("decide_actor_parameter"),
      content: null,
      prefix: ": ",
      message:
        "app_private.decide_auction_fact_claim reads or relays the detail, the hint or the message of an error",
    },
    {
      label: "la même fonction : une erreur inattendue qui n'est plus ramenée à un code",
      file: migration("decide_actor_parameter"),
      content: null,
      prefix: ": ",
      message:
        "app_private.decide_auction_fact_claim no longer turns an unexpected error into registry_write_failed",
    },
    {
      label: "une fonction publique de décision qui prend un auteur et choisit sa décision",
      file: migration("oppose_actor_parameter"),
      content:
        "create or replace function public.oppose_auction_fact_claim(p_claim_id uuid, p_actor_id uuid, p_decision text default 'opposed') returns jsonb language sql security definer set search_path = '' as $$ select app_private.decide_auction_fact_claim(p_claim_id, p_decision, 'other', null, null, null); $$;",
      prefix: ": ",
      message:
        "public.oppose_auction_fact_claim must have no author parameter and only call app_private.decide_auction_fact_claim with the decision 'opposed'",
    },
    {
      label: "une autre fonction qui appelle la fonction de décision",
      file: migration("decide_wrapped"),
      content:
        "create function public.decide_for(p_claim_id uuid) returns jsonb language sql security definer set search_path = '' as $$ select app_private.decide_auction_fact_claim(p_claim_id, 'accepted', null, 'single_lot', null, null); $$;",
      prefix: ": ",
      message:
        "public.decide_for calls app_private.decide_auction_fact_claim: only the four decision functions may",
    },
    {
      label: "une fonction qui applique la projection sans être une des trois admises",
      file: migration("projection_applied_elsewhere"),
      content:
        "create function app_private.reapply_everything() returns void language plpgsql security definer set search_path = '' as $$ declare v_sale_id uuid; begin perform app_private.project_sale_fields(v_sale_id, null, true); end; $$;",
      prefix: ": ",
      message: "app_private.reapply_everything applies the projection",
    },
    {
      label: "une fonction qui lance la relance planifiée hors de la tâche quotidienne",
      file: migration("reprojection_called_elsewhere"),
      content:
        "create function public.reproject_now() returns jsonb language sql security definer set search_path = '' as $$ select public.reproject_fact_registry_drift() $$;",
      prefix: ": ",
      message:
        "public.reproject_now calls public.reproject_fact_registry_drift: the scheduled reprojection is launched by the daily job only",
    },
    {
      label: "une migration qui ouvre la relance planifiée",
      file: migration("reprojection_opened"),
      content: "select app_private.set_fact_registry_scheduled_reprojection(true);",
      message: "names a switch of the fact registry",
    },
    {
      label: "une migration qui ouvre la relance planifiée en écrivant sa table",
      file: migration("reprojection_opened_by_update"),
      content:
        "update app_private.fact_registry_switches set enabled = true where switch_name = 'scheduled_reprojection';",
      message: "names a switch of the fact registry",
    },
    {
      label:
        "une migration qui ouvre la relance planifiée sous un alias, par une autre colonne d'abord",
      file: migration("reprojection_opened_by_alias"),
      content:
        "update only app_private.fact_registry_switches as s set updated_by = 'x', enabled = true where s.switch_name is not null;",
      message: "names a switch of the fact registry",
    },
    {
      label: "une migration qui lève le second facteur des décisions",
      file: migration("second_factor_lifted"),
      content:
        "do $$ begin perform app_private.set_fact_registry_decisions_second_factor(false); end $$;",
      message: "names a switch of the fact registry",
    },
    {
      label: "une insertion qui rouvre un interrupteur par conflit",
      file: migration("switch_upsert"),
      content:
        "insert into app_private.fact_registry_switches (enabled, switch_name) values (true, 'scheduled_reprojection') on conflict (switch_name) do update set enabled = excluded.enabled;",
      message: "names a switch of the fact registry",
    },
    {
      label: "une relance planifiée qui ne lit plus son interrupteur",
      file: migration("reprojection_without_switch"),
      content:
        "create or replace function public.reproject_fact_registry_drift() returns jsonb language plpgsql security definer set search_path = '' as $$ declare v_sale_id uuid; begin perform app_private.project_sale_fields(v_sale_id, null, true); return '{}'::jsonb; end; $$;",
      prefix: ": ",
      message:
        "public.reproject_fact_registry_drift must take no parameter, read its switch (closed when absent), do nothing without a decision in the journal",
    },
    {
      label: "la même fonction de décision : un corps qui n'est plus celui qui a été relu",
      file: migration("decide_actor_parameter"),
      content: null,
      prefix: ": ",
      message: "the body of app_private.decide_auction_fact_claim is not the reviewed one",
    },
    {
      label: "une fonction qui pose le jeton d'un autre puis appelle une fonction de décision",
      file: migration("accept_as_someone"),
      content:
        "create function public.accept_fact_as(p_who uuid, p_claim_id uuid, p_lot text) returns jsonb language plpgsql security definer set search_path = '' as $$ begin perform pg_catalog.set_config('request.jwt.claims', pg_catalog.jsonb_build_object('sub', p_who, 'role', 'authenticated')::text, true); return public.accept_auction_fact_claim(p_claim_id, p_lot); end; $$;",
      prefix: ": ",
      message: "public.accept_fact_as names a decision function of the fact registry",
    },
    {
      label: "la même fonction : le jeton de la requête écrit",
      file: migration("accept_as_someone"),
      content: null,
      message: "writes the request token (request.jwt.claim",
    },
    {
      label: "une fonction interne qui insère une décision au nom d'un auteur reçu en paramètre",
      file: migration("decision_inserted_elsewhere"),
      content:
        "create function app_private.write_decision(p_who uuid, p_claim uuid, p_sale uuid, p_field text) returns uuid language sql security definer set search_path = '' as $$ insert into public.auction_fact_claim_decisions (claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id) values (p_claim, p_sale, p_field, 'accepted', 'single_lot', 'admin', p_who) returning id $$;",
      prefix: ": ",
      message:
        "app_private.write_decision inserts into public.auction_fact_claim_decisions: only app_private.decide_auction_fact_claim writes a decision",
    },
    {
      label: "une fonction qui pose le jeton par un littéral",
      file: migration("impersonate_literal"),
      content:
        "create function public.impersonate(p_user uuid) returns void language sql security definer set search_path = '' as $$ select pg_catalog.set_config('request.jwt.claims', pg_catalog.json_build_object('sub', p_user)::text, false) $$;",
      message: "writes the request token (request.jwt.claim",
    },
    {
      label: "un jeton posé par SET LOCAL dans le texte d'un EXECUTE",
      file: migration("impersonate_set_local"),
      content:
        "create function app_private.as_user(p_user uuid) returns void language plpgsql set search_path = '' as $$ begin execute pg_catalog.format('set local request.jwt.claim.sub = %L', p_user); end; $$;",
      message: "writes the request token (request.jwt.claim",
    },
    {
      label: "un jeton posé sur un rôle",
      file: migration("impersonate_alter_role"),
      content:
        "alter role service_role set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';",
      message: "writes the request token (request.jwt.claim",
    },
    {
      label: "un jeton posé par la clause SET d'une fonction qui enveloppe une décision",
      file: migration("impersonate_function_set"),
      content:
        "create function public.accept_fact_fixed(p_claim_id uuid, p_lot text) returns jsonb language sql security definer set search_path = '' set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001' as $$ select public.accept_auction_fact_claim(p_claim_id, p_lot) $$;",
      message: "writes the request token (request.jwt.claim",
    },
    {
      label: "une application de la projection cachée par des parenthèses imbriquées",
      file: migration("projection_applied_nested"),
      content:
        "create function app_private.apply_nested(p_sale uuid) returns jsonb language sql security definer set search_path = '' as $$ select app_private.project_sale_fields(coalesce(p_sale, gen_random_uuid()), null, (1 = 1)) $$;",
      prefix: ": ",
      message: "app_private.apply_nested applies the projection",
    },
    {
      label: "une fonction qui écrit des décisions manuelles hors de la fonction de décision",
      file: migration("manual_decisions_elsewhere"),
      content: inFunction(
        decision(
          ", publication_mode",
          "values (gen_random_uuid(), gen_random_uuid(), 'accepted', 'single_lot', 'admin', 'manual')",
        ),
      ),
      prefix: ": ",
      message:
        "app_private.registry_test_writer inserts into public.auction_fact_claim_decisions: only app_private.decide_auction_fact_claim writes a decision",
    },
    {
      label: "une fonction de report qui lit la colonne interne de la vente conservée",
      file: migration("merge_carry_reads_kept_sale"),
      content:
        "create or replace function app_private.carry_sale_user_data_to_merged_sale() returns trigger language plpgsql security definer set search_path = '' as $$ declare v_kept jsonb; begin select to_jsonb(merged) -> 'held_fields' into v_kept from public.auction_sales merged where merged.id <> old.id; perform app_private.project_sale_fields(old.id, null, true, old.held_fields); return old; end; $$;",
      prefix: ": ",
      message:
        "app_private.carry_sale_user_data_to_merged_sale names held_fields otherwise than as old.held_fields",
    },
    {
      label: "la relecture des observations qui rend une décision du journal",
      file: migration("review_reads_journal"),
      content:
        "create or replace function public.review_auction_fact_claim(p_reviewer_id uuid, p_claim_id uuid, p_decision text, p_resolution_note text default null) returns jsonb language sql security definer set search_path = '' as $$ select to_jsonb(decision) from public.auction_fact_claim_decisions decision where decision.claim_id = p_claim_id $$;",
      prefix: ": ",
      message: "public.review_auction_fact_claim reads public.auction_fact_claim_decisions",
    },
    {
      label: "une fonction qui relaie à set_config un nom reçu en paramètre",
      file: migration("set_config_relay"),
      content:
        "create function public.relay_setting(p_name text, p_value text) returns text language sql security definer set search_path = '' as $$ select pg_catalog.set_config(p_name, p_value, true) $$;",
      message: "calls set_config with a first argument that is not a literal setting name",
    },
    {
      label: "un nom de réglage assemblé à partir d'une constante",
      file: migration("set_config_concat"),
      content:
        "create function public.relay_setting_suffix(p_name text) returns text language sql security definer set search_path = '' as $$ select set_config('app.' || p_name, 'x', true) $$;",
      message: "calls set_config with a first argument that is not a literal setting name",
    },
    {
      label: "un jeton posé par une fonction créée dans un schéma de la plateforme",
      file: migration("impersonate_platform_schema"),
      content:
        "create function realtime.as_user(p_user uuid) returns text language sql security definer set search_path = '' as $$ select pg_catalog.set_config('request.jwt.claims', pg_catalog.json_build_object('sub', p_user)::text, true) $$;",
      message: "writes the request token (request.jwt.claim",
    },
    {
      label: "le même jeton, seulement nommé, dans un schéma de la plateforme",
      file: migration("token_named_platform_schema"),
      content:
        "create or replace function extensions.token_name() returns text language sql set search_path = '' as $$ select 'request.jwt' || '.claims' $$;",
      message: "names the request token (request.jwt)",
    },
    // Contre-vérification du lot R2b : contournements trouvés par la relecture, tels qu'elle les a écrits, et
    // formes voisines. Toute routine est lue, quelle que soit la forme de son corps ; le texte du fichier juge.
    {
      label:
        "une enveloppe « begin atomic » ouverte à service_role, avec un jeton posé par un EXECUTE assemblé (Nx06)",
      file: migration("cv2_nx06"),
      content:
        "create function app_private.request_scope(p_who uuid) returns boolean language plpgsql set search_path = '' as $s1$ begin execute pg_catalog.format('set local %I = %L', 'request.jwt.' || 'claims', pg_catalog.json_build_object('sub', p_who, 'role', 'authenticated', 'aal', 'aal2')::text); return true; end; $s1$; create function public.registry_batch(p_who uuid, p_claim uuid) returns jsonb language sql security definer set search_path = '' begin atomic select public.oppose_auction_fact_claim(p_claim) from (select app_private.request_scope(p_who) as ready offset 0) scope where scope.ready; end; grant execute on function public.registry_batch(uuid, uuid) to service_role;",
      prefix: ": ",
      message:
        "public.registry_batch names a decision function of the fact registry: nothing wraps",
    },
    {
      label: "le même fichier : il nomme une fonction de décision",
      file: migration("cv2_nx06"),
      content: null,
      message:
        "names a decision function of the fact registry: only 20261118100100_fact_claim_decision_rpcs.sql, 20261119100100_fact_decision_limits_switch_and_author_lock.sql, 20261119100400_fact_claim_decision_grants.sql may",
    },
    {
      label: "le même fichier : un EXECUTE dont le texte est assemblé",
      file: migration("cv2_nx06"),
      content: null,
      message: "runs dynamic SQL (execute) whose text is not a single string literal",
    },
    {
      label: "le même fichier : le jeton de la requête nommé en deux morceaux",
      file: migration("cv2_nx06"),
      content: null,
      message: "names the request token (request.jwt)",
    },
    {
      label: "la même enveloppe en SECURITY INVOKER, ouverte à authenticated (Nx07)",
      file: migration("cv2_nx07"),
      content:
        "create function app_private.request_scope(p_who uuid) returns boolean language plpgsql set search_path = '' as $s1$ begin execute pg_catalog.format('set local %I = %L', 'request.jwt.' || 'claims', pg_catalog.json_build_object('sub', p_who, 'role', 'authenticated', 'aal', 'aal2')::text); return true; end; $s1$; create function public.registry_batch(p_who uuid, p_claim uuid) returns jsonb language sql security invoker set search_path = '' begin atomic select public.oppose_auction_fact_claim(p_claim) from (select app_private.request_scope(p_who) as ready offset 0) scope where scope.ready; end; grant execute on function public.registry_batch(uuid, uuid) to authenticated;",
      prefix: ": ",
      message:
        "public.registry_batch names a decision function of the fact registry: nothing wraps",
    },
    {
      label: "une décision écrite par MERGE dans une fonction (Nb02)",
      file: migration("cv2_nb02"),
      content:
        "create function app_private.nb(p_who uuid, p_claim uuid) returns jsonb language plpgsql security definer set search_path = '' as $$ begin merge into public.auction_fact_claim_decisions d using (select c.id, c.auction_sale_id, c.field_key from public.auction_fact_claims c where c.id = p_claim) s on false when not matched then insert (claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id) values (s.id, s.auction_sale_id, s.field_key, 'opposed', 'unknown', 'admin', p_who); return null; end; $$; revoke all on function app_private.nb(uuid, uuid) from public, anon, authenticated; grant execute on function app_private.nb(uuid, uuid) to service_role;",
      message: "writes public.auction_fact_claim_decisions (insert, merge or copy)",
    },
    {
      label: "une enveloppe dont la balise du corps porte un chiffre (Nd04)",
      file: migration("cv2_nd04"),
      content:
        "create function public.nd(p_who uuid, p_claim uuid) returns jsonb language plpgsql security definer set search_path = '' as $w1$ begin return public.oppose_auction_fact_claim(p_claim); end; $w1$; revoke all on function public.nd(uuid, uuid) from public, anon, authenticated; grant execute on function public.nd(uuid, uuid) to service_role;",
      prefix: ": ",
      message: "public.nd names a decision function of the fact registry: nothing wraps",
    },
    {
      label: "la même balise, appel direct de la fonction de décision (Nd05)",
      file: migration("cv2_nd05"),
      content:
        "create function public.nd(p_who uuid, p_claim uuid) returns jsonb language plpgsql security definer set search_path = '' as $w1$ begin return app_private.decide_auction_fact_claim(p_claim, 'opposed', 'professional_opposition', null, null, null); end; $w1$; revoke all on function public.nd(uuid, uuid) from public, anon, authenticated; grant execute on function public.nd(uuid, uuid) to service_role;",
      prefix: ": ",
      message:
        "public.nd calls app_private.decide_auction_fact_claim: only the four decision functions may",
    },
    {
      label: "une enveloppe dont le corps est écrit entre apostrophes (Nd06)",
      file: migration("cv2_nd06"),
      content:
        "create function public.nd(p_claim uuid) returns jsonb language sql security definer set search_path = '' as 'select public.oppose_auction_fact_claim(p_claim)'; grant execute on function public.nd(uuid) to service_role;",
      prefix: ": ",
      message: "public.nd names a decision function of the fact registry: nothing wraps",
    },
    {
      label: "une enveloppe « begin atomic » (Nd07)",
      file: migration("cv2_nd07"),
      content:
        "create function public.nd(p_claim uuid) returns jsonb language sql security definer set search_path = '' begin atomic select public.oppose_auction_fact_claim(p_claim); end; grant execute on function public.nd(uuid) to service_role;",
      prefix: ": ",
      message: "public.nd names a decision function of the fact registry: nothing wraps",
    },
    {
      label: "une enveloppe écrite comme une procédure (Nd08)",
      file: migration("cv2_nd08"),
      content:
        "create procedure public.nd(p_claim uuid) language plpgsql security definer set search_path = '' as $$ begin perform public.oppose_auction_fact_claim(p_claim); end; $$; grant execute on procedure public.nd(uuid) to service_role;",
      prefix: ": ",
      message: "public.nd names a decision function of the fact registry: nothing wraps",
    },
    {
      label: "une enveloppe qui assemble le nom de la fonction dans un EXECUTE (Nd09)",
      file: migration("cv2_nd09"),
      content:
        "create function public.nd(p_who uuid, p_claim uuid) returns jsonb language plpgsql security definer set search_path = '' as $$ declare v jsonb; begin execute 'select public.oppose_' || 'auction_fact_claim($1)' into v using p_claim; return v; end; $$; revoke all on function public.nd(uuid, uuid) from public, anon, authenticated; grant execute on function public.nd(uuid, uuid) to service_role;",
      message: "runs dynamic SQL (execute) whose text is not a single string literal",
    },
    {
      label: "un droit donné sur une fonction de décision nommée sans son schéma (Nc02)",
      file: migration("cv2_nc02"),
      content:
        "grant execute on function accept_auction_fact_claim(uuid, text, text, uuid) to anon;",
      message:
        "grants a privilege on public.accept_auction_fact_claim: the only grant admitted is EXECUTE to authenticated alone",
    },
    {
      label: "le même fichier : il nomme une fonction de décision",
      file: migration("cv2_nc02"),
      content: null,
      message:
        "names a decision function of the fact registry: only 20261118100100_fact_claim_decision_rpcs.sql, 20261119100100_fact_decision_limits_switch_and_author_lock.sql, 20261119100400_fact_claim_decision_grants.sql may",
    },
    {
      label: "un jeton posé par un EXECUTE format (Na16)",
      file: migration("cv2_na16"),
      content:
        "create function public.na(p_who uuid, p_claim uuid) returns jsonb language plpgsql security definer set search_path = '' as $$ begin execute pg_catalog.format('set local %I = %L', 'request.jwt.claims', '{}'); return null; end; $$; revoke all on function public.na(uuid, uuid) from public, anon, authenticated; grant execute on function public.na(uuid, uuid) to service_role;",
      message: "runs dynamic SQL (execute) whose text is not a single string literal",
    },
    {
      label: "le même fichier : le jeton de la requête nommé",
      file: migration("cv2_na16"),
      content: null,
      message: "names the request token (request.jwt)",
    },
    {
      label: "une décision écrite par COPY",
      file: migration("journal_copy"),
      content: "copy public.auction_fact_claim_decisions from '/tmp/decisions.csv';",
      message: "writes public.auction_fact_claim_decisions (insert, merge or copy)",
    },
    {
      label: "la relance planifiée ouverte à un rôle du navigateur, nommée sans son schéma",
      file: migration("reprojection_unqualified"),
      content: "grant execute on function reproject_fact_registry_drift() to anon;",
      message:
        "grants on public.reproject_fact_registry_drift something else than EXECUTE to service_role alone",
    },
    {
      label: "une routine dont le corps ne se lit pas",
      file: migration("routine_without_body"),
      content: "create function public.unreadable_body() returns integer language sql;",
      prefix: ": ",
      message: "the body of the routine public.unreadable_body cannot be read",
    },
    {
      label: "la lecture du second facteur redéfinie pour ne plus l'exiger",
      file: migration("second_factor_reader_off"),
      content:
        "create or replace function app_private.fact_registry_decisions_second_factor_required() returns boolean language sql stable security definer set search_path = '' as $$ select false; $$;",
      prefix: ": ",
      message:
        "app_private.fact_registry_decisions_second_factor_required must only read the switch decisions_require_second_factor, and answer true when its row is missing",
    },
    {
      label: "la lecture de l'interrupteur de la relance redéfinie pour l'ouvrir",
      file: migration("reprojection_reader_on"),
      content:
        "create or replace function app_private.fact_registry_scheduled_reprojection_enabled() returns boolean language sql stable security definer set search_path = '' as $r2$ select true; $r2$;",
      prefix: ": ",
      message:
        "app_private.fact_registry_scheduled_reprojection_enabled must only read the switch scheduled_reprojection, and answer false when its row is missing",
    },
    // Lot R2c. Contre-vérification 3 du lot R2b : les cas P01 à P07 et R_01 de la relecture, tels qu'elle les a
    // écrits, et formes voisines.
    {
      label: "une enveloppe qui nomme une fonction de décision par un identifiant Unicode (P01)",
      file: migration("cv3_p01"),
      content:
        "create function public.registry_batch(p_claim uuid) returns jsonb language sql security definer set search_path = '' as $$ select public.U&\"oppose\\005Fauction_fact_claim\"(p_claim) $$; revoke all on function public.registry_batch(uuid) from public, anon, authenticated; grant execute on function public.registry_batch(uuid) to service_role;",
      message: "writes a Unicode-escaped identifier or string (U&)",
    },
    {
      label: "une décision insérée dans le journal nommé par un identifiant Unicode (P02)",
      file: migration("cv3_p02"),
      content:
        "create function app_private.registry_note(p_who uuid, p_claim uuid) returns void language sql security definer set search_path = '' as $$ insert into public.U&\"auction_fact_claim\\005Fdecisions\" (claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id, reason_code) select c.id, c.auction_sale_id, c.field_key, 'opposed', 'unknown', 'admin', p_who, 'other' from public.auction_fact_claims c where c.id = p_claim $$;",
      message: "writes a Unicode-escaped identifier or string (U&)",
    },
    {
      label: "un EXECUTE d'un littéral qui crée une fonction au SQL assemblé (P03)",
      file: migration("cv3_p03"),
      content:
        "do $$ begin execute 'create function public.registry_batch(p_claim uuid) returns jsonb language plpgsql security definer set search_path = '''' as $f$ declare r jsonb; begin execute pg_catalog.format(''select public.%I($1)'', ''oppose_'' || ''auction_fact_claim'') into r using p_claim; return r; end $f$'; end $$;",
      message: "writes an EXECUTE inside a string",
    },
    {
      label: "une requête assemblée lancée par query_to_xml (P04)",
      file: migration("cv3_p04"),
      content:
        "create function public.registry_batch(p_claim uuid) returns xml language sql security definer set search_path = '' as $$ select pg_catalog.query_to_xml('select public.oppose_' || 'auction_fact_claim(' || pg_catalog.quote_literal(p_claim::text) || '::uuid)', false, false, '') $$;",
      message: "names query_to_xml, which runs the text of a query",
    },
    {
      label: "une requête lancée par dblink",
      file: migration("cv3_dblink"),
      content: "select extensions.dblink_exec('dbname=postgres', 'select 1');",
      message: "names dblink_exec, which runs the text of a query",
    },
    {
      label: "une requête lancée par ts_stat",
      file: migration("cv3_ts_stat"),
      content: "select * from pg_catalog.ts_stat('select ' || 'to_tsvector(''x'')');",
      message: "names ts_stat, which runs the text of a query",
    },
    {
      label: "une table fille du journal des décisions (P05)",
      file: migration("cv3_p05"),
      content:
        "create table app_private.decision_notes () inherits (public.auction_fact_claim_decisions);",
      message:
        "creates a child table or a structure copy of auction_fact_claim_decisions (INHERITS or LIKE)",
    },
    {
      label: "une copie de structure de la file des évènements",
      file: migration("cv3_like"),
      content:
        "create table app_private.events_copy (like public.auction_sale_field_hold_events including all);",
      message:
        "creates a child table or a structure copy of auction_sale_field_hold_events (INHERITS or LIKE)",
    },
    {
      label: "un déclencheur du journal coupé par une action placée après une autre (P06)",
      file: migration("cv3_p06"),
      content:
        "alter table public.auction_fact_claim_decisions alter column reason_code set statistics 100, disable trigger auction_fact_claim_decisions_append_only; update public.auction_fact_claim_decisions set decision = 'rejected', reason_code = 'other' where decision = 'opposed'; alter table public.auction_fact_claim_decisions alter column reason_code set statistics -1, enable always trigger auction_fact_claim_decisions_append_only;",
      message:
        "disables the trigger auction_fact_claim_decisions_append_only of public.auction_fact_claim_decisions",
    },
    {
      label: "le même fichier : le journal des décisions réécrit",
      file: migration("cv3_p06"),
      content: null,
      message: "updates, deletes from or truncates public.auction_fact_claim_decisions",
    },
    {
      label: "le déclencheur de validation coupé après une autre action (P06d)",
      file: migration("cv3_p06d"),
      content:
        "alter table public.auction_fact_claim_decisions validate constraint auction_fact_claim_decisions_reason_code_check, disable trigger auction_fact_claim_decisions_validate;",
      message:
        "disables the trigger auction_fact_claim_decisions_validate of public.auction_fact_claim_decisions",
    },
    {
      label: "le même déclencheur coupé derrière une étoile (P06e)",
      file: migration("cv3_p06e"),
      content:
        "alter table public.auction_fact_claim_decisions * disable trigger auction_fact_claim_decisions_validate;",
      message:
        "disables the trigger auction_fact_claim_decisions_validate of public.auction_fact_claim_decisions",
    },
    {
      label: "le même déclencheur nommé par un identifiant Unicode (P06f)",
      file: migration("cv3_p06f"),
      content:
        'alter table public.auction_fact_claim_decisions disable trigger U&"auction\\005Ffact_claim_decisions_validate";',
      message:
        "disables the trigger auction_fact_claim_decisions_validate of public.auction_fact_claim_decisions",
    },
    {
      label: "un déclencheur du registre remis en mode ordinaire après une autre action",
      file: migration("cv3_enable_after_action"),
      content:
        "alter table public.auction_sale_field_hold_events alter column event set statistics 100, enable trigger auction_sale_field_hold_events_stamp;",
      message:
        "puts the trigger auction_sale_field_hold_events_stamp of public.auction_sale_field_hold_events back to a mode that replica sessions skip",
    },
    {
      label: "une tâche pg_cron dont la commande est assemblée (P07)",
      file: migration("cv3_p07"),
      content:
        "select cron.schedule('registry-batch', '*/5 * * * *', 'select set_' || 'config(''req'' || ''uest.jwt.claims'', ''{\"sub\":\"88700000-0000-4000-8000-0000000000a1\",\"role\":\"authenticated\",\"aal\":\"aal2\"}'', true), public.opp' || 'ose_auction_fact_claim(c.id) from public.auction_fact_claims c limit 1');",
      message: "schedules a pg_cron job whose arguments are not all string literals",
    },
    {
      label:
        "une tâche pg_cron dont la commande littérale pose le jeton et nomme une fonction de décision",
      file: migration("cv3_cron_literal"),
      content:
        "select cron.schedule('registry-batch', '*/5 * * * *', $job$select set_config('request.jwt.claims', '{}', true), public.oppose_auction_fact_claim(c.id) from public.auction_fact_claims c limit 1$job$);",
      message: "writes the request token (request.jwt.claim",
    },
    {
      label: "le même fichier : il nomme une fonction de décision",
      file: migration("cv3_cron_literal"),
      content: null,
      message: "names a decision function of the fact registry: only",
    },
    {
      label: "la commande d'une tâche pg_cron changée par cron.alter_job",
      file: migration("cv3_cron_alter"),
      content: "select cron.alter_job(job_id := 1, command := 'select ' || 'pg_catalog.now()');",
      message: "changes the command of a pg_cron job",
    },
    {
      label: "une décision supprimée dans une fonction",
      file: migration("cv3_journal_delete"),
      content:
        "create function app_private.forget_decisions() returns void language sql security definer set search_path = '' as $$ delete from public.auction_fact_claim_decisions where reason_code = 'other' $$;",
      message: "updates, deletes from or truncates public.auction_fact_claim_decisions",
    },
    {
      label: "le journal des décisions vidé par le texte d'un EXECUTE",
      file: migration("cv3_journal_truncate"),
      content:
        "do $$ begin execute 'truncate table public.auction_sale_field_hold_events, public.auction_fact_claim_decisions'; end $$;",
      message: "updates, deletes from or truncates public.auction_fact_claim_decisions",
    },
    {
      label: "une fonction qui coupe tous les déclencheurs d'une table (N3)",
      file: migration("cv3_n3_trigger_user"),
      content:
        "create function app_private.quiet_rewrite() returns void language plpgsql security definer set search_path = '' as $$ begin alter table public.auction_sales disable trigger user; update public.auction_sales set city = btrim(city); alter table public.auction_sales enable trigger user; end; $$;",
      prefix: ": ",
      message:
        "app_private.quiet_rewrite switches every trigger of a table (trigger user or trigger all)",
    },
    {
      label: "une fonction de suspension des déclencheurs redéfinie hors de sa migration",
      file: migration("cv3_resume_redefined"),
      content:
        "create or replace function app_private.resume_ordinary_sale_triggers(p_triggers name[]) returns void language plpgsql set search_path = '' as $$ declare v_trigger name; begin foreach v_trigger in array p_triggers loop execute pg_catalog.format('alter table public.auction_sales enable trigger %I', v_trigger); end loop; end; $$; revoke all on function app_private.resume_ordinary_sale_triggers(name[]) from public, anon, authenticated, service_role;",
      prefix: ": ",
      message:
        "the body of app_private.resume_ordinary_sale_triggers is not the reviewed one of 20261119100000_sale_triggers_suspended_by_name.sql",
    },
    {
      label:
        "le même fichier : la forme admise des rattrapages n'est pas admise dans une autre migration",
      file: migration("cv3_resume_redefined"),
      content: null,
      message: "runs dynamic SQL (execute) whose text is not a single string literal",
    },
    {
      label: "une fonction de décision ouverte au rôle de service",
      file: migration("cv3_grant_service_role"),
      content:
        "grant execute on function public.oppose_auction_fact_claim(uuid, text) to service_role;",
      message:
        "grants a privilege on public.oppose_auction_fact_claim: the only grant admitted is EXECUTE to authenticated alone",
    },
    {
      label: "les plafonds levés par une autre migration",
      file: migration("cv3_limits_off_elsewhere"),
      content: "select app_private.set_fact_registry_decision_rate_limits(false);",
      message: "names a switch of the fact registry",
    },
    {
      label: "la lecture du réglage des plafonds redéfinie pour ne plus les appliquer",
      file: migration("cv3_limits_reader_off"),
      content:
        "create or replace function app_private.fact_registry_decision_rate_limits_enabled() returns boolean language sql stable security definer set search_path = '' as $$ select coalesce((select switch.enabled from app_private.fact_registry_switches switch where switch.switch_name = 'decision_rate_limits_enabled'), false); $$;",
      prefix: ": ",
      message:
        "app_private.fact_registry_decision_rate_limits_enabled must only read the switch decision_rate_limits_enabled, and answer true when its row is missing",
    },
    {
      label: "un rattrapage qui donne à sa variable le nom d'un déclencheur du registre (R_01)",
      where: "repair",
      file: "repairs/99990101000010_cv3_r01.sql",
      content:
        "begin;\n-- leurre : les deux mots attendus par le contrôle, dans une requête sans rapport\nselect count(*) from pg_catalog.pg_trigger trigger_row where trigger_row.tgenabled = 'O' and trigger_row.tgname not like 'aaab\\_%';\ndo $suspend$\ndeclare\n  v_trigger name := 'aaab_auction_sales_hold_projected_fields';\nbegin\n  execute pg_catalog.format('alter table public.auction_sales disable trigger %I', v_trigger);\nend;\n$suspend$;\nupdate public.auction_sales set rooms_count = 99 where held_fields is not null;\nalter table public.auction_sales enable always trigger aaab_auction_sales_hold_projected_fields;\nselect app_private.assert_fact_registry_triggers();\ncommit;",
      message: "gives its trigger variable v_trigger a name outside the admitted loop",
    },
    {
      label: "le même rattrapage : un déclencheur du registre nommé après TRIGGER",
      where: "repair",
      file: "repairs/99990101000010_cv3_r01.sql",
      content: null,
      message: "names a trigger of the fact registry (aaab_…) after TRIGGER",
    },
    {
      label: "un rattrapage dont la boucle admise est élargie par une union",
      where: "repair",
      file: "repairs/99990101000011_cv3_loop_union.sql",
      content:
        "begin; do $$ declare v_trigger name; begin for v_trigger in select trigger_row.tgname from pg_catalog.pg_trigger trigger_row where trigger_row.tgenabled = 'O' and trigger_row.tgname not like 'aaab\\_%' union select 'auction_sales_other'::name loop execute format('alter table public.auction_sales disable trigger %I', v_trigger); end loop; end $$; update public.auction_sales set city = btrim(city); select app_private.assert_fact_registry_triggers(); commit;",
      message: "gives its trigger variable v_trigger a name outside the admitted loop",
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
        Object.entries({ ...filesOf("repair"), ...filesOf("maintenance") }).map(
          ([file, content]) => [`supabase/${file}`, content],
        ),
      ),
    });
  });

  it("le script échoue sur ces fichiers", () => {
    expect(refused.status).toBe(1);
  });

  it.each(bypasses)("refuse $label", ({ file, prefix = " ", message }) => {
    expect(refused.stderr).toContain(prefix === null ? message : `${file}${prefix}${message}`);
  });

  // Une colonne tenue, puis une colonne voisine surveillée contre l'écho (lot R2a) : un passage chacune.
  it.each(["rooms_count", "habitable_surface_m2"])(
    "refuse un déclencheur de retenue qui ne se déclenche plus sur %s",
    (column) => {
      const result = runInvariants({
        [migration("hold_trigger_without_column")]: holdTrigger(
          heldColumns.replace(` ${column},`, ""),
          holdWhen,
        ),
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `the hold trigger aaab_auction_sales_hold_projected_fields no longer fires on a write of ${column}`,
      );
    },
  );

  // La vue des observations sans son expression ancrée (un passage : même objet que le cas « autre extracteur »).
  it("refuse une vue des observations qui compare les versions comme des chaînes", () => {
    const result = runInvariants({
      [migration("claims_view_text_compare")]:
        "create or replace view public.v_auction_fact_claims_read_model with (security_invoker = true) as select claim.id as claim_id from public.auction_fact_claims claim left join (select peer.auction_sale_id, max(peer.extractor_version) as generation from public.auction_fact_claims peer where peer.extractor_name = 'immojudis.pipeline.fact_claims' group by peer.auction_sale_id) latest on latest.auction_sale_id = claim.auction_sale_id where not coalesce(claim.extractor_version < latest.generation, false);",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "public.v_auction_fact_claims_read_model no longer reads the generation of the pipeline claims through app_private.fact_claims_generation",
    );
  });

  // Lot R2c : la migration des droits et celle des réglages sont admises telles qu'elles sont, et rien de plus.
  // (Le fichier du dépôt est remplacé par une copie retouchée : un passage par cas.)
  const withAppended = (file, addition) =>
    runInvariants(
      { [file]: readFileSync(join(repo, "supabase/migrations", file), "utf8") + addition },
      [file],
    );

  it("refuse, dans la migration des droits elle-même, un droit donné à un autre rôle", () => {
    const file = "20261119100400_fact_claim_decision_grants.sql";
    const result = withAppended(
      file,
      "\ngrant execute on function public.reject_auction_fact_claim(uuid, text) to authenticated, anon;\n",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `${file} grants a privilege on public.reject_auction_fact_claim: the only grant admitted is EXECUTE to authenticated alone`,
    );
  });

  it("refuse, dans la migration des réglages, un réglage posé hors des deux décisions du propriétaire", () => {
    const file = "20261119100100_fact_decision_limits_switch_and_author_lock.sql";
    const opened = withAppended(
      file,
      "\nselect app_private.set_fact_registry_scheduled_reprojection(true);\n",
    );
    expect(opened.status).toBe(1);
    expect(opened.stderr).toContain(
      `${file} sets a switch of the fact registry otherwise than in its safe sense`,
    );
    // La décision admise, écrite dans une fonction, redevient un appel de fonction de réglage.
    const wrapped = withAppended(
      file,
      "\ncreate function app_private.lift_second_factor() returns boolean language sql security definer set search_path = '' as $$ select app_private.set_fact_registry_decisions_second_factor(false); $$;\n",
    );
    expect(wrapped.status).toBe(1);
    expect(wrapped.stderr).toContain(
      `${file} sets a switch of the fact registry otherwise than in its safe sense`,
    );
  });

  it("accepte les formes permises et annonce les quatorze invariants", () => {
    const result = runInvariants(
      {
        [migration("accepted_recreated_guard")]:
          `create or replace trigger auction_fact_claim_decisions_append_only before update or delete on public.auction_fact_claim_decisions for each row execute function app_private.fact_registry_append_only(); ${always("auction_fact_claim_decisions", "auction_fact_claim_decisions_append_only")}`,
        [migration("accepted_dropped_and_recreated_guard")]:
          `drop trigger if exists auction_fact_claims_no_truncate on public.auction_fact_claims; create trigger auction_fact_claims_no_truncate before truncate on public.auction_fact_claims for each statement execute function app_private.refuse_auction_fact_claims_truncate(); ${always("auction_fact_claims", "auction_fact_claims_no_truncate")}`,
        [migration("accepted_recreated_hold")]: holdTrigger(heldColumns, holdWhen),
        [migration("accepted_detach")]:
          "update public.auction_fact_claims set auction_sale_id = null where auction_sale_id = '00000000-0000-4000-8000-000000000001';",
        [migration("accepted_later_trigger")]:
          "create trigger zzzz_auction_sales_other before update on public.auction_sales for each row execute function app_private.stamp_auction_sale_content_changed_at();",
        [migration("accepted_registry_read")]:
          "grant select on table public.auction_fact_fields to service_role;",
        // Un vrai commentaire n'est pas du code (une chaîne, elle, est lue : elle peut être du SQL dynamique).
        [migration("accepted_comments")]:
          "-- update public.auction_sales set held_fields = null; set session_replication_role = replica;\nselect 1; /* grant all on all tables in schema public to anon; */",
        // Les quatre formes de corps se lisent, et un EXECUTE d'un seul littéral est admis.
        [migration("accepted_routine_forms")]:
          "select cron.schedule('accepted-job', '*/5 * * * *', $job$select 1$job$); select cron.schedule(job_name => 'accepted-job-2', schedule => '0 3 * * *', command => 'select pg_catalog.now()'); create function public.accepted_digit_tag() returns integer language plpgsql set search_path = '' as $f1$ declare v integer; begin execute 'select 1' into v; return v; end; $f1$; create procedure public.accepted_procedure() language sql set search_path = '' as 'select 1'; create function public.accepted_atomic(p integer) returns integer language sql set search_path = '' begin atomic select case when p > 0 then 1 else 0 end; end; create function public.accepted_return(p integer) returns integer language sql set search_path = '' return p + 1;",
        [migration("accepted_projection_writes")]:
          "create or replace function app_private.project_sale_fields(p_sale_id uuid, p_fields text[] default null, p_apply boolean default false, p_listing_hints jsonb default null) returns jsonb language plpgsql security definer set search_path = '' as $$ declare t_surface_source text; t_app_surface_kind text; begin t_surface_source := 'fact_registry'; t_app_surface_kind := 'built'; perform set_config('app.sale_field_projection', p_sale_id::text, true); update public.auction_sales set held_fields = null, surface_source = t_surface_source, app_surface_kind = t_app_surface_kind where id = p_sale_id; return '{}'::jsonb; end; $$;",
      },
      [],
      {},
      {
        "supabase/repairs/99990101000000_accepted_repair.sql":
          "select app_private.project_sale_fields(sale.id, null, false) from public.auction_sales sale where false;",
        // Un rattrapage qui écrit les ventes : déclencheurs ordinaires hors registre coupés par leur nom,
        // puis le contrôle du mode des déclencheurs en dernière instruction avant le commit.
        "supabase/repairs/99990101000001_accepted_writing_repair.sql":
          "begin; do $$ declare v_trigger name; begin for v_trigger in select trigger_row.tgname from pg_catalog.pg_trigger trigger_row where trigger_row.tgrelid = 'public.auction_sales'::regclass and not trigger_row.tgisinternal and trigger_row.tgenabled = 'O' and trigger_row.tgname not like 'aaab\\_%' loop execute format('alter table public.auction_sales disable trigger %I', v_trigger); execute format('alter table public.auction_sales enable trigger %I', v_trigger); end loop; end $$; update public.auction_sales set city = btrim(city) where city <> btrim(city); select app_private.assert_fact_registry_triggers(); commit;",
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
        "held-fields-never-returned",
        "fact-registry-check-read-only",
        "registry-neutral-surface-labels",
        "fact-claims-generation-pattern",
        "set-config-literal-name",
        "registry-rpc-actor-from-jwt",
        "registry-rpc-no-error-detail",
      ]),
    );
  });
});
