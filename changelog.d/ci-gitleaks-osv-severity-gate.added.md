CI gained a `gitleaks-scan` job that scans the full working tree for hardcoded secrets
on every MR and on `main`, backed by a documented `.gitleaks.toml` allowlist. It's also
wired as a local pre-commit hook (`scripts/setup-hooks.sh`) so a secret is caught before
it's even committed.
