.PHONY: check typecheck lint test depcruise build fmt

check: typecheck lint test depcruise

typecheck:
	bun x tsc --noEmit
	bun x tsc --noEmit -p tsconfig.pure.json

lint:
	bun x biome check .

test:
	bun test

depcruise:
	bun x depcruise src plugin

build:
	bun build src/cli/index.ts --target=node --outfile=dist/crew-net.js --banner='#!/usr/bin/env node'
	chmod +x dist/crew-net.js

fmt:
	bun x biome check --write .
