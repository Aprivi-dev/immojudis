"""Un changement de source déjà absorbé ne réinvalide pas la lecture des pièces (04/11/2026).

La collecte recopie ``source_content_changed`` depuis la ligne enregistrée tant que l'étape LLM ne l'a pas
consommé. Pris pour un nouveau changement, ce drapeau hérité effaçait ``document_facts_version`` à chaque
collecte : 99 ventes relues dans la journée ont été invalidées de nouveau sans que leur page ait changé.
"""

from __future__ import annotations

from src import known_enrichment
from src.dedupe import merge_duplicate_sales
from src.freshness import is_new_source_change, record_source_checks
from src.normalize import normalize_sale
from src.publication_identity import merge_revision

V5 = "document_facts_v5_quality_audit"


def _sale(url: str, source_name: str = "avoventes"):
    sale = normalize_sale(
        {
            "source_name": source_name,
            "source_url": url,
            "address": "12 rue Victor Hugo",
            "postal_code": "33000",
            "city": "Bordeaux",
            "starting_price_eur": 100000,
            "sale_date": "2099-10-01T10:00:00+00:00",
        }
    )
    sale.raw_payload["source_checks"] = {url: {"checked_at": "2026-11-04T10:00:00+00:00"}}
    return sale


def _pending(payload: dict, *, at: str | None, reason: str = "source_content_changed") -> None:
    payload.update(source_content_changed=True, source_content_change_reason=reason)
    if at is not None:
        payload["source_content_changed_at"] = at


def test_the_comparison_tells_an_inherited_flag_from_a_new_change() -> None:
    stored = {"source_content_changed": True, "source_content_changed_at": "2026-11-04T01:00:00+00:00"}
    assert is_new_source_change({}, stored) is False
    assert is_new_source_change(dict(stored), stored) is False
    assert is_new_source_change({**stored, "source_content_changed_at": "2026-11-04T14:00:00+00:00"}, stored) is True
    assert is_new_source_change(dict(stored), {}) is True
    # Rows stored before the date existed: the copied reason and marker identify an inherited flag.
    legacy = {"source_content_changed": True, "source_content_change_reason": "source_content_changed"}
    assert is_new_source_change(dict(legacy), legacy) is False
    assert is_new_source_change({**legacy, "source_content_change_reason": "source_operational_changed"}, legacy)


def test_a_detected_change_is_dated() -> None:
    url = "https://example.test/dated"
    first = {"source_url": url, "source_name": "avoventes", "starting_price_eur": 100000}
    record_source_checks([first], {})
    known = {url: {"raw_payload": {"source_checks": first["source_checks"]}}}
    changed = {"source_url": url, "source_name": "avoventes", "starting_price_eur": 90000}
    record_source_checks([changed], known)
    assert changed["source_content_changed"] is True
    assert changed["source_content_changed_at"] == changed["source_checks"][url]["checked_at"]


def test_an_inherited_flag_keeps_the_document_facts_on_the_stored_row() -> None:
    existing = _sale("https://avoventes.fr/enchere/inherited")
    _pending(existing.raw_payload, at="2026-11-04T01:00:00+00:00")
    existing.raw_payload["document_facts_version"] = V5
    incoming = _sale("https://www.licitor.com/annonce/inherited.html", source_name="licitor")
    _pending(incoming.raw_payload, at="2026-11-04T01:00:00+00:00")

    result = merge_revision(existing, incoming)

    assert result.raw_payload.get("document_facts_version") == V5


def test_a_new_change_still_invalidates_the_document_facts() -> None:
    existing = _sale("https://avoventes.fr/enchere/new-change")
    _pending(existing.raw_payload, at="2026-11-04T01:00:00+00:00")
    existing.raw_payload["document_facts_version"] = V5
    incoming = _sale("https://www.licitor.com/annonce/new-change.html", source_name="licitor")
    _pending(incoming.raw_payload, at="2026-11-04T14:00:00+00:00")

    result = merge_revision(existing, incoming)

    assert "document_facts_version" not in result.raw_payload
    assert result.raw_payload["source_content_changed_at"] == "2026-11-04T14:00:00+00:00"


