import type { StatusEvent } from "./contract";

export interface BackendSenderOptions {
  backendUrl: string;
  accountToken: string;
  /** Injectable for tests; defaults to global fetch (Node 20+). */
  fetchFn?: typeof fetch;
  /** Injectable for tests; defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Number of retries on transient (5xx / network) failures. Default 4. */
  maxRetries?: number;
  /** Base backoff in ms (doubled each retry). Default 500. */
  baseBackoffMs?: number;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

export class BackendSender {
  private readonly backendUrl: string;
  private readonly accountToken: string;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;

  constructor(opts: BackendSenderOptions) {
    this.backendUrl = opts.backendUrl.replace(/\/+$/, "");
    this.accountToken = opts.accountToken;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxRetries = opts.maxRetries ?? 4;
    this.baseBackoffMs = opts.baseBackoffMs ?? 500;
  }

  /** State-change event: the backend upserts it and fans out pushes. */
  sendEvent(event: StatusEvent): Promise<void> {
    return this.post(event);
  }

  /** "Still alive, nothing changed": refreshes server-side liveness only. */
  sendHeartbeat(event: StatusEvent): Promise<void> {
    return this.post({ ...event, heartbeat: true });
  }

  /** Emitter keepalive that works even when there are no sessions. */
  sendPing(): Promise<void> {
    return this.post({ ping: true });
  }

  private async post(body: object): Promise<void> {
    const url = `${this.backendUrl}/events`;
    let attempt = 0;
    // total tries = 1 + maxRetries
    while (true) {
      let res: Response | null = null;
      let networkError: unknown = null;
      try {
        res = await this.fetchFn(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.accountToken}`,
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        networkError = err;
      }

      if (res && res.ok) return;

      // 4xx (other than 429) are caller errors — do not retry.
      if (res && res.status >= 400 && res.status < 500 && res.status !== 429) {
        throw new Error(`backend rejected event (${res.status})`);
      }

      if (attempt >= this.maxRetries) {
        if (networkError) throw networkError;
        throw new Error(
          `backend send failed after retries (${res?.status ?? "network"})`,
        );
      }
      await this.sleep(this.baseBackoffMs * 2 ** attempt);
      attempt += 1;
    }
  }
}
