import json

from src.extraction_audit import load_exported_sales, main, run_extraction_audit
from src.normalize import normalize_sale


def test_load_exported_sales_reads_pipeline_json_export(tmp_path) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/export",
            "title": "Maison",
            "property_type": "Maison",
            "address": "12 rue Test 33000 Bordeaux",
            "surface_m2": "80 m2",
            "starting_price_eur": "100 000 euros",
            "sale_date": "10 septembre 2026 à 10h00",
            "raw_text": "Maison de 80 m2.",
            "source_blocks": {"description": "Maison de 80 m2."},
        }
    )
    path = tmp_path / "auction_sales.json"
    path.write_text(json.dumps([sale.to_storage_dict()], ensure_ascii=False), encoding="utf-8")

    loaded = load_exported_sales(path)

    assert len(loaded) == 1
    assert loaded[0].source_name == "avoventes"
    assert loaded[0].surface_m2 == 80


def test_run_extraction_audit_fails_only_when_required_gaps_are_requested(tmp_path, capsys) -> None:
    sale = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://www.licitor.com/annonce/incomplete/100.html",
            "title": "Maison",
            "raw_text": "Maison sans prix ni surface.",
        }
    )
    path = tmp_path / "auction_sales.json"
    path.write_text(json.dumps([sale.to_storage_dict()], ensure_ascii=False), encoding="utf-8")

    assert run_extraction_audit(path) == 0
    assert run_extraction_audit(path, fail_on_required_gaps=True) == 1

    output = capsys.readouterr().out
    assert "extraction_required_gap_sales: 1" in output
    assert "https://www.licitor.com/annonce/incomplete/100.html" in output


def test_run_extraction_audit_filters_source_and_writes_json_report(tmp_path) -> None:
    avoventes_sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/complete",
            "title": "Maison",
            "property_type": "Maison",
            "address": "12 rue Test 33000 Bordeaux",
            "surface_m2": "80 m2",
            "starting_price_eur": "100 000 euros",
            "sale_date": "10 septembre 2026 à 10h00",
            "raw_text": "Maison de 80 m2.",
            "source_blocks": {"description": "Maison de 80 m2."},
        }
    )
    licitor_sale = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://www.licitor.com/annonce/incomplete/100.html",
            "title": "Maison",
            "raw_text": "Maison sans prix ni surface.",
        }
    )
    path = tmp_path / "auction_sales.json"
    report_path = tmp_path / "reports" / "audit.json"
    path.write_text(
        json.dumps(
            [avoventes_sale.to_storage_dict(), licitor_sale.to_storage_dict()],
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    assert (
        run_extraction_audit(
            path,
            source="avoventes",
            fail_on_required_gaps=True,
            report_json_path=report_path,
        )
        == 0
    )
    report = json.loads(report_path.read_text(encoding="utf-8"))

    assert report["total"] == 1
    assert report["required_gap_sales"] == 0
    assert list(report["sources"]) == ["avoventes"]


def test_extraction_audit_main_returns_error_for_invalid_export(tmp_path, capsys) -> None:
    path = tmp_path / "bad.json"
    path.write_text("{}", encoding="utf-8")

    assert main(["--input", str(path)]) == 2

    assert "export must contain a JSON array" in capsys.readouterr().err
