import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const runFile = promisify(execFile);

const MEDIA_EXTENSIONS = new Set([
  ".avi",
  ".m2ts",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp4",
  ".mpeg",
  ".mpg",
  ".ts",
  ".webm",
]);
// Bump this whenever the intermediate container or normalization invariants
// change. The version is part of the cache key, so old outputs cannot be reused.
const PLAYLIST_CACHE_VERSION = "audio-v2-opus-48k-stereo-aligned";

type SourceFileConfig = {
  source?: string;
  sources?: string[];
  sourceDirectory?: string;
  shuffle?: boolean;
  quality?: string;
};

export type SourcePlan = {
  kind: "local" | "remote" | "playlist";
  input: string;
  inputOptions: string[];
  loopWithFfmpeg: boolean;
  sourceCount: number;
  description: string;
  quality?: string;
  dispose(): void;
};

export type ResolveSourceOptions = {
  singleSource?: string;
  sourceDirectory?: string;
  configFile?: string;
  shuffleOverride?: boolean;
  runtimeDirectory?: string;
  probeMedia?: boolean;
};

function isRemoteSource(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

function isHlsSource(source: string): boolean {
  if (!isRemoteSource(source)) return false;
  try {
    return new URL(source).pathname.toLowerCase().endsWith(".m3u8");
  } catch {
    return false;
  }
}

function assertSafeSourceText(source: string): void {
  if (/[\u0000-\u001f\u007f]/u.test(source)) {
    throw new Error("Media sources cannot contain control characters");
  }
}

function normalizeSource(source: string, baseDirectory: string): string {
  const trimmed = source.trim();
  if (!trimmed) throw new Error("Media source cannot be empty");
  assertSafeSourceText(trimmed);
  if (isRemoteSource(trimmed) || isAbsolute(trimmed)) return trimmed;
  return resolve(baseDirectory, trimmed);
}

function validateLocalFile(path: string): void {
  if (!existsSync(path)) throw new Error(`Media file does not exist: ${path}`);
  if (!statSync(path).isFile()) throw new Error(`Media source is not a regular file: ${path}`);
}

type ProbeStream = {
  codec_type?: unknown;
  codec_name?: unknown;
  width?: unknown;
  height?: unknown;
  pix_fmt?: unknown;
  profile?: unknown;
  level?: unknown;
  avg_frame_rate?: unknown;
  time_base?: unknown;
  extradata_size?: unknown;
  extradata?: unknown;
};

type ProbeResult = { streams?: ProbeStream[] };

type MediaShape = {
  videoFingerprint: string;
  hasAudio: boolean;
};

async function probeMediaShape(path: string, signal?: AbortSignal): Promise<MediaShape> {
  let result: ProbeResult;
  try {
    result = JSON.parse(
      (await runFile(
        "ffprobe",
        [
          "-v", "error",
          "-show_data",
          "-show_entries",
          "stream=codec_type,codec_name,width,height,pix_fmt,profile,level,avg_frame_rate,time_base,extradata_size,extradata",
          "-of", "json",
          path,
        ],
        { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, signal },
      )).stdout,
    ) as ProbeResult;
  } catch (error) {
    throw new Error(`ffprobe failed for ${path}: ${String(error)}`);
  }
  const streams = result.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  if (!video || typeof video.codec_name !== "string") {
    throw new Error(`Media file has no video stream: ${path}`);
  }
  return {
    videoFingerprint: JSON.stringify(video),
    hasAudio: streams.some((stream) => stream.codec_type === "audio"),
  };
}

async function normalizePlaylistSources(
  sources: string[],
  cacheDirectory: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const shapes: MediaShape[] = [];
  // Probe sequentially: directories can contain hundreds of files, and
  // launching one ffprobe process per file at once can exhaust Windows handles.
  for (const source of sources) shapes.push(await probeMediaShape(source, signal));
  const expected = shapes[0]!;
  for (let index = 1; index < sources.length; index += 1) {
    const shape = shapes[index]!;
    if (shape.videoFingerprint !== expected.videoFingerprint) {
      throw new Error(
        `Playlist source has incompatible video parameters with ${sources[0]}: ${sources[index]}`,
      );
    }
  }

  mkdirSync(cacheDirectory, { recursive: true });
  const normalized: string[] = [];
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index]!;
    signal?.throwIfAborted();
    const metadata = statSync(source);
    const cacheKey = createHash("sha256")
      .update(`${PLAYLIST_CACHE_VERSION}\0${source}\0${metadata.size}\0${metadata.mtimeMs}`)
      .digest("hex")
      .slice(0, 24);
    const output = join(cacheDirectory, `${cacheKey}.mkv`);
    if (existsSync(output) && statSync(output).size > 0) {
      try {
        const cachedShape = await probeMediaShape(output, signal);
        if (!cachedShape.hasAudio) throw new Error("normalized cache has no audio stream");
        normalized.push(output);
        continue;
      } catch {
        rmSync(output, { force: true });
      }
    }

    const temporary = `${output}.${process.pid}-${randomUUID()}.tmp.mkv`;
    // Concat demuxing is timestamp-sensitive. Copy video only after proving all
    // video parameters match; normalize every audio track to Opus/48k/stereo,
    // pad it to video duration, and publish the cache file atomically.
    const args = [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-i", source,
    ];
    if (!shapes[index]!.hasAudio) {
      args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
    }
    args.push(
      "-map", "0:v:0",
      "-c:v", "copy",
      "-map", shapes[index]!.hasAudio ? "0:a:0" : "1:a:0",
      "-c:a", "libopus",
      "-b:a", "192k",
      "-ar", "48000",
      "-ac", "2",
      // Preserve a real initial A/V offset. Resetting only audio to PTS zero is
      // what previously caused audio to run ahead of delayed video.
      "-af", "aresample=48000:async=1,apad",
      "-shortest",
      "-copyts",
      "-start_at_zero",
    );
    args.push(
      "-fflags", "+genpts",
      "-y", temporary,
    );

    try {
      await runFile("ffmpeg", args, {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        signal,
      });
      const after = statSync(source);
      if (after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs) {
        throw new Error("source changed while normalization was running");
      }
      try {
        renameSync(temporary, output);
      } catch (error) {
        // Another process may have atomically published the same cache key.
        // Accept its completed output instead of failing this stream attempt.
        if (!existsSync(output) || statSync(output).size === 0) throw error;
        const winnerShape = await probeMediaShape(output, signal);
        if (!winnerShape.hasAudio) throw error;
        rmSync(temporary, { force: true });
      }
    } catch (error) {
      rmSync(temporary, { force: true });
      throw new Error(`Failed to normalize playlist source ${source}: ${String(error)}`);
    }
    normalized.push(output);
  }
  return normalized;
}

