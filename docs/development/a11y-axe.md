# Accessibility scans (axe-core)

`frontend/e2e/a11y.spec.ts` runs [axe-core](https://github.com/dequelabs/axe-core) through
`@axe-core/playwright` at WCAG 2.1 A and AA on seven states: board view, card detail dialog,
command palette, filter bar (expanded), settings page, member management modal (Board Settings,
Members tab), and mobile navigation (375 px). It runs inside the existing `playwright-e2e` CI job,
so there is no separate job to find.

## What fails the job

- A violation whose rule id is not in the `BASELINE` map for that state.
- A baselined rule that now affects more nodes than its recorded `maxNodes`.
- A baselined rule that no longer reproduces. Delete its entry: the list only shrinks.

## Reading a failure

The assertion message lists, per rule: the rule id, impact, help text, a `helpUrl` to the Deque
rule page, and the CSS selector of each offending node. Open the `helpUrl` first; it explains the
rule and the fix. Then find the element from its selector.

To reproduce locally:

```bash
cd frontend && source ../.envrc
npx playwright test e2e/a11y.spec.ts
```

Common fixes: give icon-only buttons an `aria-label`; make an `aria-label` start with the visible
text (WCAG 2.5.3); use the contrast-checked color tokens in `frontend/CLAUDE.md` rather than
`text-info` on tinted backgrounds; never nest a button or link inside another interactive element.

## The baseline

When the gate landed, the scanned states already had violations. They are recorded in `BASELINE`
in the spec, each tied to an open issue: #2466 (color-contrast), #2467
(label-content-name-mismatch), #2468 (missing accessible names), #2469 (ARIA validity). Fix the
issue, then remove the matching entries. Never add an entry for a regression you just introduced;
fix the regression. A new entry needs an open tracking issue.

## Adding a state

Add the name to `StateName`, write a test that drives the UI into the state and calls
`scan(page, '<state>')`, run it, and fix or baseline (with an issue) what it reports.
