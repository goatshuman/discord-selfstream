export function abortReason(signal: AbortSignal, fallback = "Operation aborted"): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(String(signal.reason ?? fallback));
}

export function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
  label: string,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortReason(signal)));
    const timer = setTimeout(
      () => finish(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`))),
      timeoutMs,
    );

    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
    // AbortSignal does not replay an abort to listeners registered after it.
    // Recheck after registration to close the check/listen race.
    if (signal.aborted) onAbort();
  });
}

export function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

export function waitUntil(
  predicate: () => boolean,
  options: {
    intervalMs: number;
    timeoutMs: number;
    signal: AbortSignal;
    label: string;
  },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearInterval(interval);
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => fail(abortReason(options.signal));
    const check = () => {
      if (settled || !predicate()) return;
      settled = true;
      cleanup();
      resolve();
    };
    const interval = setInterval(check, options.intervalMs);
    const timeout = setTimeout(
      () => fail(new Error(`${options.label} timed out after ${options.timeoutMs}ms`)),
      options.timeoutMs,
    );
    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) onAbort();
    else check();
  });
}
