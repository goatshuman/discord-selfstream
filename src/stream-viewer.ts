import {
  GatewayOpCodes,
  StreamConnection,
  Streamer,
  VoiceOpCodes,
} from "@dank074/discord-video-stream";
import { Client } from "discord.js-selfbot-v13";
import {
  abortableDelay,
  abortReason,
  waitUntil,
  withTimeout,
} from "./async-utils.js";
import { errorFields, logger } from "./logger.js";

type ViewerConfig = {
  token: string;
  guildId: string;
  channelId: string;
  loginTimeoutMs: number;
  voiceJoinTimeoutMs: number;
  rtcReadyTimeoutMs: number;
  rtcLossTimeoutMs: number;
  watchIntervalMs: number;
  stableResetMs: number;
};

export type ViewerPacket = {
  t?: string;
  d?: {
    guild_id?: string;
    user_id?: string;
    channel_id?: string | null;
    session_id?: string;
    stream_key?: string;
    rtc_server_id?: string;
    rtc_channel_id?: string;
    endpoint?: string | null;
    token?: string;
    reason?: string;
  };
};

type ViewerPacketContext = {
  streamKey: string;
  viewerUserId: string;
  guildId: string;
  channelId: string;
  voiceSessionId: string;
  rtcServerId?: string;
  endpoint?: string;
  token?: string;
};

export type ViewerPacketAction =
  | { kind: "ignore" }
  | { kind: "stream-create"; rtcServerId: string; rtcChannelId?: string }
  | { kind: "server-update"; endpoint: string; token: string }
  | { kind: "restart"; reason: string };

export const MEDIA_SINK_WANTS = Object.freeze({
  any: 100,
  pixelCounts: {},
});

export function guildStreamKey(
  guildId: string,
  channelId: string,
  broadcasterUserId: string,
): string {
  return `guild:${guildId}:${channelId}:${broadcasterUserId}`;
}

export function isPacketForStream(packet: ViewerPacket, streamKey: string): boolean {
  return packet.d?.stream_key === streamKey;
}

export function inspectViewerPacket(
  packet: ViewerPacket,
  context: ViewerPacketContext,
): ViewerPacketAction {
  if (
    packet.t === "VOICE_STATE_UPDATE" &&
    packet.d?.guild_id === context.guildId &&
    packet.d.user_id === context.viewerUserId
  ) {
    if (packet.d.channel_id !== context.channelId) {
      return { kind: "restart", reason: "Viewer was disconnected or moved from voice" };
    }
    if (
      typeof packet.d.session_id === "string" &&
      packet.d.session_id !== context.voiceSessionId
    ) {
      return { kind: "restart", reason: "Discord replaced the viewer voice session" };
    }
    return { kind: "ignore" };
  }

  if (!isPacketForStream(packet, context.streamKey)) return { kind: "ignore" };
  if (packet.t === "STREAM_DELETE") {
    const suffix = packet.d?.reason ? `: ${packet.d.reason}` : "";
    return { kind: "restart", reason: `Discord ended the viewer stream session${suffix}` };
  }
  if (packet.t === "STREAM_CREATE" && typeof packet.d?.rtc_server_id === "string") {
    if (context.rtcServerId && context.rtcServerId !== packet.d.rtc_server_id) {
      return { kind: "restart", reason: "Viewer stream RTC server changed" };
    }
    return {
      kind: "stream-create",
      rtcServerId: packet.d.rtc_server_id,
      rtcChannelId: packet.d.rtc_channel_id,
    };
  }
  if (packet.t === "STREAM_SERVER_UPDATE") {
    if (packet.d?.endpoint === null) {
      return { kind: "restart", reason: "Viewer stream server is being reallocated" };
    }
    if (
      typeof packet.d?.endpoint === "string" &&
      typeof packet.d.token === "string"
    ) {
      if (
        (context.endpoint && context.endpoint !== packet.d.endpoint) ||
        (context.token && context.token !== packet.d.token)
      ) {
        return { kind: "restart", reason: "Viewer stream server credentials changed" };
      }
      return {
        kind: "server-update",
        endpoint: packet.d.endpoint,
        token: packet.d.token,
      };
    }
  }
  return { kind: "ignore" };
}

/** Maintains an optional second account as an actual RTC stream viewer. */
export class StreamViewer {
  private readonly client = new Client();
  private readonly streamer = new Streamer(this.client);
  private watching = false;
  private needsLogin = true;
  private loginOperation?: Promise<void>;
  private destroyed = false;
  private activeWatchController?: AbortController;
  private watchConnectedAt?: number;

  constructor(private readonly config: ViewerConfig) {
    this.client.on("shardDisconnect", (event, shardId) => {
      logger.warn("Viewer Gateway shard disconnected", { shardId, code: event.code });
      this.activeWatchController?.abort(new Error("Viewer Gateway disconnected"));
    });
    this.client.on("invalidated", () => {
      this.needsLogin = true;
      this.activeWatchController?.abort(new Error("Viewer Discord session invalidated"));
      this.client.destroy();
    });
  }

