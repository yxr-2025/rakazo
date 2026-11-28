import type { UserDeviceHub } from "@rakazo/adapters";
import {
  USER_DEVICE_DISCONNECT_PATH,
  USER_DEVICE_FORWARD_PATH,
  userDeviceDisconnectBody,
  userDeviceForwardBody,
  validUserDeviceForwardSecret,
} from "@rakazo/adapters";
import type { Hono } from "hono";
import { parseJson, readBoundedBody } from "../http/http-body.js";

const FORWARD_BODY_MAX_BYTES = 13 * 1024 * 1024;

/** Private, inter-process routes. They authenticate the forwarding server, not an end-user session. */
export function mountUserDeviceForwardingRoutes(
  app: Hono,
  deps: { forwardSecret: string; hub: Pick<UserDeviceHub, "stream" | "disconnect"> },
) {
  app.post(USER_DEVICE_FORWARD_PATH, async (c) => {
    if (!validUserDeviceForwardSecret(deps.forwardSecret, c.req.header("authorization")))
      return c.json({ error: "Unauthorized" }, 401);
    const body = await readBoundedBody(c.req.raw, FORWARD_BODY_MAX_BYTES);
    if (body === null) return c.json({ error: "Request too large" }, 413);
    const input = userDeviceForwardBody.safeParse(parseJson(body));
    if (!input.success) return c.json({ error: "Invalid request" }, 400);
    const { request, ...route } = input.data;
    return deps.hub.stream(route, request, c.req.raw.signal);
  });

  app.post(USER_DEVICE_DISCONNECT_PATH, async (c) => {
    if (!validUserDeviceForwardSecret(deps.forwardSecret, c.req.header("authorization")))
      return c.json({ error: "Unauthorized" }, 401);
    const body = await readBoundedBody(c.req.raw, 1024);
    const input = userDeviceDisconnectBody.safeParse(parseJson(body ?? ""));
    if (!input.success) return c.json({ error: "Invalid request" }, 400);
    deps.hub.disconnect(input.data.deviceId, input.data.reason);
    return c.body(null, 204);
  });
}
