# Help links cannot rot: the anchor check
<a id="help-link-anchors"></a>

The `help-link-anchors` CI job fails when an in-app help topic points at a docs page or anchor that no longer exists.

**Why it matters:** Rename a docs heading and the app's "Learn more" link still opens the right page, just at the top. Nobody sees it break. This check turns that silent rot into a red job.

## What it checks

`scripts/check-help-link-anchors.py` reads every topic in the help registry (`frontend/src/help/topics.ts`, #2589) and, for each one:

1. The docs page for its `path` exists (`features/webhooks/` maps to `docs/features/webhooks.md`).
2. If the topic has an `anchor`, that anchor exists on the page. An anchor is either a heading slug or an explicit `<a id="...">`.

A failure names the topic key, the path and the missing anchor:

```text
FAIL: help topic 'webhooks.verify': anchor '#verifying-signatures' not found in docs/api/webhooks.md (path 'api/webhooks/')
```

**Reverse check (warning only):** every `page.md#anchor` in the Anchors table of [Concepts](../features/concepts.md#concept-anchors) must still exist. A stale entry prints `WARNING:` lines in a block at the end of the job log, with a count, and does not fail the job (exit code unchanged).

## How anchors are resolved

The check is offline. It reads the markdown in `docs/` and does not run `mkdocs build`. Heading slugs follow the `toc` extension that mkdocs uses by default: lowercase, punctuation removed, spaces become `-`, and a repeated heading gets `_1`, `_2`. Headings inside code fences do not count.

Prefer an explicit `<a id>` for any anchor the app links to. A heading rename then cannot break the link.

## When it runs

On merge requests and on `main` that touch `docs/`, `frontend/src/help/`, or the script. The job runs `--self-test` first, which builds a throwaway docs tree and proves a missing anchor, a missing page, and an unparseable registry each fail, that the real registry parses to at least one topic with a path, and that the reverse check only warns. See [CI gate self-tests](ci-gates.md).

## Fixing a failure

- Heading renamed: restore the heading, add `<a id="old-anchor"></a>` above the new one, or update the topic's `anchor` in the registry.
- Page moved: update the topic's `path`.
- Never remove a registry key to silence the check; surfaces reference keys.
