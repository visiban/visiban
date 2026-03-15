# Dependency Check

You are reviewing a new package before it is added to the project. The CI will catch license and CVE issues after push, but catching them here is faster and avoids a failed pipeline.

## What to do

Given the package name(s) in `$ARGUMENTS`:

### 1. Identify the ecosystem

- **Python** (`backend/requirements.txt`) — check PyPI
- **JavaScript/TypeScript** (`frontend/package.json`) — check npm
- If unclear, infer from context or ask

### 2. License check

The CI blocks these licenses: `GPL-2.0`, `GPL-3.0`, and their variants.

Classify the package license:
- ✅ **Permissive** — MIT, Apache 2.0, BSD, ISC, CC0, Unlicense → safe to add
- ⚠️ **Weak copyleft** — LGPL, MPL → generally safe for application use (not library distribution); flag for awareness
- 🔴 **Strong copyleft** — GPL-2.0, GPL-3.0, AGPL → **blocked by CI license check; do not add**
- ❓ **Unknown / proprietary** — escalate; do not add without legal sign-off

### 3. Security check

Look up the package for known CVEs or audit flags:
- Check if the package has any recent high/critical CVEs (the CI runs `pip-audit` / `npm audit --audit-level=high`)
- Check the package's maintenance status — abandoned packages with open CVEs are a liability
- For npm: check if it has a known supply-chain incident history

### 4. Justification check

Before adding any dependency, verify:
- **Is it necessary?** Can this be done with what's already in the stack (Django utilities, React built-ins, existing deps)?
- **Is it the right package?** Is this the canonical/maintained choice for this need, or a lesser-known alternative?
- **What is the bundle/install size impact?** For frontend deps, is this being tree-shaken, or does it add significantly to the bundle?
- **How many transitive dependencies does it bring?** A package that pulls in 50 sub-dependencies deserves more scrutiny.

### 5. Output

For each package:
- ✅ **Clear to add** — license, security, and justification all pass
- ⚠️ **Add with awareness** — flag the specific concern (weak copyleft, large bundle, maintenance risk)
- 🔴 **Do not add** — GPL license or unresolved high CVE; suggest an alternative if one exists

If the package is approved, state the correct way to add it:
```bash
# Python
pip install <package> && pip freeze | grep <package> >> backend/requirements.txt

# JavaScript
cd frontend && npm install <package>
# or for dev deps:
cd frontend && npm install --save-dev <package>
```
