import { abortReason } from "./async-utils.js";
import { logger } from "./logger.js";

type StreamPacket = {
  t?: string;
  d?: Record<string, unknown>;
};

export type RawEventSource = {
  on(event: "raw", listener: (packet: StreamPacket) => void): unknown;
  off(event: "raw", listener: (packet: StreamPacket) => void): unknown;
};

export class StreamEventTracker {
  readonly ready: Promise<void>;
  readonly failure: Promise<never>;

  private hasCreate = false;
  private initialEndpoint?: string;
  private initialToken?: string;
  private active = false;
  private disposed = false;
  private readySettled = false;
  private failReady!: (error: Error) => void;
  private markReady!: () => void;
  private failRuntime!: (error: Error) => void;
  private readonly timeout: NodeJS.Timeout;

  constructor(
    private readonly client: RawEventSource,
    private readonly expectedKey: string,
    timeoutMs: number,
    private readonly signal: AbortSignal,
  ) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.markReady = () => {
        if (this.readySettled) return;
        this.readySettled = true;
        // Readiness pins the endpoint/token immediately. There must be no gap
        // in failover detection while the caller is still waiting for RTC.
        this.active = true;
        clearTimeout(this.timeout);
        resolve();
      };
      this.failReady = (error) => {
        if (this.readySettled) return;
        this.readySettled = true;
        clearTimeout(this.timeout);
        reject(error);
      };
    });
    this.failure = new Promise<never>((_, reject) => {
      this.failRuntime = reject;
    });
    // Failure can arrive just before StreamController enters its runtime race.
    // Attach a sink now; consumers still observe the same rejected promise.
    this.failure.catch(() => {});

    this.timeout = setTimeout(() => {
      this.failReady(
        new Error(
          `Discord did not confirm Go Live within ${timeoutMs}ms ` +
          `(STREAM_CREATE=${this.hasCreate}, STREAM_SERVER_UPDATE=${Boolean(this.initialEndpoint)})`,
        ),
      );
      this.dispose();
    }, timeoutMs);
    this.client.on("raw", this.onPacket);
    this.signal.addEventListener("abort", this.onAbort, { once: true });
    // An already-aborted signal will not invoke a newly attached listener.
    if (this.signal.aborted) this.onAbort();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timeout);
    this.client.off("raw", this.onPacket);
    this.signal.removeEventListener("abort", this.onAbort);
  }

  private readonly onAbort = () => {
    const error = abortReason(this.signal, "Stream tracking aborted");
    this.failReady(error);
    this.failRuntime(error);
    this.dispose();
  };

  private readonly onPacket = (packet: StreamPacket) => {
    if (!packet.t?.startsWith("STREAM_")) return;
    const streamKey = typeof packet.d?.stream_key === "string"
      ? packet.d.stream_key
      : undefined;
    if (streamKey !== this.expectedKey) return;

    if (packet.t === "STREAM_CREATE") {
      this.hasCreate = true;
      logger.info("Gateway STREAM_CREATE received", {
        streamKey,
        rtcServerId: packet.d?.rtc_server_id,
      });
    } else if (packet.t === "STREAM_SERVER_UPDATE") {
      const endpoint = typeof packet.d?.endpoint === "string"
        ? packet.d.endpoint
        : undefined;
      const token = typeof packet.d?.token === "string" ? packet.d.token : undefined;
      logger.info("Gateway STREAM_SERVER_UPDATE received", {
        streamKey,
        endpoint,
      });

      if (!this.initialEndpoint && endpoint) {
        this.initialEndpoint = endpoint;
        this.initialToken = token;
      } else if (
        this.active &&
        (endpoint !== this.initialEndpoint || token !== this.initialToken)
      ) {
        // Identical updates are normal Gateway replays. A changed tuple points
        // at a different RTC server, so this media connection is stale.
        this.failRuntime(
          new Error("Discord changed the active stream server; recreating the RTC stream"),
        );
        this.dispose();
        return;
      }
    } else if (packet.t === "STREAM_DELETE") {
      const error = new Error(
        `Discord deleted stream: ${String(packet.d?.reason ?? "unknown")}`,
      );
      this.failReady(error);
      this.failRuntime(error);
      this.dispose();
      return;
    }

    if (this.hasCreate && this.initialEndpoint) this.markReady();
  };
}
