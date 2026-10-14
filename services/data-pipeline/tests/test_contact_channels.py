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
