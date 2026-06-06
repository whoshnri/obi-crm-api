import { verify } from "argon2";
import { Hono } from "hono";
import { z } from "zod";
import {
  clearAccessCookie,
  clearRefreshCookie,
  createAdminSession,
  getAccessCookie,
  getRefreshCookie,
  hashAdminPassword,
  rotateRefreshSession,
  setAccessCookie,
  setRefreshCookie,
  sha256,
  signAccessToken,
  signAdminPasswordSetupToken,
  verifyAccessToken,
  verifyAdminPasswordSetupToken
} from "../lib/auth.js";
import { handleRoute } from "../lib/http.js";
import { prisma, retryDatabaseOperation } from "../lib/prisma.js";
import { sendEmail } from "../jobs/utils.js";

type AdminRecord = {
  id: string;
  name: string;
  email: string;
  role: string;
  password: string | null;
};

type AdminMagicLinkRecord = {
  id: string;
  purpose: "sign_in" | "reset_password";
  expiresAt: Date;
  usedAt: Date | null;
  admin: AdminRecord;
};

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

const authOptionsSchema = z.object({
  email: z.string().email()
});

const adminLinkRequestSchema = z.object({
  email: z.string().email(),
  purpose: z.enum(["sign_in", "reset_password"]).optional()
});

const setPasswordSchema = z
  .object({
    token: z.string().min(1),
    password: z.string().min(8),
    confirmPassword: z.string().min(8)
  })
  .refine((input) => input.password === input.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"]
  });

function getAdminOrigin() {
  return process.env.OBI_CRM_ORIGIN ?? "http://localhost:3000";
}

async function verifyPassword(input: string, stored: string) {
  if (stored.startsWith("$")) {
    return verify(stored, input);
  }
  return input === stored;
}

async function findAdminByEmail(email: string) {
  return retryDatabaseOperation(() =>
    prisma.admin.findUnique({
      where: { email }
    })
  );
}

async function findAdminMagicLink(token: string) {
  const tokenHash = await sha256(token);
  return retryDatabaseOperation<AdminMagicLinkRecord | null>(() =>
    (prisma as typeof prisma & {
      adminMagicLink: {
        findUnique: (args: unknown) => Promise<AdminMagicLinkRecord | null>;
      };
    }).adminMagicLink.findUnique({
      where: { tokenHash },
      include: { admin: true }
    })
  );
}

async function markAdminMagicLinkUsed(id: string) {
  return retryDatabaseOperation(() =>
    (prisma as typeof prisma & {
      adminMagicLink: {
        update: (args: unknown) => Promise<unknown>;
      };
    }).adminMagicLink.update({
      where: { id },
      data: { usedAt: new Date() }
    })
  );
}

function serializeAdmin(admin: { id: string; name: string; email: string; role: string }) {
  return {
    id: admin.id,
    name: admin.name,
    email: admin.email,
    role: admin.role
  };
}

