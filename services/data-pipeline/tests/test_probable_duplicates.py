"""Drapeau ``probable_duplicate`` : posé sur les copies que le balayage supprimerait, retiré quand elles ne le sont plus."""

from __future__ import annotations

import httpx
import pytest

from src import probable_duplicates
from src.normalize import normalize_sale
from src.position_quality import PROBABLE_DUPLICATE, preserved_position_flags, remove_flags
from src.probable_duplicates import MAX_WRITES_PER_PASS, flag_probable_duplicates, plan_flag_updates
from src.storage import duplicate_sweep
from src.storage.duplicate_sweep import DuplicateMergeGroup, DuplicateRowSummary, DuplicateSweepPlan


class _EmptyRegistry:
    def protected_sale_ids(self):
        return frozenset()

    def protected_source_urls(self):
        return frozenset()


def _sale(source_name: str, source_url: str, row_id: str, **extra: object):
    sale = normalize_sale(
        {
            "source_name": source_name,
            "source_url": source_url,
            "city": "Ondres",
            "postal_code": "40440",
            "property_type": "house",
            "surface_m2": "80",
            "starting_price_eur": "70 000 €",
            "sale_date": "mardi 10 novembre 2026 à 14h",
            **extra,
        }
    )
    sale.tribunal_code = "dax"
    sale.id = row_id
    return sale


def _summary(row_id: str, flags: tuple[str, ...] = ()) -> DuplicateRowSummary:
    return DuplicateRowSummary(
        id=row_id,
        source_name="licitor",
        source_url=f"https://www.licitor.com/annonce/{row_id}.html",
        city="Ondres",
        sale_date="2026-11-10T13:00:00+00:00",
        starting_price_eur="70000",
        status="upcoming",
        quality_flags=flags,
    )


def _plan(*groups: tuple[DuplicateRowSummary, tuple[DuplicateRowSummary, ...]], truncated: bool = False):
    return DuplicateSweepPlan(
        scanned=10,
        truncated=truncated,
        truncation_reason="read_ceiling" if truncated else None,
        groups=[DuplicateMergeGroup(primary=primary, secondaries=secondaries, reason="strict_key") for primary, secondaries in groups],
    )


# --- plan_flag_updates ------------------------------------------------------------------------------


def test_the_flag_goes_on_the_copies_the_sweep_would_delete_not_on_the_kept_row() -> None:
    plan = _plan((_summary("kept"), (_summary("copy-1", ("multi_lot_sale",)), _summary("copy-2"))))

    updates = plan_flag_updates(plan, [])

    assert updates.add == {
        "copy-1": ["multi_lot_sale", PROBABLE_DUPLICATE],
        "copy-2": [PROBABLE_DUPLICATE],
    }
    assert updates.remove == {}


def test_a_copy_that_already_carries_the_flag_is_left_alone() -> None:
    plan = _plan((_summary("kept"), (_summary("copy", (PROBABLE_DUPLICATE,)),)))

    updates = plan_flag_updates(plan, [{"id": "copy", "quality_flags": [PROBABLE_DUPLICATE]}])

    assert updates.total == 0


def test_the_flag_is_removed_once_the_condition_is_gone() -> None:
    # « stale » n'est plus candidate ; « kept » a gardé le drapeau d'avant la fusion.
    plan = _plan((_summary("kept"), (_summary("copy"),)))
    flagged = [
        {"id": "copy", "quality_flags": [PROBABLE_DUPLICATE]},
        {"id": "stale", "quality_flags": ["price_conflict", PROBABLE_DUPLICATE]},
        {"id": "kept", "quality_flags": [PROBABLE_DUPLICATE, "multi_lot_sale"]},
    ]

    updates = plan_flag_updates(plan, flagged)

    assert updates.add == {"copy": [PROBABLE_DUPLICATE]}  # la liste de la copie lue dans le plan n'avait pas le drapeau
    assert updates.remove == {"stale": ["price_conflict"], "kept": ["multi_lot_sale"]}


