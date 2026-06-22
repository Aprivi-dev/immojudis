from src.normalize import normalize_sale
from src.storage import supabase_client
from src.storage.supabase_client import _sanitize_postgrest_payload, _secondary_source_urls


def test_sanitize_postgrest_payload_removes_null_characters_recursively() -> None:
    payload = {
        "result": [
            {
                "text": "surface\x00 habitable",
                "pages": [{"text": "page\x00 1"}, {"confidence": 0.7}],
            }
        ],
        "untouched": None,
    }

    assert _sanitize_postgrest_payload(payload) == {
        "result": [
            {
                "text": "surface habitable",
                "pages": [{"text": "page 1"}, {"confidence": 0.7}],
            }
        ],
        "untouched": None,
    }


def test_secondary_source_urls_excludes_batch_primary_urls() -> None:
    first = normalize_sale(
        {
            "source_name": "vench",
            "source_url": "https://vench.test/rich",
        }
    )
    first.source_urls.append("https://avoventes.test/poor")
    second = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://licitor.test/keep",
            "source_urls": ["https://licitor.test/keep"],
        }
    )

    assert _secondary_source_urls([first, second]) == ["https://avoventes.test/poor"]


def test_known_signatures_only_include_scored_rows(monkeypatch) -> None:
    monkeypatch.setattr(
        supabase_client,
        "fetch_known_sale_details",
        lambda: {
            "https://example.test/scored": {
                "_signature": "2027-01-10|100000",
                "score_version": "v1",
            },
            "https://example.test/unscored": {
                "_signature": "2027-01-11|200000",
                "score_version": None,
            },
        },
    )

    assert supabase_client.fetch_known_sale_signatures() == {
        "https://example.test/scored": "2027-01-10|100000"
    }
