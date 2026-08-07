import type { PoolClient } from "pg";

export async function disableNotificationDevicesForSessionFamily(
  client: PoolClient,
  sessionFamilyId: string,
): Promise<void> {
  await client.query(
    `
      UPDATE notification_devices
      SET disabled_at = COALESCE(disabled_at, now()), updated_at = now()
      WHERE session_family_id = $1 AND disabled_at IS NULL
    `,
    [sessionFamilyId],
  );
}
