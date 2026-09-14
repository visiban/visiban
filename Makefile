.PHONY: help memory-check memory-check-selftest

help:
	@echo "Available targets:"
	@echo "  memory-check           Budget-check the local Claude Code memory store"
	@echo "                         (scripts/check-memory-index.sh). Not a CI gate —"
	@echo "                         see .claude/skills/release/SKILL.md pre-flight checks."
	@echo "  memory-check-selftest  Run scripts/check-memory-index.sh --self-test"
	@echo "                         (synthetic store, touches nothing real)."

memory-check:
	@scripts/check-memory-index.sh

memory-check-selftest:
	@scripts/check-memory-index.sh --self-test
