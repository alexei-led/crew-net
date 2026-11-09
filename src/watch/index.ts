import type { AppPorts } from "../app/ports";
import { Watcher } from "../app/watch";
import { decodeEvent, encodeEvent, type HelperEvent } from "../protocol/index";

/** Design "Sync": the watcher runs a sync tick every 30 s while the session is open. */
export const TICK_MS = 30_000;

export interface WatchIo {
  /** NDJSON lines from the mod. The mod writes `hello` and closes stdin; EOF is normal. */
  lines: AsyncIterable<string>;
  /** Write one NDJSON line to the mod. */
  write(line: string): void;
  /** False once the process that started the watcher is gone. */
  parentAlive(): boolean;
  /** Resolves on SIGTERM or SIGINT: the engine unloads the mod. */
  stopped: Promise<void>;
}

/**
 * `crew-net watch --session <id>` (design: Harness adapters): the mod's child. Writes
 * `ready`, reads `hello` (and possibly `ack`/`bye`) from stdin, then ticks
 * every `tickMs`. stdin closing after `hello` is normal: the engine closes
 * it once the input is written. Runs until `bye`, a stop signal or the
 * parent's death. Without a `hello` by EOF there is nothing to serve: exit 1.
 */
export async function runWatch(
  ports: AppPorts,
  sessionId: string,
  io: WatchIo,
  tickMs = TICK_MS,
): Promise<number> {
  const emit = (event: HelperEvent) => io.write(`${encodeEvent(event)}\n`);
  const watcher = new Watcher(ports, sessionId, emit);
  let queue: Promise<void> = Promise.resolve();
  const serial = (fn: () => Promise<void>): Promise<void> => {
    queue = queue.then(fn).catch((error: unknown) =>
      emit({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return queue;
  };
  let stop: (code: number) => void = () => {};
  const done = new Promise<number>((resolve) => {
    stop = resolve;
  });
  void io.stopped.then(() => stop(0));
  let ticking = false;
  const timer = setInterval(() => {
    if (!io.parentAlive()) {
      stop(0);
      return;
    }
    // A tick slower than the interval (a 120 s fetch) is not stacked behind.
    if (!watcher.started || ticking) return;
    ticking = true;
    void serial(() => watcher.tick()).finally(() => {
      ticking = false;
    });
  }, tickMs);
  emit({ type: "ready" });

  void (async () => {
    let helloSeen = false;
    for await (const line of io.lines) {
      if (!line.trim()) continue;
      const decoded = decodeEvent(line);
      if (!decoded.ok) {
        emit({ type: "error", message: `bad event: ${decoded.detail}` });
        continue;
      }
      const event = decoded.event;
      if (event.type === "hello") {
        helloSeen = true;
        void serial(() => watcher.start(event));
      } else if (event.type === "ack") {
        void serial(() => watcher.ack(event));
      } else if (event.type === "bye") {
        await serial(() => watcher.bye());
        stop(0);
        return;
      } else {
        emit({ type: "error", message: `unexpected event ${event.type}` });
      }
    }
    if (!helloSeen) {
      emit({ type: "error", message: "stdin closed before hello" });
      stop(1);
    }
  })();
  const code = await done;
  clearInterval(timer);
  watcher.stop();
  await queue;
  return code;
}

/**
 * `crew-net watch send --session <id>`: the mod's way to send `ack` and
 * `bye` after the watcher's stdin is closed. Applies each line to the store
 * and returns the number of bad lines.
 */
export async function sendToWatch(
  ports: AppPorts,
  sessionId: string,
  lines: AsyncIterable<string>,
  report: (message: string) => void,
): Promise<number> {
  const watcher = new Watcher(ports, sessionId, () => {});
  let bad = 0;
  for await (const line of lines) {
    if (!line.trim()) continue;
    const decoded = decodeEvent(line);
    if (!decoded.ok) {
      bad++;
      report(`bad event: ${decoded.detail}`);
      continue;
    }
    const event = decoded.event;
    if (event.type === "ack") await watcher.ack(event);
    else if (event.type === "bye") await watcher.bye();
    else {
      bad++;
      report(`unexpected event ${event.type}`);
    }
  }
  return bad;
}
