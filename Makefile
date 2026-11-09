.PHONY: check typecheck lint fmt test test-fast build plugin plugin-fresh plugin-test workflows help

PLUGIN := plugin
PLUGIN_CLI := $(PLUGIN)/bin/crew-net
PLUGIN_HOOK := $(PLUGIN)/hooks/dist/hook.js
PLUGIN_MOD := $(PLUGIN)/hooks/dist/register.js

# One bun for the lockfile and the committed bundles; CI reads the same file.
BUN_VERSION := $(shell cat .bun-version)
ifneq ($(shell bun --version 2>/dev/null),$(BUN_VERSION))
$(error bun $(BUN_VERSION) is required (.bun-version), found '$(shell bun --version 2>/dev/null)')
endif

check: typecheck lint test plugin-test ## Types, lint, architecture rules, tests, plugin engine tests

typecheck: ## TypeScript: the repo, pure core/protocol, the mod
	bun x tsc --noEmit
	bun x tsc --noEmit -p tsconfig.pure.json
	bun x tsc --noEmit -p $(PLUGIN)/tsconfig.json

lint: ## Biome lint, format and design §19 import rules; warnings fail
	bun x biome check --error-on-warnings .

fmt: ## Apply Biome fixes and formatting
	bun x biome check --write .

# plugin/tests run inside the Claude Code engine (plugin-test), not under bun.
# Test files run in parallel worker processes, so no test may share a path with another file.
TEST := bun test --parallel --path-ignore-patterns='plugin/tests/**'

test: ## Bun tests
	$(TEST)

test-fast: ## Bun tests affected by changes against origin/main (local loop)
	$(TEST) --changed=origin/main

build: ## dist/crew-net.js for Pi, Codex and manual installs
	bun build src/cli/index.ts --target=node --outfile=dist/crew-net.js --banner='#!/usr/bin/env node'
	chmod +x dist/crew-net.js

# The plugin ships built: an install is a copy of the repo with no build step.
# The CLI, the command hooks and the mod are bundled into plugin/ and committed;
# `plugin-fresh` (CI) fails when they are older than the sources.
plugin: ## Rebuild the committed plugin bundles
	bun build src/cli/index.ts --target=node --outfile=$(PLUGIN_CLI) --banner='#!/usr/bin/env node'
	chmod +x $(PLUGIN_CLI)
	bun build $(PLUGIN)/hooks/hook-main.ts --target=node --format=esm --outfile=$(PLUGIN_HOOK)
	bun build $(PLUGIN)/hooks/register.ts --target=browser --format=esm --outfile=$(PLUGIN_MOD)
	@if grep -nE "node:|require\(|import\(" $(PLUGIN_MOD); then \
		echo "$(PLUGIN_MOD): node: modules, require and import() are not allowed in the mod" >&2; exit 1; fi

plugin-fresh: plugin ## Fail when the committed bundles are older than the sources
	@git diff --exit-code -- $(PLUGIN_CLI) $(PLUGIN_HOOK) $(PLUGIN_MOD) || \
		{ echo "plugin bundles are stale: run 'make plugin' and commit them" >&2; exit 1; }

# Needs the claude CLI; without it the engine tests and validation do not run, and this says so.
plugin-test: plugin ## claude plugin validate and test (skipped without claude)
	@if command -v claude >/dev/null 2>&1; then \
		claude plugin validate $(PLUGIN) && claude plugin test $(PLUGIN); \
	else \
		echo "SKIPPED plugin-test: claude is not on PATH, so the mod's engine tests and validation did not run" >&2; \
	fi

# CI pins both tools (.github/workflows/ci.yml); locally use the same versions.
workflows: ## actionlint and zizmor on .github (needs both installed)
	actionlint
	zizmor --offline .

help: ## List targets
	@awk 'BEGIN {FS = ":.*## "} /^[a-z-]+:.*## / {printf "  %-13s %s\n", $$1, $$2}' $(MAKEFILE_LIST)
