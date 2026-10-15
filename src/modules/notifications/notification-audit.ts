import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { PoolClient } from "pg";

/** Event keys keep retry/read acknowledgements append-only without duplicate ledger entries. */
export async function notificationAudit(
  client: PoolClient,
  event: {
    organizationId: string;
    actorId: string | null;
    actorRole: string;
    action:
      | "notification.created"
      | "notification.read"
      | "notification.email-sent"
      | "notification.email-failed";
    notificationId: string;
    eventKey: string;
    ip?: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO activity_audit(organization_id,actor_id,actor_role,action,target_type,target_id,method,route,source_ip,status_code,duration_ms,request_id,event_key)
     VALUES($1,$2,$3,$4,'notification',$5,'POST','/api/notifications',$6,$9,0,$7,$8)
     ON CONFLICT(organization_id,event_key) WHERE event_key IS NOT NULL DO NOTHING`,
    [
      event.organizationId,
      event.actorId,
      event.actorRole,
      event.action,
      event.notificationId,
      event.ip && isIP(event.ip) ? event.ip : null,
      randomUUID(),
      event.eventKey,
      event.action === "notification.email-failed" ? 502 : 200,
    ],
  );
}
