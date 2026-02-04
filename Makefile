.PHONY: help build clean test sdk-test claude-test codex-test opencode-test claude-sdk-test codex-sdk-test opencode-sdk-test

JOBS ?= 4

help:
	@echo "Targets:"
	@echo "  build              Build all packages"
	@echo "  clean              Remove build artifacts"
	@echo "  test               Run unit + integration tests"
	@echo "  sdk-test           Run live SDK tests for all providers"
	@echo "  claude-test        Run Claude unit + integration tests"
	@echo "  codex-test         Run Codex unit + integration tests"
	@echo "  opencode-test      Run OpenCode unit + integration tests"
	@echo "  claude-sdk-test    Run Claude live SDK tests"
	@echo "  codex-sdk-test     Run Codex live SDK tests"
	@echo "  opencode-sdk-test  Run OpenCode live SDK tests"

build:
	npm run build

clean:
	rm -rf slack/dist claude/dist codex/dist opencode/dist

test:
	npm run test -- --maxWorkers=$(JOBS)

sdk-test:
	npm run test:claude -- --maxWorkers=$(JOBS)
	npm run test:codex -- --maxWorkers=$(JOBS)
	npm run test:opencode -- --maxWorkers=$(JOBS)

claude-test:
	npm run test -- --maxWorkers=$(JOBS) tests/unit/claude tests/integration/claude

codex-test:
	npm run test -- --maxWorkers=$(JOBS) tests/unit/codex tests/integration/codex

opencode-test:
	npm run test:opencode:all -- --maxWorkers=$(JOBS)

claude-sdk-test:
	npm run test:claude -- --maxWorkers=$(JOBS)

codex-sdk-test:
	npm run test:codex -- --maxWorkers=$(JOBS)

opencode-sdk-test:
	npm run test:opencode -- --maxWorkers=$(JOBS)
