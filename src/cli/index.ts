import { main } from "./main";
import { createRuntime } from "./runtime";

// Composition root of the `crew-net` binary (dist/crew-net.js).
const code = await main(process.argv.slice(2), createRuntime(process.cwd()), {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
});
process.exitCode = code;
