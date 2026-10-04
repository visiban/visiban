"""Read access to the shipped sample boards (#1452).

The files and ``manifest.json`` are written by ``boards/seed_data/generate_seed_data.py``
into ``boards/sample_boards/`` — inside the backend build context so they ship
in the image and always match the importer in the same release.

The manifest is the only index. A caller-supplied id is looked up in a dict
built from it and the path comes from the manifest entry, never from the
request, so there is no path to traverse.
"""

import json
from functools import lru_cache
from pathlib import Path

SAMPLE_DIR = Path(__file__).resolve().parents[1] / "sample_boards"
MANIFEST_NAME = "manifest.json"

# Manifest fields the list endpoint exposes. ``file`` and ``sha256`` are
# internal: the first is a path component, the second becomes the ETag.
SUMMARY_FIELDS = (
    "id", "title", "description", "swimlane_theme", "card_count",
    "includes", "order", "schema_version", "date_anchor",
)


@lru_cache(maxsize=1)
def _manifest():
    entries = json.loads((SAMPLE_DIR / MANIFEST_NAME).read_text(encoding="utf-8"))
    return tuple(sorted(entries, key=lambda e: e["order"]))


@lru_cache(maxsize=1)
def _by_id():
    return {e["id"]: e for e in _manifest()}


def list_samples():
    """Summaries in gallery order."""
    return [{k: e[k] for k in SUMMARY_FIELDS} for e in _manifest()]


def get_entry(sample_id):
    """Return the manifest entry for an id, or ``None`` if unknown. Reads no file."""
    return _by_id().get(sample_id)


def read_body(entry):
    """Return the file bytes for an entry returned by :func:`get_entry`."""
    return (SAMPLE_DIR / entry["file"]).read_bytes()


def get_sample(sample_id):
    """Return ``(entry, bytes)`` for a manifest id, or ``None`` if unknown."""
    entry = get_entry(sample_id)
    if entry is None:
        return None
    return entry, read_body(entry)
