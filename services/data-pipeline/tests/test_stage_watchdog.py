import logging
import threading

import pytest

from src import source_process, stage_watchdog


@pytest.fixture(autouse=True)
def _disarmed():
    yield
    stage_watchdog.disarm()


def test_track_stage_journals_start_end_and_duration(caplog) -> None:
    with caplog.at_level(logging.INFO, logger="src.stage_watchdog"):
        with stage_watchdog.track_stage("known_sale_details"):
            assert [name for name, _elapsed, _thread in stage_watchdog.active_stages()] == [
                "known_sale_details"
            ]

    messages = [record.getMessage() for record in caplog.records]
    assert messages[0] == "Stage start name=known_sale_details"
    assert messages[1].startswith("Stage end name=known_sale_details seconds=")
    assert stage_watchdog.active_stages() == []


def test_track_stage_journals_failure_and_clears_the_stage(caplog) -> None:
    with caplog.at_level(logging.INFO, logger="src.stage_watchdog"):
        with pytest.raises(RuntimeError):
            with stage_watchdog.track_stage("publish_run"):
                raise RuntimeError("boom")

    assert any(
        record.getMessage().startswith("Stage failed name=publish_run seconds=")
        for record in caplog.records
    )
    assert stage_watchdog.active_stages() == []


def test_watchdog_names_the_blocked_stage_and_exits_with_its_code(capsys) -> None:
    exits: list[int] = []
    fired = threading.Event()
    cleaned: list[bool] = []

    def exit_process(code: int) -> None:
        exits.append(code)
        fired.set()

    stage_watchdog.arm(
        0.05,
        label="test",
        on_fire=lambda: cleaned.append(True),
        exit_process=exit_process,
    )
    with stage_watchdog.track_stage("known_sales.page_3"):
        assert fired.wait(timeout=5)

    assert exits == [stage_watchdog.WATCHDOG_EXIT_CODE]
    assert exits[0] not in (0, 1, 2)
    assert cleaned == [True]
    error = capsys.readouterr().err
    assert "WATCHDOG" in error
    assert "known_sales.page_3" in error


def test_disarmed_watchdog_never_fires() -> None:
    exits: list[int] = []
    timer = stage_watchdog.arm(0.05, exit_process=exits.append)
    stage_watchdog.disarm()
    timer.join(timeout=1)

    assert exits == []


def test_arm_from_env(monkeypatch) -> None:
    monkeypatch.delenv(stage_watchdog.WATCHDOG_ENV, raising=False)
    assert stage_watchdog.arm_from_env() is None

    monkeypatch.setenv(stage_watchdog.WATCHDOG_ENV, "0")
    assert stage_watchdog.arm_from_env() is None

    monkeypatch.setenv(stage_watchdog.WATCHDOG_ENV, "not-a-number")
    assert stage_watchdog.arm_from_env() is None

    monkeypatch.setenv(stage_watchdog.WATCHDOG_ENV, "3600")
    timer = stage_watchdog.arm_from_env(exit_process=lambda _code: None)
    assert timer is not None
    assert timer.interval == 3600


def test_kill_live_source_processes_stops_registered_collectors(monkeypatch) -> None:
    killed = []

    class FakeProcess:
        pass

    process = FakeProcess()
    monkeypatch.setattr(source_process, "_kill_process_tree", killed.append)
    source_process._LIVE_PROCESSES.add(process)
    try:
        assert source_process.kill_live_source_processes() == 1
    finally:
        source_process._LIVE_PROCESSES.discard(process)

    assert killed == [process]
