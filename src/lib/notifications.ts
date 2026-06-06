import { prisma } from "./prisma.js";
import { redis, withRedisFallback } from "./redis.js";

export type NotificationType =
  | "event_deployed"
  | "event_failed"
  | "event_completed"
  | "form_submitted"
  | "participant_enrolled"
  | "invoice_created"
  | "opportunity_converted";

export type NotificationMeta = Record<string, unknown> | null;

export type Notification = {
  id: string;
  type: NotificationType;
  title?: string;
  message?: string;
  meta?: NotificationMeta;
  createdAt: string; // ISO
  isNew?: boolean;
};

function adminNotificationsKey(adminId: string) {
  return `notifications:${adminId}`;
}

export async function addNotificationForAdmins(payload: Omit<Notification, "id" | "createdAt">) {
  const admins = await prisma.admin.findMany({ where: { notificationsEnabled: true }, select: { id: true } });
  const createdAt = new Date().toISOString();
  const ops: Array<Promise<number | string>> = [];

  for (const admin of admins) {
    const id = crypto.randomUUID();
    const notif: Notification = { id, ...payload, createdAt, isNew: true };
    ops.push(withRedisFallback(() => redis.hset(adminNotificationsKey(admin.id), id, JSON.stringify(notif)), 0));
  }

  await Promise.all(ops);
  return true;
}

export async function getNotificationsForAdmin(adminId: string) {
  const raw = await withRedisFallback(() => redis.hgetall(adminNotificationsKey(adminId)), {} as Record<string, string>);
  const items: Notification[] = Object.values(raw)
    .map((v) => {
      try {
        return JSON.parse(v) as Notification;
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Notification[];

  items.sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));
  return items;
}

export async function markAllNotificationsSeen(adminId: string) {
  const key = `notifications:lastseen:${adminId}`;
  await withRedisFallback(() => redis.set(key, new Date().toISOString()), "OK");
}

export async function clearNotificationsForAdmin(adminId: string) {
  await withRedisFallback(() => redis.del(adminNotificationsKey(adminId)), 0);
}
