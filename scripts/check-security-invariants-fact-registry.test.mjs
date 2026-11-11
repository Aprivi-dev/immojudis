// Invariants du registre des pièces (scripts/check-security-invariants-fact-registry.mjs, lots R1 et R2a) et
// verrous ajoutés pour lui à information-agent-no-automatic-publication-path.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { removeSandboxes, runInvariants } from "./check-security-invariants-harness.mjs";

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
      message:
        "public.check_fact_registry_consistency must call the projection as a simulation only",
    },
    {
      label:
        "une fonction d'alertes qui reprend une borne en paramètre et écrit la table des alertes",
      file: migration("alerts_direct_write"),
      content:
        "create or replace function public.sync_fact_registry_alerts(p_limit integer default 500) returns jsonb language plpgsql security definer set search_path = '' as $$ declare v_report jsonb := public.check_fact_registry_consistency(p_limit); begin insert into public.operational_alerts (alert_key, category, severity) values ('anything', 'import', 'critical'); return v_report; end; $$;",
      prefix: ": ",
      message:
        "public.sync_fact_registry_alerts must take no parameter and only run the check, with its default bound",
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

  it("accepte les formes permises et annonce les douze invariants", () => {
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
      ]),
    );
  });
});
