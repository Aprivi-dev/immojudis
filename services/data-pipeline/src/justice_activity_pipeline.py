from __future__ import annotations

import json
import math
import re
import unicodedata
from collections import defaultdict
from collections.abc import Callable, Mapping, Sequence
from dataclasses import asdict, dataclass, replace
from datetime import UTC, date, datetime
from typing import Any, Literal

from src.official_sources.justice_activity import (
    PARSER_VERSION,
    STATJUR_ENDPOINT_URL,
    JusticeActivityParseResult,
    JusticeJurisdictionActivityRecord,
)
from src.storage.supabase_client import _postgres_connect

MatchStatus = Literal["exact_official_reference", "exact_code", "exact_name", "ambiguous", "unmatched"]
_PUBLISHABLE_CATALOGUE_SAMPLE = 5


class JusticeActivityPipelineError(RuntimeError):
    pass


@dataclass(frozen=True)
class CourtReference:
    court_id: str
    code: str
    name: str
    judicial_region: str | None
    official_origin_code: str | None = None
    official_srj_code: str | None = None


@dataclass(frozen=True)
class ActivityMatch:
    record: JusticeJurisdictionActivityRecord
    status: MatchStatus
    court: CourtReference | None
    candidate_court_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class PersistActivitySummary:
    import_id: str
    inserted: bool
    source_rows: int
    matched_rows: int
    unmatched_rows: int


@dataclass(frozen=True)
class JudicialRegionReference:
    by_official_reference: Mapping[tuple[str, str], str]
    by_normalized_name: Mapping[str, str]


@dataclass(frozen=True)
class CourtCoverageProfile:
    court_id: str
    court_code: str
    court_name: str
    judicial_region: str | None
    catalogue_sales_36m: int
    catalogue_profile_publishable: bool
    official_activity_year: int
    official_new_cases_status: str
    official_new_cases_value: int | None
    official_terminated_cases_status: str
    official_terminated_cases_value: int | None


@dataclass(frozen=True)
class RegionPilot:
    name: str
    volume_band: Literal["low", "medium", "high"]
    tracked_courts: int
    publishable_catalogue_profiles: int
    catalogue_sales_36m: int
    readiness_score: float


@dataclass(frozen=True)
class CoverageReport:
    generated_at: str
    official_activity_year: int
    catalogue_window_months: int
    periods_comparable: bool
    catalogue_total_sales_36m: int
    catalogue_exact_court_sales_36m: int
    catalogue_exact_court_assignment_rate: float
    matched_source_rows: int
    ambiguous_source_rows: int
    unmatched_source_rows: int
    courts: tuple[CourtCoverageProfile, ...]
    pilot_regions: tuple[RegionPilot, ...]
    warnings: tuple[str, ...]

    def as_dict(self) -> dict[str, object]:
        return asdict(self)


