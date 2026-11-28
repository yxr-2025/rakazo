import type { PrismaClient } from "@rakazo/db";
import { recordSecurityEvent, runAsSystem } from "@rakazo/db";

/** Sessions among these that were deleted or have expired. */
async function endedSessions(prisma: PrismaClient, sessionIds: string[]): Promise<Set<string>> {
  if (!sessionIds.length) return new Set();
  const live = await runAsSystem("check user device sessions", () =>
    prisma.session.findMany({
      where: { id: { in: sessionIds }, expiresAt: { gt: new Date() } },
      select: { id: true },
    }),
  );
  const kept = new Set(live.map((session) => session.id));
  return new Set(sessionIds.filter((id) => !kept.has(id)));
}

/** Users among these with no sign-in left. */
async function signedOutUsers(prisma: PrismaClient, userIds: string[]): Promise<Set<string>> {
  if (!userIds.length) return new Set();
  const live = await runAsSystem("check users' remaining sign-ins", () =>
    prisma.session.findMany({
      where: { userId: { in: userIds }, expiresAt: { gt: new Date() } },
      select: { userId: true },
      distinct: ["userId"],
    }),
  );
  const kept = new Set(live.map((session) => session.userId));
  return new Set(userIds.filter((id) => !kept.has(id)));
}

/**
 * Revokes the devices whose pairing sign-in was deleted or expired without its sign-out hook
 * revoking them, and those paired before sign-ins were recorded once their user has none left.
 * Returns the ids it revoked.
 */
export async function revokeSignedOut(
  prisma: PrismaClient,
  devices: { id: string; userId: string; sessionId: string | null }[],
): Promise<string[]> {
  const [ended, signedOut] = await Promise.all([
    endedSessions(
      prisma,
      devices.flatMap((device) => (device.sessionId ? [device.sessionId] : [])),
    ),
    signedOutUsers(prisma, [
      ...new Set(devices.filter((device) => !device.sessionId).map((device) => device.userId)),
    ]),
  ]);
  const revoked: string[] = [];
  for (const device of devices.filter((device) =>
    device.sessionId ? ended.has(device.sessionId) : signedOut.has(device.userId),
  )) {
    // Matching the session too leaves a device a password change or a tie just moved alone.
    const { count } = await runAsSystem("revoke a user device whose sign-in ended", () =>
      prisma.userDevice.updateMany({
        where: { id: device.id, sessionId: device.sessionId, revokedAt: null },
        data: { revokedAt: new Date(), revokedBy: "session" },
      }),
    );
    if (!count) continue;
    await recordSecurityEvent({
      type: "device.revoked",
      userId: device.userId,
      metadata: { deviceId: device.id, by: "session" },
    });
    revoked.push(device.id);
  }
  return revoked;
}
