# Maintainer Runbooks

Operational reference for whoever runs the Visiban project itself — CI infrastructure,
credentials, and known failure patterns. This is **not** end-user or self-hosted-instance
documentation; see [Administration](../administration/index.md) for that audience.

These pages exist because operational facts that only live in a maintainer's personal notes
are invisible to everyone else and nothing forces them to stay current. Point-in-time facts
belong here, committed and versioned, not in a private notes file.

| Guide | Description |
|---|---|
| [CI Runners](ci-runners.md) | Self-hosted runner inventory, which jobs need them and why, the untagged-fallthrough trap |
| [Tokens and Rotation](tokens-and-rotation.md) | Every PAT and CI credential: scope, owner, storage, expiry, and how to rotate it |
| [Known CI Failures](known-ci-failures.md) | Failure signature → root cause → fix, so the next person greps instead of re-deriving |