def test_a_partial_scan_never_removes_a_flag_but_still_adds_the_pairs_it_saw() -> None:
    plan = _plan((_summary("kept"), (_summary("copy"),)), truncated=True)

    updates = plan_flag_updates(plan, [{"id": "stale", "quality_flags": [PROBABLE_DUPLICATE]}])

    assert updates.remove == {}
    assert list(updates.add) == ["copy"]


def test_a_row_without_id_or_with_garbage_flags_is_ignored() -> None:
    plan = _plan((_summary("kept"), (DuplicateRowSummary(None, "licitor", "u", None, None, None, None),)))

    updates = plan_flag_updates(
        plan,
        [{"id": None, "quality_flags": [PROBABLE_DUPLICATE]}, {"id": "x", "quality_flags": "probable_duplicate"}],
    )

    assert updates.total == 0


# --- avec le vrai plan du balayage ------------------------------------------------------------------


def test_a_strict_key_pair_flags_only_the_copy() -> None:
    licitor = _sale("licitor", "https://www.licitor.com/annonce/20.html", "id-licitor")
    avoventes = _sale("avoventes", "https://avoventes.fr/enchere/20", "id-avoventes")

    plan = duplicate_sweep.build_plan([licitor, avoventes], _EmptyRegistry(), max_merges=None)

    assert len(plan.groups) == 1
    primary, copy = plan.groups[0].primary, plan.groups[0].secondaries[0]
    assert {primary.id, copy.id} == {"id-licitor", "id-avoventes"}
    updates = plan_flag_updates(plan, [])
    assert updates.add == {copy.id: [PROBABLE_DUPLICATE]}
    assert updates.remove == {}


def test_the_kept_row_loses_the_flag_the_merge_would_have_copied_onto_it() -> None:
    licitor = _sale("licitor", "https://www.licitor.com/annonce/20.html", "id-licitor")
    avoventes = _sale("avoventes", "https://avoventes.fr/enchere/20", "id-avoventes")
    # Les deux lignes portaient le drapeau d'un passage précédent.
    licitor.quality_flags = [PROBABLE_DUPLICATE]
    avoventes.quality_flags = [PROBABLE_DUPLICATE]

    plan = duplicate_sweep.build_plan([licitor, avoventes], _EmptyRegistry(), max_merges=None)

    assert all(PROBABLE_DUPLICATE not in sale.quality_flags for sale in plan.impacted_sales)
    primary = plan.groups[0].primary
    flagged = [
        {"id": "id-licitor", "quality_flags": [PROBABLE_DUPLICATE]},
        {"id": "id-avoventes", "quality_flags": [PROBABLE_DUPLICATE]},
    ]
    updates = plan_flag_updates(plan, flagged)
    assert updates.add == {}
    assert updates.remove == {primary.id: []}


def test_two_unrelated_sales_are_not_flagged() -> None:
    first = _sale("licitor", "https://www.licitor.com/annonce/21.html", "a", city="Dax", postal_code="40100")
    second = _sale("avoventes", "https://avoventes.fr/enchere/21", "b", starting_price_eur="90 000 €")

    plan = duplicate_sweep.build_plan([first, second], _EmptyRegistry(), max_merges=None)

    assert plan_flag_updates(plan, []).total == 0


# --- Écriture ---------------------------------------------------------------------------------------


class _Response:
    def __init__(self, payload=None, status_code: int = 200):
        self._payload = payload
        self.status_code = status_code
        self.is_error = status_code >= 400
        self.text = ""

    def json(self):
        return self._payload


def _run(monkeypatch, *, plan, flagged_pages, write: bool, patch_status: int = 200):
    patches: list[dict[str, object]] = []
    gets: list[dict[str, object]] = []
    monkeypatch.setattr(
        probable_duplicates,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )
    monkeypatch.setattr(probable_duplicates, "plan_duplicate_reconciliation", lambda **kwargs: plan)
    pages = iter(flagged_pages)

    def fake_get(url, **kwargs):
        gets.append({"url": url, **kwargs})
        page = next(pages)
        if isinstance(page, Exception):
            raise page
        return _Response(page)

    def fake_patch(url, **kwargs):
        patches.append({"url": url, **kwargs})
        return _Response(status_code=patch_status)

    monkeypatch.setattr(probable_duplicates.httpx, "get", fake_get)
    monkeypatch.setattr(probable_duplicates.httpx, "patch", fake_patch)
    code = flag_probable_duplicates(write=write)
    return code, patches, gets