def test_dedupe_does_not_reinvalidate_an_inherited_flag() -> None:
    from tests.test_dedupe import _make

    primary = _make("https://avoventes.fr/enchere/inherited-dedupe")
    _pending(primary.raw_payload, at="2026-11-04T01:00:00+00:00")
    primary.raw_payload["document_facts_version"] = V5
    secondary = _make("https://licitor.com/annonce/inherited-dedupe", source_name="licitor")
    _pending(secondary.raw_payload, at="2026-11-04T01:00:00+00:00")

    result = merge_duplicate_sales([primary, secondary])

    assert len(result) == 1
    assert result[0].raw_payload.get("document_facts_version") == V5


def test_a_collection_keeps_the_document_facts_until_the_source_really_changes() -> None:
    from src.known_enrichment import preserve_known_enrichment_payloads

    url = "https://www.licitor.com/annonce/keep.html"
    first = {"source_url": url, "source_name": "licitor", "starting_price_eur": 100000, "raw_text": "Appartement"}
    record_source_checks([first], {})
    stored_payload = {"source_checks": first["source_checks"], "document_facts_version": V5}
    known = {url: {"source_url": url, "documents": [], "raw_payload": stored_payload}}

    unchanged = {"source_url": url, "source_name": "licitor", "starting_price_eur": 100000, "raw_text": "Appartement"}
    preserve_known_enrichment_payloads([unchanged], known)
    record_source_checks([unchanged], known)
    assert unchanged.get("document_facts_version") == V5
    assert not unchanged.get("source_content_changed")

    changed = {
        "source_url": url,
        "source_name": "licitor",
        "starting_price_eur": 100000,
        "raw_text": "Maison de 4 pièces avec jardin, occupée par le propriétaire.",
        "description": "Maison de 4 pièces avec jardin, occupée par le propriétaire.",
        "rooms_count": 4,
    }
    preserve_known_enrichment_payloads([changed], known)
    record_source_checks([changed], known)
    assert "document_facts_version" not in changed
    assert changed["source_content_changed"] is True


def _raw(url: str, documents: list[dict], source_name: str = "licitor") -> dict:
    return {
        "source_url": url,
        "source_name": source_name,
        "source_detail_status": "complete",
        "documents": documents,
    }


def test_a_secondary_source_does_not_change_the_documents_of_a_merged_sale() -> None:
    """05/11/2026 : chaque passe Licitor effaçait la lecture des pièces d'environ 70 ventes fusionnées."""
    primary = "https://avoventes.fr/enchere/maison"
    secondary = "https://www.licitor.com/annonce/1.html"
    stored = [
        {"url": "https://avoventes.fr/doc/ccv.pdf", "label": "CCV"},
        {"url": "https://www.licitor.com/doc/pv.pdf", "label": "PV"},
    ]
    known = {"source_url": primary, "documents": stored, "raw_payload": {"document_facts_version": V5}}

    for documents in ([], [{"url": "https://www.licitor.com/doc/pv.pdf", "label": "Procès-verbal"}]):
        raw = _raw(secondary, documents)
        known_enrichment.preserve_known_enrichment_payloads([raw], {secondary: known})
        assert "source_content_changed_at" not in raw
        assert raw.get("document_facts_version") == V5

    added = _raw(secondary, [{"url": "https://www.licitor.com/doc/diag.pdf", "label": "Diagnostics"}])
    known_enrichment.preserve_known_enrichment_payloads([added], {secondary: known})
    assert added["source_content_changed"] is True
    assert "source_content_changed_at" in added


def test_the_primary_source_still_sees_a_removed_or_renamed_document() -> None:
    primary = "https://avoventes.fr/enchere/maison"
    stored = [{"url": "https://avoventes.fr/doc/ccv.pdf", "label": "CCV"}]
    known = {"source_url": primary, "documents": stored, "raw_payload": {"document_facts_version": V5}}

    removed = _raw(primary, [], source_name="avoventes")
    known_enrichment.preserve_known_enrichment_payloads([removed], {primary: known})
    assert removed["source_content_changed"] is True

    unchanged = _raw(primary, list(stored), source_name="avoventes")
    known_enrichment.preserve_known_enrichment_payloads([unchanged], {primary: known})
    assert "source_content_changed_at" not in unchanged
