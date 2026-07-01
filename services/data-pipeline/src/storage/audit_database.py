from __future__ import annotations

import json
from typing import Any

import psycopg

from src.config import load_settings

QUERIES = {
    "tables": """
        select c.relname as table_name, c.reltuples::bigint as estimated_rows, obj_description(c.oid) as table_comment
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind = 'r'
          and c.relname like 'auction_%'
        order by c.relname;
    """,
    "columns": """
        select table_name, column_name, data_type, is_nullable, column_default
        from information_schema.columns
        where table_schema = 'public'
          and table_name like 'auction_%'
        order by table_name, ordinal_position;
    """,
    "constraints": """
        select tc.table_name, tc.constraint_name, tc.constraint_type, kcu.column_name,
               ccu.table_name as foreign_table, ccu.column_name as foreign_column
        from information_schema.table_constraints tc
        left join information_schema.key_column_usage kcu
          on tc.constraint_name = kcu.constraint_name
         and tc.table_schema = kcu.table_schema
        left join information_schema.constraint_column_usage ccu
          on tc.constraint_name = ccu.constraint_name
         and tc.table_schema = ccu.table_schema
        where tc.table_schema = 'public'
          and tc.table_name like 'auction_%'
        order by tc.table_name, tc.constraint_type, tc.constraint_name, kcu.ordinal_position;
    """,
    "indexes": """
        select tablename, indexname, indexdef
        from pg_indexes
        where schemaname = 'public'
          and tablename like 'auction_%'
        order by tablename, indexname;
    """,
    "rls": """
        select c.relname as table_name, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as force_rls
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind = 'r'
          and c.relname like 'auction_%'
        order by c.relname;
    """,
    "policies": """
        select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
        from pg_policies
        where schemaname = 'public'
          and tablename like 'auction_%'
        order by tablename, policyname;
    """,
    "counts": """
        select 'auction_sales' as table_name, count(*) as rows from auction_sales union all
        select 'auction_observations', count(*) from auction_observations union all
        select 'auction_features', count(*) from auction_features union all
        select 'auction_surfaces', count(*) from auction_surfaces union all
        select 'auction_risks', count(*) from auction_risks union all
        select 'auction_runs', count(*) from auction_runs union all
        select 'auction_documents', count(*) from auction_documents union all
        select 'auction_extractions', count(*) from auction_extractions union all
        select 'auction_scoring_versions', count(*) from auction_scoring_versions union all
        select 'auction_sale_history', count(*) from auction_sale_history;
    """,
    "quality": """
        select
          count(*) as total,
          count(*) filter (where source_url is null or source_url = '') as missing_source_url,
          count(*) filter (where source_name is null or source_name = '') as missing_source_name,
          count(*) filter (where department is null) as missing_department,
          count(*) filter (where tribunal is null) as missing_tribunal,
          count(*) filter (where sale_date is null) as missing_sale_date,
          count(*) filter (where latitude is null or longitude is null) as missing_gps,
          count(*) filter (where app_surface_m2 is null) as missing_app_surface,
          count(*) filter (where rooms_count is null) as missing_rooms,
          count(*) filter (where bedrooms_count is null) as missing_bedrooms,
          count(*) filter (where content_hash is null) as missing_hash,
          count(*) filter (where status not in ('upcoming','past','adjudicated','unknown')) as invalid_status,
          count(*) filter (
            where property_type not in ('apartment','house','building','land','commercial','parking','mixed','other','unknown')
              and property_type is not null
          ) as invalid_property_type,
          count(*) filter (
            where occupancy_status not in ('vacant','occupied','rented','owner_occupied','squatted','unknown')
              and occupancy_status is not null
          ) as invalid_occupancy,
          count(*) filter (where sale_date < now() and status in ('upcoming','unknown')) as expired_not_past
        from auction_sales;
    """,
    "duplicates": """
        select 'content_hash' as key, content_hash as value, count(*) as n
        from auction_sales
        where content_hash is not null
        group by content_hash
        having count(*) > 1
        order by n desc;
    """,
    "orphans": """
        select 'observations_no_parent' as check_name, count(*) as rows
        from auction_observations o
        left join auction_sales s on s.source_url = o.canonical_source_url
        where o.canonical_source_url is not null and s.source_url is null
        union all
        select 'features_no_parent', count(*)
        from auction_features f left join auction_sales s on s.source_url = f.source_url
        where s.source_url is null
        union all
        select 'surfaces_no_parent', count(*)
        from auction_surfaces f left join auction_sales s on s.source_url = f.source_url
        where s.source_url is null
        union all
        select 'risks_no_parent', count(*)
        from auction_risks r left join auction_sales s on s.source_url = r.source_url
        where s.source_url is null
        union all
        select 'documents_no_parent', count(*)
        from auction_documents d left join auction_sales s on s.source_url = d.source_url
        where s.source_url is null
        union all
        select 'extractions_no_parent', count(*)
        from auction_extractions e left join auction_sales s on s.source_url = e.source_url
        where s.source_url is null
        union all
        select 'history_no_parent', count(*)
        from auction_sale_history h left join auction_sales s on s.source_url = h.source_url
        where s.source_url is null;
    """,
    "status_counts": """
        select status, count(*) as rows
        from auction_sales
        group by status
        order by rows desc;
    """,
    "source_counts": """
        select source_name, count(*) as rows
        from auction_sales
        group by source_name
        order by rows desc;
    """,
    "department_counts": """
        select department, count(*) as rows
        from auction_sales
        group by department
        order by department;
    """,
    "samples": """
        select source_name, city, department, tribunal, property_type, status, sale_date,
               app_surface_m2, rooms_count, bedrooms_count, quality_flags
        from auction_sales
        order by source_name, city
        limit 50;
    """,
    "checks": """
        select conrelid::regclass::text as table_name, conname, pg_get_constraintdef(oid) as definition
        from pg_constraint
        where connamespace = 'public'::regnamespace
          and conrelid::regclass::text like 'auction_%'
          and contype = 'c'
        order by table_name, conname;
    """,
    "triggers": """
        select event_object_table as table_name, trigger_name, action_timing, event_manipulation, action_statement
        from information_schema.triggers
        where trigger_schema = 'public'
          and event_object_table like 'auction_%'
        order by event_object_table, trigger_name;
    """,
    "grants": """
        select table_name, grantee, privilege_type
        from information_schema.role_table_grants
        where table_schema = 'public'
          and table_name like 'auction_%'
        order by table_name, grantee, privilege_type;
    """,
    "views": """
        select table_name, view_definition
        from information_schema.views
        where table_schema = 'public'
          and table_name like 'auction_%'
        order by table_name;
    """,
    "extensions": """
        select extname, extversion
        from pg_extension
        order by extname;
    """,
    "stale_sales": """
        select source_url, source_name, city, sale_date, status, last_seen_at, updated_at
        from auction_sales
        where last_seen_at < now() - interval '2 days'
        order by last_seen_at nulls first;
    """,
    "canonical_vs_observations": """
        select s.source_url, s.source_name,
               jsonb_array_length(coalesce(s.observations, '[]'::jsonb)) as embedded_observations,
               count(o.source_url) as observation_rows
        from auction_sales s
        left join auction_observations o on o.canonical_source_url = s.source_url
        group by s.source_url, s.source_name, s.observations
        order by observation_rows desc, embedded_observations desc;
    """,
    "risk_duplicates": """
        select source_url, risk_type, risk_label, count(*) as rows
        from auction_risks
        group by source_url, risk_type, risk_label
        having count(*) > 1
        order by rows desc;
    """,
    "bad_surfaces": """
        select source_url, city, property_type, app_surface_m2, habitable_surface_m2,
               land_surface_m2, carrez_surface_m2, surface_evidence
        from auction_sales
        where app_surface_m2 is not null
          and (app_surface_m2 < 20 or app_surface_m2 > 1000)
        order by app_surface_m2;
    """,
    "tribunal_flags": """
        select city, department, tribunal, quality_flags
        from auction_sales
        where quality_flags ? 'tribunal_inconsistent'
        order by department, city;
    """,
}


def run_audit() -> dict[str, list[dict[str, Any]]]:
    settings = load_settings()
    db_url = settings["supabase_db_url"]
    if not db_url:
        raise RuntimeError("SUPABASE_DB_URL is missing")
    output: dict[str, list[dict[str, Any]]] = {}
    with psycopg.connect(str(db_url)) as connection:
        with connection.cursor() as cursor:
            for name, query in QUERIES.items():
                cursor.execute(query)
                columns = [description.name for description in cursor.description]
                output[name] = [dict(zip(columns, row, strict=True)) for row in cursor.fetchall()]
    return output


def main() -> int:
    print(json.dumps(run_audit(), ensure_ascii=False, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
