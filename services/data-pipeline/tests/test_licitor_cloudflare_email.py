"""Adresses e-mail des avocats Licitor masquées par Cloudflare (fixtures fictives, domaine exemple.test)."""

import json

import pytest
from bs4 import BeautifulSoup

from src.information_sufficiency import extract_emails
from src.sources.common import decode_cloudflare_email, is_plausible_email, reveal_cloudflare_emails
from src.sources.licitor import parse_licitor_detail_html
from src.sources.licitor_extraction import refresh_licitor_raw_sale
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


def test_data_cfemail_address_fills_the_lawyer_contact() -> None:
    raw = parse_licitor_detail_html(_html(_data_cfemail_block("maitre@exemple.test")), URL)

    assert raw["lawyer_contact"] == (
        "1, rue du Palais - 75001 Paris | Tél.: 01 00 00 00 01 | Fax : 01 00 00 00 02"
        " | maitre@exemple.test | www.exemple-avocats.test"
    )
    assert raw["source_blocks"]["contact_avocat"] == raw["lawyer_contact"]
    lawyers = raw["source_property_features"]["lawyers"]
    assert lawyers[0]["email"] == "maitre@exemple.test" and lawyers[0]["email_published"] is True
    assert "email" not in lawyers[1]
    # L'agent d'information trouve l'adresse dans le même champ que pour les autres sources.
    assert extract_emails(raw["lawyer_contact"]) == {"maitre@exemple.test"}
    assert "protected" not in _published_text(raw)


def test_email_protection_link_alone_is_decoded() -> None:
    encoded = cloudflare_encode("cabinet@exemple.test", 0x5C)
    link = f'<p><a href="/cdn-cgi/l/email-protection#{encoded}">[email&#160;protected]</a></p>'
    raw = parse_licitor_detail_html(_html(link), URL)

    assert "cabinet@exemple.test" in raw["lawyer_contact"]
    assert raw["source_property_features"]["lawyers"][0]["email"] == "cabinet@exemple.test"
    assert "protected" not in _published_text(raw)


def test_invalid_hex_is_ignored_and_the_placeholder_is_dropped() -> None:
    invalid = (
        '<p><a href="/cdn-cgi/l/email-protection#zz12"><span data-cfemail="zz12">'
        "[email&#160;protected]</span></a></p>"
    )
    raw = parse_licitor_detail_html(_html(invalid), URL)

    assert raw["lawyer_contact"] == CONTACT_WITHOUT_EMAIL
    assert "email" not in raw["source_property_features"]["lawyers"][0]
    assert "protected" not in _published_text(raw)
    assert raw["lawyer_name"] == "Maître Jeanne Exemple, membre de la SELARL Exemple Avocats, Avocat"


@pytest.mark.parametrize("court_email", ["greffe@tj-exemple.justice.fr", "accueil@ta-exemple.justice.gouv.fr"])
def test_court_address_is_never_decoded_nor_stored(court_email: str) -> None:
    raw = parse_licitor_detail_html(_html(_data_cfemail_block(court_email)), URL)

    assert raw["lawyer_contact"] == CONTACT_WITHOUT_EMAIL
    assert "email" not in raw["source_property_features"]["lawyers"][0]
    assert court_email not in _published_text(raw)
    assert "protected" not in _published_text(raw)


def test_court_address_is_dropped_but_the_lawyer_address_kept_on_the_same_page() -> None:
    court = _data_cfemail_block("greffe@tj-exemple.justice.fr")
    lawyer = _data_cfemail_block("maitre@exemple.test")
    raw = parse_licitor_detail_html(_html(court + lawyer), URL)

    assert extract_emails(raw["lawyer_contact"]) == {"maitre@exemple.test"}
    assert "greffe@" not in _published_text(raw)


def test_page_without_email_is_unchanged() -> None:
    raw = parse_licitor_detail_html(_html(""), URL)

    assert raw["lawyer_contact"] == CONTACT_WITHOUT_EMAIL
    lawyer = raw["source_property_features"]["lawyers"][0]
    assert "email" not in lawyer and "email_published" not in lawyer


def test_reveal_returns_each_address_once_in_page_order() -> None:
    first, second = cloudflare_encode("a.b@exemple.test"), cloudflare_encode("c@exemple.test", 0x11)
    soup = BeautifulSoup(
        f'<p><a href="/cdn-cgi/l/email-protection#{first}"><span data-cfemail="{first}">x</span></a>'
        f'<span data-cfemail="{second}">y</span><a href="/cdn-cgi/l/email-protection#{first}">z</a></p>',
        "html.parser",
    )

    assert reveal_cloudflare_emails(soup) == ["a.b@exemple.test", "c@exemple.test"]
    assert soup.get_text("|") == "a.b@exemple.test|c@exemple.test|a.b@exemple.test"


