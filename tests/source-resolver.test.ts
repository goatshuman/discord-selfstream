import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Encoders, prepareStream, Utils } from "@dank074/discord-video-stream";
import { resolveSourcePlan } from "../src/source-resolver.js";

test("source directory becomes a naturally sorted concat playlist", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "selfstream-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const media = join(root, "media");
  const nested = join(media, "nested");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(media, "10-last.mp4"), "");
  writeFileSync(join(media, "2-first.mp4"), "");
  writeFileSync(join(nested, "ignored.txt"), "");

  const plan = await resolveSourcePlan({
    sourceDirectory: media,
    runtimeDirectory: join(root, "runtime"),
    probeMedia: false,
  });

  assert.equal(plan.sourceCount, 2);
  assert.deepEqual(plan.inputOptions, ["-safe", "0"]);
  const manifest = readFileSync(plan.input, "utf8");
  assert.ok(manifest.indexOf("2-first.mp4") < manifest.indexOf("10-last.mp4"));
  plan.dispose();
  assert.equal(existsSync(plan.input), false);
});

test("directory scan excludes the generated runtime directory", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "selfstream-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = join(root, ".selfstream");
  mkdirSync(join(runtime, "media-cache"), { recursive: true });
  writeFileSync(join(root, "source.mp4"), "");
  writeFileSync(join(runtime, "media-cache", "generated.mkv"), "");

  const plan = await resolveSourcePlan({
    sourceDirectory: root,
    runtimeDirectory: runtime,
    probeMedia: false,
  });
  context.after(() => plan.dispose());

  assert.equal(plan.sourceCount, 1);
  assert.match(plan.input, /source\.mp4$/);
});

test("config file resolves relative sources and quality", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "selfstream-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = join(root, "config.json");
  writeFileSync(join(root, "one.mp4"), "");
  writeFileSync(join(root, "two.mkv"), "");
  writeFileSync(
    configPath,
    JSON.stringify({ sources: ["./one.mp4", "./two.mkv"], quality: "1080p" }),
  );

  const plan = await resolveSourcePlan({
    configFile: configPath,
    runtimeDirectory: join(root, "runtime"),
    probeMedia: false,
  });

  assert.equal(plan.sourceCount, 2);
  assert.equal(plan.quality, "1080p");
  const manifest = readFileSync(plan.input, "utf8");
  assert.match(manifest, /one\.mp4/);
  assert.match(manifest, /two\.mkv/);
  plan.dispose();
  assert.equal(existsSync(plan.input), false);
});

test("multi-source playlists reject remote URLs", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "selfstream-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const local = join(root, "one.mp4");
  writeFileSync(local, "");

  await assert.rejects(
    resolveSourcePlan({
      configFile: writeConfig(root, {
        sources: [local, "https://example.com/two.mp4"],
      }),
      runtimeDirectory: join(root, "runtime"),
      probeMedia: false,
    }),
    /Remote URLs are not supported/,
  );
});

test("playlist sources reject control characters", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "selfstream-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  await assert.rejects(
    resolveSourcePlan({ singleSource: `${root}/bad\nfile.mp4` }),
    /control characters/,
  );
});

test("finite remote files can loop but HLS sources are left open-ended", async () => {
  const mp4 = await resolveSourcePlan({ singleSource: "https://example.com/short.mp4" });
  const hls = await resolveSourcePlan({
    singleSource: "https://example.com/live/stream.m3u8?token=secret",
  });

  assert.equal(mp4.kind, "remote");
  assert.equal(mp4.loopWithFfmpeg, true);
  assert.equal(hls.kind, "remote");
  assert.equal(hls.loopWithFfmpeg, false);
});

function writeConfig(root: string, value: unknown): string {
  const path = join(root, "source-config.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

test("FFmpeg normalizes audio layout changes while transitioning and looping", {
  timeout: 30_000,
}, async (context) => {
  const root = mkdtempSync(join(tmpdir(), "selfstream-ffmpeg-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const media = join(root, "media");
  mkdirSync(media, { recursive: true });

  const fixtures: Array<[string, string, string, string]> = [
    ["one.mp4", "440", "48000", "1"],
    ["two.mp4", "660", "44100", "2"],
    ["three.mp4", "", "", ""],
  ];
  for (const [name, frequency, sampleRate, channels] of fixtures) {
    const args = [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10",
    ];
    if (frequency) {
      args.push("-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=${sampleRate}`);
    }
    args.push(
      "-t", "1",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-g", "10", "-bf", "0",
    );
    if (frequency) args.push("-c:a", "aac", "-b:a", "96k", "-ac", channels);
    args.push("-y", join(media, name));
    execFileSync("ffmpeg", args);
  }

  const plan = await resolveSourcePlan({
    sourceDirectory: media,
    runtimeDirectory: join(root, "runtime"),
  });
  context.after(() => plan.dispose());
  const prepared = prepareStream(plan.input, {
    encoder: Encoders.software({ x264: { preset: "ultrafast" } }),
    height: 240,
    frameRate: 10,
    bitrateVideo: 500,
    bitrateVideoMax: 800,
    bitrateAudio: 96,
    includeAudio: true,
    minimizeLatency: false,
    videoCodec: Utils.normalizeVideoCodec("H264"),
    customInputOptions: [...plan.inputOptions, "-stream_loop", "-1"],
    customFfmpegFlags: ["-t", "11"],
  });
  const timestampErrors: string[] = [];
  prepared.command.on("stderr", (line: string) => {
    if (/non.monoton|invalid dts|timestamp.*error/i.test(line)) timestampErrors.push(line);
  });
  prepared.output.resume();
  await prepared.promise;

  assert.equal(plan.kind, "playlist");
  assert.equal(plan.sourceCount, 3);
  assert.deepEqual(timestampErrors, []);
});
