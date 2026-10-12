"""Session-wide test teardown for the headless-Qt suite.

The Qt wallet UIs spin up an ``AgentLoop`` (an asyncio event loop on a daemon
thread) per controller. A *running* loop on a daemon thread that survives into
CPython + Qt/C++ interpreter teardown intermittently segfaults the headless-Qt CI
(exit 139). We stop+join+close every AgentLoop the tests created BEFORE the
interpreter tears down, so no running loop is left to race with Qt cleanup.
"""


def pytest_sessionfinish(session, exitstatus):
    try:
        from blockle.qtmultichain import AgentLoop
    except Exception:
        return
    try:
        AgentLoop.stop_all()
    except Exception:
        pass
