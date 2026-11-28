import { createHmac, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { getLogger } from "@rakazo/logging";
import { z } from "zod";
import type { HostComputerRequest } from "../../computers/host/host-computer-protocol.js";
import {
  HOST_COMPUTER_MAX_BYTES,
  hostComputerRequest,
} from "../../computers/host/host-computer-protocol.js";
import type { UserDeviceRevokeReason } from "../../computers/host/user-device-protocol.js";
import { userDeviceRevokeReason } from "../../computers/host/user-device-protocol.js";

/** Internal API endpoints other processes forward to. Not under /api, so the public proxy never routes them. */
export const USER_DEVICE_FORWARD_PATH = "/internal/user-devices/request";
export const USER_DEVICE_DISCONNECT_PATH = "/internal/user-devices/disconnect";
export const USER_DEVICE_OFFLINE_MESSAGE =
  "Your computer is not connected. Open the Rakazo desktop app.";
export const DISCONNECTED_MESSAGE = "Your computer disconnected. Check the result before retrying.";
export const MAX_MESSAGE_BYTES = HOST_COMPUTER_MAX_BYTES + 64 * 1024;

export class UserDeviceOfflineError extends Error {
  constructor(message = USER_DEVICE_OFFLINE_MESSAGE, options?: ErrorOptions) {
    super(message, options);
    this.name = "UserDeviceOfflineError";
  }
}

/** API and worker share ENCRYPTION_KEY; forwarding uses a key derived from it for this purpose only. */
export function userDeviceForwardSecret(encryptionKey: string): string {
  return createHmac("sha256", encryptionKey).update("rakazo:user-device-forward:v1").digest("hex");
}

export function validUserDeviceForwardSecret(expected: string, header: string | null | undefined) {
  const supplied = /^Bearer (.+)$/.exec(header ?? "")?.[1];
  if (!supplied) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The base URL other processes reach this API process at; a bound wildcard host uses the first network address. */
export function userDeviceInternalAddress(host: string, port: number): string {
  let address = host;
  if (!host || host === "0.0.0.0" || host === "::") {
    const candidates = Object.values(networkInterfaces())
      .flat()
      .filter((entry) => entry && !entry.internal);
    address =
      candidates.find((entry) => entry?.family === "IPv4")?.address ??
      candidates.find((entry) => entry?.family === "IPv6" && !entry.address.startsWith("fe80"))
        ?.address ??
      "127.0.0.1";
  }
  return `http://${address.includes(":") ? `[${address}]` : address}:${port}`;
}

export interface UserDeviceRoute {
  deviceId: string;
  userId: string;
  connectionId: string;
}

/** Body of a forwarded request; the forward secret authorizes it. */
export const userDeviceDisconnectBody = z.object({
  deviceId: z.string().min(1).max(64),
  reason: userDeviceRevokeReason.optional(),
});

export const userDeviceForwardBody = z.object({
  deviceId: z.string().min(1).max(64),
  userId: z.string().min(1).max(128),
  connectionId: z.string().min(1).max(64),
  request: hostComputerRequest,
});

/** Sends a request to the API that holds an already-selected desktop connection. Never selects another device or retries a request. */
export class DesktopDeviceForwarder {
  constructor(
    private readonly secret: string,
    private readonly fetch: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  async *frames(
    address: string,
    route: UserDeviceRoute,
    request: HostComputerRequest,
    signal: AbortSignal,
  ): AsyncIterable<unknown> {
    let response: Response;
    try {
      response = await this.post(address, USER_DEVICE_FORWARD_PATH, { ...route, request }, signal);
    } catch (error) {
      signal.throwIfAborted();
      throw new UserDeviceOfflineError(undefined, { cause: error });
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new UserDeviceOfflineError();
    }
    yield* ndjson(response.body, signal);
  }

  async disconnect(
    address: string,
    deviceId: string,
    reason?: UserDeviceRevokeReason,
  ): Promise<void> {
    await this.post(
      address,
      USER_DEVICE_DISCONNECT_PATH,
      { deviceId, reason },
      AbortSignal.timeout(5_000),
    )
      .then((response) => response.body?.cancel())
      .catch((error) => getLogger().warn("user device disconnect forward failed", { error }));
  }

  private post(
    address: string,
    path: typeof USER_DEVICE_FORWARD_PATH | typeof USER_DEVICE_DISCONNECT_PATH,
    body: unknown,
    signal: AbortSignal,
  ): Promise<Response> {
    return this.fetch(new URL(path, address), {
      method: "POST",
      headers: { authorization: `Bearer ${this.secret}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal,
    });
  }
}

/** The receiving API streams raw desktop frames. If the HTTP reader leaves, stop its socket request. */
export function forwardedDesktopStream(
  signal: AbortSignal,
  frames: (signal: AbortSignal) => AsyncIterable<unknown>,
): Response {
  const controller = new AbortController();
  const linked = AbortSignal.any([signal, controller.signal]);
  const iterator = frames(linked)[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(stream) {
      try {
        const next = await iterator.next();
        if (next.done) stream.close();
        else stream.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
      } catch (error) {
        const message = error instanceof Error ? error.message : DISCONNECTED_MESSAGE;
        stream.enqueue(encoder.encode(`${JSON.stringify({ error: message })}\n`));
        stream.close();
      }
    },
    async cancel(reason) {
      controller.abort(reason);
      await iterator.return?.();
    },
  });
  return new Response(body, {
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
  });
}

async function* ndjson(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = body.getReader();
  const abort = () => void reader.cancel(signal.reason).catch(() => undefined);
  signal.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) return;
      pending += decoder.decode(chunk.value, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        if (newline > MAX_MESSAGE_BYTES)
          throw new Error("Response from your computer is too large");
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        yield JSON.parse(line) as unknown;
        newline = pending.indexOf("\n");
      }
      if (pending.length > MAX_MESSAGE_BYTES)
        throw new Error("Response from your computer is too large");
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
