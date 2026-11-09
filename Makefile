.PHONY: check typecheck lint test depcruise build plugin plugin-fresh plugin-test fmt

PLUGIN := plugin
PLUGIN_CLI := $(PLUGIN)/bin/crew-net
PLUGIN_HOOK := $(PLUGIN)/hooks/dist/hook.js
PLUGIN_MOD := $(PLUGIN)/hooks/dist/register.js

check: typecheck lint test depcruise plugin-test

typecheck:
	bun x tsc --noEmit
	bun x tsc --noEmit -p tsconfig.pure.json
	bun x tsc --noEmit -p $(PLUGIN)/tsconfig.json

lint:
	bun x biome check .

# plugin/tests run inside the Claude Code engine (plugin-test), not under bun.
test:
	bun test --path-ignore-patterns='plugin/tests/**'

depcruise:
	bun x depcruise src plugin

build: plugin
	bun build src/cli/index.ts --target=node --outfile=dist/crew-net.js --banner='#!/usr/bin/env node'
	chmod +x dist/crew-net.js

# The plugin ships built: an install is a copy of the repo with no build step.
# The CLI, the command hooks and the mod are bundled into plugin/ and committed;
# `plugin-fresh` (CI) fails when they are older than the sources.
plugin:
	bun build src/cli/index.ts --target=node --outfile=$(PLUGIN_CLI) --banner='#!/usr/bin/env node'
	chmod +x $(PLUGIN_CLI)
	bun build $(PLUGIN)/hooks/hook-main.ts --target=node --format=esm --outfile=$(PLUGIN_HOOK)
	bun build $(PLUGIN)/hooks/register.ts --target=browser --format=esm --outfile=$(PLUGIN_MOD)
	@if grep -nE "node:|require\(|import\(" $(PLUGIN_MOD); then \
		echo "$(PLUGIN_MOD): node: modules, require and import() are not allowed in the mod" >&2; exit 1; fi

plugin-fresh: plugin
	@git diff --exit-code -- $(PLUGIN_CLI) $(PLUGIN_HOOK) $(PLUGIN_MOD) || \
		{ echo "plugin bundles are stale: run 'make plugin' and commit them" >&2; exit 1; }

# Needs the claude CLI; without it the engine tests and validation do not run, and this says so.
plugin-test: plugin
	@if command -v claude >/dev/null 2>&1; then \
		claude plugin validate $(PLUGIN) && claude plugin test $(PLUGIN); \
	else \
		echo "SKIPPED plugin-test: claude is not on PATH, so the mod's engine tests and validation did not run" >&2; \
	fi

fmt:
	bun x biome check --write .
