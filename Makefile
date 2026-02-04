.PHONY: build clean test sdk-test claude-test codex-test opencode-test claude-sdk-test codex-sdk-test opencode-sdk-test

JOBS ?= 4

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