def test_a_dry_run_reads_and_writes_nothing(monkeypatch) -> None:
    plan = _plan((_summary("kept"), (_summary("copy"),)))

    code, patches, gets = _run(
        monkeypatch, plan=plan, flagged_pages=[[{"id": "stale", "quality_flags": [PROBABLE_DUPLICATE]}], []], write=False
    )

    assert code == 0
    assert patches == []
    assert gets[0]["params"]["quality_flags"] == 'cs.["probable_duplicate"]'


def test_write_patches_only_the_quality_flags_of_the_rows_that_change(monkeypatch) -> None:
    plan = _plan((_summary("kept"), (_summary("copy", ("multi_lot_sale",)),)))

    code, patches, _ = _run(
        monkeypatch,
        plan=plan,
        flagged_pages=[[{"id": "stale", "quality_flags": ["price_conflict", PROBABLE_DUPLICATE]}], []],
        write=True,
    )

    assert code == 0
    assert [(patch["params"]["id"], patch["json"]) for patch in patches] == [
        ("eq.stale", {"quality_flags": ["price_conflict"]}),
        ("eq.copy", {"quality_flags": ["multi_lot_sale", PROBABLE_DUPLICATE]}),
    ]
    assert all(patch["url"] == "https://supabase.test/rest/v1/auction_sales" for patch in patches)
    assert all(set(patch["json"]) == {"quality_flags"} for patch in patches)


def test_an_unreadable_flag_list_writes_nothing_and_fails(monkeypatch) -> None:
    plan = _plan((_summary("kept"), (_summary("copy"),)))

    code, patches, _ = _run(monkeypatch, plan=plan, flagged_pages=[httpx.ConnectError("down")], write=True)

    assert code == 1
    assert patches == []


def test_a_failed_write_is_reported_and_the_others_still_go_through(monkeypatch) -> None:
    plan = _plan((_summary("kept"), (_summary("copy-1"), _summary("copy-2"))))

    code, patches, _ = _run(monkeypatch, plan=plan, flagged_pages=[[]], write=True, patch_status=500)

    assert code == 1
    assert len(patches) == 2


def test_the_number_of_writes_per_pass_is_capped(monkeypatch) -> None:
    copies = tuple(_summary(f"copy-{index}") for index in range(MAX_WRITES_PER_PASS + 5))
    plan = _plan((_summary("kept"), copies))

    code, patches, _ = _run(monkeypatch, plan=plan, flagged_pages=[[]], write=True)

    assert code == 0
    assert len(patches) == MAX_WRITES_PER_PASS


def test_without_a_plan_or_credentials_nothing_happens(monkeypatch) -> None:
    monkeypatch.setattr(probable_duplicates, "load_settings", lambda: {})
    assert flag_probable_duplicates(write=True) == 1
    monkeypatch.setattr(
        probable_duplicates,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )
    monkeypatch.setattr(probable_duplicates, "plan_duplicate_reconciliation", lambda **kwargs: None)
    assert flag_probable_duplicates(write=True) == 1


# --- Le drapeau survit au recalcul d'une ligne et à l'effacement des drapeaux de position -------------


def test_recompute_keeps_the_flag_with_the_position_flags() -> None:
    assert preserved_position_flags(["price_conflict", PROBABLE_DUPLICATE, "implausible_coordinates"]) == [
        PROBABLE_DUPLICATE,
        "implausible_coordinates",
    ]


@pytest.mark.parametrize("flags", [[PROBABLE_DUPLICATE], ["x", PROBABLE_DUPLICATE]])
def test_clearing_the_position_flags_does_not_clear_the_flag(flags) -> None:
    from src.position_quality import POSITION_FLAGS

    assert PROBABLE_DUPLICATE in remove_flags(flags, POSITION_FLAGS)
