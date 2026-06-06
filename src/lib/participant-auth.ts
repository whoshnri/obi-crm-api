import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { prisma } from "./prisma.js";
import { createRefreshToken, sha256 } from "./auth.js";

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAGIC_LINK_TTL_SECONDS = 30 * 60;
export const PARTICIPANT_ACCESS_COOKIE = "obi_participant_access_token";
export const PARTICIPANT_REFRESH_COOKIE = "obi_participant_refresh_token";

function isSecureCookieEnvironment() {
  return process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
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

type ParticipantJwtPayload = {
  sub: string;
  email: string;
  type: "participant";
  exp: number;
  iat: number;
};

type ParticipantPasswordSetupJwtPayload = {
  sub: string;
  email: string;
  type: "participant_password_setup";
  exp: number;
  iat: number;
};

function getSecret() {
  const secret = process.env.OBI_JWT_SECRET ?? process.env.JWT_SECRET;
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

export async function signParticipantAccessToken(participant: { id: string; email: string }) {
  const now = Math.floor(Date.now() / 1000);
  const payload: ParticipantJwtPayload = {
    sub: participant.id,
    email: participant.email,
    type: "participant",
    iat: now,
    exp: now + ACCESS_TOKEN_TTL_SECONDS
  };
  const header = { alg: "HS256", typ: "JWT" };
  const body = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = base64Url(await hmac(body));
  return `${body}.${signature}`;
}

export async function verifyParticipantAccessToken(token: string) {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) throw new Error("Invalid access token");

  const expected = base64Url(await hmac(`${header}.${payload}`));
  if (expected !== signature) throw new Error("Invalid access token signature");

  const parsed = JSON.parse(fromBase64Url(payload)) as ParticipantJwtPayload;
  if (parsed.type !== "participant") throw new Error("Invalid token type");
  if (parsed.exp <= Math.floor(Date.now() / 1000)) throw new Error("Access token expired");
  return parsed;
}

export async function signParticipantPasswordSetupToken(participant: { id: string; email: string }) {
  const now = Math.floor(Date.now() / 1000);
  const payload: ParticipantPasswordSetupJwtPayload = {
    sub: participant.id,
    email: participant.email,
    type: "participant_password_setup",
    iat: now,
    exp: now + MAGIC_LINK_TTL_SECONDS
  };
  const header = { alg: "HS256", typ: "JWT" };
  const body = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = base64Url(await hmac(body));
  return `${body}.${signature}`;
}

export async function verifyParticipantPasswordSetupToken(token: string) {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) throw new Error("Invalid password setup token");

  const expected = base64Url(await hmac(`${header}.${payload}`));
  if (expected !== signature) throw new Error("Invalid password setup token signature");

  const parsed = JSON.parse(fromBase64Url(payload)) as ParticipantPasswordSetupJwtPayload;
  if (parsed.type !== "participant_password_setup") throw new Error("Invalid password setup token type");
  if (parsed.exp <= Math.floor(Date.now() / 1000)) throw new Error("Password setup token expired");
  return parsed;
}

export function setParticipantRefreshCookie(c: Context, token: string) {
  setCookie(c, PARTICIPANT_REFRESH_COOKIE, token, getCookieOptions(REFRESH_TOKEN_TTL_SECONDS));
}

export function setParticipantAccessCookie(c: Context, token: string) {
  setCookie(c, PARTICIPANT_ACCESS_COOKIE, token, getCookieOptions(ACCESS_TOKEN_TTL_SECONDS));
}

export function clearParticipantAccessCookie(c: Context) {
  deleteCookie(c, PARTICIPANT_ACCESS_COOKIE, getCookieOptions(0));
}

export function clearParticipantRefreshCookie(c: Context) {
  deleteCookie(c, PARTICIPANT_REFRESH_COOKIE, getCookieOptions(0));
}

export function getParticipantAccessCookie(c: Context) {
  return getCookie(c, PARTICIPANT_ACCESS_COOKIE);
}

export function getParticipantRefreshCookie(c: Context) {
  return getCookie(c, PARTICIPANT_REFRESH_COOKIE);
}

export async function createParticipantSession(participantId: string) {
  const refreshToken = createRefreshToken();
  const tokenHash = await sha256(refreshToken);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);
  await prisma.participantSession.create({ data: { participantId, tokenHash, expiresAt } });
  return { refreshToken, expiresAt };
}

export async function rotateParticipantRefreshSession(refreshToken: string) {
  const tokenHash = await sha256(refreshToken);
  const session = await prisma.participantSession.findUnique({
    where: { tokenHash },
    include: { participant: true }
  });

  if (!session || session.revokedAt || session.expiresAt <= new Date()) {
    return null;
  }

  await prisma.participantSession.update({
    where: { id: session.id },
    data: { revokedAt: new Date(), lastUsedAt: new Date() }
  });

  const next = await createParticipantSession(session.participantId);
  return {
    participant: session.participant,
    refreshToken: next.refreshToken,
    accessToken: await signParticipantAccessToken(session.participant)
  };
}

export function createMagicLinkToken() {
  return crypto.randomUUID() + "." + base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export function getMagicLinkExpiry() {
  return new Date(Date.now() + MAGIC_LINK_TTL_SECONDS * 1000);
}

export function getPortalOrigin() {
  return process.env.OBI_PORTAL_ORIGIN ?? "http://localhost:3003";
}

export function getFormsAppOrigin() {
  return process.env.OBI_CUSTOM_FORMS_APP_ORIGIN ?? "http://localhost:3000";
}

export function participantAuthMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const token = getParticipantAccessCookie(c);
    if (!token) return c.json({ error: "Missing access token" }, 401);

    try {
      const payload = await verifyParticipantAccessToken(token);
      c.set("participant", payload);
      await next();
    } catch {
      return c.json({ error: "Invalid or expired access token" }, 401);
    }
  };
}
