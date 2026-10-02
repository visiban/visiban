Harden maintainer scripts flagged by SonarCloud: confine `fuzz_deep_file_issue.py --seed-file` to trusted roots, stop hardcoding `/tmp` as a trusted path root, and resolve `glab` explicitly with a urlencoded query in `kaizen_gate_ledger.py`.
Restrict `kaizen_gate_ledger.py --project` to an allowlist of known Visiban projects so no CLI text reaches the `glab` subprocess (SonarCloud S8705).
