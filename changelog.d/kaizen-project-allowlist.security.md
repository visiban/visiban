Harden `scripts/kaizen_gate_ledger.py`: `--project` is now checked against an allowlist of known projects, so no CLI text reaches the `glab` subprocess (SonarCloud S8705).