def normalize_court_name(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", value)
    ascii_value = "".join(character for character in decomposed if not unicodedata.combining(character))
    normalized = re.sub(r"[^a-z0-9]+", " ", ascii_value.casefold()).strip()
    normalized = re.sub(
        r"^(?:greffe du )?(?:tribunal (?:de grande instance|judiciaire)|tgi|tj)(?: de | d | )",
        "",
        normalized,
    )
    return re.sub(r"\s+", " ", normalized).strip()


def match_activity_records(
    records: Sequence[JusticeJurisdictionActivityRecord],
    courts: Sequence[CourtReference],
) -> tuple[ActivityMatch, ...]:
    courts_by_code: dict[str, list[CourtReference]] = defaultdict(list)
    courts_by_name: dict[str, list[CourtReference]] = defaultdict(list)
    courts_by_official_reference: dict[tuple[str, str], list[CourtReference]] = defaultdict(list)
    for court in courts:
        courts_by_code[court.code.casefold()].append(court)
        fingerprint = normalize_court_name(court.name)
        if fingerprint:
            courts_by_name[fingerprint].append(court)
        if court.official_origin_code and court.official_srj_code:
            courts_by_official_reference[(court.official_origin_code, court.official_srj_code)].append(court)

    matches: list[ActivityMatch] = []
    for record in records:
        official_reference = statjur_official_reference(record.source_court_code)
        official_candidates = courts_by_official_reference.get(official_reference, [])
        if len(official_candidates) == 1:
            matches.append(
                ActivityMatch(record=record, status="exact_official_reference", court=official_candidates[0])
            )
            continue
        if len(official_candidates) > 1:
            matches.append(
                ActivityMatch(
                    record=record,
                    status="ambiguous",
                    court=None,
                    candidate_court_ids=tuple(sorted(candidate.court_id for candidate in official_candidates)),
                )
            )
            continue

        code_candidates = courts_by_code.get(record.source_court_code.casefold(), [])
        if len(code_candidates) == 1:
            matches.append(ActivityMatch(record=record, status="exact_code", court=code_candidates[0]))
            continue
        if len(code_candidates) > 1:
            matches.append(
                ActivityMatch(
                    record=record,
                    status="ambiguous",
                    court=None,
                    candidate_court_ids=tuple(sorted(candidate.court_id for candidate in code_candidates)),
                )
            )
            continue

        name_candidates = courts_by_name.get(normalize_court_name(record.source_court_name), [])
        if len(name_candidates) == 1:
            matches.append(ActivityMatch(record=record, status="exact_name", court=name_candidates[0]))
        elif len(name_candidates) > 1:
            matches.append(
                ActivityMatch(
                    record=record,
                    status="ambiguous",
                    court=None,
                    candidate_court_ids=tuple(sorted(candidate.court_id for candidate in name_candidates)),
                )
            )
        else:
            matches.append(ActivityMatch(record=record, status="unmatched", court=None))
    return tuple(matches)


def statjur_official_reference(source_court_code: str) -> tuple[str, str]:
    if not re.fullmatch(r"\d{8}", source_court_code):
        raise ValueError("StatJur jurisdiction code must contain eight digits")
    origin = source_court_code[:3].lstrip("0") or "0"
    srj = source_court_code[3:].lstrip("0") or "0"
    return origin, srj


def build_judicial_region_reference(records: Sequence[Mapping[str, object]]) -> JudicialRegionReference:
    regions_by_official: dict[tuple[str, str], set[str]] = defaultdict(set)
    regions_by_name: dict[str, set[str]] = defaultdict(set)
    for record in records:
        origin = str(record.get("tj_origin_code") or "").strip()
        srj = str(record.get("tj_srj_code") or "").strip()
        court_name = normalize_court_name(str(record.get("tj_name") or ""))
        region = str(record.get("ca_name") or "").strip()
        if origin and srj and region:
            regions_by_official[(origin, srj)].add(region)
        if court_name and region:
            regions_by_name[court_name].add(region)
    return JudicialRegionReference(
        by_official_reference={key: next(iter(values)) for key, values in regions_by_official.items() if len(values) == 1},
        by_normalized_name={key: next(iter(values)) for key, values in regions_by_name.items() if len(values) == 1},
    )


def enrich_court_judicial_regions(
    courts: Sequence[CourtReference],
    reference: JudicialRegionReference,
) -> tuple[CourtReference, ...]:
    enriched: list[CourtReference] = []
    for court in courts:
        region = court.judicial_region
        if not region and court.official_origin_code and court.official_srj_code:
            region = reference.by_official_reference.get((court.official_origin_code, court.official_srj_code))
        if not region:
            region = reference.by_normalized_name.get(normalize_court_name(court.name))
        enriched.append(replace(court, judicial_region=region))
    return tuple(enriched)


def build_coverage_report(
    *,
    result: JusticeActivityParseResult,
    matches: Sequence[ActivityMatch],
    catalogue_counts: Mapping[str, int],
    catalogue_total_sales: int | None = None,
    generated_at: datetime | None = None,
    pilot_count: int = 5,
) -> CoverageReport:
    exact = [match for match in matches if match.court is not None]
    profiles = tuple(
        sorted(
            (
                CourtCoverageProfile(
                    court_id=match.court.court_id,
                    court_code=match.court.code,
                    court_name=match.court.name,
                    judicial_region=match.court.judicial_region,
                    catalogue_sales_36m=max(0, int(catalogue_counts.get(match.court.court_id, 0))),
                    catalogue_profile_publishable=(
                        int(catalogue_counts.get(match.court.court_id, 0)) >= _PUBLISHABLE_CATALOGUE_SAMPLE
                    ),
                    official_activity_year=result.activity_year,
                    official_new_cases_status=match.record.new_sales_seizures.status,
                    official_new_cases_value=match.record.new_sales_seizures.value,
                    official_terminated_cases_status=match.record.terminated_sales_seizures.status,
                    official_terminated_cases_value=match.record.terminated_sales_seizures.value,
                )
                for match in exact
                if match.court is not None
            ),
            key=lambda profile: (-profile.catalogue_sales_36m, profile.court_name),
        )
    )
    pilots = select_pilot_regions(profiles, count=pilot_count)
    exact_catalogue_sales = sum(profile.catalogue_sales_36m for profile in profiles)
    total_catalogue_sales = exact_catalogue_sales if catalogue_total_sales is None else catalogue_total_sales
    if total_catalogue_sales < exact_catalogue_sales or total_catalogue_sales < 0:
        raise ValueError("catalogue total cannot be lower than exactly assigned sales")
    assignment_rate = exact_catalogue_sales / total_catalogue_sales if total_catalogue_sales else 0.0
    ambiguous = sum(match.status == "ambiguous" for match in matches)
    unmatched = sum(match.status == "unmatched" for match in matches)
    timestamp = generated_at or datetime.now(UTC)
    if timestamp.tzinfo is None or timestamp.utcoffset() is None:
        raise ValueError("generated_at must be timezone-aware")
    return CoverageReport(
        generated_at=timestamp.astimezone(UTC).isoformat().replace("+00:00", "Z"),
        official_activity_year=result.activity_year,
        catalogue_window_months=36,
        periods_comparable=False,
        catalogue_total_sales_36m=total_catalogue_sales,
        catalogue_exact_court_sales_36m=exact_catalogue_sales,
        catalogue_exact_court_assignment_rate=assignment_rate,
        matched_source_rows=len(exact),
        ambiguous_source_rows=ambiguous,
        unmatched_source_rows=unmatched,
        courts=profiles,
        pilot_regions=pilots,
        warnings=(
            "Les volumes StatJur historiques et le catalogue ImmoJudis sur 36 mois sont affichés côte à côte, jamais divisés.",
            "NC désigne une valeur officielle non nulle inférieure à cinq; ce statut ne vaut ni zéro ni donnée absente.",
            "Le catalogue couvre uniquement les ventes au tribunal vérifiées ou recoupées; les ventes notariales et pending sont exclues.",
            "Seuls un code exact ou un libellé normalisé résolu vers un unique tribunal actif peuvent alimenter un profil tribunal.",
            "Les ventes judiciaires admissibles sans tribunal actif rattaché restent dans le total catalogue mais hors profils locaux.",
        ),
    )


def select_pilot_regions(
    profiles: Sequence[CourtCoverageProfile],
    *,
    count: int = 5,
) -> tuple[RegionPilot, ...]:
    if count < 1:
        return ()
    grouped: dict[str, list[CourtCoverageProfile]] = defaultdict(list)
    for profile in profiles:
        if profile.judicial_region and profile.judicial_region.strip():
            grouped[profile.judicial_region.strip()].append(profile)

    candidates: list[tuple[str, int, int, int]] = []
    for region, region_profiles in grouped.items():
        tracked = len(region_profiles)
        if tracked < 3:
            continue
        publishable = sum(profile.catalogue_profile_publishable for profile in region_profiles)
        catalogue_volume = sum(profile.catalogue_sales_36m for profile in region_profiles)
        if catalogue_volume > 0:
            candidates.append((region, tracked, publishable, catalogue_volume))
    if not candidates:
        return ()

    volume_ranks = {
        region: rank
        for rank, (region, _tracked, _publishable, _volume) in enumerate(
            sorted(candidates, key=lambda candidate: (candidate[3], candidate[0]))
        )
    }
    pilots: list[RegionPilot] = []
    for region, tracked, publishable, catalogue_volume in candidates:
        volume_tertile = min(2, volume_ranks[region] * 3 // len(candidates))
        if volume_tertile == 0:
            band: Literal["low", "medium", "high"] = "low"
        elif volume_tertile == 2:
            band = "high"
        else:
            band = "medium"
        coverage = publishable / tracked
        score = round(coverage * 0.7 + min(1.0, math.log1p(catalogue_volume) / math.log(101)) * 0.3, 6)
        pilots.append(
            RegionPilot(
                name=region,
                volume_band=band,
                tracked_courts=tracked,
                publishable_catalogue_profiles=publishable,
                catalogue_sales_36m=catalogue_volume,
                readiness_score=score,
            )
        )

    selected: list[RegionPilot] = []
    for band in ("high", "medium", "low"):
        band_candidates = sorted(
            (pilot for pilot in pilots if pilot.volume_band == band),
            key=lambda pilot: (-pilot.readiness_score, pilot.name),
        )
        if band_candidates and len(selected) < count:
            selected.append(band_candidates[0])
    remaining = sorted(
        (pilot for pilot in pilots if pilot not in selected),
        key=lambda pilot: (-pilot.readiness_score, pilot.name),
    )
    selected.extend(remaining[: max(0, count - len(selected))])
    return tuple(selected)


class JusticeActivityRepository:
    def __init__(self, *, connect: Callable[[str], Any] = _postgres_connect) -> None:
        self._connect = connect

    def load_courts_and_catalogue_counts(
        self,
        db_url: str,
        *,
        as_of: date,
        window_months: int = 36,
    ) -> tuple[tuple[CourtReference, ...], dict[str, int], int]:
        if window_months not in {12, 24, 36}:
            raise ValueError("catalogue window must be 12, 24 or 36 months")
        with self._connect(db_url) as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                select
                  court.id::text as court_id,
                  court.code,
                  court.name,
                  court.judicial_region,
                  official_reference.court_origin_code,
                  official_reference.court_srj_code,
                  count(sale.id) filter (
                    where sale.sale_date >= %s::date - make_interval(months => %s)
                      and sale.sale_date < %s::date + interval '1 day'
                  )::integer as catalogue_sales
                from public.outcome_courts court
                left join lateral (
                  select
                    reference.official_origin_code as court_origin_code,
                    reference.official_srj_code as court_srj_code
                  from public.outcome_court_official_references reference
                  where reference.court_id = court.id
                  order by reference.observed_on desc, reference.created_at desc
                  limit 1
                ) official_reference on true
                left join public.auction_sales sale
                  on sale.tribunal_code = court.code
                 and sale.sale_venue_type = 'tribunal'
                 and sale.sale_verification_status in ('verified', 'cross_checked')
                where court.active and court.court_type = 'tribunal_judiciaire'
                group by
                  court.id, court.code, court.name, court.judicial_region,
                  official_reference.court_origin_code, official_reference.court_srj_code
                order by court.code
                """,
                (as_of, window_months, as_of),
            )
            rows = cursor.fetchall()
            columns = [description.name for description in cursor.description]
            cursor.execute(
                """
                select count(*)::integer
                from public.auction_sales sale
                where sale.sale_date >= %s::date - make_interval(months => %s)
                  and sale.sale_date < %s::date + interval '1 day'
                  and sale.sale_venue_type = 'tribunal'
                  and sale.sale_verification_status in ('verified', 'cross_checked')
                """,
                (as_of, window_months, as_of),
            )
            total_catalogue_sales = int(cursor.fetchone()[0])
        mappings = [dict(zip(columns, row, strict=True)) for row in rows]
        courts = tuple(
            CourtReference(
                court_id=str(row["court_id"]),
                code=str(row["code"]),
                name=str(row["name"]),
                judicial_region=(str(row["judicial_region"]) if row["judicial_region"] else None),
                official_origin_code=(
                    str(row["court_origin_code"]) if row["court_origin_code"] is not None else None
                ),
                official_srj_code=(str(row["court_srj_code"]) if row["court_srj_code"] is not None else None),
            )
            for row in mappings
        )
        counts = {str(row["court_id"]): int(row["catalogue_sales"] or 0) for row in mappings}
        return courts, counts, total_catalogue_sales

    def persist(
        self,
        db_url: str,
        *,
        result: JusticeActivityParseResult,
        matches: Sequence[ActivityMatch],
        fetched_at: datetime,
    ) -> PersistActivitySummary:
        if fetched_at.tzinfo is None or fetched_at.utcoffset() is None:
            raise ValueError("fetched_at must be timezone-aware")
        matched_count = sum(match.court is not None for match in matches)
        with self._connect(db_url) as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                select id::text, official, active, legal_review_status, ingestion_policy
                from public.data_sources
                where name = 'justice_jurisdiction_statistics'
                for share
                """
            )
            policy = cursor.fetchone()
            if not policy or policy[1:] != (True, True, "approved", "allowed_automated"):
                raise JusticeActivityPipelineError(
                    "justice_jurisdiction_statistics must be official, approved, automated and active"
                )
            source_id = str(policy[0])
            cursor.execute(
                """
                insert into public.justice_jurisdiction_activity_imports (
                  source_id, source_url, source_version, parser_version,
                  period_start_year, period_end_year, fetched_at, content_hash,
                  source_row_count, matched_row_count, unmatched_row_count,
                  national_new_cases_status, national_new_cases_value,
                  national_terminated_cases_status, national_terminated_cases_value
                ) values (
                  %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
                )
                on conflict (source_id, content_hash, parser_version) do nothing
                returning id::text
                """,
                (
                    source_id,
                    STATJUR_ENDPOINT_URL,
                    result.source_version,
                    PARSER_VERSION,
                    result.activity_year,
                    result.activity_year,
                    fetched_at,
                    result.content_hash,
                    len(matches),
                    matched_count,
                    len(matches) - matched_count,
                    result.national.new_sales_seizures.status,
                    result.national.new_sales_seizures.value,
                    result.national.terminated_sales_seizures.status,
                    result.national.terminated_sales_seizures.value,
                ),
            )
            inserted_row = cursor.fetchone()
            if inserted_row is None:
                cursor.execute(
                    """
                    select id::text
                    from public.justice_jurisdiction_activity_imports
                    where source_id = %s and content_hash = %s and parser_version = %s
                    """,
                    (source_id, result.content_hash, PARSER_VERSION),
                )
                existing = cursor.fetchone()
                if not existing:
                    raise JusticeActivityPipelineError("idempotent StatJur import could not be resolved")
                return PersistActivitySummary(
                    import_id=str(existing[0]),
                    inserted=False,
                    source_rows=len(matches),
                    matched_rows=matched_count,
                    unmatched_rows=len(matches) - matched_count,
                )

            import_id = str(inserted_row[0])
            for match in matches:
                cursor.execute(
                    """
                    insert into public.justice_jurisdiction_activity (
                      import_id, court_id, source_court_code, source_court_name,
                      activity_year, match_status, match_details,
                      new_cases_status, new_cases_value,
                      terminated_cases_status, terminated_cases_value, canonical_hash
                    ) values (%s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s, %s, %s)
                    """,
                    (
                        import_id,
                        match.court.court_id if match.court else None,
                        match.record.source_court_code,
                        match.record.source_court_name,
                        match.record.activity_year,
                        match.status,
                        json.dumps({"candidateCourtIds": match.candidate_court_ids}, separators=(",", ":")),
                        match.record.new_sales_seizures.status,
                        match.record.new_sales_seizures.value,
                        match.record.terminated_sales_seizures.status,
                        match.record.terminated_sales_seizures.value,
                        match.record.canonical_hash,
                    ),
                )
            connection.commit()
            return PersistActivitySummary(
                import_id=import_id,
                inserted=True,
                source_rows=len(matches),
                matched_rows=matched_count,
                unmatched_rows=len(matches) - matched_count,
            )
