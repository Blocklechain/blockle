"""Session teardown for the headless-Qt suite.

The Qt wallet UIs create a real QApplication + PySide6 QWidgets and an
``AgentLoop`` (asyncio loop on a daemon thread) across hundreds of tests. After the
whole suite PASSES, the CI headless-Qt runners intermittently segfault (exit 139)
during interpreter teardown — the crash is in the PySide6/Qt C++ object teardown +
daemon-thread GC race, not in any test. (The suite passes locally and the per-test
results are already reported by the time this runs.)

We first stop every AgentLoop cleanly, then — once pytest has finished and written
its results (hookwrapper: our post-yield code runs after all other sessionfinish
hooks, including the terminal summary) — flush and ``os._exit(exitstatus)`` to skip
the crash-prone CPython/Qt teardown. The REAL pass/fail code is propagated
verbatim, so a genuine test failure still fails the job; only the environmental
teardown crash is bypassed.
"""

import os
import sys

import pytest


def _stop_agent_loops():
    try:
        from blockle.qtmultichain import AgentLoop
    except Exception:
        return
    try:
        AgentLoop.stop_all()
    except Exception:
        pass


@pytest.hookimpl(hookwrapper=True)
def pytest_sessionfinish(session, exitstatus):
    # Let every other sessionfinish hook run first (so pytest's own summary prints).
    yield
    _stop_agent_loops()
    # os._exit cuts pytest's final summary line, so emit an explicit result for CI logs.
    try:
        collected = getattr(session, "testscollected", "?")
        failed = getattr(session, "testsfailed", "?")
        print("\n[conftest] sessionfinish: collected=%s failed=%s exitstatus=%s "
              "-> os._exit (bypassing Qt teardown)" % (collected, failed, int(exitstatus)))
    except Exception:
        pass
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except Exception:
        pass
    # Exit immediately with the real status, bypassing the segfault-prone Qt/CPython
    # interpreter teardown. int() because exitstatus may be a pytest.ExitCode enum.
    os._exit(int(exitstatus))