export const authRouter = new Hono()
  .post("/options", (c) =>
    handleRoute(c, async () => {
      const input = authOptionsSchema.parse(await c.req.json());
      const admin = await findAdminByEmail(input.email.trim().toLowerCase());
      return {
        method: admin?.password ? "password" : "magic_link"
      } as const;
    })
  )
  .post("/request-link", (c) =>
    handleRoute(c, async () => {
      const input = adminLinkRequestSchema.parse(await c.req.json());
      const email = input.email.trim().toLowerCase();
      const admin = await findAdminByEmail(email);
      if (!admin) return { ok: true };

      const rawToken = `${crypto.randomUUID()}.${crypto.randomUUID().replace(/-/g, "")}`;
      const tokenHash = await sha256(rawToken);
      await retryDatabaseOperation(() =>
        (prisma as typeof prisma & {
          adminMagicLink: {
            create: (args: unknown) => Promise<unknown>;
          };
        }).adminMagicLink.create({
          data: {
            adminId: admin.id,
            tokenHash,
            purpose: input.purpose ?? "sign_in",
            expiresAt: new Date(Date.now() + 30 * 60 * 1000)
          }
        })
      );

      const verifyUrl = `${getAdminOrigin()}/auth/verify?token=${encodeURIComponent(rawToken)}`;
      const purpose = input.purpose ?? "sign_in";
      const subject =
        purpose === "reset_password"
          ? "Reset your OBI admin password"
          : "Your OBI admin sign-in link";
      const body = [
        `Hi ${admin.name},`,
        "",
        purpose === "reset_password"
          ? "Use the link below to reset your OBI admin password:"
          : "Use the link below to sign in to OBI admin:",
        verifyUrl,
        "",
        "This link expires in 30 minutes. If you did not request this, you can ignore this email."
      ].join("\n");

      await sendEmail(admin.email, subject, body);
      return { ok: true };
    })
  )
  .get("/verify", (c) =>
    handleRoute(c, async () => {
      const token = c.req.query("token");
      if (!token) return c.json({ error: "Missing token" }, 400);

      const magicLink = await findAdminMagicLink(token);
      if (!magicLink || magicLink.usedAt || magicLink.expiresAt <= new Date()) {
        return c.json({ error: "Invalid or expired sign-in link" }, 401);
      }

      await markAdminMagicLinkUsed(magicLink.id);

      if (!magicLink.admin.password || magicLink.purpose === "reset_password") {
        const setupToken = await signAdminPasswordSetupToken(magicLink.admin, magicLink.purpose);
        clearAccessCookie(c);
        clearRefreshCookie(c);
        return {
          admin: serializeAdmin(magicLink.admin),
          requiresPasswordSetup: true,
          setupToken
        };
      }

      const accessToken = await signAccessToken(magicLink.admin);
      const { refreshToken } = await createAdminSession(magicLink.admin.id);
      setAccessCookie(c, accessToken);
      setRefreshCookie(c, refreshToken);
      return {
        admin: serializeAdmin(magicLink.admin),
        requiresPasswordSetup: false
      };
    })
  )
  .post("/set-password", (c) =>
    handleRoute(c, async () => {
      const input = setPasswordSchema.parse(await c.req.json());
      const payload = await verifyAdminPasswordSetupToken(input.token);
      const admin = await retryDatabaseOperation(() =>
        prisma.admin.findUnique({
          where: { id: payload.sub }
        })
      );

      if (!admin) {
        return c.json({ error: "Admin not found" }, 404);
      }

      const password = await hashAdminPassword(input.password);
      await retryDatabaseOperation(() =>
        prisma.$transaction([
          prisma.admin.update({
            where: { id: admin.id },
            data: { password }
          }),
          prisma.adminSession.updateMany({
            where: { adminId: admin.id, revokedAt: null },
            data: { revokedAt: new Date() }
          })
        ])
      );

      const nextAdmin = { ...admin, password };
      const accessToken = await signAccessToken(nextAdmin);
      const { refreshToken } = await createAdminSession(admin.id);
      setAccessCookie(c, accessToken);
      setRefreshCookie(c, refreshToken);

      return { admin: serializeAdmin(admin) };
    })
  )
  .get("/me", (c) =>
    handleRoute(c, async () => {
      const accessToken = getAccessCookie(c);
      if (!accessToken) return c.json({ error: "Missing access token" }, 401);

      let payload: Awaited<ReturnType<typeof verifyAccessToken>>;
      try {
        payload = await verifyAccessToken(accessToken);
      } catch {
        return c.json({ error: "Invalid or expired access token" }, 401);
      }

      const admin = await retryDatabaseOperation(() =>
        prisma.admin.findUnique({
          where: { id: payload.sub }
        })
      );
      if (!admin) return c.json({ error: "Admin not found" }, 401);

      return { admin: serializeAdmin(admin) };
    })
  )
  .post("/login", (c) =>
    handleRoute(c, async () => {
      const input = loginSchema.parse(await c.req.json());
      const admin = await findAdminByEmail(input.email.trim().toLowerCase());

      if (!admin?.password) {
        clearAccessCookie(c);
        clearRefreshCookie(c);
        return c.json({ error: "Use your sign-in link to continue." }, 401);
      }

      const passwordMatches = await verifyPassword(input.password, admin.password);
      if (!passwordMatches) {
        clearAccessCookie(c);
        clearRefreshCookie(c);
        return c.json({ error: "Invalid email or password" }, 401);
      }

      const accessToken = await signAccessToken(admin);
      const { refreshToken } = await createAdminSession(admin.id);
      setAccessCookie(c, accessToken);
      setRefreshCookie(c, refreshToken);

      return { admin: serializeAdmin(admin) };
    })
  )
  .post("/refresh", (c) =>
    handleRoute(c, async () => {
      const refreshToken = getRefreshCookie(c);
      if (!refreshToken) {
        clearAccessCookie(c);
        return c.json({ error: "Missing refresh token" }, 401);
      }

      const rotated = await retryDatabaseOperation(() => rotateRefreshSession(refreshToken));
      if (!rotated) {
        clearAccessCookie(c);
        clearRefreshCookie(c);
        return c.json({ error: "Invalid refresh token" }, 401);
      }

      setAccessCookie(c, rotated.accessToken);
      setRefreshCookie(c, rotated.refreshToken);
      return { admin: serializeAdmin(rotated.admin) };
    })
  )
  .post("/logout", (c) =>
    handleRoute(c, async () => {
      const refreshToken = getRefreshCookie(c);
      if (refreshToken) {
        const tokenHash = await sha256(refreshToken);
        await retryDatabaseOperation(() =>
          prisma.adminSession.updateMany({
            where: { tokenHash, revokedAt: null },
            data: { revokedAt: new Date() }
          })
        );
      }

      clearAccessCookie(c);
      clearRefreshCookie(c);
      return { ok: true };
    })
  );
