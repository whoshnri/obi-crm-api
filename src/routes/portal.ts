import { Hono } from "hono";
import { verify } from "argon2";
import { z } from "zod";
import type { Prisma } from "../generated/client.js";
import { hashParticipantPassword, sha256 } from "../lib/auth.js";
import { answersSchema } from "../lib/form-contract.js";
import { handleRoute } from "../lib/http.js";
import { prisma, retryDatabaseOperation } from "../lib/prisma.js";
import {
  clearParticipantAccessCookie,
  clearParticipantRefreshCookie,
  createMagicLinkToken,
  createParticipantSession,
  getMagicLinkExpiry,
  getFormsAppOrigin,
  getParticipantAccessCookie,
  getParticipantRefreshCookie,
  getPortalOrigin,
  participantAuthMiddleware,
  rotateParticipantRefreshSession,
  setParticipantAccessCookie,
  setParticipantRefreshCookie,
  signParticipantPasswordSetupToken,
  signParticipantAccessToken,
  verifyParticipantPasswordSetupToken,
  verifyParticipantAccessToken
} from "../lib/participant-auth.js";
import { sendEmail } from "../jobs/utils.js";
import { trackAnalyticsEvent } from "../lib/analytics.js";
import { serializeParticipantForumThread } from "../lib/serializers.js";

const requestLinkSchema = z.object({
  email: z.string().email(),
  app: z.enum(["portal", "forms"]).optional(),
  nextPath: z
    .string()
    .optional()
    .refine((value) => value === undefined || value.startsWith("/"), {
      message: "nextPath must start with /"
    })
});

const participantAuthOptionsSchema = z.object({
  email: z.string().email()
});

const participantLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

const participantSetPasswordSchema = z
  .object({
    token: z.string().min(1),
    password: z.string().min(8),
    confirmPassword: z.string().min(8)
  })
  .refine((input) => input.password === input.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"]
  });

const participantSettingsSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  organisation: z.string().trim().max(200).optional().nullable(),
  address: z.string().trim().max(500).optional().nullable(),
  phone: z.string().trim().max(50).optional().nullable(),
  socialLinks: z.array(z.string().trim().url("Enter valid links")).max(6).default([])
});

const participantChangePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required"),
    password: z.string().min(8, "Password must be at least 8 characters"),
    confirmPassword: z.string().min(8, "Confirm your new password")
  })
  .refine((input) => input.password === input.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"]
  });

const forumThreadSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  isPinned: z.boolean().optional()
});

const forumReplySchema = z.object({
  body: z.string().min(1),
  parentId: z.string().min(1).optional().nullable()
});

const requestResponseSchema = z.object({
  content: z.record(z.string(), z.unknown()).optional(),
  answers: answersSchema.optional()
}).refine((input) => input.content || input.answers, {
  message: "Response content is required"
});

const participantSelect = { id: true, name: true, email: true } as const;

const forumThreadInclude = {
  author: { select: participantSelect },
  replies: {
    include: { author: { select: participantSelect } },
    orderBy: { createdAt: "asc" as const }
  }
};

type ParticipantAuthPayload = {
  sub: string;
  email: string;
  type: "participant";
};

type ParticipantAuthRecord = {
  id: string;
  name: string;
  email: string;
  organisation: string | null;
  address: string | null;
  phone: string | null;
  socialLinks: string[];
  photoId: string | null;
  password: string | null;
};

function getParticipantPayload(c: { get: (key: never) => unknown }) {
  return c.get("participant" as never) as ParticipantAuthPayload;
}

function normalizeOptionalString(value?: string | null) {
  if (value == null) return null;
  const normalized = value.trim();
  return normalized.length ? normalized : null;
}

function serializeParticipant(participant: {
  id: string;
  name: string;
  email: string;
  organisation: string | null;
  address: string | null;
  phone: string | null;
  socialLinks: string[];
  photoId: string | null;
}) {
  return {
    id: participant.id,
    name: participant.name,
    email: participant.email,
    organisation: participant.organisation,
    address: participant.address,
    phone: participant.phone,
    socialLinks: participant.socialLinks,
    photoId: participant.photoId
  };
}

