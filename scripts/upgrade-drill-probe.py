# scripts/upgrade-drill-probe.py — in-container probe for the upgrade drills (#2463).
#
# gate-selftest-exempt: not a gate — it is piped into a live backend container
# by the upgrade drills, and its known-bad case is the drill going red.
#
# Piped on stdin into `python - <mode>` inside a running backend container, by
# scripts/compose-upgrade-drill.sh (docker compose exec) and
# scripts/helm-upgrade-drill.sh (kubectl exec). It runs against BOTH the last
# release's image and HEAD's, so it may only use APIs that exist in both: the
# Django ORM via apps.get_model, and plain urllib against the backend's own
# port. Never import Visiban modules here — a module renamed at HEAD would
# turn an upgrade drill red for a reason that is not an upgrade defect.
#
# The drill prepends `DRILL_HOST = "<host>"` and `DRILL_PASSWORD = "<pw>"` to
# this file's text on stdin (see probe() in each drill script), so
# the drill user's password never appears in argv (readable from the
# container's process list) or in the pod/container environment.
#
# Modes:
#   create-user  create the `upgrade-drill` user with that password
#   counts       print `COUNTS boards=N cards=N movements=N users=N`
#   health       GET /api/health/readiness/ must report status ok
#   login        POST /api/v1/auth/login/ as the drill user must return 200
import json
import os
import sys
import urllib.error
import urllib.request

DRILL_USER = "upgrade-drill"
BASE = "http://127.0.0.1:8000"


def _django():
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "visiban.settings")
    sys.path.insert(0, os.getcwd())
    import django

    django.setup()


def _request(method, path, body=None):
    # ALLOWED_HOSTS does not carry localhost in production (#1230); send the
    # configured host, as the chart's probes do.
    headers = {"Host": globals().get("DRILL_HOST", "localhost")}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, resp.read().decode(errors="replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode(errors="replace")


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    password = globals().get("DRILL_PASSWORD", "")
    if mode in ("create-user", "login") and not password:
        print("DRILL_PASSWORD was not prepended to the probe", file=sys.stderr)
        sys.exit(2)
    if mode == "create-user":
        _django()
        from django.contrib.auth import get_user_model

        user_model = get_user_model()
        if not user_model.objects.filter(username=DRILL_USER).exists():
            user_model.objects.create_user(
                username=DRILL_USER, email="upgrade-drill@drill.invalid", password=password
            )
        print("USER ok")
    elif mode == "counts":
        _django()
        from django.apps import apps
        from django.contrib.auth import get_user_model

        counts = {
            "boards": apps.get_model("boards", "Board").objects.count(),
            "cards": apps.get_model("boards", "Card").objects.count(),
            "movements": apps.get_model("boards", "CardMovement").objects.count(),
            "users": get_user_model().objects.count(),
        }
        print("COUNTS " + " ".join(f"{k}={v}" for k, v in counts.items()))
    elif mode == "health":
        status, body = _request("GET", "/api/health/readiness/")
        ok = status == 200 and json.loads(body or "{}").get("status") == "ok"
        print(f"HEALTH {status} {body[:200]}")
        sys.exit(0 if ok else 1)
    elif mode == "login":
        status, body = _request(
            "POST", "/api/v1/auth/login/", {"username": DRILL_USER, "password": password}
        )
        # A wrong password is a 400, so 200 alone proves the hash survived.
        ok = status == 200
        print(f"LOGIN {status}" + ("" if ok else f" {body[:200]}"))
        sys.exit(0 if ok else 1)
    else:
        print(f"unknown mode: {mode!r}", file=sys.stderr)
        sys.exit(2)


main()
