import assert from "node:assert/strict";
import test from "node:test";
import { waitUntil, withTimeout } from "../src/async-utils.js";
import type { AppConfig } from "../src/config.js";
import { inspectVoiceState } from "../src/voice-watchdog.js";

const config: AppConfig = {
  discord: {
    token: "test-token",
    guildId: "100000000000000001",
    channelId: "100000000000000002",
  },
  media: {
    sourceProvider: {
      resolve: async () => ({
        kind: "local",
        input: "test.mp4",
        inputOptions: [],
        loopWithFfmpeg: true,
        sourceCount: 1,
        description: "test.mp4",
        dispose() {},
      }),
      dispose() {},
    },
    loopSource: true,
    encoder: "software",
    height: 720,
    frameRate: 30,
    videoBitrate: 2_500,
    videoMaxBitrate: 4_000,
    audioBitrate: 128,
  },
  retry: {
    baseDelayMs: 5_000,
    maxDelayMs: 60_000,
    stableResetMs: 60_000,
  },
  watchdog: {
    healthLogIntervalMs: 30_000,
    streamStartTimeoutMs: 20_000,
    voiceJoinTimeoutMs: 20_000,
    loginTimeoutMs: 30_000,
    rtcReadyTimeoutMs: 20_000,
    rtcLossTimeoutMs: 15_000,
    mediaStallTimeoutMs: 60_000,
    runtimeWatchIntervalMs: 2_000,
    gatewayReconnectTimeoutMs: 30_000,
  },
};

test("withTimeout rejects an unresolved voice operation", async () => {
  await assert.rejects(
    withTimeout(new Promise<never>(() => {}), 10, new AbortController().signal, "Voice join"),
    /Voice join timed out after 10ms/,
  );
});

test("waitUntil rejects immediately when its signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort(new Error("already stopped"));
  await assert.rejects(
    waitUntil(() => false, {
      intervalMs: 10,
      timeoutMs: 1_000,
      signal: controller.signal,
      label: "test poll",
    }),
    /already stopped/,
  );
});

test("waitUntil owns and clears its timeout path", async () => {
  await assert.rejects(
    waitUntil(() => false, {
      intervalMs: 5,
      timeoutMs: 15,
      signal: new AbortController().signal,
      label: "test poll",
    }),
    /test poll timed out after 15ms/,
  );
});

test("voice watchdog requests a restart after a kick", () => {
  const result = inspectVoiceState({
    t: "VOICE_STATE_UPDATE",
    d: {
      guild_id: config.discord.guildId,
      user_id: "self-user",
      channel_id: null,
      session_id: "voice-session",
    },
  }, {
    selfUserId: "self-user",
    guildId: config.discord.guildId,
    expectedChannelId: config.discord.channelId,
    activeSessionId: "voice-session",
    attemptActive: true,
  });

  assert.equal(result.relevant, true);
  assert.match(result.relevant ? result.restartReason ?? "" : "", /Disconnected or kicked/);
});

test("voice watchdog ignores another guild and the expected channel", () => {
  const context = {
    selfUserId: "self-user",
    guildId: config.discord.guildId,
    expectedChannelId: config.discord.channelId,
    activeSessionId: "voice-session",
    attemptActive: true,
  };
  const otherGuild = inspectVoiceState({
    t: "VOICE_STATE_UPDATE",
    d: {
      guild_id: "another-guild",
      user_id: "self-user",
      channel_id: null,
      session_id: "voice-session",
    },
  }, context);
  const expectedChannel = inspectVoiceState({
    t: "VOICE_STATE_UPDATE",
    d: {
      guild_id: config.discord.guildId,
      user_id: "self-user",
      channel_id: config.discord.channelId,
      session_id: "voice-session",
    },
  }, context);

  assert.deepEqual(otherGuild, { relevant: false });
  assert.equal(expectedChannel.relevant, true);
  assert.equal(expectedChannel.relevant && expectedChannel.restartReason, undefined);
});

test("voice watchdog restarts when Discord replaces the voice session", () => {
  const result = inspectVoiceState({
    t: "VOICE_STATE_UPDATE",
    d: {
      guild_id: config.discord.guildId,
      user_id: "self-user",
      channel_id: config.discord.channelId,
      session_id: "replacement-session",
    },
  }, {
    selfUserId: "self-user",
    guildId: config.discord.guildId,
    expectedChannelId: config.discord.channelId,
    activeSessionId: "voice-session",
    attemptActive: true,
  });

  assert.equal(result.relevant, true);
  assert.match(result.relevant ? result.restartReason ?? "" : "", /replaced/);
});
