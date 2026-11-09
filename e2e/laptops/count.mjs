// Preload: log every fetch (method, path, status) to $CREW_E2E_FETCH_LOG.
import { appendFileSync } from "node:fs";

const log = process.env.CREW_E2E_FETCH_LOG;
const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const res = await real(input, init);
  const url = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
  );
  appendFileSync(
    log,
    `${Date.now()} ${init?.method ?? "GET"} ${url.pathname} ${res.status} ${res.headers.get("x-ratelimit-remaining") ?? ""}\n`,
  );
  return res;
};