  get userId(): string | undefined {
    return this.client.user?.id;
  }

  get connected(): boolean {
    const voiceReady = this.streamer.voiceConnection?.webRtcConn.ready === true;
    const streamReady =
      this.streamer.voiceConnection?.streamConnection?.webRtcConn.ready === true;
    return this.watching && voiceReady && streamReady;
  }

  async login(signal: AbortSignal): Promise<void> {
    if (this.isClientReady()) {
      this.needsLogin = false;
      return;
    }
    if (!this.needsLogin) {
      await waitUntil(() => this.isClientReady(), {
        intervalMs: 250,
        timeoutMs: this.config.loginTimeoutMs,
        signal,
        label: "Viewer Gateway resume",
      });
      return;
    }
    if (!this.loginOperation) {
      this.loginOperation = this.client.login(this.config.token).then(() => {
        if (this.destroyed) {
          this.client.destroy();
          throw new Error("Viewer was destroyed during Discord login");
        }
        this.needsLogin = false;
        logger.info("Viewer Discord login succeeded", { userId: this.client.user?.id });
      }).finally(() => {
        this.loginOperation = undefined;
      });
    }
    const operation = this.loginOperation;
    if (!operation) throw new Error("Viewer login operation was not created");
    if (signal.aborted) {
      throw abortReason(signal);
    }
    await withTimeout(
      operation,
      this.config.loginTimeoutMs,
      signal,
      "Viewer Discord login",
    );
    if (signal.aborted) {
      if (this.destroyed) {
        this.client.destroy();
      }
      throw abortReason(signal, "Viewer login completed after watch attempt ended");
    }
  }

  async maintainWatch(broadcasterUserId: string, signal: AbortSignal): Promise<void> {
    let attempt = 0;
    while (!signal.aborted) {
      try {
        await this.login(signal);
        if (this.userId === broadcasterUserId) {
          logger.error("VIEWER_TOKEN belongs to the broadcaster; viewer disabled");
          return;
        }
        await this.watchOnce(broadcasterUserId, signal);
      } catch (error) {
        if (signal.aborted) break;
        if (
          this.watchConnectedAt &&
          Date.now() - this.watchConnectedAt >= this.config.stableResetMs
        ) {
          attempt = 0;
        }
        this.watchConnectedAt = undefined;
        attempt += 1;
        const retryInMs = Math.min(30_000, 2_000 * 2 ** Math.min(attempt - 1, 4));
        logger.warn("Viewer watch attempt failed", {
          attempt,
          retryInMs,
          ...errorFields(error),
        });
        await abortableDelay(retryInMs, signal);
      }
    }
    this.leaveVoice();
  }

  destroy(): void {
    this.destroyed = true;
    this.leaveVoice();
    this.client.destroy();
  }

