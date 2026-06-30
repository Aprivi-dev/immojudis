from src import config


def test_target_departments_default_matches_production_scope(monkeypatch) -> None:
    monkeypatch.delenv("TARGET_DEPARTMENTS", raising=False)

    assert config._target_departments_from_env() == ("24", "33", "40", "47", "64")


def test_target_departments_can_be_overridden(monkeypatch) -> None:
    monkeypatch.setenv("TARGET_DEPARTMENTS", "33,64")

    assert config._target_departments_from_env() == ("33", "64")
