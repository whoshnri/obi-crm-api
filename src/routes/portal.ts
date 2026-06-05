import { Hono } from "hono";
import { z } from "zod";
import { sha256 } from "../lib/auth";
import { handleRoute } from "../lib/http";
import { prisma } from "../lib/prisma";
import {
  clearParticipantAccessCookie,
  clearParticipantRefreshCookie,
  createMagicLinkToken,
  createParticipantSession,
  getMagicLinkExpiry,
  getParticipantAccessCookie,
  getParticipantRefreshCookie,
  getPortalOrigin,
  participantAuthMiddleware,
  rotateParticipantRefreshSession,
  setParticipantAccessCookie,
  setParticipantRefreshCookie,
  signParticipantAccessToken,
  verifyParticipantAccessToken
} from "../lib/participant-auth";
import { sendEmail } from "../jobs/utils";
import { trackAnalyticsEvent } from "../lib/analytics";
import { serializeParticipantForumThread } from "../lib/serializers";

const requestLinkSchema = z.object({
  email: z.string().email()
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
  content: z.record(z.string(), z.unknown())
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

function getParticipantPayload(c: { get: (key: never) => unknown }) {
  return c.get("participant" as never) as ParticipantAuthPayload;
}

function serializeParticipant(participant: { id: string; name: string; email: string; organisation: string | null }) {
  return {
    id: participant.id,
    name: participant.name,
    email: participant.email,
    organisation: participant.organisation
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

export const portalRouter = new Hono()
  .post("/auth/request-link", (c) =>
    handleRoute(c, async () => {
      const input = requestLinkSchema.parse(await c.req.json());
      const email = input.email.trim().toLowerCase();
      const participant = await prisma.participant.findUnique({ where: { email } });

      if (!participant) {
        return { ok: true };
      }

      const rawToken = createMagicLinkToken();
      const tokenHash = await sha256(rawToken);
      await prisma.participantMagicLink.create({
        data: {
          participantId: participant.id,
          tokenHash,
          expiresAt: getMagicLinkExpiry()
        }
      });

      const verifyUrl = `${getPortalOrigin()}/auth/verify?token=${encodeURIComponent(rawToken)}`;
      const subject = "Your OBI participant portal sign-in link";
      const body = [
        `Hi ${participant.name},`,
        "",
        "Use the link below to sign in to your participant portal:",
        verifyUrl,
        "",
        "This link expires in 30 minutes. If you did not request this, you can ignore this email."
      ].join("\n");

      if (Bun.env.NODE_ENV === "production") {
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
      const magicLink = await prisma.participantMagicLink.findUnique({
        where: { tokenHash },
        include: { participant: true }
      });

      if (!magicLink || magicLink.usedAt || magicLink.expiresAt <= new Date()) {
        return c.json({ error: "Invalid or expired magic link" }, 401);
      }

      await prisma.participantMagicLink.update({
        where: { id: magicLink.id },
        data: { usedAt: new Date() }
      });

      const accessToken = await signParticipantAccessToken(magicLink.participant);
      const { refreshToken } = await createParticipantSession(magicLink.participant.id);
      setParticipantAccessCookie(c, accessToken);
      setParticipantRefreshCookie(c, refreshToken);

      void trackAnalyticsEvent({
        type: "portal_login",
        participantId: magicLink.participant.id,
        payload: { source: "magic_link" }
      }).catch((error) => console.error("failed to track portal_login", error));

      return {
        participant: serializeParticipant(magicLink.participant)
      };
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

      const participant = await prisma.participant.findUnique({ where: { id: payload.sub } });
      if (!participant) return c.json({ error: "Participant not found" }, 401);

      return { participant: serializeParticipant(participant) };
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
            response: true
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
          createdAt: request.createdAt
        })),
        deliverables: deliverables.map((deliverable) => ({
          id: deliverable.id,
          title: deliverable.title,
          description: deliverable.description,
          status: deliverable.status,
          resourceType: deliverable.resourceType,
          url: deliverable.url,
          scheduledAt: deliverable.scheduledAt,
          deliveredAt: deliverable.deliveredAt,
          acknowledgedAt: deliverable.acknowledgedAt
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
        where: { id: requestId, participantId: payload.sub }
      });
      if (!request) return c.json({ error: "Request not found" }, 404);

      const response = await prisma.$transaction(async (tx) => {
        const saved = await tx.participantRequestResponse.upsert({
          where: { requestId },
          create: { requestId, content: input.content as object },
          update: { content: input.content as object, submittedAt: new Date() }
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
      const payload = getParticipantPayload(c);
      const deliverableId = c.req.param("deliverableId");

      const deliverable = await prisma.deliverable.findFirst({
        where: {
          id: deliverableId,
          OR: [{ participantId: payload.sub }, { participantId: null }]
        }
      });
      if (!deliverable) return c.json({ error: "Deliverable not found" }, 404);

      const updated = await prisma.deliverable.update({
        where: { id: deliverableId },
        data: {
          status: "acknowledged",
          acknowledgedAt: new Date()
        }
      });

      void trackAnalyticsEvent({
        type: "deliverable_acknowledged",
        participantId: payload.sub,
        programmeId: deliverable.programmeId ?? undefined,
        cohortId: deliverable.cohortId ?? undefined,
        payload: { deliverableId }
      }).catch((error) => console.error("failed to track deliverable_acknowledged", error));

      return {
        id: updated.id,
        status: updated.status,
        acknowledgedAt: updated.acknowledgedAt?.toISOString()
      };
    })
  );
