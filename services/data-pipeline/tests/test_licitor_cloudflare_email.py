"""Adresses e-mail des avocats Licitor masquées par Cloudflare (fixtures fictives, domaine exemple.test).

Décision du propriétaire (14/10/2026) : l'adresse décodée est conservée uniquement dans le registre interne de
l'agent d'information (``internal_contacts``) et n'apparaît dans aucun champ publié.
"""

import json

import pytest
from bs4 import BeautifulSoup

from src.dedupe import merge_duplicate_sales
from src.information_sufficiency import usable_contact_emails
from src.models import AuctionSale
from src.normalize import normalize_sale
from src.sources.common import decode_cloudflare_email, extract_cloudflare_emails, is_plausible_email
from src.sources.licitor import parse_licitor_detail_html
from src.sources.licitor_extraction import refresh_licitor_raw_sale
from src.storage.column_sets import UPSERT_COLUMNS
from tests.test_licitor_extraction import DETAIL_HTML, MULTI_LOT_TEXT, URL

PLACEHOLDER_BLOCK = (
    '<p><a href="/cdn-cgi/l/email-protection#00"><span class="__cf_email__" data-cfemail="00">'
    "[email&#160;protected]</span></a></p>"
)
CONTACT_WITHOUT_EMAIL = (
    "1, rue du Palais - 75001 Paris | Tél.: 01 00 00 00 01 | Fax : 01 00 00 00 02 | www.exemple-avocats.test"
)


def cloudflare_encode(email: str, key: int = 0x2A) -> str:
    """Encodage Cloudflare : la clé, puis chaque octet XOR la clé (hexadécimal)."""
    return f"{key:02x}" + "".join(f"{byte ^ key:02x}" for byte in email.encode())


def _html(block: str) -> str:
    assert PLACEHOLDER_BLOCK in DETAIL_HTML
    return DETAIL_HTML.replace(PLACEHOLDER_BLOCK, block)


def _data_cfemail_block(email: str) -> str:
    encoded = cloudflare_encode(email)
    return (
        f'<p><a href="/cdn-cgi/l/email-protection#{encoded}"><span class="__cf_email__" '
        f'data-cfemail="{encoded}">[email&#160;protected]</span></a></p>'
    )


def _published_text(raw: dict) -> str:
    return json.dumps(raw, ensure_ascii=False, default=str)


def test_decoder_follows_cloudflare_xor_scheme() -> None:
    assert decode_cloudflare_email("2a474b435e584f6a4f524f475a464f045e4f595e") == "maitre@exemple.test"
    assert decode_cloudflare_email(cloudflare_encode("Maitre.Test@Exemple.test", key=0xFE)) == "maitre.test@exemple.test"
    assert decode_cloudflare_email(" 2A474B435E584F6A4F524F475A464F045E4F595E ") == "maitre@exemple.test"


@pytest.mark.parametrize(
    "encoded",
    [
        None,
        42,
        "",
        "00",  # la clé seule, aucun octet
        "2a4",  # longueur impaire
        "zz474b435e",  # pas de l'hexadécimal
        cloudflare_encode("pas une adresse"),
        cloudflare_encode("a@b"),
        cloudflare_encode("deux@@exemple.test"),
        "ffffffff",  # octets 0x00 : pas une adresse
        "2ad4d4d4d4d4d4",  # octets 0xFE : pas de l'UTF-8
    ],
)
def test_decoder_ignores_invalid_data_silently(encoded: object) -> None:
    assert decode_cloudflare_email(encoded) is None


def test_plausible_email_rejects_malformed_addresses() -> None:
    assert is_plausible_email("maitre@exemple.test")
    for value in ("maitre@exemple", "@exemple.test", "ma itre@exemple.test", ".a@exemple.test", "a@exemple..test", None):
        assert not is_plausible_email(value)


LAWYER_EMAIL = "maitre@exemple.test"
LAWYER_NAME = "Maître Jeanne Exemple, membre de la SELARL Exemple Avocats, Avocat"


def _storage_json(sale: AuctionSale) -> str:
    """Tout ce qui part vers auction_sales : colonnes d'écriture, raw_payload et observations compris."""
    data = sale.to_storage_dict(exclude_none=False)
    row = {column: data.get(column) for column in UPSERT_COLUMNS}
    return json.dumps([row, sale.raw_payload, sale.observations, data], ensure_ascii=False, default=str)


