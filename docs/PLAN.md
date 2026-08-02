# SelfStream implementation plan

## Goal

Keep one user account connected to a configured voice channel and continuously
publish a single video/audio source or local playlist through Discord Go Live. Recover automatically
from media completion, FFmpeg failure, RTC loss, Gateway reconnects, and process
restarts. Optionally keep a second user account connected as a DAVE/RTC viewer
without coupling viewer failures to broadcast recovery.

## Chosen baseline

- Node.js 22 and TypeScript.
- `discord.js-selfbot-v13` for the user Gateway session.
- `@dank074/discord-video-stream` 6.x for voice/stream signaling, WebRTC,
  RTP/RTX, codec negotiation, and DAVE E2EE.
- FFmpeg for decoding and transcoding to H.264 plus Opus.
- Environment variables for secrets and deployment-specific settings.

The streaming library is isolated behind `StreamController`. This gives us a
single replacement boundary if Discord changes the protocol or the dependency
stops being maintained.

`StreamViewer` owns the optional second Gateway, voice, and watched-stream RTC
connections. It joins with its own token, sends Gateway opcode 20 for the
broadcaster's stream key, requests remote layers with voice opcode 15, and
retries independently for the lifetime of each broadcast attempt. It maintains
viewer presence and requests media delivery without decoding or persisting
received frames.

## Runtime state machine

```text
IDLE -> AUTHENTICATING -> JOINING_VOICE -> PREPARING_MEDIA -> STREAMING
                            ^                                  |
                            |                                  v
                            +------------- BACKOFF <-----------+
STOPPING ------------------------------------------------> STOPPED
```

Only one streaming attempt may exist at a time. Every failure tears down media
and RTC resources before a retry. Retry delay uses capped exponential backoff
with jitter. A successful streaming period resets the failure count.

## Milestones

### M0 - Feasibility spike

- Validate Node/native dependencies and FFmpeg `libzmq` support.
- Login, join a fixed voice channel, and stream a fixed local MP4 or direct URL.
- Confirm video and stream audio from a second Discord client for at least 30
  minutes.

Exit criterion: visible, audible Go Live stream on a test account.

### M1 - Continuous playback

- Loop finite local media inside FFmpeg so EOF does not recreate the RTC stream.
- Restart the media pipeline when an unlooped source reaches EOF.
- Require both `STREAM_CREATE` and `STREAM_SERVER_UPDATE` before reporting the
  stream as healthy; time out and retry when the upstream library silently hangs.
- Add bounded exponential retry for FFmpeg, RTC, and Gateway failures.
- Add graceful shutdown and structured status logs.
- Prevent overlapping FFmpeg/stream attempts.

Exit criterion: a short test file loops for 6 hours without duplicate streams
or orphan FFmpeg processes.

### M2 - 24/7 recovery

- Detect stalled media, not only exited processes.
- Watch the active account's `VOICE_STATE_UPDATE`; when it is disconnected,
  kicked, or moved elsewhere, abort the current media attempt and rejoin the
  configured channel after backoff.
- Rejoin voice and recreate Go Live after invalid sessions or Stream Delete.
- React to stream-server failover and Gateway reconnect events.
- Add an external process supervisor and restart-on-boot configuration.

Exit criterion: recovery from network interruption, killed FFmpeg, killed Node,
and Discord voice reconnect, followed by a 24-hour soak test.

### M3 - Operations

- Health endpoint or heartbeat file for external monitoring.
- Metrics: uptime, retry count, current source, last frame/progress timestamp.
- Remote control authenticated separately from Discord messages.

Exit criterion: observable 72-hour soak test with documented failure history.

## Recovery policy

| Failure | First response | Escalation |
| --- | --- | --- |
| Source EOF | Loop finite local input in FFmpeg | Backoff/recreate an unlooped source |
| FFmpeg error | Recreate media pipeline | Increase capped backoff |
| Stream RTC closes | Recreate Go Live | Rejoin parent voice session |
| Voice session invalid | Leave and join voice again | Exit on invalidated Gateway session |
| Gateway disconnect | Allow library resume | Exit after deadline for external supervisor restart |
| Process crash | External supervisor restart | Alert after crash-loop threshold |

## Initial quality profile

Start conservatively at H.264, 720p30, 2.5 Mbps average / 4 Mbps maximum, and
Opus 128 kbps. Raise quality only after the recovery path passes its soak tests.

## Known risks

- The Discord user API and stream behavior are unofficial and can change without
  compatibility notice.
- DAVE/voice changes are the largest protocol-compatibility risk after March
  2026; pinning and explicit upgrade tests are required.
- Native Node dependencies make container and OS upgrades non-trivial.
- The initial dependency audit reports high-severity advisories in transitive
  WebRTC/image dependencies. Do not apply the suggested forced downgrade to 5.x;
  assess and upgrade the affected dependencies when compatible releases exist.
- A valid login does not prove that RTC media is flowing. Viewer-side validation
  or media-progress telemetry is required for a meaningful health check.
