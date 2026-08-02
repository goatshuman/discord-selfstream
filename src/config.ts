import { existsSync } from "node:fs";
import { resolveSourcePlan, type SourcePlan } from "./source-resolver.js";

export type EncoderKind = "software" | "nvenc";
export type QualityPreset = "480p" | "720p" | "1080p";

export type SourceProvider = {
  resolve(signal?: AbortSignal): Promise<SourcePlan>;
  dispose(): void;
};

export type AppConfig = {
  discord: {
    token: string;
    guildId: string;
    channelId: string;
    viewerToken?: string;
  };
  media: {
    sourceProvider: SourceProvider;
    loopSource: boolean;
    encoder: EncoderKind;
    height: number;
    frameRate: number;
    videoBitrate: number;
    videoMaxBitrate: number;
    audioBitrate: number;
  };
  retry: {
    baseDelayMs: number;
    maxDelayMs: number;
    stableResetMs: number;
  };
  watchdog: {
    healthLogIntervalMs: number;
    streamStartTimeoutMs: number;
    voiceJoinTimeoutMs: number;
    loginTimeoutMs: number;
    rtcReadyTimeoutMs: number;
    rtcLossTimeoutMs: number;
    mediaStallTimeoutMs: number;
    runtimeWatchIntervalMs: number;
    gatewayReconnectTimeoutMs: number;
  };
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function encoderKind(): EncoderKind {
  const value = (process.env.STREAM_ENCODER ?? "software").toLowerCase();
  if (value !== "software" && value !== "nvenc") {
    throw new Error("STREAM_ENCODER must be either software or nvenc");
  }
  return value;
}

function qualityPreset(configuredQuality?: string): {
  height: number;
  frameRate: number;
  videoBitrate: number;
  videoMaxBitrate: number;
  audioBitrate: number;
} {
  const value = (configuredQuality ?? "720p").trim().toLowerCase();
  const presets: Record<QualityPreset, {
    height: number;
    frameRate: number;
    videoBitrate: number;
    videoMaxBitrate: number;
    audioBitrate: number;
  }> = {
    "480p": {
      height: 480,
      frameRate: 30,
      videoBitrate: 1_500,
      videoMaxBitrate: 2_500,
      audioBitrate: 96,
    },
    "720p": {
      height: 720,
      frameRate: 30,
      videoBitrate: 2_500,
      videoMaxBitrate: 4_000,
      audioBitrate: 128,
    },
    "1080p": {
      height: 1_080,
      frameRate: 30,
      videoBitrate: 5_000,
      videoMaxBitrate: 7_500,
      audioBitrate: 128,
    },
  };
  if (!(value in presets)) {
    throw new Error("STREAM_QUALITY must be 480p, 720p, or 1080p");
  }
  return presets[value as QualityPreset];
}

function booleanValue(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["true", "1", "yes", "on"].includes(raw)) return true;
  if (["false", "0", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be true or false`);
}

function optionalBoolean(name: string): boolean | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  return booleanValue(name, false);
}

export async function loadConfig(): Promise<AppConfig> {
  const singleSource = process.env.STREAM_SOURCE?.trim();
  const sourceDirectory = process.env.STREAM_SOURCE_DIR?.trim();
  const explicitConfigFile = process.env.STREAM_CONFIG_FILE?.trim();
  const configFile = explicitConfigFile ||
    (!singleSource && !sourceDirectory && existsSync("config.json")
      ? "config.json"
      : undefined);
  const sourceOptions = {
    singleSource,
    sourceDirectory,
    configFile,
    shuffleOverride: optionalBoolean("STREAM_SHUFFLE"),
  };
  // Validate secrets before creating a disposable playlist manifest.
  const token = required("DISCORD_TOKEN");
  const guildId = required("DISCORD_GUILD_ID");
  const channelId = required("DISCORD_CHANNEL_ID");
  const viewerToken = process.env.VIEWER_TOKEN?.trim() || undefined;
  const firstSourcePlan = await resolveSourcePlan(sourceOptions);
  let initialSourcePlan: SourcePlan | undefined = firstSourcePlan;
  let configCompleted = false;
  const sourceProvider: SourceProvider = {
    async resolve(signal?: AbortSignal) {
      signal?.throwIfAborted();
      if (initialSourcePlan) {
        const plan = initialSourcePlan;
        initialSourcePlan = undefined;
        return plan;
      }
      return resolveSourcePlan(sourceOptions, signal);
    },
    dispose() {
      initialSourcePlan?.dispose();
      initialSourcePlan = undefined;
    },
  };
  try {
    const quality = qualityPreset(process.env.STREAM_QUALITY ?? firstSourcePlan.quality);
    const restartBaseDelayMs = positiveInteger("RESTART_BASE_DELAY_MS", 5_000);
    const restartMaxDelayMs = positiveInteger("RESTART_MAX_DELAY_MS", 60_000);
    if (restartMaxDelayMs < restartBaseDelayMs) {
      throw new Error("RESTART_MAX_DELAY_MS must be >= RESTART_BASE_DELAY_MS");
    }
    const videoBitrate = positiveInteger("STREAM_VIDEO_BITRATE", quality.videoBitrate);
    const videoMaxBitrate = positiveInteger("STREAM_VIDEO_MAX_BITRATE", quality.videoMaxBitrate);
    if (videoMaxBitrate < videoBitrate) {
      throw new Error("STREAM_VIDEO_MAX_BITRATE must be >= STREAM_VIDEO_BITRATE");
    }

    const config: AppConfig = {
    discord: {
      token,
      guildId,
      channelId,
      viewerToken,
    },
    media: {
      sourceProvider,
      loopSource: booleanValue("STREAM_LOOP", true),
      encoder: encoderKind(),
      height: positiveInteger("STREAM_HEIGHT", quality.height),
      frameRate: positiveInteger("STREAM_FPS", quality.frameRate),
      videoBitrate,
      videoMaxBitrate,
      audioBitrate: positiveInteger("STREAM_AUDIO_BITRATE", quality.audioBitrate),
    },
    retry: {
      baseDelayMs: restartBaseDelayMs,
      maxDelayMs: restartMaxDelayMs,
      stableResetMs: positiveInteger("RETRY_STABLE_RESET_MS", 60_000),
    },
    watchdog: {
      healthLogIntervalMs: positiveInteger("HEALTH_LOG_INTERVAL_MS", 30_000),
      streamStartTimeoutMs: positiveInteger("STREAM_START_TIMEOUT_MS", 20_000),
      voiceJoinTimeoutMs: positiveInteger("VOICE_JOIN_TIMEOUT_MS", 20_000),
      loginTimeoutMs: positiveInteger("LOGIN_TIMEOUT_MS", 30_000),
      rtcReadyTimeoutMs: positiveInteger("RTC_READY_TIMEOUT_MS", 20_000),
      rtcLossTimeoutMs: positiveInteger("RTC_LOSS_TIMEOUT_MS", 15_000),
      mediaStallTimeoutMs: positiveInteger("MEDIA_STALL_TIMEOUT_MS", 60_000),
      runtimeWatchIntervalMs: positiveInteger("RUNTIME_WATCH_INTERVAL_MS", 2_000),
      gatewayReconnectTimeoutMs: positiveInteger("GATEWAY_RECONNECT_TIMEOUT_MS", 30_000),
    },
    };
    configCompleted = true;
    return config;
  } finally {
    if (!configCompleted) sourceProvider.dispose();
  }
}
