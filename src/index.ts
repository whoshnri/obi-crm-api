import 'dotenv/config'
import { serve } from "@hono/node-server";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { authMiddleware } from "./lib/auth.js";
import { logApiError } from "./lib/http.js";
import { assetsRouter } from "./routes/assets.js";
import { authRouter } from "./routes/auth.js";
import { adminsRouter } from "./routes/admins.js";
import { eventsRouter } from "./routes/events.js";
import { formsRouter } from "./routes/forms.js";
import { invoicesRouter } from "./routes/invoices.js";
import { opportunitiesRouter } from "./routes/opportunities.js";
import { participantsRouter } from "./routes/participants.js";
import { programmesRouter } from "./routes/programmes.js";
import { publicRouter } from "./routes/public.js";
import { templatesRouter } from "./routes/templates.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { notificationsRouter } from "./routes/notifications.js";
import { orgRouter } from "./routes/org.js";
import { organisationsRouter } from "./routes/organisations.js";
import { cohortsRouter } from "./routes/cohorts.js";
import { portalRouter } from "./routes/portal.js";
import { analyticsRouter } from "./routes/analytics.js";

const app = new Hono();

const allowedOrigins = new Set(
  [
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:3002",
    "http://localhost:3003", // OBI_PORTAL_ORIGIN
    process.env.OBI_CRM_ORIGIN,
    process.env.OBI_FORMS_APP_ORIGIN,
    process.env.OBI_PORTAL_ORIGIN,
    ...(process.env.OBI_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  ].filter(Boolean)
);

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: (origin) => (allowedOrigins.has(origin) ? origin : null),
    allowHeaders: ["Content-Type", "Authorization", "X-API-Key"],
    allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    credentials: true
  })
);

app.get("/", (c) => c.json({ok: true}))
app.get("/health", (c) => c.json({ ok: true, service: "obi-api" }));
app.route("/webhooks", webhooksRouter);
app.route("/portal", portalRouter);
app.use("*", authMiddleware());
app.route("/auth", authRouter);
app.route("/programmes", programmesRouter);
app.route("/events", eventsRouter);
app.route("/forms", formsRouter);
app.route("/participants", participantsRouter);
app.route("/opportunities", opportunitiesRouter);
app.route("/invoices", invoicesRouter);
app.route("/templates", templatesRouter);
app.route("/admins", adminsRouter);
app.route("/notifications", notificationsRouter);
app.route("/org", orgRouter);
app.route("/organisations", organisationsRouter);
app.route("/cohorts", cohortsRouter);
app.route("/analytics", analyticsRouter);
app.route("/public", publicRouter);
app.route("/assets", assetsRouter);

app.onError((error, c) => {
  logApiError(c, 500, error);
  return c.json({ error: "Unexpected API error" }, 500);
});

export default app;

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule && !process.env.VERCEL) {
  await import("./jobs/index.js");

  const port = Number(process.env.OBI_APP_PORT ?? 3001);

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("OBI_APP_PORT must be a positive integer");
  }

  serve({ port, fetch: app.fetch });

  console.log(`OBI API listening on http://localhost:${port}`);
}
