import {
  Encoders,
  prepareStream,
  playStream,
  Streamer,
  Utils,
} from "@dank074/discord-video-stream";
import { Client } from "discord.js-selfbot-v13";
import { abortableDelay, abortReason, waitUntil, withTimeout } from "./async-utils.js";
import type { AppConfig } from "./config.js";
import { errorFields, logger } from "./logger.js";
import { StreamEventTracker } from "./stream-event-tracker.js";
import { inspectVoiceState, type VoiceStatePacket } from "./voice-watchdog.js";

type State =
  | "idle"
  | "authenticating"
  | "joining_voice"
  | "preparing_media"
  | "streaming"
  | "backoff"
  | "stopping"
  | "stopped";

export class StreamController {
  private readonly client = new Client();
  private readonly streamer = new Streamer(this.client);
  private readonly stopController = new AbortController();
  private state: State = "idle";
  private attempt = 0;
  private startedAt = Date.now();
  private healthTimer?: NodeJS.Timeout;
  private activeAttemptController?: AbortController;
  private activeVoiceSessionId?: string;
  private fatalError?: Error;
  private attemptGeneration = 0;
  private activeStreamStartedAt?: number;
  private gatewayReconnectTimer?: NodeJS.Timeout;
  private cleaningUp = false;

  constructor(private readonly config: AppConfig) {
    this.client.on("shardDisconnect", (event, shardId) => {
      logger.warn("Gateway shard disconnected", { shardId, code: event.code });
      this.startGatewayReconnectDeadline();
    });
    this.client.on("shardResume", (shardId, replayedEvents) => {
      this.clearGatewayReconnectDeadline();
      logger.info("Gateway shard resumed", { shardId, replayedEvents });
    });
    this.client.on("shardReady", () => this.clearGatewayReconnectDeadline());
    this.client.on("invalidated", () => {
      this.fatalError = new Error("Discord session invalidated");
      logger.error(this.fatalError.message);
      this.stopController.abort(this.fatalError);
    });
    this.client.on("raw", (packet: VoiceStatePacket) => this.handleVoiceStateUpdate(packet));
  }

  async run(): Promise<void> {
    this.startedAt = Date.now();
    this.healthTimer = setInterval(
      () => this.logHealth(),
      this.config.watchdog.healthLogIntervalMs,
    );

    try {
      this.setState("authenticating");
      const loginOperation = this.client.login(this.config.discord.token).then((token) => {
        if (this.stopController.signal.aborted) {
          this.client.destroy();
          throw abortReason(this.stopController.signal, "Stale Discord login completed");
        }
        return token;
      });
      await withTimeout(
        loginOperation,
        this.config.watchdog.loginTimeoutMs,
        this.stopController.signal,
        "Discord login",
      );
      logger.info("Discord login succeeded", { userId: this.client.user?.id });

      while (!this.stopController.signal.aborted) {
        try {
          await this.runAttempt();
          throw new Error("Media source ended; restarting after backoff");
        } catch (error) {
          if (this.stopController.signal.aborted) break;
          if (
            this.activeStreamStartedAt &&
            Date.now() - this.activeStreamStartedAt >= this.config.retry.stableResetMs
          ) {
            // Reset only after a genuinely stable window; resetting as soon as
            // Go Live starts turns rapid RTC failures into a hot retry loop.
            this.attempt = 0;
          }
          this.activeStreamStartedAt = undefined;
          this.attempt += 1;
          const delayMs = this.retryDelay(this.attempt);
          logger.error("Streaming attempt failed", {
            attempt: this.attempt,
            retryInMs: delayMs,
            ...errorFields(error),
          });
          this.safeTearDownStream();
          this.setState("backoff");
          await abortableDelay(delayMs, this.stopController.signal);
        }
      }
    } finally {
      await this.cleanup();
    }

    if (this.fatalError) throw this.fatalError;
  }

  stop(reason = "shutdown requested"): void {
    if (this.stopController.signal.aborted) return;
    logger.info("Stopping supervisor", { reason });
    this.setState("stopping");
    this.stopController.abort(new Error(reason));
  }

