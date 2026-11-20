"""Telling "the enterprise edition is not installed" from "it is broken" (#1753).

The OSS core imports three optional enterprise modules at startup: the settings
include (``visiban/settings.py``), the HTTP URL extension point
(``visiban/urls.py``) and the WebSocket one (``visiban/asgi.py``). Each used a
bare ``except ImportError: pass``, which treats an enterprise package whose own
dependency is missing, or one with a typo in an import, exactly like an OSS-only
install: the routes or settings silently vanish and nothing at startup says so.

Only the module we asked for, or the ``enterprise`` package itself, being
absent means "not installed". Any other ``ModuleNotFoundError`` (a dependency of
the enterprise code) and any other ``ImportError`` (``cannot import name ...``)
is a broken install and is re-raised, so the process fails loudly at startup.

Pure Python with no Django import: ``settings.py`` imports it.
"""

ENTERPRISE_PACKAGE = "enterprise"


def enterprise_module_missing(exc, module):
    """True when ``exc`` reports that ``module`` (an ``enterprise.*`` module the
    caller imported) or the ``enterprise`` package itself does not exist.

    Anything else is a broken enterprise install and the caller re-raises. A
    guard that cannot tell (an ``ImportError`` that is not a
    ``ModuleNotFoundError``, or one with no ``name``) answers ``False``, so it
    never hides an error it does not recognize.
    """
    if not isinstance(exc, ModuleNotFoundError):
        return False
    name = exc.name
    if not name:
        return False
    # Every package on the way down: ``enterprise.ws.routing`` is missing
    # when ``enterprise`` or ``enterprise.ws`` is.
    parts = module.split(".")
    ancestors = {".".join(parts[: i + 1]) for i in range(len(parts))}
    return name in ancestors and (name == ENTERPRISE_PACKAGE or name.startswith(ENTERPRISE_PACKAGE + "."))
