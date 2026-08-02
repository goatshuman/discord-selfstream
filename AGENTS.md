# SelfStream contributor guide

These instructions apply to the entire repository. SelfStream automates an
unofficial Discord user session, so preserve the caution notice at the top of
`README.md` and never weaken token/logging safeguards.

## Required checks

- Use Node.js 22.x (22.4+) and FFmpeg/FFprobe with H.264, Opus, and libzmq
  support. Do not claim support for a newer Node major without voice/RTC tests.
- Install reproducibly with `npm ci` when validating a clean checkout.
- Run `npm run check` after code changes. It typechecks source and tests, runs
  all tests, and builds `dist`.
- Tests must use temporary directories and generated media. Never connect to a
  real Discord account in an automated test.

## Architecture and ownership

- `StreamController` owns the Discord client, one `Streamer`, retry policy, and
  exactly one active attempt. Keep protocol details in focused helpers rather
  than growing the controller.
- Every attempt owns an `AbortController`, `StreamEventTracker`, FFmpeg process,
  voice/stream connection, and `SourcePlan`. Abort and dispose them on every
  exit path.
- `StreamViewer` owns the optional second Discord client and its voice/watch
  RTC connections. Viewer retries must never restart a healthy broadcaster;
  do not report it connected before both RTCs are ready and Media Sink Wants
  has been sent.
- `joinVoice()` is not cancelled by a wrapper timeout. Preserve the generation
  check that stops the exact late connection; never use a late callback to tear
  down the controller's current global connection.
- A retry counter resets only after `RETRY_STABLE_RESET_MS` of healthy streaming.
- `SourcePlan.dispose()` owns only its unique manifest. Normalized cache files
  are shared across attempts and processes and must not be deleted per attempt.
- Do not run synchronous FFmpeg/FFprobe subprocesses after Discord login. Use
  argument-array `execFile`/`spawn`, pass the attempt signal, and avoid shell
  command construction.

## Media pipeline invariants

- Multi-source playlists are local-only. A single HTTP/HLS source remains
  supported through the upstream library.
- The FFconcat demuxer requires identical video parameters. `source-resolver`
  fingerprints codec/profile/level/geometry/pixel format/frame rate/time base
  and codec extradata; do not loosen this without a production-pipeline test.
- Playlist video is copied into the cache. Audio is normalized to Opus, 48 kHz,
  stereo, padded to video duration, and given aligned timestamps. Video-only
  clips receive silence.
- Increment `PLAYLIST_CACHE_VERSION` whenever cache container, codecs, filters,
  timestamp handling, or compatibility rules change.
- Keep `-stream_loop -1` as an input option after concat options and before the
  input. It applies to local/finite HTTP media, but not HLS manifests. Do not
  move it to output flags.
- Do not enable FFmpeg `nobuffer/analyzeduration=0` for local playlists. Those
  options are reserved for remote/live inputs.
- A media regression test must cross several complete seams/loops using
  `prepareStream`, drain its NUT output, and fail on non-monotonic timestamps.

## Reliability and security

- Abort listeners must handle signals that were already aborted when attached;
  `AbortSignal` does not replay events.
- STREAM events are tracked by one `StreamEventTracker`. Identical server
  updates are Gateway replays; a changed endpoint/token invalidates the RTC
  attempt from the moment Gateway readiness is confirmed.
- Voice kick/move events must restart attempts during join, preparation, and
  active streaming.
- Never log Discord tokens, Authorization/Cookie headers, signed URLs, URL query
  strings, or raw config contents. Redact FFmpeg diagnostics before logging.
- Never delete user media. Destructive cleanup must be limited to a resolved,
  validated `.selfstream` runtime path. Cache retention/GC must be safe across
  concurrent processes.

## Configuration and documentation

- Keep the normal `.env.example` minimal: Discord identity, exactly one source
  mode, and quality. Advanced defaults belong in README, not the example env.
- Source precedence and path semantics live in `source-resolver.ts`; JSON paths
  are relative to the JSON file. `config.json` is auto-detected only when no
  source env variable is set.
- When behavior changes, update `README.md`, `.env.example`,
  `config.example.json`, and `docs/PLAN.md` where applicable.
- Preserve open-source credits. Before publishing or redistributing, review the
  license obligations of direct and bundled/transitive dependencies.

## Review expectations

- Add comments for non-obvious reasons and invariants, not line-by-line syntax.
- Add regression tests for cancellation races, listener/timer cleanup, cache
  hit/invalidation/concurrency, playlist boundaries, and reconnect behavior.
- This workspace may not be a Git repository. Preserve unrelated user files and
  do not assume `git diff` or destructive Git recovery is available.
