import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import {
  EmailEmulator,
  FakeSandboxProvider,
  UserDevices,
  userDeviceForwardSecret,
} from "@rakazo/adapters";
import { startUserDeviceClient } from "@rakazo/adapters/user-device-client";
import type { AppHandles } from "@rakazo/api/app";
import { createApp } from "@rakazo/api/app";
import type { UserDevicePairResponse } from "@rakazo/contracts/user-devices";
import { USER_DEVICE_PAIR_PATH } from "@rakazo/contracts/user-devices";
import { withAbort } from "@rakazo/core";
import { deferred } from "@rakazo/core/test-async";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sessionCookieHeader } from "../index.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const encryptionKey = "test-desktop-forwarding-encryption-key";

describe.skipIf(!databaseUrl)("the socket-owning API's private desktop transport", () => {
  let handles: AppHandles;
  let server: Server;
  let url: string;
  let dataDir: string;
  let desktop: ReturnType<typeof startUserDeviceClient> | undefined;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "rakazo-desktop-forward-"));
    // Bind first: the same ephemeral address must be advertised in PostgreSQL and used by HTTP and WS.
    server = serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => handles.app.fetch(request),
    }) as Server;
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    url = `http://127.0.0.1:${port}`;
    handles = await createApp({
      apiHost: "127.0.0.1",
      port,
      databaseUrl: databaseUrl!,
      encryptionKey,
      dataDir,
      userDevicesEnabled: true,
      sandboxProvider: "fake",
      sandbox: new FakeSandboxProvider(),
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      signupAllowlist: "",
      webOrigin: url,
      authUrl: url,
      email: new EmailEmulator(),
    });
    if (!handles.handleUpgrade) throw new Error("Expected the desktop upgrade handler");
    server.on("upgrade", handles.handleUpgrade);
  });

  afterAll(async () => {
    desktop?.close();
    await handles?.stop();
    if (server?.listening) {
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    }
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it("delivers a worker request, cancellation and session-ended disconnect over HTTP to the paired client", async () => {
    const email = `forward-${randomUUID()}@example.test`;
    const account = { email, password: "test-password-123" };
    const post = (path: string, body: object, cookie = "") =>
      fetch(new URL(path, url), {
        method: "POST",
        headers: { "content-type": "application/json", origin: url, ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      });
    expect((await post("/api/auth/sign-up/email", { ...account, name: "Owner" })).status).toBe(200);
    const signIn = await post("/api/auth/sign-in/email", account);
    expect(signIn.status).toBe(200);
    const pair = await post(
      USER_DEVICE_PAIR_PATH,
      { name: "Desktop", platform: "linux" },
      sessionCookieHeader(signIn),
    );
    expect(pair.status).toBe(201);
    const { token, userId, deviceId } = (await pair.json()) as UserDevicePairResponse;

    const started = deferred();
    const stopped = deferred();
    const revoked = vi.fn();
    const stalled = deferred<{ app: string; tree: string }>();
    const authorize = vi.fn(async () => true);
    desktop = startUserDeviceClient({
      serverUrl: url,
      token,
      root: dataDir,
      authorize,
      onRevoked: revoked,
      screen: {
        async observe({ signal }, app, options) {
          if (options?.query !== "hold") return { app, tree: "Synthetic document" };
          started.resolve();
          try {
            return await withAbort(stalled.promise, signal);
          } finally {
            if (signal.aborted) stopped.resolve();
          }
        },
        act: vi.fn(),
        close: vi.fn(),
      },
    });
    // Same gateway construction as the Worker: no socket hub and no injected fetch.
    const remote = new UserDevices({
      prisma: handles.prisma,
      forwardSecret: userDeviceForwardSecret(encryptionKey),
    });
    await vi.waitFor(async () =>
      expect(await remote.connected(userId, deviceId)).toMatchObject({ deviceId }),
    );
    const request = { method: "screenObserve", botId: "test-bot", app: "Fixture" } as const;
    const peer = fileURLToPath(
      new URL("./desktop-forwarding-peer.test-support.ts", import.meta.url),
    );
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--conditions=development", "--import", "tsx", peer, userId, deviceId],
      {
        env: { ...process.env, DATABASE_URL: databaseUrl, ENCRYPTION_KEY: encryptionKey },
        timeout: 30_000,
      },
    );
    expect(JSON.parse(stdout)).toEqual([{ app: "Fixture", tree: "Synthetic document" }]);

    const controller = new AbortController();
    const pending = remote
      .request(userId, { ...request, query: "hold" }, controller.signal, deviceId)
      [Symbol.asyncIterator]()
      .next();
    await started.promise;
    const rejected = expect(pending).rejects.toThrow("Stopped by caller");
    controller.abort(new Error("Stopped by caller"));
    await rejected;
    await stopped.promise;
    expect(authorize).toHaveBeenCalledTimes(2);
    await remote.disconnect(deviceId, "session-ended");
    await vi.waitFor(() => expect(revoked).toHaveBeenCalledWith("session-ended"));
    await vi.waitFor(async () => expect(await remote.connected(userId, deviceId)).toBeNull());
  }, 60_000);
});