function scanDirectory(directory: string, excludedDirectory: string): string[] {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new Error(`Source directory does not exist: ${directory}`);
  }

  const files: string[] = [];
  const excluded = resolve(excludedDirectory).toLowerCase();
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      // A source directory may be the project root. Never ingest our generated
      // cache/manifests on a later retry, or the playlist grows recursively.
      if (entry.isDirectory() && resolve(path).toLowerCase() !== excluded) visit(path);
      else if (entry.isFile() && MEDIA_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        files.push(path);
      }
    }
  };
  visit(directory);
  return files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function shuffle<T>(values: T[]): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [result[index], result[target]] = [result[target]!, result[index]!];
  }
  return result;
}

function escapeConcatSource(source: string): string {
  const normalized = isRemoteSource(source) ? source : source.replaceAll("\\", "/");
  return normalized.replaceAll("'", "'\\''");
}

function readFileConfig(path: string): SourceFileConfig {
  if (!existsSync(path)) throw new Error(`Config file does not exist: ${path}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse source config ${path}: ${String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Source config must contain a JSON object");
  }
  const config = parsed as Record<string, unknown>;
  for (const field of ["source", "sourceDirectory", "quality"] as const) {
    if (config[field] !== undefined && typeof config[field] !== "string") {
      throw new Error(`${field} in source config must be a string`);
    }
  }
  if (
    config.sources !== undefined &&
    (!Array.isArray(config.sources) || config.sources.some((source) => typeof source !== "string"))
  ) {
    throw new Error("sources in source config must be an array of strings");
  }
  if (config.shuffle !== undefined && typeof config.shuffle !== "boolean") {
    throw new Error("shuffle in source config must be true or false");
  }
  return config as SourceFileConfig;
}

export async function resolveSourcePlan(
  options: ResolveSourceOptions,
  signal?: AbortSignal,
): Promise<SourcePlan> {
  const workingDirectory = process.cwd();
  const runtimeDirectory = resolve(
    workingDirectory,
    options.runtimeDirectory ?? ".selfstream",
  );
  const configPath = options.configFile
    ? resolve(workingDirectory, options.configFile)
    : undefined;
  const fileConfig = configPath ? readFileConfig(configPath) : undefined;
  const configBase = configPath ? dirname(configPath) : workingDirectory;

  if (configPath && (options.singleSource || options.sourceDirectory)) {
    throw new Error(
      "Use STREAM_CONFIG_FILE by itself; do not combine it with STREAM_SOURCE or STREAM_SOURCE_DIR",
    );
  }
  if (options.singleSource && options.sourceDirectory) {
    throw new Error("Use only one of STREAM_SOURCE or STREAM_SOURCE_DIR");
  }

  const configuredKinds = [
    fileConfig?.source,
    fileConfig?.sourceDirectory,
    fileConfig?.sources?.length ? fileConfig.sources : undefined,
  ].filter(Boolean).length;
  if (!options.singleSource && !options.sourceDirectory && configuredKinds > 1) {
    throw new Error("config.json must use only one of source, sourceDirectory, or sources");
  }

  let sources: string[];
  if (options.sourceDirectory) {
    sources = scanDirectory(resolve(workingDirectory, options.sourceDirectory), runtimeDirectory);
  } else if (options.singleSource) {
    sources = [normalizeSource(options.singleSource, workingDirectory)];
  } else if (fileConfig?.sourceDirectory) {
    sources = scanDirectory(
      normalizeSource(fileConfig.sourceDirectory, configBase),
      runtimeDirectory,
    );
  } else if (fileConfig?.sources?.length) {
    sources = fileConfig.sources.map((source) => normalizeSource(source, configBase));
  } else if (fileConfig?.source) {
    sources = [normalizeSource(fileConfig.source, configBase)];
  } else {
    throw new Error(
      "Configure STREAM_SOURCE, STREAM_SOURCE_DIR, or STREAM_CONFIG_FILE with media sources",
    );
  }

  if (sources.length === 0) throw new Error("No supported media files were found");
  for (const source of sources) {
    assertSafeSourceText(source);
    if (!isRemoteSource(source)) validateLocalFile(source);
  }
  const shouldShuffle = options.shuffleOverride ?? fileConfig?.shuffle ?? false;
  if (shouldShuffle) sources = shuffle(sources);

  if (sources.length === 1) {
    const remote = isRemoteSource(sources[0]!);
    return {
      kind: remote ? "remote" : "local",
      input: sources[0]!,
      inputOptions: [],
      // Finite remote files can be shorter than Discord's RTC startup. Looping
      // them at the input keeps FFmpeg alive; HLS/live manifests stay open on
      // their own and must not be rewound with -stream_loop.
      loopWithFfmpeg: !remote || !isHlsSource(sources[0]!),
      sourceCount: 1,
      description: remote ? "remote source" : basename(sources[0]!),
      quality: fileConfig?.quality,
      dispose() {},
    };
  }

  if (sources.some(isRemoteSource)) {
    throw new Error(
      "Remote URLs are not supported in multi-source playlists; download them locally first",
    );
  }
  mkdirSync(runtimeDirectory, { recursive: true });
  if (options.probeMedia !== false) {
    sources = await normalizePlaylistSources(
      sources,
      join(runtimeDirectory, "media-cache"),
      signal,
    );
  }
  const manifestId = `${process.pid}-${randomUUID()}`;
  const manifestPath = join(runtimeDirectory, `playlist-${manifestId}.ffconcat`);
  const temporaryPath = `${manifestPath}.tmp`;
  const manifest = [
    "ffconcat version 1.0",
    ...sources.map((source) => `file '${escapeConcatSource(source)}'`),
    "",
  ].join("\n");
  writeFileSync(temporaryPath, manifest, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporaryPath, manifestPath);

  return {
    kind: "playlist",
    input: manifestPath,
    inputOptions: ["-safe", "0"],
    loopWithFfmpeg: true,
    sourceCount: sources.length,
    description: `playlist (${sources.length} sources)`,
    quality: fileConfig?.quality,
    // The caller owns this unique manifest and must dispose it exactly once.
    // Cache MKVs are shared and intentionally survive attempt teardown.
    dispose() {
      // Cleanup must never mask the streaming error which triggered it.
      try { rmSync(temporaryPath, { force: true }); } catch {}
      try { rmSync(manifestPath, { force: true }); } catch {}
    },
  };
}
