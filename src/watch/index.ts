import type { AppPorts } from "../app/ports";
import { Watcher } from "../app/watch";
import { decodeEvent, encodeEvent, type HelperEvent } from "../protocol/index";

/** Design §8.2: the watcher runs a sync tick every 30 s while the session is open. */
export const TICK_MS = 30_000;

export interface WatchIo {
  /** NDJSON lines from the mod, until stdin closes. */
  lines: AsyncIterable<string>;
  /** Write one NDJSON line to the mod. */
  write(line: string): void;
  /** False once the process that started the watcher is gone. */
  parentAlive(): boolean;
}

/**
 * `crew-net watch --session <id>` (design §16): the mod's child. Writes
 * `ready`, waits for `hello`, then ticks every `tickMs`. Reads `ack` and
 * `bye`. Runs until stdin closes, `bye` arrives or the parent dies; it never
 * exits on its own after `hello`.
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
  let stop: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  const timer = setInterval(() => {
    if (!io.parentAlive()) {
      stop();
      return;
    }
    if (watcher.started) void serial(() => watcher.tick());
  }, tickMs);
  emit({ type: "ready" });

  const read = (async () => {
    for await (const line of io.lines) {
      if (!line.trim()) continue;
      const decoded = decodeEvent(line);
      if (!decoded.ok) {
        emit({ type: "error", message: `bad event: ${decoded.detail}` });
        continue;
      }
      const event = decoded.event;
      if (event.type === "hello") {
        void serial(() => watcher.start(event));
      } else if (event.type === "ack") {
        void serial(() => watcher.ack(event));
      } else if (event.type === "bye") {
        await serial(() => watcher.bye());
        return;
      } else {
        emit({ type: "error", message: `unexpected event ${event.type}` });
      }
    }
  })();
  await Promise.race([read, stopped]);
  clearInterval(timer);
  await queue;
  return 0;
}
