import { describe, expect, it, vi } from "vitest";
import { DesktopDeviceForwarder } from "./desktop-forwarding.js";

const route = { userId: "owner", deviceId: "desktop", connectionId: "socket" };
const request = { method: "environment", botId: "bot" } as const;
const address = "http://127.0.0.1:3100";

describe("the existing desktop forwarding wire format", () => {
  it("keeps the fenced request and disconnect envelopes, including frames split inside UTF-8", async () => {
    const encoded = new TextEncoder().encode('{"value":"\u2603"}\n{"done":true}\n');
    // The first byte of the snowman ends the first chunk.
    const split = encoded.indexOf(0xe2) + 1;
    expect(split).toBeGreaterThan(0);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, split));
        controller.enqueue(encoded.slice(split));
        controller.close();
      },
    });
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(stream))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new DesktopDeviceForwarder("fixture-secret", send);
    const signal = new AbortController().signal;
    const frames = [];
    for await (const frame of client.frames(address, route, request, signal)) frames.push(frame);
    expect(frames).toEqual([{ value: "\u2603" }, { done: true }]);
    await client.disconnect(address, route.deviceId, "session-ended");
    const calls = send.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: init?.method,
      redirect: init?.redirect,
      headers: init?.headers,
      body: JSON.parse(String(init?.body)),
    }));
    const options = {
      method: "POST",
      redirect: "error",
      headers: { authorization: "Bearer fixture-secret", "content-type": "application/json" },
    };
    expect(calls).toEqual([
      { ...options, url: `${address}/internal/user-devices/request`, body: { ...route, request } },
      {
        ...options,
        url: `${address}/internal/user-devices/disconnect`,
        body: { deviceId: "desktop", reason: "session-ended" },
      },
    ]);
    expect(send.mock.calls[0]?.[1]?.signal).toBe(signal);
  });

  it("releases an unread HTTP body if a forwarding consumer leaves after one frame", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"value":"first"}\n'));
      },
      cancel,
    });
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    const client = new DesktopDeviceForwarder("fixture-secret", send);
    for await (const frame of client.frames(
      address,
      route,
      request,
      new AbortController().signal,
    )) {
      expect(frame).toEqual({ value: "first" });
      break;
    }
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
});