def test_data_cfemail_address_is_kept_apart_and_never_published() -> None:
    raw = parse_licitor_detail_html(_html(_data_cfemail_block(LAWYER_EMAIL)), URL)

    assert raw["internal_contacts"] == [
        {"email": LAWYER_EMAIL, "name": LAWYER_NAME, "role": "lawyer", "source_name": "licitor"}
    ]
    # Aucun champ de la vente brute ne porte l'adresse, hormis la clé interne.
    published = {key: value for key, value in raw.items() if key != "internal_contacts"}
    assert LAWYER_EMAIL not in _published_text(published)
    assert "protected" not in _published_text(published)
    assert raw["lawyer_contact"] == CONTACT_WITHOUT_EMAIL
    assert raw["source_blocks"]["contact_avocat"] == CONTACT_WITHOUT_EMAIL
    assert LAWYER_EMAIL not in raw["raw_text"] and LAWYER_EMAIL not in raw["source_blocks"]["page_text"]
    lawyers = raw["source_property_features"]["lawyers"]
    assert all("email" not in lawyer for lawyer in lawyers)
    assert "contact" not in raw["source_property_features"]


def test_email_protection_link_alone_is_kept_apart() -> None:
    encoded = cloudflare_encode("cabinet@exemple.test", 0x5C)
    link = f'<p><a href="/cdn-cgi/l/email-protection#{encoded}">[email&#160;protected]</a></p>'
    raw = parse_licitor_detail_html(_html(link), URL)

    assert [item["email"] for item in raw["internal_contacts"]] == ["cabinet@exemple.test"]
    published = {key: value for key, value in raw.items() if key != "internal_contacts"}
    assert "cabinet@exemple.test" not in _published_text(published)
    assert "protected" not in _published_text(published)


def test_invalid_hex_is_ignored_and_the_placeholder_is_dropped() -> None:
    invalid = (
        '<p><a href="/cdn-cgi/l/email-protection#zz12"><span data-cfemail="zz12">'
        "[email&#160;protected]</span></a></p>"
    )
    raw = parse_licitor_detail_html(_html(invalid), URL)

    assert "internal_contacts" not in raw
    assert raw["lawyer_contact"] == CONTACT_WITHOUT_EMAIL
    assert "protected" not in _published_text(raw)
    assert raw["lawyer_name"] == LAWYER_NAME


@pytest.mark.parametrize("court_email", ["greffe@tj-exemple.justice.fr", "accueil@ta-exemple.justice.gouv.fr"])
def test_court_address_is_never_decoded_nor_stored(court_email: str) -> None:
    raw = parse_licitor_detail_html(_html(_data_cfemail_block(court_email)), URL)

    assert "internal_contacts" not in raw
    assert raw["lawyer_contact"] == CONTACT_WITHOUT_EMAIL
    assert court_email not in _published_text(raw)
    assert "protected" not in _published_text(raw)


def test_court_address_is_dropped_but_the_lawyer_address_kept_on_the_same_page() -> None:
    court = _data_cfemail_block("greffe@tj-exemple.justice.fr")
    lawyer = _data_cfemail_block(LAWYER_EMAIL)
    raw = parse_licitor_detail_html(_html(court + lawyer), URL)

    assert [item["email"] for item in raw["internal_contacts"]] == [LAWYER_EMAIL]
    assert "greffe@" not in _published_text(raw)


def test_page_without_email_is_unchanged() -> None:
    raw = parse_licitor_detail_html(_html(""), URL)

    assert "internal_contacts" not in raw
    assert raw["lawyer_contact"] == CONTACT_WITHOUT_EMAIL
    lawyer = raw["source_property_features"]["lawyers"][0]
    assert "email" not in lawyer and "email_published" not in lawyer


def test_extract_returns_each_address_once_in_page_order_and_removes_the_elements() -> None:
    first, second = cloudflare_encode("a.b@exemple.test"), cloudflare_encode("c@exemple.test", 0x11)
    soup = BeautifulSoup(
        f'<p><a href="/cdn-cgi/l/email-protection#{first}"><span data-cfemail="{first}">x</span></a>'
        f'<span data-cfemail="{second}">y</span><a href="/cdn-cgi/l/email-protection#{first}">z</a>'
        "<b>reste</b></p>",
        "html.parser",
    )

    assert extract_cloudflare_emails(soup) == ["a.b@exemple.test", "c@exemple.test"]
    assert soup.get_text("|") == "reste"


