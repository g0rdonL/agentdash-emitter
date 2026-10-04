import { describe, expect, it, vi } from "vitest";
import { BackendSender } from "./sender";
import type { StatusEvent } from "./contract";

const event: StatusEvent = {
  sessionId: "s1",
  status: "waiting",
  projectLabel: "widget",
  updatedAt: 5,
};

describe("BackendSender", () => {
  it("POSTs to {backendUrl}/events with bearer auth and JSON body", async () => {
    const fetchMock = vi.fn(
      () => ({ ok: true, status: 200 } as Response),
    );
    const sender = new BackendSender({
      backendUrl: "https://api.example.com",
      accountToken: "secret",
      fetchFn: fetchMock as unknown as typeof fetch,
      sleep: async () => {},
    });
    await sender.sendEvent(event);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.example.com/events");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer secret",
    );
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect(JSON.parse(init.body as string)).toEqual(event);
  });

  it("retries on a 500 then succeeds, with backoff", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response);
    const sleep = vi.fn(async () => {});
    const sender = new BackendSender({
      backendUrl: "https://api.example.com",
      accountToken: "secret",
      fetchFn: fetchMock as unknown as typeof fetch,
      sleep,
      maxRetries: 3,
    });
    await sender.sendEvent(event);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on a 4xx (caller error) and throws", async () => {
    const fetchMock = vi.fn(
      () => ({ ok: false, status: 400 } as Response),
    );
    const sender = new BackendSender({
      backendUrl: "https://api.example.com",
      accountToken: "secret",
      fetchFn: fetchMock as unknown as typeof fetch,
      sleep: async () => {},
    });
    await expect(sender.sendEvent(event)).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws after exhausting retries on persistent 5xx", async () => {
    const fetchMock = vi.fn(
      () => ({ ok: false, status: 503 } as Response),
    );
    const sender = new BackendSender({
      backendUrl: "https://api.example.com",
      accountToken: "secret",
      fetchFn: fetchMock as unknown as typeof fetch,
      sleep: async () => {},
      maxRetries: 2,
    });
    await expect(sender.sendEvent(event)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});
