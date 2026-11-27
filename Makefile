.PHONY: help memory-check memory-check-selftest pre-tool-agent-budget-selftest

help:
	@echo "Available targets:"
	@echo "  memory-check           Budget-check the local Claude Code memory store"
	@echo "                         (scripts/check-memory-index.sh). Not a CI gate —"
	@echo "                         see .claude/skills/release/SKILL.md pre-flight checks."
	@echo "  memory-check-selftest  Run scripts/check-memory-index.sh --self-test"
	@echo "                         (synthetic store, touches nothing real)."
	@echo "  pre-tool-agent-budget-selftest"
	@echo "                         Run scripts/tests/pre-tool-agent-budget.test.sh, the"
	@echo "                         tests for the /wave implementer's lifetime tool-call hook."

memory-check:
	@scripts/check-memory-index.sh

memory-check-selftest:
	@scripts/check-memory-index.sh --self-test

pre-tool-agent-budget-selftest:
	@bash scripts/tests/pre-tool-agent-budget.test.sh