def test_stored_page_text_with_the_placeholder_has_no_address_to_decode() -> None:
    text = MULTI_LOT_TEXT.replace("Tél.: 01 00 00 00 03", "Tél.: 01 00 00 00 03\n[email protected]")
    raw = {"source_name": "licitor", "source_url": URL, "source_blocks": {"page_text": text}}

    assert refresh_licitor_raw_sale(raw) is True
    assert raw["lawyer_contact"] == "3, rue des États - 78000 Versailles | Tél.: 01 00 00 00 03"
    assert raw["source_property_features"]["lawyers"][0]["email_published"] is True
    assert "internal_contacts" not in raw


@pytest.mark.parametrize(
    "excluded",
    [
        "maitre@avocat-conseil.fr",  # messagerie RPVA : réservée à la procédure
        "maitre@Avocat-Conseil.FR",
        "contact@ordre-avocats-exemple.test",
        "carpa@cabinet-exemple.test",
        "noreply@cabinet-exemple.test",
    ],
)
def test_decoded_address_filtered_like_a_clear_one_is_dropped(excluded: str) -> None:
    raw = parse_licitor_detail_html(_html(_data_cfemail_block(excluded)), URL)

    assert "internal_contacts" not in raw
    assert raw["lawyer_contact"] == CONTACT_WITHOUT_EMAIL
    assert excluded.lower() not in _published_text(raw).lower()
    assert "protected" not in _published_text(raw)


def test_only_the_professional_blocks_are_decoded() -> None:
    # Une adresse masquée hors du bloc d'un professionnel (texte de l'annonce, pied de page) n'est pas décodée.
    outside = _data_cfemail_block("particulier@exemple.test")
    html = _html(_data_cfemail_block(LAWYER_EMAIL)).replace('<div class="Trusts">', outside + '<div class="Trusts">')
    raw = parse_licitor_detail_html(html, URL)

    assert "particulier@exemple.test" not in _published_text(raw)
    assert [item["email"] for item in raw["internal_contacts"]] == [LAWYER_EMAIL]


def test_corrupt_strings_never_raise_and_never_leave_an_address() -> None:
    corrupt = ["", "0", "zz", "2a4", "ffffffff", "2ad4d4d4d4d4d4", "00" * 400, "é" * 6]
    block = "".join(
        f'<p><a href="/cdn-cgi/l/email-protection#{value}"><span data-cfemail="{value}">'
        "[email&#160;protected]</span></a></p>"
        for value in corrupt
    )
    raw = parse_licitor_detail_html(_html(block), URL)

    assert "internal_contacts" not in raw
    assert raw["lawyer_contact"] == CONTACT_WITHOUT_EMAIL
    assert "protected" not in _published_text(raw)


def test_vench_pages_are_never_decoded() -> None:
    from pathlib import Path

    from src.sources.vench import parse_vench_detail_html

    html = (Path(__file__).parent / "fixtures" / "vench_fiche_avocat_cabinet.html").read_text(encoding="utf-8")
    # La fiche porte bien des adresses décodables : c'est le parseur Vench qui ne les décode pas.
    soup = BeautifulSoup(html, "html.parser")
    decodable = {decode_cloudflare_email(node["data-cfemail"]) for node in soup.find_all(attrs={"data-cfemail": True})}
    assert decodable and None not in decodable

    sale = parse_vench_detail_html(html, "https://www.vench.fr/vente-170001-un-bien-exempleville.html")

    published = _published_text(sale)
    assert all(address not in published for address in decodable)
    assert "[email protected]" in sale["source_blocks"]["page_text"]
    assert "internal_contacts" not in sale


def test_masked_address_outside_trust_blocks_is_logged_not_failed(caplog: pytest.LogCaptureFixture) -> None:
    import logging

    outside = _data_cfemail_block("particulier@exemple.test")
    html = _html(_data_cfemail_block(LAWYER_EMAIL)).replace('<div class="Trusts">', outside + '<div class="Trusts">')
    with caplog.at_level(logging.DEBUG, logger="src.sources.licitor"):
        raw = parse_licitor_detail_html(html, URL)
    assert raw["internal_contacts"]
    assert any("hors des blocs .Trust" in record.getMessage() for record in caplog.records)
    assert all(LAWYER_EMAIL not in record.getMessage() for record in caplog.records)

    caplog.clear()
    no_trust = _html("").replace('class="Trust"', 'class="Autre"')
    with caplog.at_level(logging.DEBUG, logger="src.sources.licitor"):
        parse_licitor_detail_html(no_trust, URL)
    assert any("aucun bloc .Trust" in record.getMessage() for record in caplog.records)


