import { UserDevices, userDeviceForwardSecret } from "@rakazo/adapters";
import { createDb } from "@rakazo/db";

// Standalone caller in the PostgreSQL transport test; this process has no hub or shared JS state.
const [userId, deviceId] = process.argv.slice(2);
if (
  !userId ||
  !deviceId ||
  process.env.VERIFY_DATABASE !== "1" ||
  !process.env.DATABASE_URL ||
  !process.env.ENCRYPTION_KEY
) {
  throw new Error("Expected an isolated test database and a paired fixture");
}
const db = createDb(process.env.DATABASE_URL);
try {
  const caller = new UserDevices({
    prisma: db.prisma,
    forwardSecret: userDeviceForwardSecret(process.env.ENCRYPTION_KEY),
  });
  const values = [];
  for await (const value of caller.request(
    userId,
    { method: "screenObserve", botId: "test-bot", app: "Fixture" },
    AbortSignal.timeout(10_000),
    deviceId,
  ))
    values.push(value);
  process.stdout.write(JSON.stringify(values));
} finally {
  await db.prisma.$disconnect();
  await db.pool.end();
}
