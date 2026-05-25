import { Hono } from "hono";
import { handleRoute } from "../lib/http.js";
import { getNotificationsForAdmin, markAllNotificationsSeen } from "../lib/notifications.js";

export const notificationsRouter = new Hono()
  .get("/", (c) =>
    handleRoute(c, async () => {
      const admin = (c as any).get("admin") as { sub: string } | undefined;
      if (!admin) return [];
      const items = await getNotificationsForAdmin(admin.sub);
      return items;
    })
  )
  .post("/seen", (c) =>
    handleRoute(c, async () => {
      const admin = (c as any).get("admin") as { sub: string } | undefined;
      if (!admin) return { ok: false };
      await markAllNotificationsSeen(admin.sub);
      return { ok: true };
    })
  );