  private async watchOnce(broadcasterUserId: string, signal: AbortSignal): Promise<void> {
    const sessionController = new AbortController();
    this.activeWatchController = sessionController;
    const sessionSignal = AbortSignal.any([signal, sessionController.signal]);
    this.leaveVoice();
    const voiceJoin = this.streamer
      .joinVoice(this.config.guildId, this.config.channelId)
      .then((connection) => {
        // joinVoice cannot be cancelled by the timeout wrapper. The session
        // signal makes an exact late connection stop instead of overlapping a
        // newer viewer retry.
        if (sessionSignal.aborted) {
          connection.mediaConnection.stop();
          throw abortReason(sessionSignal, "Stale viewer voice join completed");
        }
        return connection;
      });
    let onRaw: ((packet: ViewerPacket) => void) | undefined;
    let streamKey: string | undefined;
    try {
      await withTimeout(
        voiceJoin,
        this.config.voiceJoinTimeoutMs,
        sessionSignal,
        "Viewer voice join",
      );

      const voice = this.streamer.voiceConnection;
      const viewerUserId = this.client.user?.id;
      const voiceSessionId = voice?.session_id;
      if (!voice || !viewerUserId || !voiceSessionId) {
        throw new Error("Viewer voice session is incomplete");
      }

      streamKey = guildStreamKey(
        this.config.guildId,
        this.config.channelId,
        broadcasterUserId,
      );
      let rejectStreamFailure: (error: Error) => void = () => {};
      let rtcServerId: string | undefined;
      let endpoint: string | undefined;
      let streamToken: string | undefined;
      const streamFailure = new Promise<never>((_, reject) => {
        rejectStreamFailure = reject;
      });
      const streamReady = new Promise<void>((resolve) => {
        const newConnection = new StreamConnection(
          this.streamer,
          this.config.guildId,
          viewerUserId,
          this.config.channelId,
          () => resolve(),
        );
        voice.streamConnection = newConnection;
      });
      const connection = voice.streamConnection;
      if (!connection) throw new Error("Viewer stream connection was not created");

      onRaw = (packet: ViewerPacket) => {
        const action = inspectViewerPacket(packet, {
          streamKey: streamKey!,
          viewerUserId,
          guildId: this.config.guildId,
          channelId: this.config.channelId,
          voiceSessionId,
          rtcServerId,
          endpoint,
          token: streamToken,
        });
        switch (action.kind) {
          case "stream-create":
            rtcServerId = action.rtcServerId;
            connection.serverId = action.rtcServerId;
            connection.streamKey = streamKey!;
            connection.setSession(voiceSessionId);
            break;
          case "server-update":
            endpoint = action.endpoint;
            streamToken = action.token;
            connection.setTokens(action.endpoint, action.token);
            break;
          case "restart":
            rejectStreamFailure(new Error(action.reason));
            break;
        }
      };
      this.client.on("raw", onRaw);

      // Opcode 20 asks Discord for stream-specific credentials. The subsequent
      // RTC connection is required; merely sending this packet is not a viewer.
      this.streamer.sendOpcode(GatewayOpCodes.STREAM_WATCH, {
        stream_key: streamKey,
      });
      await withTimeout(
        Promise.race([streamReady, streamFailure]),
        this.config.rtcReadyTimeoutMs,
        sessionSignal,
        "Viewer stream RTC readiness",
      );
      await waitUntil(
        () => voice.webRtcConn.ready && connection.webRtcConn.ready,
        {
          intervalMs: 100,
          timeoutMs: this.config.rtcReadyTimeoutMs,
          signal: sessionSignal,
          label: "Viewer WebRTC connection",
        },
      );
      this.requestMedia(connection);
      this.watching = true;
      this.watchConnectedAt = Date.now();
      logger.info("Viewer is watching the Go Live stream", {
        viewerUserId,
        broadcasterUserId,
      });
      await Promise.race([
        streamFailure,
        this.waitForRtcLoss(connection, voice, sessionSignal),
      ]);
    } finally {
      // Cancels the losing side of Promise.race and any late join callback.
      sessionController.abort(new Error("Viewer watch session finished"));
      if (this.activeWatchController === sessionController) {
        this.activeWatchController = undefined;
      }
      this.watching = false;
      if (onRaw) this.client.off("raw", onRaw);
      if (streamKey) {
        this.streamer.sendOpcode(GatewayOpCodes.STREAM_DELETE, {
          stream_key: streamKey,
        });
      }
      this.leaveVoice();
    }
  }

  private waitForRtcLoss(
    stream: StreamConnection,
    voice: NonNullable<Streamer["voiceConnection"]>,
    signal: AbortSignal,
  ): Promise<never> {
    return new Promise((_, reject) => {
      let unhealthySince: number | undefined;
      let lastSinkWantsAt = Date.now();
      let settled = false;
      const cleanup = () => {
        clearInterval(interval);
        signal.removeEventListener("abort", onAbort);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => fail(abortReason(signal));
      const interval = setInterval(() => {
        const now = Date.now();
        if (voice.webRtcConn.ready && stream.webRtcConn.ready) {
          unhealthySince = undefined;
          if (now - lastSinkWantsAt >= 10_000) {
            try {
              this.requestMedia(stream);
            } catch (error) {
              fail(error instanceof Error ? error : new Error(String(error)));
              return;
            }
            lastSinkWantsAt = now;
          }
          return;
        }
        unhealthySince ??= now;
        if (now - unhealthySince >= this.config.rtcLossTimeoutMs) {
          fail(new Error("Viewer voice or stream RTC remained disconnected"));
        }
      }, this.config.watchIntervalMs);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  private requestMedia(stream: StreamConnection): void {
    // v6 exposes the opcode but its request union omits Media Sink Wants.
    // Runtime sendOpcode accepts any JSON voice payload, so keep the cast local.
    const sendOpcode = stream.sendOpcode.bind(stream) as (
      opcode: VoiceOpCodes,
      data: Record<string, unknown>,
    ) => void;
    sendOpcode(VoiceOpCodes.MEDIA_SINK_WANTS, MEDIA_SINK_WANTS);
  }

  private isClientReady(): boolean {
    // Hide discord.js's generic type predicate from narrowing this.client to
    // never throughout the false branch of login().
    return this.client.isReady();
  }

  private leaveVoice(): void {
    this.watching = false;
    try {
      this.streamer.voiceConnection?.streamConnection?.stop();
      if (this.streamer.voiceConnection) {
        this.streamer.voiceConnection.streamConnection = undefined;
      }
      this.streamer.leaveVoice();
    } catch (error) {
      logger.warn("Failed to stop viewer cleanly", errorFields(error));
    }
  }
}
