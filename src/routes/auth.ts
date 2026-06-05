import { verify } from "argon2";
import { Hono } from "hono";
import { z } from "zod";
import {
  clearAccessCookie,
  clearRefreshCookie,
  createAdminSession,
  getAccessCookie,
  getRefreshCookie,
  rotateRefreshSession,
  setAccessCookie,
  setRefreshCookie,
  sha256,
  signAccessToken,
  verifyAccessToken
} from "../lib/auth.js";
import { handleRoute } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

async function verifyPassword(input: string, stored: string) {
  if (stored.startsWith("$")) {
    return verify(stored, input);
  }
  return input === stored;
}

function isTransientDatabaseTimeout(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ETIMEDOUT"
  );
}

async function findAdminByEmail(email: string) {
  try {
    return await prisma.admin.findUnique({ where: { email } });
  } catch (error) {
    if (!isTransientDatabaseTimeout(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 350));
    return prisma.admin.findUnique({ where: { email } });
  }
}

export const authRouter = new Hono()
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

      console.log(payload)
      const admin = await prisma.admin.findUnique({ where: { id: payload.sub } });

      if (!admin) return c.json({ error: "Admin not found" }, 401);

      return {
        admin: {
          id: admin.id,
          name: admin.name,
          email: admin.email,
          role: admin.role
        }
      };
    })
  )
  .post("/login", (c) =>
    handleRoute(c, async () => {
      const input = loginSchema.parse(await c.req.json());
      const admin = await findAdminByEmail(input.email);
      const passwordMatches = admin ? await verifyPassword(input.password, admin.password) : false;

      if (!admin || !passwordMatches) {
        clearAccessCookie(c);
        clearRefreshCookie(c);
        return c.json({ error: "Invalid email or password" }, 401);
      }

      const accessToken = await signAccessToken(admin);
      const { refreshToken } = await createAdminSession(admin.id);
      setAccessCookie(c, accessToken);
      setRefreshCookie(c, refreshToken);

      return {
        admin: {
          id: admin.id,
          name: admin.name,
          email: admin.email,
          role: admin.role
        }
      };
    })
  )
  .post("/refresh", (c) =>
    handleRoute(c, async () => {
      const refreshToken = getRefreshCookie(c);
      if (!refreshToken) {
        clearAccessCookie(c);
        return c.json({ error: "Missing refresh token" }, 401);
      }

      const rotated = await rotateRefreshSession(refreshToken);
      if (!rotated) {
        clearAccessCookie(c);
        clearRefreshCookie(c);
        return c.json({ error: "Invalid refresh token" }, 401);
      }

      setAccessCookie(c, rotated.accessToken);
      setRefreshCookie(c, rotated.refreshToken);
      return {
        admin: {
          id: rotated.admin.id,
          name: rotated.admin.name,
          email: rotated.admin.email,
          role: rotated.admin.role
        }
      };
    })
  )
  .post("/logout", (c) =>
    handleRoute(c, async () => {
      const refreshToken = getRefreshCookie(c);
      if (refreshToken) {
        await prisma.adminSession.updateMany({
          where: { tokenHash: await sha256(refreshToken), revokedAt: null },
          data: { revokedAt: new Date() }
        });
      }
      clearAccessCookie(c);
      clearRefreshCookie(c);
      return { ok: true };
    })
  );
