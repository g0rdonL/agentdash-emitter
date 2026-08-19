import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { HappyAdapter } from "./adapter";
import type { StatusEvent } from "./contract";
import { encodeBase64, encrypt, getRandomBytes } from "./encryption";
import type { PersistedSessionInfo } from "./happyFiles";

// Minimal fake socket exposing the socket.io-client surface the adapter uses.
class FakeSocket extends EventEmitter {
  connected = false;
  connect = vi.fn(() => {
    this.connected = true;
    this.emit("connect");
  });
  close = vi.fn(() => {
    this.connected = false;
    this.emit("disconnect", "io client disconnect");
  });
}

const KEY = getRandomBytes(32);
const KEY_B64 = encodeBase64(KEY);

const sessions: PersistedSessionInfo[] = [
  {
    sessionId: "s1",
    encryptionKey: KEY_B64,
    encryptionVariant: "dataKey",
    projectLabel: "happy",
  },
];

let socket: FakeSocket;
let events: StatusEvent[];
let adapter: HappyAdapter;

beforeEach(() => {
  vi.useFakeTimers();
  socket = new FakeSocket();
  events = [];
  adapter = new HappyAdapter({
    serverUrl: "https://happy.example.com",
    accountToken: "tok",
    loadSessions: () => sessions,
    socketFactory: () => socket as any,
    debounceMs: 500,
  });
});

afterEach(() => {
  adapter.stop();
  vi.useRealTimers();
});

function flushDebounce() {
  vi.advanceTimersByTime(600);
}

describe("HappyAdapter", () => {
  it("emits thinking then waiting from ephemeral activity events", () => {
    adapter.start((e) => events.push(e));
    socket.emit("ephemeral", {
      type: "activity",
      id: "s1",
      active: true,
      activeAt: 1000,
      thinking: true,
    });
    flushDebounce();
    socket.emit("ephemeral", {
      type: "activity",
      id: "s1",
      active: true,
      activeAt: 1100,
      thinking: false,
    });
    flushDebounce();
    expect(events.map((e) => e.status)).toEqual(["thinking", "waiting"]);
    expect(events[0]).toMatchObject({
      sessionId: "s1",
      projectLabel: "😊 happy",
    });
  });

  it("emits permission_required when a decrypted agentState has pending requests", () => {
    adapter.start((e) => events.push(e));
    socket.emit("ephemeral", {
      type: "activity",
      id: "s1",
      active: true,
      activeAt: 1000,
      thinking: true,
    });
    flushDebounce();
    events.length = 0;
    const agentState = {
      requests: { "r1": { tool: "Bash", arguments: {}, createdAt: 1 } },
    };
    const blob = encodeBase64(encrypt(KEY, "dataKey", agentState));
    socket.emit("update", {
      body: { t: "update-session", agentState: { value: blob, version: 2 } },
    });
    flushDebounce();
    expect(events.at(-1)?.status).toBe("permission_required");
  });

  it("emits disconnected on an inactive activity event", () => {
    adapter.start((e) => events.push(e));
    socket.emit("ephemeral", {
      type: "activity",
      id: "s1",
      active: true,
      activeAt: 1000,
      thinking: false,
    });
    flushDebounce();
    events.length = 0;
    socket.emit("ephemeral", {
      type: "activity",
      id: "s1",
      active: false,
      activeAt: 1200,
      thinking: false,
    });
    flushDebounce();
    expect(events.at(-1)?.status).toBe("disconnected");
  });

  it("does not emit duplicate consecutive identical statuses", () => {
    adapter.start((e) => events.push(e));
    socket.emit("ephemeral", {
      type: "activity",
      id: "s1",
      active: true,
      activeAt: 1000,
      thinking: true,
    });
    flushDebounce();
    socket.emit("ephemeral", {
      type: "activity",
      id: "s1",
      active: true,
      activeAt: 1100,
      thinking: true,
    });
    flushDebounce();
    expect(events).toHaveLength(1);
  });
});