function isUniqueConstraintError(error: unknown, field: string) {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? (error as { code?: unknown }).code : undefined;
  if (code !== "P2002") return false;

  const meta = "meta" in error ? (error as { meta?: unknown }).meta : undefined;
  if (!meta || typeof meta !== "object") return false;
  const target = "target" in meta ? (meta as { target?: unknown }).target : undefined;

  return Array.isArray(target) && target.includes(field);
}

async function verifyParticipantPassword(input: string, stored: string) {
  if (stored.startsWith("$")) {
    return verify(stored, input);
  }
  return input === stored;
}

async function findParticipantByEmail(email: string) {
  return retryDatabaseOperation<ParticipantAuthRecord | null>(() =>
    prisma.participant.findUnique({
      where: { email }
    }) as Promise<ParticipantAuthRecord | null>
  );
}

export const portalRouter = new Hono()
  .post("/auth/options", (c) =>
    handleRoute(c, async () => {
      const input = participantAuthOptionsSchema.parse(await c.req.json());
      const participant = await findParticipantByEmail(input.email.trim().toLowerCase());
      return {
        method: participant?.password ? "password" : "magic_link"
      } as const;
    })
  )
  .post("/auth/login", (c) =>
    handleRoute(c, async () => {
      const input = participantLoginSchema.parse(await c.req.json());
      const participant = await findParticipantByEmail(input.email.trim().toLowerCase());

      if (!participant?.password) {
        clearParticipantAccessCookie(c);
        clearParticipantRefreshCookie(c);
        return c.json({ error: "Use your sign-in link to continue." }, 401);
      }

      const passwordMatches = await verifyParticipantPassword(input.password, participant.password);
      if (!passwordMatches) {
        clearParticipantAccessCookie(c);
        clearParticipantRefreshCookie(c);
        return c.json({ error: "Invalid email or password" }, 401);
      }

      const accessToken = await signParticipantAccessToken(participant);
      const { refreshToken } = await createParticipantSession(participant.id);
      setParticipantAccessCookie(c, accessToken);
      setParticipantRefreshCookie(c, refreshToken);

      void trackAnalyticsEvent({
        type: "portal_login",
        participantId: participant.id,
        payload: { source: "password" }
      }).catch((error) => console.error("failed to track portal_login", error));

      return {
        participant: serializeParticipant(participant)
      };
    })
  )
  .post("/auth/request-link", (c) =>
    handleRoute(c, async () => {
      const input = requestLinkSchema.parse(await c.req.json());
      const email = input.email.trim().toLowerCase();
      const participant = await findParticipantByEmail(email);

      if (!participant) {
        return { ok: true };
      }

      const rawToken = createMagicLinkToken();
      const tokenHash = await sha256(rawToken);
      await retryDatabaseOperation(() =>
        prisma.participantMagicLink.create({
          data: {
            participantId: participant.id,
            tokenHash,
            expiresAt: getMagicLinkExpiry()
          }
        })
      );

      const origin = input.app === "forms" ? getFormsAppOrigin() : getPortalOrigin();
      const verifyUrl = new URL("/auth/verify", origin);
      verifyUrl.searchParams.set("token", rawToken);
      if (input.nextPath) {
        verifyUrl.searchParams.set("next", input.nextPath);
      }
      const targetLabel = input.app === "forms" ? "OBI form" : "OBI participant portal";
      const subject = `Your ${targetLabel} sign-in link`;
      const body = [
        `Hi ${participant.name},`,
        "",
        `Use the link below to sign in to your ${input.app === "forms" ? "form" : "participant portal"}:`,
        verifyUrl.toString(),
        "",
        "This link expires in 30 minutes. If you did not request this, you can ignore this email."
      ].join("\n");

      if (process.env.NODE_ENV === "production") {
        await sendEmail(participant.email, subject, body);
      } else {
        console.log("[portal:magic-link]", verifyUrl);
        await sendEmail(participant.email, subject, body);
      }

      return { ok: true };
    })
  )
  .get("/auth/verify", (c) =>
    handleRoute(c, async () => {
      const token = c.req.query("token");
      if (!token) return c.json({ error: "Missing token" }, 400);

      const tokenHash = await sha256(token);
      const magicLink = await retryDatabaseOperation(() =>
        prisma.participantMagicLink.findUnique({
          where: { tokenHash },
          include: { participant: true }
        })
      );

      if (!magicLink || magicLink.usedAt || magicLink.expiresAt <= new Date()) {
        return c.json({ error: "Invalid or expired magic link" }, 401);
      }

      await retryDatabaseOperation(() =>
        prisma.participantMagicLink.update({
          where: { id: magicLink.id },
          data: { usedAt: new Date() }
        })
      );

      return {
        participant: serializeParticipant(magicLink.participant),
        requiresPasswordSetup: true,
        setupToken: await signParticipantPasswordSetupToken(magicLink.participant)
      };
    })
  )
  .post("/auth/set-password", (c) =>
    handleRoute(c, async () => {
      const input = participantSetPasswordSchema.parse(await c.req.json());
      const payload = await verifyParticipantPasswordSetupToken(input.token);
      const participant = await retryDatabaseOperation(() =>
        prisma.participant.findUnique({
          where: { id: payload.sub }
        })
      );

      if (!participant) {
        return c.json({ error: "Participant not found" }, 404);
      }

      const password = await hashParticipantPassword(input.password);
      await retryDatabaseOperation(() =>
        prisma.$transaction([
          prisma.participant.update({
            where: { id: participant.id },
            data: { password }
          }),
          prisma.participantSession.updateMany({
            where: { participantId: participant.id, revokedAt: null },
            data: { revokedAt: new Date() }
          })
        ])
      );

      const nextParticipant = { ...participant, password };
      const accessToken = await signParticipantAccessToken(nextParticipant);
      const { refreshToken } = await createParticipantSession(participant.id);
      setParticipantAccessCookie(c, accessToken);
      setParticipantRefreshCookie(c, refreshToken);

      void trackAnalyticsEvent({
        type: "portal_login",
        participantId: participant.id,
        payload: { source: "password_reset" }
      }).catch((error) => console.error("failed to track portal_login", error));

      return { participant: serializeParticipant(participant) };
    })
  )
  .post("/auth/refresh", (c) =>
    handleRoute(c, async () => {
      const refreshToken = getParticipantRefreshCookie(c);
      if (!refreshToken) {
        clearParticipantAccessCookie(c);
        return c.json({ error: "Missing refresh token" }, 401);
      }

      const rotated = await rotateParticipantRefreshSession(refreshToken);
      if (!rotated) {
        clearParticipantAccessCookie(c);
        clearParticipantRefreshCookie(c);
        return c.json({ error: "Invalid refresh token" }, 401);
      }

      setParticipantAccessCookie(c, rotated.accessToken);
      setParticipantRefreshCookie(c, rotated.refreshToken);
      return { participant: serializeParticipant(rotated.participant) };
    })
  )
  .post("/auth/logout", (c) =>
    handleRoute(c, async () => {
      const refreshToken = getParticipantRefreshCookie(c);
      if (refreshToken) {
        await prisma.participantSession.updateMany({
          where: { tokenHash: await sha256(refreshToken), revokedAt: null },
          data: { revokedAt: new Date() }
        });
      }
      clearParticipantAccessCookie(c);
      clearParticipantRefreshCookie(c);
      return { ok: true };
    })
  )
  .use("*", participantAuthMiddleware())
  .get("/me", (c) =>
    handleRoute(c, async () => {
      const accessToken = getParticipantAccessCookie(c);
      if (!accessToken) return c.json({ error: "Missing access token" }, 401);

      let payload: Awaited<ReturnType<typeof verifyParticipantAccessToken>>;
      try {
        payload = await verifyParticipantAccessToken(accessToken);
      } catch {
        return c.json({ error: "Invalid or expired access token" }, 401);
      }

      const participant = await retryDatabaseOperation(() =>
        prisma.participant.findUnique({ where: { id: payload.sub } })
      );
      if (!participant) return c.json({ error: "Participant not found" }, 401);

      return { participant: serializeParticipant(participant) };
    })
  )
  .patch("/me", (c) =>
    handleRoute(c, async () => {
      const payload = getParticipantPayload(c);
      const input = participantSettingsSchema.parse(await c.req.json());

      const participant = await retryDatabaseOperation(() =>
        prisma.participant.update({
          where: { id: payload.sub },
          data: {
            name: input.name.trim(),
            organisation: normalizeOptionalString(input.organisation),
            address: normalizeOptionalString(input.address),
            phone: normalizeOptionalString(input.phone),
            socialLinks: input.socialLinks.map((link) => link.trim())
          }
        })
      );

      return { participant: serializeParticipant(participant) };
    })
  )
  .post("/me/change-password", (c) =>
    handleRoute(c, async () => {
      const payload = getParticipantPayload(c);
      const input = participantChangePasswordSchema.parse(await c.req.json());
      const participant = await retryDatabaseOperation(() =>
        prisma.participant.findUnique({
          where: { id: payload.sub }
        })
      );

      if (!participant) {
        clearParticipantAccessCookie(c);
        clearParticipantRefreshCookie(c);
        return c.json({ error: "Participant not found" }, 404);
      }

      if (!participant.password) {
        return c.json({ error: "Set a password from your sign-in link first." }, 400);
      }

      const passwordMatches = await verifyParticipantPassword(input.currentPassword, participant.password);
      if (!passwordMatches) {
        return c.json({ error: "Current password is incorrect" }, 401);
      }

      const password = await hashParticipantPassword(input.password);
      await retryDatabaseOperation(() =>
        prisma.participant.update({
          where: { id: participant.id },
          data: { password }
        })
      );

      return { ok: true };
    })
  )
  .get("/programmes", (c) =>
    handleRoute(c, async () => {
      const payload = getParticipantPayload(c);
      const enrolments = await prisma.programmeParticipant.findMany({
        where: { participantId: payload.sub },
        include: {
          programme: {
            select: {
              id: true,
              name: true,
              description: true,
              startDate: true
            }
          },
          cohort: {
            select: {
              id: true,
              name: true,
              slug: true
            }
          }
        },
        orderBy: { createdAt: "desc" }
      });

      return {
        programmes: enrolments.map((entry) => ({
          id: entry.programme.id,
          name: entry.programme.name,
          description: entry.programme.description,
          startDate: entry.programme.startDate,
          cohort: entry.cohort,
          paymentStatus: entry.paymentStatus,
          enrolledAt: entry.createdAt
        }))
      };
    })
  )
  .get("/programmes/:programmeId", (c) =>
    handleRoute(c, async () => {
      const payload = getParticipantPayload(c);
      const programmeId = c.req.param("programmeId");

      const enrolment = await prisma.programmeParticipant.findUnique({
        where: {
          programmeId_participantId: {
            programmeId,
            participantId: payload.sub
          }
        },
        include: {
          programme: {
            include: {
              timeline: {
                include: {
                  milestones: {
                    orderBy: [{ order: "asc" }, { scheduledAt: "asc" }]
                  }
                }
              },
              resources: {
                orderBy: { createdAt: "desc" }
              }
            }
          },
          cohort: {
            select: {
              id: true,
              name: true,
              slug: true
            }
          }
        }
      });

      if (!enrolment) return c.json({ error: "Programme not found" }, 404);

      if (enrolment.programme.resources.length) {
        void Promise.all(
          enrolment.programme.resources.map((resource) =>
            trackAnalyticsEvent({
              type: "resource_viewed",
              participantId: payload.sub,
              programmeId,
              cohortId: enrolment.cohortId ?? undefined,
              payload: {
                resourceId: resource.id,
                resourceLabel: resource.label,
                resourceType: resource.type
              }
            })
          )
        ).catch((error) => console.error("failed to track resource_viewed", error));
      }

      const [requests, deliverables] = await Promise.all([
        prisma.participantRequest.findMany({
          where: {
            participantId: payload.sub,
            programmeId
          },
          include: {
            response: true,
            form: {
              select: {
                id: true,
                name: true,
                slug: true,
                description: true,
                status: true,
                sections: true
              }
            }
          },
          orderBy: { createdAt: "desc" }
        }),
        prisma.deliverable.findMany({
          where: {
            programmeId,
            OR: [{ participantId: payload.sub }, { participantId: null }]
          },
          orderBy: { createdAt: "desc" }
        })
      ]);

      return {
        programme: {
          id: enrolment.programme.id,
          name: enrolment.programme.name,
          description: enrolment.programme.description,
          startDate: enrolment.programme.startDate,
          cohort: enrolment.cohort,
          paymentStatus: enrolment.paymentStatus
        },
        timeline: enrolment.programme.timeline
          ? {
              id: enrolment.programme.timeline.id,
              milestones: enrolment.programme.timeline.milestones.map((milestone) => ({
                id: milestone.id,
                title: milestone.title,
                description: milestone.description,
                scheduledAt: milestone.scheduledAt,
                completedAt: milestone.completedAt,
                order: milestone.order
              }))
            }
          : null,
        resources: enrolment.programme.resources.map((resource) => ({
          id: resource.id,
          label: resource.label,
          url: resource.url,
          type: resource.type,
          description: resource.description
        })),
        requests: requests.map((request) => ({
          id: request.id,
          title: request.title,
          description: request.description,
          dueDate: request.dueDate,
          status: request.status,
          hasResponse: Boolean(request.response),
          formId: request.formId,
          linkUrl: request.linkUrl,
          form: request.form
            ? {
                id: request.form.id,
                name: request.form.name,
                slug: request.form.slug,
                description: request.form.description,
                status: request.form.status,
                sections: Array.isArray(request.form.sections) ? request.form.sections : []
              }
            : null,
          response: request.response
            ? {
                id: request.response.id,
                content:
                  request.response.content && typeof request.response.content === "object" && !Array.isArray(request.response.content)
                    ? request.response.content
                    : {},
                submittedAt: request.response.submittedAt
              }
            : null,
          createdAt: request.createdAt
        })),
        deliverables: deliverables.map((deliverable) => ({
          id: deliverable.id,
          title: deliverable.title,
          description: deliverable.description,
          status: deliverable.status,
          deliveryChannel: deliverable.deliveryChannel,
          resourceType: deliverable.resourceType,
          url: deliverable.url,
          scheduledAt: deliverable.scheduledAt,
          deliveredAt: deliverable.deliveredAt
        }))
      };
    })
  )
  .get("/forum", (c) =>
    handleRoute(c, async () => {
      const payload = getParticipantPayload(c);

      const [programmeEnrolments, cohortMemberships] = await Promise.all([
        prisma.programmeParticipant.findMany({
          where: { participantId: payload.sub },
          include: { programme: { select: { id: true, name: true } }, cohort: { select: { id: true, name: true, slug: true } } }
        }),
        prisma.cohortParticipant.findMany({
          where: { participantId: payload.sub },
          include: { cohort: { select: { id: true, name: true, slug: true } } }
        })
      ]);

      const programmes = programmeEnrolments.map((entry) => ({
        type: "programme" as const,
        id: entry.programme.id,
        name: entry.programme.name,
        cohort: entry.cohort
      }));

      const cohorts = cohortMemberships
        .filter((entry) => !programmes.some((p) => p.cohort?.id === entry.cohort.id))
        .map((entry) => ({
          type: "cohort" as const,
          id: entry.cohort.id,
          name: entry.cohort.name,
          slug: entry.cohort.slug
        }));

      return { channels: [...programmes, ...cohorts] };
    })
  )
  .get("/programmes/:programmeId/forum", (c) =>
    handleRoute(c, async () => {
      const payload = getParticipantPayload(c);
      const programmeId = c.req.param("programmeId");

      const enrolment = await prisma.programmeParticipant.findUnique({
        where: { programmeId_participantId: { programmeId, participantId: payload.sub } }
      });
      if (!enrolment) return c.json({ error: "Programme not found" }, 404);

      let channel = await prisma.programmeParticipantCommsChannel.findUnique({
        where: { programmeId },
        include: {
          threads: {
            include: forumThreadInclude,
            orderBy: [{ isPinned: "desc" }, { createdAt: "desc" }]
          }
        }
      });

      if (!channel) {
        try {
          channel = await prisma.programmeParticipantCommsChannel.create({
            data: { programmeId },
            include: {
              threads: {
                include: forumThreadInclude,
                orderBy: [{ isPinned: "desc" }, { createdAt: "desc" }]
              }
            }
          });
        } catch (error) {
          if (!isUniqueConstraintError(error, "programmeId")) throw error;

          channel = await prisma.programmeParticipantCommsChannel.findUnique({
            where: { programmeId },
            include: {
              threads: {
                include: forumThreadInclude,
                orderBy: [{ isPinned: "desc" }, { createdAt: "desc" }]
              }
            }
          });
        }
      }

      if (!channel) return c.json({ error: "Unable to open programme channel" }, 500);

      return {
        channelId: channel.id,
        programmeId,
        threads: channel.threads.map(serializeParticipantForumThread)
      };
    })
  )
  .post("/programmes/:programmeId/forum/threads", (c) =>
    handleRoute(c, async () => {
      const payload = getParticipantPayload(c);
      const programmeId = c.req.param("programmeId");
      const input = forumThreadSchema.parse(await c.req.json());

      const enrolment = await prisma.programmeParticipant.findUnique({
        where: { programmeId_participantId: { programmeId, participantId: payload.sub } }
      });
      if (!enrolment) return c.json({ error: "Programme not found" }, 404);

      let channel = await prisma.programmeParticipantCommsChannel.findUnique({
        where: { programmeId }
      });

      if (!channel) {
        try {
          channel = await prisma.programmeParticipantCommsChannel.create({
            data: { programmeId }
          });
        } catch (error) {
          if (!isUniqueConstraintError(error, "programmeId")) throw error;

          channel = await prisma.programmeParticipantCommsChannel.findUnique({
            where: { programmeId }
          });
        }
      }

      if (!channel) return c.json({ error: "Unable to open programme channel" }, 500);

      const thread = await prisma.programmeParticipantCommsThread.create({
        data: {
          channelId: channel.id,
          authorId: payload.sub,
          title: input.title,
          body: input.body,
          isPinned: input.isPinned ?? false
        },
        include: forumThreadInclude
      });

      void trackAnalyticsEvent({
        type: "forum_post",
        participantId: payload.sub,
        programmeId,
        cohortId: enrolment.cohortId ?? undefined
      }).catch((error) => console.error("failed to track forum_post", error));

      return serializeParticipantForumThread(thread);
    })
  )
  .post("/programme-forum/threads/:threadId/replies", (c) =>
    handleRoute(c, async () => {
      const payload = getParticipantPayload(c);
      const threadId = c.req.param("threadId");
      const input = forumReplySchema.parse(await c.req.json());

      const thread = await prisma.programmeParticipantCommsThread.findUnique({
        where: { id: threadId },
        include: { channel: true }
      });
      if (!thread) return c.json({ error: "Thread not found" }, 404);

      const enrolment = await prisma.programmeParticipant.findUnique({
        where: {
          programmeId_participantId: {
            programmeId: thread.channel.programmeId,
            participantId: payload.sub
          }
        }
      });
      if (!enrolment) return c.json({ error: "Forbidden" }, 403);

      const reply = await prisma.programmeParticipantCommsReply.create({
        data: {
          threadId,
          authorId: payload.sub,
          body: input.body,
          parentId: input.parentId ?? null
        },
        include: { author: { select: participantSelect } }
      });

      void trackAnalyticsEvent({
        type: "forum_reply",
        participantId: payload.sub,
        programmeId: thread.channel.programmeId,
        cohortId: enrolment.cohortId ?? undefined
      }).catch((error) => console.error("failed to track forum_reply", error));

      return {
        id: reply.id,
        body: reply.body,
        parentId: reply.parentId ?? undefined,
        createdAt: reply.createdAt.toISOString(),
        author: reply.author
      };
    })
  )
  .get("/cohorts/:cohortId/forum", (c) =>
    handleRoute(c, async () => {
      const payload = getParticipantPayload(c);
      const cohortId = c.req.param("cohortId");

      const membership = await prisma.cohortParticipant.findUnique({
        where: { cohortId_participantId: { cohortId, participantId: payload.sub } }
      });
      if (!membership) return c.json({ error: "Cohort not found" }, 404);

      const channel = await prisma.cohortCommsChannel.upsert({
        where: { cohortId },
        create: { cohortId },
        update: {},
        include: {
          threads: {
            include: forumThreadInclude,
            orderBy: [{ isPinned: "desc" }, { createdAt: "desc" }]
          }
        }
      });

      return {
        channelId: channel.id,
        cohortId,
        threads: channel.threads.map(serializeParticipantForumThread)
      };
    })
  )
  .post("/cohorts/:cohortId/forum/threads", (c) =>
    handleRoute(c, async () => {
      const payload = getParticipantPayload(c);
      const cohortId = c.req.param("cohortId");
      const input = forumThreadSchema.parse(await c.req.json());

      const membership = await prisma.cohortParticipant.findUnique({
        where: { cohortId_participantId: { cohortId, participantId: payload.sub } }
      });
      if (!membership) return c.json({ error: "Cohort not found" }, 404);

      const channel = await prisma.cohortCommsChannel.upsert({
        where: { cohortId },
        create: { cohortId },
        update: {}
      });

      const thread = await prisma.cohortCommsThread.create({
        data: {
          channelId: channel.id,
          authorId: payload.sub,
          title: input.title,
          body: input.body,
          isPinned: input.isPinned ?? false
        },
        include: forumThreadInclude
      });

      void trackAnalyticsEvent({
        type: "forum_post",
        participantId: payload.sub,
        cohortId
      }).catch((error) => console.error("failed to track forum_post", error));

      return serializeParticipantForumThread(thread);
    })
  )
  .post("/cohort-forum/threads/:threadId/replies", (c) =>
    handleRoute(c, async () => {
      const payload = getParticipantPayload(c);
      const threadId = c.req.param("threadId");
      const input = forumReplySchema.parse(await c.req.json());

      const thread = await prisma.cohortCommsThread.findUnique({
        where: { id: threadId },
        include: { channel: true }
      });
      if (!thread) return c.json({ error: "Thread not found" }, 404);

      const membership = await prisma.cohortParticipant.findUnique({
        where: {
          cohortId_participantId: {
            cohortId: thread.channel.cohortId,
            participantId: payload.sub
          }
        }
      });
      if (!membership) return c.json({ error: "Forbidden" }, 403);

      const reply = await prisma.cohortCommsReply.create({
        data: {
          threadId,
          authorId: payload.sub,
          body: input.body,
          parentId: input.parentId ?? null
        },
        include: { author: { select: participantSelect } }
      });

      void trackAnalyticsEvent({
        type: "forum_reply",
        participantId: payload.sub,
        cohortId: thread.channel.cohortId
      }).catch((error) => console.error("failed to track forum_reply", error));

      return {
        id: reply.id,
        body: reply.body,
        parentId: reply.parentId ?? undefined,
        createdAt: reply.createdAt.toISOString(),
        author: reply.author
      };
    })
  )
  .post("/requests/:requestId/responses", (c) =>
    handleRoute(c, async () => {
      const payload = getParticipantPayload(c);
      const requestId = c.req.param("requestId");
      const input = requestResponseSchema.parse(await c.req.json());

      const request = await prisma.participantRequest.findFirst({
        where: { id: requestId, participantId: payload.sub },
        include: {
          form: {
            select: {
              id: true,
              programmeId: true,
              cohortId: true
            }
          },
          response: true
        }
      });
      if (!request) return c.json({ error: "Request not found" }, 404);
      if (request.formId && !request.form) return c.json({ error: "Linked form not found" }, 404);
      if (request.formId && !input.answers) {
        return c.json({ error: "This request requires a form submission." }, 400);
      }

      const response = await prisma.$transaction(async (tx) => {
        let content: Record<string, unknown>;

        if (request.formId) {
          const submission = await tx.formSubmission.create({
            data: {
              formId: request.formId,
              respondentId: payload.sub,
              answers: input.answers as Prisma.InputJsonValue,
              metadata: {
                source: "portal_request",
                requestId
              } as Prisma.InputJsonValue
            }
          });

          content = {
            type: "form_submission",
            submissionId: submission.id
          };
        } else {
          content = input.content ?? {};
        }

        const saved = await tx.participantRequestResponse.upsert({
          where: { requestId },
          create: { requestId, content: content as Prisma.InputJsonValue },
          update: { content: content as Prisma.InputJsonValue, submittedAt: new Date() }
        });
        await tx.participantRequest.update({
          where: { id: requestId },
          data: { status: "submitted" }
        });
        return saved;
      });

      void trackAnalyticsEvent({
        type: "form_submitted",
        participantId: payload.sub,
        programmeId: request.programmeId ?? undefined,
        cohortId: request.cohortId ?? undefined,
        payload: { source: "participant_request", requestId }
      }).catch((error) => console.error("failed to track request response", error));

      return {
        id: response.id,
        requestId: response.requestId,
        submittedAt: response.submittedAt.toISOString()
      };
    })
  )
  .patch("/deliverables/:deliverableId/acknowledge", (c) =>
    handleRoute(c, async () => {
      return c.json({ error: "Deliverable acknowledgement is no longer supported." }, 410);
    })
  );
