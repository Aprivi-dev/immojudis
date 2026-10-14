from src.contact_channels import contact_channels


def test_labelled_phone_wins_over_digits_of_a_postal_address() -> None:
    text = "14, bd Chasseigne - CS 60062 - 86002 Poitiers Cedex | Tél.: 05 49 88 96 40 | maitre@cabinet.test"

    assert contact_channels(text) == {"phone": "05 49 88 96 40", "email": "maitre@cabinet.test"}


def test_unlabelled_phone_and_email_keep_their_channels() -> None:
    assert contact_channels("01 40 00 00 00 · cabinet@exemple.test") == {
        "phone": "01 40 00 00 00",
        "email": "cabinet@exemple.test",
    }


def test_single_channel_is_unchanged() -> None:
    assert contact_channels("cabinet@exemple.test") == {"email": "cabinet@exemple.test"}
    assert contact_channels("01 40 00 00 00") == {"phone": "01 40 00 00 00"}
    assert contact_channels("Étude Dupont") == {}


def test_mobile_and_phone_labels_rank_alike_and_the_first_one_wins() -> None:
    email = "maitre@cabinet.test"
    assert contact_channels(f"Mobile : 06 00 00 00 00 · Tél : 01 40 00 00 00 · {email}")["phone"] == "06 00 00 00 00"
    assert contact_channels(f"Tél : 01 40 00 00 00 · Mobile : 06 00 00 00 00 · {email}")["phone"] == "01 40 00 00 00"
    for label in ("Portable", "Port.", "Mob.", "mobile", "Tél.", "Téléphone"):
        assert contact_channels(f"1, rue A - CS 60062 - 86002 Poitiers | {label} {'06 00 00 00 00'} | {email}") == {
            "phone": "06 00 00 00 00",
            "email": email,
        }


def test_fax_is_never_the_phone() -> None:
    email = "maitre@cabinet.test"
    assert contact_channels(f"Fax : 01 40 00 00 01 | Mobile : 06 00 00 00 00 | {email}")["phone"] == "06 00 00 00 00"
    assert contact_channels(f"Fax : 01 40 00 00 01 | 01 40 00 00 00 | {email}")["phone"] == "01 40 00 00 00"
    assert contact_channels(f"Tél : 01 40 00 00 00 - Fax : 01 40 00 00 01 | {email}")["phone"] == "01 40 00 00 00"
    assert "phone" not in contact_channels(f"Fax : 01 40 00 00 01 | {email}")


def test_abbreviation_labels_need_their_dot() -> None:
    # « Port » ou « Mob » sans point peuvent être un nom de rue ou un nom propre.
    assert contact_channels("Port 75001 Paris · 01 40 00 00 00 · maitre@cabinet.test")["phone"] == "01 40 00 00 00"