  private async runAttempt(): Promise<void> {
    const attemptController = new AbortController();
    this.activeAttemptController = attemptController;
    const generation = ++this.attemptGeneration;
    const attemptSignal = AbortSignal.any([
      this.stopController.signal,
      attemptController.signal,
    ]);
    let sourcePlan: Awaited<ReturnType<AppConfig["media"]["sourceProvider"]["resolve"]>> | undefined;
    let streamEvents: StreamEventTracker | undefined;

    try {
      sourcePlan = await this.config.media.sourceProvider.resolve(attemptSignal);
      this.setState("joining_voice");
      this.safeTearDownStream();
      const joinOperation = this.streamer
        .joinVoice(this.config.discord.guildId, this.config.discord.channelId)
        .then((connection) => {
          // The library does not cancel its underlying join on our timeout.
          // Stop that exact late connection without tearing down a newer,
          // generation-owned attempt which may already be healthy.
          if (generation !== this.attemptGeneration || attemptSignal.aborted) {
            connection.mediaConnection.stop();
            throw abortReason(attemptSignal, "Stale voice join completed");
          }
          return connection;
        });
      await withTimeout(
        joinOperation,
        this.config.watchdog.voiceJoinTimeoutMs,
        attemptSignal,
        "Voice join",
      );
      this.activeVoiceSessionId = this.streamer.voiceConnection?.session_id ?? undefined;
      logger.info("Joined voice channel", {
        guildId: this.config.discord.guildId,
        channelId: this.config.discord.channelId,
      });

      this.setState("preparing_media");
      const encoder = this.config.media.encoder === "nvenc"
        ? Encoders.nvenc({ preset: "p4" })
        : Encoders.software({ x264: { preset: "veryfast", tune: "zerolatency" } });

      const media = prepareStream(
        sourcePlan.input,
        {
          encoder,
          height: this.config.media.height,
          frameRate: this.config.media.frameRate,
          bitrateVideo: this.config.media.videoBitrate,
          bitrateVideoMax: this.config.media.videoMaxBitrate,
          bitrateAudio: this.config.media.audioBitrate,
          includeAudio: true,
          // nobuffer/analyzeduration=0 is useful for live URLs but can discard
          // late stream metadata in a seekable local concat playlist.
          minimizeLatency: sourcePlan.kind === "remote",
          videoCodec: Utils.normalizeVideoCodec("H264"),
          customInputOptions: [
            ...sourcePlan.inputOptions,
            ...(this.config.media.loopSource && sourcePlan.loopWithFfmpeg
              ? ["-stream_loop", "-1"]
              : []),
          ],
        },
        attemptSignal,
      );

      media.command.on("start", () => {
        logger.info("FFmpeg started");
      });
      media.command.on("stderr", (line: string) => {
        if (/error|failed|invalid/i.test(line)) {
          // FFmpeg may echo a signed source URL or request header. Keep useful
          // diagnostics without writing credentials into long-lived logs.
          const redacted = line
            .replace(/https?:\/\/\S+/gi, "[redacted-url]")
            .replace(/(authorization|cookie):\s*\S+/gi, "$1: [redacted]");
          logger.warn("FFmpeg diagnostic", { line: redacted });
        }
      });
      let lastMediaProgressAt = Date.now();
      media.command.on("progress", () => {
        lastMediaProgressAt = Date.now();
      });

      logger.info("Requesting Discord Go Live", {
        source: sourcePlan.description,
        sourceCount: sourcePlan.sourceCount,
        ffmpegLoop: this.config.media.loopSource && sourcePlan.loopWithFfmpeg,
        encoder: this.config.media.encoder,
        height: this.config.media.height,
        frameRate: this.config.media.frameRate,
      });

      const expectedKey =
        `guild:${this.config.discord.guildId}:` +
        `${this.config.discord.channelId}:${this.client.user?.id}`;
      streamEvents = new StreamEventTracker(
        this.client,
        expectedKey,
        this.config.watchdog.streamStartTimeoutMs,
        attemptSignal,
      );
      const playback = Promise.all([
        playStream(
          media.output,
          this.streamer,
          { type: "go-live" },
          attemptSignal,
        ),
        media.promise,
      ]);

      const startupResult = await Promise.race([
        streamEvents.ready.then(() => "ready" as const),
        playback.then(() => "ended" as const),
      ]);
      if (startupResult === "ended") {
        throw new Error("Media ended before Discord confirmed the Go Live stream");
      }

      await Promise.race([
        this.waitForRtcReady(attemptSignal),
        playback.then(() => {
          throw new Error("Media ended before WebRTC became connected");
        }),
        streamEvents.failure,
      ]);

      this.setState("streaming");
      this.activeStreamStartedAt = Date.now();
      logger.info("Discord confirmed Go Live and WebRTC is connected");
      await Promise.race([
        playback,
        streamEvents.failure,
        this.waitForRuntimeFailure(attemptSignal, () => lastMediaProgressAt),
      ]);
    } finally {
      attemptController.abort(new Error("Streaming attempt finished"));
      streamEvents?.dispose();
      sourcePlan?.dispose();
      this.activeVoiceSessionId = undefined;
      if (this.activeAttemptController === attemptController) {
        this.activeAttemptController = undefined;
      }
    }
  }

  private handleVoiceStateUpdate(packet: VoiceStatePacket): void {
    const attemptActive =
      this.state === "joining_voice" ||
      this.state === "preparing_media" ||
      this.state === "streaming";
    const result = inspectVoiceState(packet, {
      selfUserId: this.client.user?.id,
      guildId: this.config.discord.guildId,
      expectedChannelId: this.config.discord.channelId,
      activeSessionId: this.activeVoiceSessionId,
      attemptActive,
    });
    if (!result.relevant) return;

    logger.info("Self voice state updated", {
      expectedChannelId: this.config.discord.channelId,
      actualChannelId: result.actualChannelId,
      state: this.state,
    });

    if (!result.restartReason) return;
    logger.warn("Voice watchdog is restarting the stream", {
      reason: result.restartReason,
    });
    this.activeAttemptController?.abort(new Error(result.restartReason));
  }


