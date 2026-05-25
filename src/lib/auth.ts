import 'dotenv/config'
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { prisma } from "./prisma";

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const ACCESS_COOKIE = "obi_access_token";
const REFRESH_COOKIE = "obi_refresh_token";

function isSecureCookieEnvironment() {
  return Bun.env.NODE_ENV === "production" || Boolean(Bun.env.VERCEL);
}

function getCookieOptions(maxAge: number) {
  const secure = isSecureCookieEnvironment();
  return {
    httpOnly: true,
    secure,
    sameSite: secure ? "None" : "Lax",
    path: "/",
    maxAge
  } as const;
}

type JwtPayload = {
  sub: string;
  email: string;
  role: string;
  exp: number;
  iat: number;
};

function getSecret() {
  const secret = Bun.env.OBI_JWT_SECRET ?? Bun.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("Missing OBI_JWT_SECRET/JWT_SECRET with at least 32 characters");
  }
  return secret;
}

function base64Url(input: ArrayBuffer | Uint8Array | string) {
  const bytes =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : input instanceof Uint8Array
        ? input
        : new Uint8Array(input);
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64Url(input: string) {
  return new TextDecoder().decode(Buffer.from(input, "base64url"));
}

async function hmac(data: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(getSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
}

export async function sha256(value: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(hash);
}

export async function signAccessToken(admin: { id: string; email: string; role: string }) {
  const now = Math.floor(Date.now() / 1000);
  const payload: JwtPayload = {
    sub: admin.id,
    email: admin.email,
    role: admin.role,
    iat: now,
    exp: now + ACCESS_TOKEN_TTL_SECONDS
  };
  const header = { alg: "HS256", typ: "JWT" };
  const body = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = base64Url(await hmac(body));
  return `${body}.${signature}`;
}

export async function verifyAccessToken(token: string) {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) throw new Error("Invalid access token");

  const expected = base64Url(await hmac(`${header}.${payload}`));
  if (expected !== signature) throw new Error("Invalid access token signature");

  const parsed = JSON.parse(fromBase64Url(payload)) as JwtPayload;
  if (parsed.exp <= Math.floor(Date.now() / 1000)) throw new Error("Access token expired");
  return parsed;
}

export function createRefreshToken() {
  return crypto.randomUUID() + "." + base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export function setRefreshCookie(c: Context, token: string) {
  setCookie(c, REFRESH_COOKIE, token, getCookieOptions(REFRESH_TOKEN_TTL_SECONDS));
}

export function setAccessCookie(c: Context, token: string) {
  setCookie(c, ACCESS_COOKIE, token, getCookieOptions(ACCESS_TOKEN_TTL_SECONDS));
}

export function clearAccessCookie(c: Context) {
  deleteCookie(c, ACCESS_COOKIE, getCookieOptions(0));
}

export function clearRefreshCookie(c: Context) {
  deleteCookie(c, REFRESH_COOKIE, getCookieOptions(0));
}

export function getAccessCookie(c: Context) {
  return getCookie(c, ACCESS_COOKIE);
}

export function getRefreshCookie(c: Context) {
  return getCookie(c, REFRESH_COOKIE);
}

export async function createAdminSession(adminId: string) {
  const refreshToken = createRefreshToken();
  const tokenHash = await sha256(refreshToken);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);
  await prisma.adminSession.create({ data: { adminId, tokenHash, expiresAt } });
  return { refreshToken, expiresAt };
}

export async function rotateRefreshSession(refreshToken: string) {
  const tokenHash = await sha256(refreshToken);
  const session = await prisma.adminSession.findUnique({
    where: { tokenHash },
    include: { admin: true }
  });

  if (!session || session.revokedAt || session.expiresAt <= new Date()) {
    return null;
  }

  await prisma.adminSession.update({
    where: { id: session.id },
    data: { revokedAt: new Date(), lastUsedAt: new Date() }
  });

  const next = await createAdminSession(session.adminId);
  return {
    admin: session.admin,
    refreshToken: next.refreshToken,
    accessToken: await signAccessToken(session.admin)
  };
}

export function authMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path;
    const method = c.req.method;
    const isPublic =
      path === "/" ||
      path === "/health" ||
      path.startsWith("/auth/") ||
      path.startsWith("/public/") ||
      path.startsWith("/assets/") ||
      (method === "GET" && /^\/forms\/(slug\/)?[^/]+$/.test(path)) ||
      (method === "POST" && /^\/forms\/[^/]+\/submissions$/.test(path));

    if (isPublic) {
      await next();
      return;
    }

    const token = getAccessCookie(c);
    if (!token) return c.json({ error: "Missing access token" }, 401);

    try {
      const payload = await verifyAccessToken(token);
      c.set("admin", payload);
      await next();
    } catch {
      return c.json({ error: "Invalid or expired access token" }, 401);
    }
  };
}
