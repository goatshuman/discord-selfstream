# SelfStream

> [!CAUTION]
> Automating a Discord user account can result in the account being permanently
> banned. Use this project at your own risk.

> [!NOTE]
> This project was vibe-coded with AI assistance. Review and test the code
> carefully before relying on it for long-running or production use.

Supervisor for a long-running Discord Go Live stream. It supports one account
and voice channel with either a single source or a looping local playlist. An
optional second account can join the channel and maintain a real RTC viewer
session that requests the stream's media layers. See
[docs/PLAN.md](docs/PLAN.md) for architecture and recovery policy.

## Prerequisites

- Node.js 22.x (22.4 or newer; other major versions are not tested)
- FFmpeg with `libzmq`, H.264, and Opus support
- A Discord user token, guild ID, and voice channel ID
- A local media file or direct media URL

## Local setup

### 1. Clone the repository

```sh
git clone https://github.com/baoayano2/discord-selfstream.git
```

### 2. Open the project directory

```sh
cd discord-selfstream
```

### 3. Install dependencies

```sh
npm install
```

### 4. Create the environment file

Windows PowerShell or Command Prompt:

```powershell
copy .env.example .env
```

Linux or macOS:

```sh
cp .env.example .env
```

### 5. Configure Discord and the media source

Open `.env` and fill in the account/channel values and exactly one source mode:

```dotenv
DISCORD_TOKEN=
DISCORD_GUILD_ID=
DISCORD_CHANNEL_ID=

# Choose ONE:
STREAM_SOURCE=E:/path/to/video.mp4
# STREAM_SOURCE_DIR=E:/path/to/media-folder
# STREAM_CONFIG_FILE=config.json

STREAM_QUALITY=720p
```

Never commit `.env` or the user token.

To enable the optional viewer account, add a different user token:

```dotenv
VIEWER_TOKEN=
```

The viewer account must already be a member of the server and have permission
to view and connect to the configured voice channel. It joins the channel
itself, so `MOVE_MEMBERS` is not required. SelfStream sends Discord's Stream
Watch request and establishes the separate DAVE/WebRTC stream connection; it
sends Media Sink Wants to request the remote stream layers, but does not decode,
render, or record received frames. Viewer health therefore confirms signaling
and RTC connectivity, not decoded video output. Viewer login and RTC failures
retry independently and do not restart a healthy broadcast. Never reuse
`DISCORD_TOKEN` as `VIEWER_TOKEN`.

Quality can be `480p`, `720p`, or `1080p`. The default is `720p`. With
`STREAM_LOOP=true`, local files and finite HTTP media such as MP4 loop inside
FFmpeg. HLS/live sources stay open and use their normal reconnect behavior.

### 6. Start SelfStream

```sh
npm run dev
```

### Multiple sources

`STREAM_SOURCE_DIR` recursively scans a directory for common video formats,
sorts filenames naturally, and streams them as one looping playlist:

```dotenv
STREAM_SOURCE_DIR=E:/media/my-playlist
```

Alternatively, copy `config.example.json` to the ignored `config.json` and set:

```dotenv
STREAM_CONFIG_FILE=config.json
```

If neither source environment variable is set, an existing `config.json` in the
working directory is detected automatically.

The JSON format supports either `source`, `sourceDirectory`, or `sources`:

```json
{
  "sources": [
    "./media/01-intro.mp4",
    "./media/02-main.mp4",
    "./media/03-outro.mp4"
  ],
  "shuffle": false,
  "quality": "720p"
}
```

Paths in JSON are resolved relative to that JSON file. Set `shuffle` to `true`
to randomize order on process start. For the most reliable seamless transition,
playlist files must have matching video codec parameters, geometry, pixel
format, frame rate, time base, and codec initialization data. Local files are
preflighted asynchronously with `ffprobe`; their audio is cached in
`.selfstream/media-cache` as 48 kHz stereo with aligned timestamps. Video-only
clips receive silence. The video stream is copied without re-encoding, and cache
entries are reused until the source changes. Stop SelfStream before manually
removing old cache entries. Remote URLs are supported only as a single source;
download remote media locally before adding it to a multi-source playlist.

## Diagnostic source

To rule out HTTP/range-request problems, set the source to the generated local
test card:

```dotenv
STREAM_SOURCE=./assets/diagnostic-15s.mp4
STREAM_QUALITY=720p
```

`STREAM_LOOP=true` loops finite local files inside FFmpeg. This preserves the
same Discord Go Live/RTC session at the loop boundary. HTTP sources use the
library's reconnect-at-EOF behavior instead; live HLS sources naturally remain
open.

The supervisor reports `streaming` only after Discord returns both
`STREAM_CREATE` and `STREAM_SERVER_UPDATE`. If neither arrives within 20 seconds,
the attempt is torn down and retried automatically.

While streaming, the supervisor also watches its own `VOICE_STATE_UPDATE`.
Being disconnected, kicked, or moved to another channel aborts the current
FFmpeg/RTC attempt; the normal capped-backoff loop then rejoins the configured
channel and recreates Go Live.

Voice join, Gateway stream creation, and WebRTC readiness each have independent
timeouts. Once live, the supervisor keeps an attempt-scoped listener for stream
deletion/server failover and checks WebRTC state plus FFmpeg progress for stalls.

## Advanced overrides

Operational defaults do not need to be copied into `.env`. If necessary, they
can still be overridden with `STREAM_LOOP`, `STREAM_ENCODER`, `STREAM_HEIGHT`,
`STREAM_FPS`, `STREAM_VIDEO_BITRATE`, `STREAM_VIDEO_MAX_BITRATE`,
`STREAM_AUDIO_BITRATE`, `RESTART_BASE_DELAY_MS`, `RESTART_MAX_DELAY_MS`,
`RETRY_STABLE_RESET_MS`, `HEALTH_LOG_INTERVAL_MS`, `STREAM_START_TIMEOUT_MS`,
`VOICE_JOIN_TIMEOUT_MS`, `LOGIN_TIMEOUT_MS`, `RTC_READY_TIMEOUT_MS`,
`RTC_LOSS_TIMEOUT_MS`, `MEDIA_STALL_TIMEOUT_MS`, `RUNTIME_WATCH_INTERVAL_MS`,
and `GATEWAY_RECONNECT_TIMEOUT_MS`. `STREAM_SHUFFLE` can override the JSON
shuffle setting.

## Credits

SelfStream builds on the work of these open-source projects and their
contributors:

- [Discord-video-stream](https://github.com/Discord-RE/Discord-video-stream) by
  [dank074](https://github.com/dank074) and the Discord-RE contributors: Go
  Live, voice/WebRTC, RTP/RTX, media packetization, and DAVE integration. It is
  based on the earlier
  [Discord-video-experiment](https://github.com/aiko-chan-ai/Discord-video-experiment)
  project. Licensed under ISC.
- [discord.js-selfbot-v13](https://github.com/aiko-chan-ai/discord.js-selfbot-v13)
  by [aiko-chan-ai](https://github.com/aiko-chan-ai) and contributors: Discord
  user Gateway client. Licensed under GPL-3.0.
- [Davey](https://github.com/Snazzah/davey) by
  [Snazzah](https://github.com/Snazzah): Discord DAVE end-to-end media
  encryption support. Licensed under MIT.
- [FFmpeg](https://ffmpeg.org/) and its contributors: media decoding,
  transcoding, filtering, and Opus/H.264 output.
- [dotenv](https://github.com/motdotla/dotenv) and its contributors: local
  environment configuration loading. Licensed under BSD-2-Clause.

Thank you to every maintainer and contributor whose work makes this project
possible.
