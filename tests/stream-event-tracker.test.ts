import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  StreamEventTracker,
  type RawEventSource,
} from "../src/stream-event-tracker.js";

const streamKey = "guild:guild:channel:user";

function source(): { emitter: EventEmitter; raw: RawEventSource } {
  const emitter = new EventEmitter();
  return { emitter, raw: emitter as unknown as RawEventSource };
}

function emitStream(
  emitter: EventEmitter,
  type: string,
  data: Record<string, unknown> = {},
): void {
  emitter.emit("raw", { t: type, d: { stream_key: streamKey, ...data } });
}

test("tracker becomes ready after create and server update", async () => {
  const { emitter, raw } = source();
  const tracker = new StreamEventTracker(
    raw,
    streamKey,
    1_000,
    new AbortController().signal,
  );

  emitStream(emitter, "STREAM_CREATE", { rtc_server_id: "rtc" });
  emitStream(emitter, "STREAM_SERVER_UPDATE", { endpoint: "voice.example", token: "one" });
  await tracker.ready;
  tracker.dispose();
  assert.equal(emitter.listenerCount("raw"), 0);
});

test("duplicate server update is ignored but a changed token fails active stream", async () => {
  const { emitter, raw } = source();
  const tracker = new StreamEventTracker(
    raw,
    streamKey,
    1_000,
    new AbortController().signal,
  );
  emitStream(emitter, "STREAM_CREATE");
  emitStream(emitter, "STREAM_SERVER_UPDATE", { endpoint: "voice.example", token: "one" });
  await tracker.ready;

  emitStream(emitter, "STREAM_SERVER_UPDATE", { endpoint: "voice.example", token: "one" });
  emitStream(emitter, "STREAM_SERVER_UPDATE", { endpoint: "voice.example", token: "two" });
  await assert.rejects(tracker.failure, /changed the active stream server/);
  assert.equal(emitter.listenerCount("raw"), 0);
});

test("stream delete rejects startup readiness", async () => {
  const { emitter, raw } = source();
  const tracker = new StreamEventTracker(
    raw,
    streamKey,
    1_000,
    new AbortController().signal,
  );
  emitStream(emitter, "STREAM_DELETE", { reason: "stream_ended" });
  await assert.rejects(tracker.ready, /stream_ended/);
  assert.equal(emitter.listenerCount("raw"), 0);
});

test("tracker cleans up immediately when constructed with an aborted signal", async () => {
  const { emitter, raw } = source();
  const controller = new AbortController();
  controller.abort(new Error("attempt already stopped"));
  const tracker = new StreamEventTracker(raw, streamKey, 1_000, controller.signal);

  await assert.rejects(tracker.ready, /attempt already stopped/);
  await assert.rejects(tracker.failure, /attempt already stopped/);
  assert.equal(emitter.listenerCount("raw"), 0);
});