  private waitForRtcReady(signal: AbortSignal): Promise<void> {
    return waitUntil(
      () => {
        const voiceReady = this.streamer.voiceConnection?.webRtcConn.ready === true;
        const streamReady =
          this.streamer.voiceConnection?.streamConnection?.webRtcConn.ready === true;
        return voiceReady && streamReady;
      },
      {
        intervalMs: 250,
        timeoutMs: this.config.watchdog.rtcReadyTimeoutMs,
        signal,
        label: "WebRTC readiness",
      },
    );
  }

  private waitForRuntimeFailure(
    signal: AbortSignal,
    lastMediaProgressAt: () => number,
  ): Promise<never> {
    return new Promise((_, reject) => {
      let rtcUnhealthySince: number | undefined;
      const cleanup = () => {
        clearInterval(interval);
        signal.removeEventListener("abort", onAbort);
      };
      const fail = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onAbort = () => fail(
        signal.reason instanceof Error
          ? signal.reason
          : new Error(String(signal.reason ?? "Streaming attempt aborted")),
      );
      const check = () => {
        const now = Date.now();
        const voiceReady = this.streamer.voiceConnection?.webRtcConn.ready === true;
        const streamReady =
          this.streamer.voiceConnection?.streamConnection?.webRtcConn.ready === true;

        if (voiceReady && streamReady) {
          rtcUnhealthySince = undefined;
        } else {
          rtcUnhealthySince ??= now;
          if (now - rtcUnhealthySince >= this.config.watchdog.rtcLossTimeoutMs) {
            fail(new Error("Voice or stream WebRTC remained disconnected"));
            return;
          }
        }

        if (now - lastMediaProgressAt() >= this.config.watchdog.mediaStallTimeoutMs) {
          fail(new Error("FFmpeg media progress stalled"));
        }
      };
      const interval = setInterval(check, this.config.watchdog.runtimeWatchIntervalMs);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  private safeTearDownStream(): void {
    try {
      this.streamer.stopStream();
    } catch (error) {
      logger.warn("Failed to stop stream cleanly", errorFields(error));
    }
    try {
      this.streamer.leaveVoice();
    } catch (error) {
      logger.warn("Failed to leave voice cleanly", errorFields(error));
    }
  }

  private async cleanup(): Promise<void> {
    this.cleaningUp = true;
    if (!this.stopController.signal.aborted) {
      this.stopController.abort(new Error("Supervisor cleanup"));
    }
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.clearGatewayReconnectDeadline();
    this.safeTearDownStream();
    this.config.media.sourceProvider.dispose();
    this.client.destroy();
    this.setState("stopped");
    logger.info("Supervisor stopped");
  }

  private retryDelay(attempt: number): number {
    const exponential = Math.min(
      this.config.retry.maxDelayMs,
      this.config.retry.baseDelayMs * 2 ** Math.min(attempt - 1, 10),
    );
    const jitter = 0.8 + Math.random() * 0.4;
    return Math.round(exponential * jitter);
  }


  private setState(next: State): void {
    if (next === this.state) return;
    const previous = this.state;
    this.state = next;
    logger.info("State changed", { previous, next });
  }

  private startGatewayReconnectDeadline(): void {
    if (this.cleaningUp || this.gatewayReconnectTimer || this.stopController.signal.aborted) return;
    this.gatewayReconnectTimer = setTimeout(() => {
      this.gatewayReconnectTimer = undefined;
      this.fatalError = new Error("Discord Gateway did not resume before the deadline");
      logger.error(this.fatalError.message);
      this.activeAttemptController?.abort(this.fatalError);
      this.stopController.abort(this.fatalError);
    }, this.config.watchdog.gatewayReconnectTimeoutMs);
  }

  private clearGatewayReconnectDeadline(): void {
    if (!this.gatewayReconnectTimer) return;
    clearTimeout(this.gatewayReconnectTimer);
    this.gatewayReconnectTimer = undefined;
  }

  private logHealth(): void {
    const voiceReady = this.streamer.voiceConnection?.webRtcConn.ready === true;
    const streamReady =
      this.streamer.voiceConnection?.streamConnection?.webRtcConn.ready === true;
    logger.info("Health", {
      state: this.state,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1_000),
      streamUptimeSeconds: this.activeStreamStartedAt
        ? Math.floor((Date.now() - this.activeStreamStartedAt) / 1_000)
        : 0,
      attemptGeneration: this.attemptGeneration,
      retryAttempt: this.attempt,
      gatewayReady: this.client.isReady(),
      voiceRtcReady: voiceReady,
      streamRtcReady: streamReady,
    });
  }
}