def test_stored_page_text_with_the_placeholder_has_no_address_to_decode() -> None:
    text = MULTI_LOT_TEXT.replace("Tél.: 01 00 00 00 03", "Tél.: 01 00 00 00 03\n[email protected]")
    raw = {"source_name": "licitor", "source_url": URL, "source_blocks": {"page_text": text}}

    assert refresh_licitor_raw_sale(raw) is True
    assert raw["lawyer_contact"] == "3, rue des États - 78000 Versailles | Tél.: 01 00 00 00 03"
    assert raw["source_property_features"]["lawyers"][0]["email_published"] is True


def test_stored_page_text_with_a_decoded_address_replays_it_but_never_a_court_one() -> None:
    kept = MULTI_LOT_TEXT.replace("Tél.: 01 00 00 00 03", "Tél.: 01 00 00 00 03\nmaitre@exemple.test")
    raw = {"source_name": "licitor", "source_url": URL, "source_blocks": {"page_text": kept}}
    assert refresh_licitor_raw_sale(raw) is True
    assert raw["lawyer_contact"].endswith("Tél.: 01 00 00 00 03 | maitre@exemple.test")

    court = MULTI_LOT_TEXT.replace("Tél.: 01 00 00 00 03", "Tél.: 01 00 00 00 03\ngreffe@tj-exemple.justice.fr")
    raw = {"source_name": "licitor", "source_url": URL, "source_blocks": {"page_text": court}}
    assert refresh_licitor_raw_sale(raw) is True
    assert "justice.fr" not in raw["lawyer_contact"]
    assert "email" not in raw["source_property_features"]["lawyers"][0]


# --- Décision du propriétaire (14/10/2026) : décodage en lot pour Licitor seulement -------------------------


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

    assert raw["lawyer_contact"] == CONTACT_WITHOUT_EMAIL
    assert "email" not in raw["source_property_features"]["lawyers"][0]
    assert "email" not in raw["source_property_features"].get("contact", {})
    assert excluded.lower() not in _published_text(raw).lower()
    assert "protected" not in _published_text(raw)


def test_clear_and_decoded_addresses_go_through_the_same_filter() -> None:
    for email in ("maitre@avocat-conseil.fr", "greffe@tj-exemple.justice.fr", "maitre@exemple.test"):
        clear = _html(f"<p>{email}</p>")
        decoded = _html(_data_cfemail_block(email))
        kept_clear = parse_licitor_detail_html(clear, URL)["source_property_features"]["lawyers"][0].get("email")
        kept_decoded = parse_licitor_detail_html(decoded, URL)["source_property_features"]["lawyers"][0].get("email")
        assert kept_clear == kept_decoded


def test_only_the_professional_blocks_are_decoded() -> None:
    # Une adresse masquée hors du bloc d'un professionnel (texte de l'annonce, pied de page) n'est pas décodée.
    outside = _data_cfemail_block("particulier@exemple.test")
    html = _html(_data_cfemail_block("maitre@exemple.test")).replace('<div class="Trusts">', outside + '<div class="Trusts">')
    raw = parse_licitor_detail_html(html, URL)

    assert "particulier@exemple.test" not in _published_text(raw)
    assert extract_emails(raw["lawyer_contact"]) == {"maitre@exemple.test"}


def test_corrupt_strings_never_raise_and_never_leave_an_address() -> None:
    corrupt = ["", "0", "zz", "2a4", "ffffffff", "2ad4d4d4d4d4d4", "00" * 400, "é" * 6]
    block = "".join(
        f'<p><a href="/cdn-cgi/l/email-protection#{value}"><span data-cfemail="{value}">'
        "[email&#160;protected]</span></a></p>"
        for value in corrupt
    )
    raw = parse_licitor_detail_html(_html(block), URL)

    assert raw["lawyer_contact"] == CONTACT_WITHOUT_EMAIL
    assert "@" not in raw["lawyer_contact"]
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


def test_contact_stays_in_channel_format_with_a_postal_address_full_of_digits() -> None:
    from src.extraction_profiles import attach_source_property_features

    html = _html(_data_cfemail_block("maitre@exemple.test")).replace(
        "1, rue du Palais - 75001 Paris", "14, bd Chasseigne - CS 60062 - 86002 Poitiers Cedex"
    )
    raw = parse_licitor_detail_html(html, URL)
    assert raw["source_property_features"]["contact"] == {"phone": "01 00 00 00 01", "email": "maitre@exemple.test"}

    observation = attach_source_property_features(raw)["source_field_observations"]["lawyer_contact"]

    assert observation["value"] == {"phone": "01 00 00 00 01", "email": "maitre@exemple.test"}
    assert set(observation["channels"]) == {"phone", "email"}
    assert observation["state"] == "observed"
    assert "conflicts" not in observation


def test_decoded_address_is_a_channel_of_the_lawyer_not_of_a_private_person() -> None:
    raw = parse_licitor_detail_html(_html(_data_cfemail_block("maitre@exemple.test")), URL)
    lawyers = raw["source_property_features"]["lawyers"]

    assert lawyers[0]["name"].startswith("Maître Jeanne Exemple") and lawyers[0]["role"] == "avocat"
    assert lawyers[0]["email"] == "maitre@exemple.test"
    assert "email" not in lawyers[1]