# --- Non-fuite : rien de ce qui part vers auction_sales ne porte l'adresse -----------------------------------


def test_normalized_sale_keeps_the_address_out_of_every_persisted_field() -> None:
    raw = parse_licitor_detail_html(_html(_data_cfemail_block(LAWYER_EMAIL)), URL)
    sale = normalize_sale(raw)

    assert sale.internal_contacts == [
        {"email": LAWYER_EMAIL, "name": LAWYER_NAME, "role": "lawyer", "source_name": "licitor", "source_url": URL}
    ]
    assert LAWYER_EMAIL not in _storage_json(sale)
    assert "internal_contacts" not in _storage_json(sale)
    assert "protected" not in _storage_json(sale)
    assert sale.lawyer_contact == CONTACT_WITHOUT_EMAIL
    # Ni sérialisation du modèle (prompt, export), ni copie profonde ne l'exposent.
    assert LAWYER_EMAIL not in json.dumps(sale.model_dump(), default=str)
    assert sale.model_copy(deep=True).internal_contacts == sale.internal_contacts


def test_normalize_does_not_consume_the_raw_sale_and_is_repeatable() -> None:
    raw = parse_licitor_detail_html(_html(_data_cfemail_block(LAWYER_EMAIL)), URL)

    first, second = normalize_sale(raw), normalize_sale(raw)

    assert raw["internal_contacts"][0]["email"] == LAWYER_EMAIL
    assert first.internal_contacts == second.internal_contacts
    assert "internal_contacts" not in first.raw_payload


def test_sale_without_internal_address_has_none() -> None:
    assert normalize_sale(parse_licitor_detail_html(_html(""), URL)).internal_contacts == []


def test_merged_duplicates_keep_the_internal_address_once() -> None:
    sale = normalize_sale(parse_licitor_detail_html(_html(_data_cfemail_block(LAWYER_EMAIL)), URL))
    twin = sale.model_copy(deep=True)
    twin.source_name, twin.source_url = "vench", "https://www.vench.fr/vente-170001-un-bien.html"
    twin.internal_contacts = [
        {"email": LAWYER_EMAIL, "name": "", "role": "lawyer", "source_url": URL},
        {"email": "autre@exemple.test", "name": "", "role": "lawyer", "source_url": URL},
    ]

    merged = merge_duplicate_sales([sale, twin])

    assert len(merged) == 1
    assert sorted(item["email"] for item in merged[0].internal_contacts) == ["autre@exemple.test", LAWYER_EMAIL]
    assert LAWYER_EMAIL not in _storage_json(merged[0])


def test_publication_gate_ignores_internal_addresses() -> None:
    # Verdict stable d'un run à l'autre et identique au miroir TypeScript, qui ne voit que la vente publiée.
    sale = AuctionSale(
        source_name="licitor",
        source_url=URL,
        internal_contacts=[{"email": LAWYER_EMAIL, "name": "", "role": "lawyer", "source_url": URL}],
    )

    assert usable_contact_emails(sale) == set()


def test_merged_duplicate_keeps_licitor_as_the_source_of_the_address() -> None:
    sale = normalize_sale(parse_licitor_detail_html(_html(_data_cfemail_block(LAWYER_EMAIL)), URL))
    twin = AuctionSale(source_name="vench", source_url="https://www.vench.fr/vente-170001-un-bien.html")

    merged = merge_duplicate_sales([twin, sale])

    contacts = [item for sale_ in merged for item in sale_.internal_contacts]
    assert [item["source_name"] for item in contacts] == ["licitor"]


def test_a_failing_decoder_never_fails_the_page(monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
    from src.sources import licitor

    def boom(*_args: object) -> list[dict[str, str]]:
        raise ValueError(f"cannot decode {LAWYER_EMAIL}")

    monkeypatch.setattr(licitor, "_internal_lawyer_contacts", boom)
    raw = parse_licitor_detail_html(_html(_data_cfemail_block(LAWYER_EMAIL)), URL)

    assert "internal_contacts" not in raw
    assert raw["lawyer_name"] == LAWYER_NAME
    assert "ValueError" in caplog.text and LAWYER_EMAIL not in caplog.text
