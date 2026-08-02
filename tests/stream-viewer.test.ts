import assert from "node:assert/strict";
import test from "node:test";
import {
  guildStreamKey,
  inspectViewerPacket,
  isPacketForStream,
  MEDIA_SINK_WANTS,
} from "../src/stream-viewer.js";

const context = {
  streamKey: "guild:guild:channel:broadcaster",
  viewerUserId: "viewer",
  guildId: "guild",
  channelId: "channel",
  voiceSessionId: "voice-session",
};

test("viewer builds the documented guild stream key", () => {
  assert.equal(
    guildStreamKey("guild", "channel", "broadcaster"),
    "guild:guild:channel:broadcaster",
  );
});

test("viewer ignores stream events for another broadcaster", () => {
  const expected = guildStreamKey("guild", "channel", "broadcaster");
  assert.equal(isPacketForStream({
    t: "STREAM_CREATE",
    d: { stream_key: expected },
  }, expected), true);
  assert.equal(isPacketForStream({
    t: "STREAM_CREATE",
    d: { stream_key: "guild:guild:channel:someone-else" },
  }, expected), false);
});

test("viewer requests the highest available remote media quality", () => {
  assert.deepEqual(MEDIA_SINK_WANTS, { any: 100, pixelCounts: {} });
});

test("viewer accepts either initial stream event ordering", () => {
  assert.deepEqual(inspectViewerPacket({
    t: "STREAM_SERVER_UPDATE",
    d: { stream_key: context.streamKey, endpoint: "voice.example", token: "token" },
  }, context), {
    kind: "server-update",
    endpoint: "voice.example",
    token: "token",
  });
  assert.deepEqual(inspectViewerPacket({
    t: "STREAM_CREATE",
    d: {
      stream_key: context.streamKey,
      rtc_server_id: "rtc-server",
      rtc_channel_id: "rtc-channel",
    },
  }, context), {
    kind: "stream-create",
    rtcServerId: "rtc-server",
    rtcChannelId: "rtc-channel",
  });
});

test("viewer restarts on server failover or deallocation", () => {
  const allocated = {
    ...context,
    endpoint: "voice.example",
    token: "old-token",
  };
  assert.match(inspectViewerPacket({
    t: "STREAM_SERVER_UPDATE",
    d: { stream_key: context.streamKey, endpoint: null },
  }, allocated).kind, /restart/);
  assert.deepEqual(inspectViewerPacket({
    t: "STREAM_SERVER_UPDATE",
    d: { stream_key: context.streamKey, endpoint: "new.example", token: "new-token" },
  }, allocated), {
    kind: "restart",
    reason: "Viewer stream server credentials changed",
  });
});

test("viewer restarts immediately after a kick, move, or replaced session", () => {
  assert.deepEqual(inspectViewerPacket({
    t: "VOICE_STATE_UPDATE",
    d: {
      guild_id: "guild",
      user_id: "viewer",
      channel_id: null,
      session_id: "voice-session",
    },
  }, context), {
    kind: "restart",
    reason: "Viewer was disconnected or moved from voice",
  });
  assert.deepEqual(inspectViewerPacket({
    t: "VOICE_STATE_UPDATE",
    d: {
      guild_id: "guild",
      user_id: "viewer",
      channel_id: "channel",
      session_id: "replacement",
    },
  }, context), {
    kind: "restart",
    reason: "Discord replaced the viewer voice session",
  });
});

test("viewer preserves Discord stream-delete failure reason", () => {
  assert.deepEqual(inspectViewerPacket({
    t: "STREAM_DELETE",
    d: { stream_key: context.streamKey, reason: "unauthorized" },
  }, context), {
    kind: "restart",
    reason: "Discord ended the viewer stream session: unauthorized",
  });
});
