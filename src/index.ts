import 'dotenv/config'
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { authMiddleware } from "./lib/auth";
import { logApiError } from "./lib/http";
import { assetsRouter } from "./routes/assets";
import { authRouter } from "./routes/auth";
import { adminsRouter } from "./routes/admins";
import { eventsRouter } from "./routes/events";
import { formsRouter } from "./routes/forms";
import { invoicesRouter } from "./routes/invoices";
import { opportunitiesRouter } from "./routes/opportunities";
import { participantsRouter } from "./routes/participants";
import { programmesRouter } from "./routes/programmes";
import { publicRouter } from "./routes/public";
import { templatesRouter } from "./routes/templates";

const app = new Hono();

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: ["http://localhost:3000", "http://localhost:3001", "http://localhost:3002"],
    allowHeaders: ["Content-Type", "Authorization", "X-API-Key"],
    allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    credentials: true
  })
);
app.use("*", authMiddleware());

app.get("/", (c) => c.json({ok: true}))
app.get("/health", (c) => c.json({ ok: true, service: "obi-api" }));
app.route("/auth", authRouter);
app.route("/programmes", programmesRouter);
app.route("/events", eventsRouter);
app.route("/forms", formsRouter);
app.route("/participants", participantsRouter);
app.route("/opportunities", opportunitiesRouter);
app.route("/invoices", invoicesRouter);
app.route("/templates", templatesRouter);
app.route("/admins", adminsRouter);
app.route("/public", publicRouter);
app.route("/assets", assetsRouter);

app.onError((error, c) => {
  logApiError(c, 500, error);

  return c.json({ error: "Unexpected API error" }, 500);
});

const port = Number(Bun.env.OBI_APP_PORT);

Bun.serve({
  port,
  fetch: app.fetch
});

console.log(`OBI API listening on http://localhost:${port}`);
