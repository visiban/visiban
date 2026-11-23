"""Guard: an unregistered pytest mark must fail collection (#2524).

``backend/setup.cfg`` lists ``--strict-markers`` in ``addopts``, but a typo'd mark
(``@pytest.mark.slwo``) was observed to only warn under that config, which would
let a mistyped ``slow`` mark silently put an expensive test back on every shard.
The CI pytest commands therefore pass ``--strict-markers`` explicitly; these
tests pin that flag's behavior and that the CI commands still carry it.
"""

import re
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2]
CI_FILE = BACKEND_DIR.parent / ".gitlab-ci.yml"


def _pytest(*args):
    return subprocess.run(  # noqa: S603 - fixed argv, no shell
        [sys.executable, "-m", "pytest", "-p", "no:cacheprovider", "-q", "--no-header", *args],
        cwd=BACKEND_DIR,
        capture_output=True,
        text=True,
        timeout=240,
    )


def test_unregistered_mark_errors_at_collection(tmp_path):
    typo = tmp_path / "test_typo.py"
    typo.write_text("import pytest\n\n@pytest.mark.slwo\ndef test_a():\n    pass\n")
    result = _pytest(str(typo), "--strict-markers", "--rootdir", str(BACKEND_DIR))
    output = result.stdout + result.stderr
    assert result.returncode != 0, output
    assert "slwo" in output and "not found in `markers` configuration option" in output


def test_slow_and_migrations_marks_are_registered():
    output = _pytest("--markers").stdout
    assert "@pytest.mark.slow:" in output
    assert "@pytest.mark.migrations:" in output


@pytest.mark.skipif(not CI_FILE.exists(), reason="CI file is not in the backend build context")
def test_ci_backend_pytest_commands_pass_strict_markers():
    text = CI_FILE.read_text()
    for job in ("backend-test", "backend-test-slow", "backend-test-migrations"):
        body = re.search(rf"^{job}:\n(.*?)(?=^\S)", text, re.M | re.S)
        assert body, job
        assert "--strict-markers" in body.group(1), f"{job} must pass --strict-markers explicitly"
