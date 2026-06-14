import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { enrollParticipant } from "../lib/enrollment.js";
import { prisma } from "../lib/prisma.js";
import { handleRoute } from "../lib/http.js";
import { serializeOrganisationSummary, serializeRegistrationPage } from "../lib/serializers.js";
import { trackAnalyticsEvent } from "../lib/analytics.js";
import { uniqueSlug } from "../lib/slug.js";

const publicCreateOrganisationSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).optional(),
  website: z.string().optional().nullable(),
  size: z.enum(["solo", "small", "medium", "large", "enterprise"]).optional().nullable(),
  industry: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  contactName: z.string().optional().nullable(),
  contactEmail: z.string().email().optional().nullable(),
  contactPhone: z.string().optional().nullable()
});

const publicCreateCohortSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).optional(),
  organisationId: z.string().min(1).optional().nullable(),
  description: z.string().optional().nullable(),
  maxSize: z.number().int().positive().optional().nullable(),
  startDate: z.string().optional().nullable(),
  endDate: z.string().optional().nullable()
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getStringValue(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return value === undefined || value === null ? "" : String(value).trim();
}

function badRequest(c: Context, error: string, details?: Record<string, unknown>) {
  return c.json({ success: false, error, ...details }, 400);
}

async function validateEnrollableCohort(programmeId: string, cohortId: string) {
  const link = await prisma.cohortProgramme.findUnique({
    where: {
      cohortId_programmeId: {
        cohortId,
        programmeId
      }
    }
  });

  if (!link) {
    return { ok: false as const, error: "Selected cohort is not linked to this programme." };
  }

  const cohort = await prisma.cohort.findUnique({
    where: { id: cohortId },
    select: {
      id: true,
      status: true,
      maxSize: true,
      _count: { select: { participants: true } }
    }
  });

  if (!cohort) {
    return { ok: false as const, error: "Selected cohort could not be found." };
  }

  if (cohort.status !== "active") {
    return { ok: false as const, error: "Selected cohort is not open for enrollment." };
  }

  if (cohort.maxSize && cohort._count.participants >= cohort.maxSize) {
    return { ok: false as const, error: "Selected cohort is already full." };
  }

  return { ok: true as const, cohort };
}

const enrollKnownColumns = new Set([
  "programId",
  "programmeId",
  "cohortId",
  "organisationId",
  "name",
  "fullName",
  "full_name",
  "email",
  "organisation",
  "organization",
  "phone",
  "address",
  "notes"
]);

export const publicRouter = new Hono()
  .get("/organisations", (c) =>
    handleRoute(c, async () => {
      const organisations = await prisma.organisation.findMany({
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          slug: true,
          industry: true,
          size: true
        }
      });

      return organisations;
    })
  )
  .post("/organisations", (c) =>
    handleRoute(c, async () => {
      const body = await c.req.json().catch(() => null);
      const payload = isRecord(body) && isRecord(body.data) ? body.data : body;
      if (!isRecord(payload)) return badRequest(c, "Expected a JSON object.");

      const input = publicCreateOrganisationSchema.parse(payload);
      const slug =
        input.slug ??
        (await uniqueSlug(input.name, async (candidate) => {
          const existing = await prisma.organisation.findUnique({ where: { slug: candidate } });
          return Boolean(existing);
        }, "org"));

      const organisation = await prisma.organisation.create({
        data: {
          name: input.name.trim(),
          slug,
          website: input.website?.trim() || null,
          size: input.size ?? null,
          industry: input.industry?.trim() || null,
          address: input.address?.trim() || null,
          contactName: input.contactName?.trim() || null,
          contactEmail: input.contactEmail?.trim() || null,
          contactPhone: input.contactPhone?.trim() || null
        }
      });

      return serializeOrganisationSummary(organisation);
    })
  )
  .post("/cohorts", (c) =>
    handleRoute(c, async () => {
      const body = await c.req.json().catch(() => null);
      const payload = isRecord(body) && isRecord(body.data) ? body.data : body;
      if (!isRecord(payload)) return badRequest(c, "Expected a JSON object.");

      const input = publicCreateCohortSchema.parse({
        ...payload,
        maxSize:
          payload.maxSize === undefined || payload.maxSize === null || payload.maxSize === ""
            ? undefined
            : Number(payload.maxSize)
      });

      const organisationId = input.organisationId?.trim() || null;

      if (organisationId) {
        const organisation = await prisma.organisation.findUnique({
          where: { id: organisationId },
          select: { id: true }
        });

        if (!organisation) return badRequest(c, "Organisation not found.");
      }

      const slug =
        input.slug ??
        (await uniqueSlug(input.name, async (candidate) => {
          const existing = await prisma.cohort.findUnique({ where: { slug: candidate } });
          return Boolean(existing);
        }, "cohort"));

      const cohort = await prisma.cohort.create({
        data: {
          name: input.name.trim(),
          slug,
          type: organisationId ? "org_specific" : "open",
          status: "active",
          organisationId,
          description: input.description?.trim() || null,
          maxSize: input.maxSize ?? null,
          startDate: input.startDate ? new Date(input.startDate) : null,
          endDate: input.endDate ? new Date(input.endDate) : null,
          eventFlows: {
            create: {
              flow: {},
              deployedAt: null
            }
          },
          commsChannel: {
            create: {}
          }
        },
        select: {
          id: true,
          name: true,
          slug: true,
          organisationId: true,
          status: true,
          maxSize: true,
          description: true,
          startDate: true,
          endDate: true
        }
      });

      return {
        ...cohort,
        startDate: cohort.startDate?.toISOString() ?? undefined,
        endDate: cohort.endDate?.toISOString() ?? undefined
      };
    })
  )
  .get("/enroll/:programmeId", (c) =>
    handleRoute(c, async () => {
      const programmeId = c.req.param("programmeId");
      const programme = await prisma.programme.findUnique({
        where: { id: programmeId },
        select: {
          id: true,
          name: true,
          startDate: true,
          registrationResourceId: true,
          registrationResource: {
            select: {
              id: true,
              label: true,
              url: true,
              type: true,
              description: true
            }
          }
        }
      });

      if (!programme) return null;

      const cohortLinks = await prisma.cohortProgramme.findMany({
        where: { programmeId },
        include: {
          cohort: {
            select: {
              id: true,
              name: true,
              slug: true,
              status: true,
              organisationId: true,
              maxSize: true,
              description: true,
              _count: { select: { participants: true } }
            }
          }
        },
        orderBy: { enrolledAt: "asc" }
      });

      const cohorts = cohortLinks
        .filter((link) => link.cohort.status === "active")
        .map((link) => {
          const participantCount = link.cohort._count.participants;
          const maxSize = link.cohort.maxSize ?? undefined;
          return {
            id: link.cohort.id,
            name: link.cohort.name,
            slug: link.cohort.slug,
            organisationId: link.cohort.organisationId ?? undefined,
            description: link.cohort.description ?? undefined,
            maxSize,
            participantCount,
            isFull: Boolean(maxSize && participantCount >= maxSize)
          };
        });

      const organisationId = c.req.query("organisationId")?.trim() || undefined;
      const filteredCohorts = organisationId
        ? cohorts.filter((cohort) => cohort.organisationId === organisationId)
        : cohorts;

      const preloadedOrganisation = organisationId
        ? await prisma.organisation.findUnique({
            where: { id: organisationId },
            select: { id: true, name: true, slug: true }
          })
        : null;

      return {
        id: programme.id,
        name: programme.name,
        startDate: programme.startDate.toISOString(),
        registrationResourceId: programme.registrationResourceId ?? undefined,
        registrationResource: programme.registrationResource ?? undefined,
        preloadedOrganisation: preloadedOrganisation ?? undefined,
        cohorts: filteredCohorts
      };
    })
  )
  .post("/forms/:slug/access-check", (c) =>
    handleRoute(c, async () => {
      const slug = c.req.param("slug");
      const body = await c.req.json().catch(() => null);
      const payload = isRecord(body) && isRecord(body.data) ? body.data : body;
      if (!isRecord(payload)) return badRequest(c, "Expected a JSON object.");

      const email = getStringValue(payload, "email");
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return badRequest(c, "A valid email address is required.");
      }

      const form = await prisma.form.findUnique({
        where: { slug },
        select: { id: true, programmeId: true }
      });

      if (!form) {
        return c.json({ allowed: false, error: "Form not found." }, 404);
      }

      if (!form.programmeId) {
        return { allowed: true };
      }

      const normalizedEmail = email.trim().toLowerCase();
      const participant = await prisma.participant.findFirst({
        where: {
          email: normalizedEmail,
          programmes: {
            some: {
              programmeId: form.programmeId
            }
          }
        },
        select: { id: true }
      });

      if (!participant) {
        return { allowed: false, error: "No participant found for that email in this programme." };
      }

      return { allowed: true };
    })
  )
  .post("/enroll-participant", (c) =>
    handleRoute(c, async () => {
      const body = await c.req.json().catch(() => null);
      const payload = isRecord(body) && isRecord(body.data) ? body.data : body;
      if (!isRecord(payload)) return badRequest(c, "Expected a JSON object.");

      const programmeId =
        c.req.query("programId") ||
        c.req.query("programmeId") ||
        getStringValue(payload, "programId") ||
        getStringValue(payload, "programmeId");

      if (!programmeId) return badRequest(c, "Programme id is required.");

      const programme = await prisma.programme.findUnique({
        where: { id: programmeId },
        select: { id: true }
      });

      if (!programme) return c.json({ success: false, error: "Programme not found." }, 404);

      const email = getStringValue(payload, "email");
      const name = getStringValue(payload, "name") || getStringValue(payload, "fullName") || getStringValue(payload, "full_name");
      const organisationId = getStringValue(payload, "organisationId") || undefined;
      const cohortId = getStringValue(payload, "cohortId") || undefined;
      const phone = getStringValue(payload, "phone") || undefined;
      const address = getStringValue(payload, "address") || undefined;
      const directNotes = getStringValue(payload, "notes") || undefined;

      if (!name) return badRequest(c, "Name is required.");
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return badRequest(c, "A valid email address is required.");

      if (organisationId) {
        const organisation = await prisma.organisation.findUnique({
          where: { id: organisationId },
          select: { id: true }
        });
        if (!organisation) return badRequest(c, "Selected organisation could not be found.");
      }

      if (cohortId) {
        const cohortValidation = await validateEnrollableCohort(programme.id, cohortId);
        if (!cohortValidation.ok) return badRequest(c, cohortValidation.error);
      }

      const extraFields = Object.entries(payload).reduce<Record<string, string>>((acc, [key, value]) => {
        if (!enrollKnownColumns.has(key) && value !== undefined && value !== null && String(value).trim()) acc[key] = String(value).trim();
        return acc;
      }, {});

      const notes = directNotes;
      const metadata = Object.keys(extraFields).length ? { enrollment: extraFields } : {};

      try {
        await enrollParticipant({
          programmeId: programme.id,
          cohortId,
          name,
          email,
          phone,
          address,
          notes,
          organisationId,
          metadata: Object.keys(metadata).length ? metadata : undefined
        });
      } catch (error) {
        if (isRecord(error) && error.code === "P2002") return c.json({ success: false, error: "Participant already exists." }, 409);
        throw error;
      }

      return c.json({ success: true }, 201);
    })
  )
  .get("/register/:slug", (c) =>
    handleRoute(c, async () => {
      const slug = c.req.param("slug");
      const page = await prisma.registrationPage.findUnique({
        where: { slug },
        include: {
          cohort: {
            include: {
              organisation: true,
              programmes: {
                include: { programme: true },
                orderBy: { enrolledAt: "asc" }
              }
            }
          }
        }
      });

      if (!page) return null;

      const cohort = page.cohort;
      const organisation = cohort.organisation;
      const logoUrl = page.logoUrl ?? cohort.logoUrl ?? organisation?.logoUrl ?? undefined;

      return {
        ...serializeRegistrationPage(page),
        logoUrl,
        cohort: {
          id: cohort.id,
          name: cohort.name,
          slug: cohort.slug,
          logoUrl: cohort.logoUrl ?? undefined,
          description: cohort.description ?? undefined
        },
        organisation: organisation
          ? {
              id: organisation.id,
              name: organisation.name,
              slug: organisation.slug,
              logoUrl: organisation.logoUrl ?? undefined,
              website: organisation.website ?? undefined
            }
          : undefined,
        programmes: cohort.programmes.map((link) => ({
          id: link.programme.id,
          name: link.programme.name,
          startDate: link.programme.startDate.toISOString()
        }))
      };
    })
  )
  .post("/register/:slug", (c) =>
    handleRoute(c, async () => {
      const slug = c.req.param("slug");
      const body = await c.req.json().catch(() => null);
      const payload = isRecord(body) && isRecord(body.data) ? body.data : body;
      if (!isRecord(payload)) return badRequest(c, "Expected a JSON object.");

      const page = await prisma.registrationPage.findUnique({
        where: { slug },
        include: {
          cohort: {
            include: {
              organisation: true,
              programmes: { orderBy: { enrolledAt: "asc" } }
            }
          }
        }
      });

      if (!page) return c.json({ success: false, error: "Registration page not found." }, 404);
      if (!page.isPublished) return c.json({ success: false, error: "Registration page is not published." }, 403);
      if (page.expiresAt && page.expiresAt < new Date()) {
        return c.json({ success: false, error: "Registration page has expired." }, 403);
      }

      const programmeId =
        getStringValue(payload, "programmeId") ||
        getStringValue(payload, "programId") ||
        page.cohort.programmes[0]?.programmeId;

      if (!programmeId) return badRequest(c, "Programme id is required.");

      const email = getStringValue(payload, "email");
      const name = getStringValue(payload, "name") || getStringValue(payload, "fullName") || getStringValue(payload, "full_name");
      const organisationId =
        getStringValue(payload, "organisationId") ||
        page.cohort.organisationId ||
        undefined;
      const phone = getStringValue(payload, "phone") || undefined;
      const address = getStringValue(payload, "address") || undefined;
      const notes = getStringValue(payload, "notes") || undefined;

      if (!name) return badRequest(c, "Name is required.");
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return badRequest(c, "A valid email address is required.");

      if (organisationId) {
        const organisation = await prisma.organisation.findUnique({
          where: { id: organisationId },
          select: { id: true }
        });
        if (!organisation) return badRequest(c, "Selected organisation could not be found.");
      }

      const knownColumns = new Set([
        "programId",
        "programmeId",
        "organisationId",
        "name",
        "fullName",
        "full_name",
        "email",
        "organisation",
        "organization",
        "phone",
        "address",
        "notes",
        "answers"
      ]);
      const extraFields = Object.entries(payload).reduce<Record<string, string>>((acc, [key, value]) => {
        if (!knownColumns.has(key) && value !== undefined && value !== null && String(value).trim()) acc[key] = String(value).trim();
        return acc;
      }, {});

      const answers = isRecord(payload.answers) ? payload.answers : payload;
      const metadata = Object.keys(extraFields).length ? { registration: extraFields } : {};

      try {
        const result = await enrollParticipant({
          programmeId,
          cohortId: page.cohortId,
          name,
          email,
          phone,
          address,
          notes,
          metadata: Object.keys(metadata).length ? metadata : undefined,
          organisationId
        });

        await prisma.registrationSubmission.create({
          data: {
            registrationPageId: page.id,
            participantId: result.participant.id,
            answers: answers as object,
            metadata: (Object.keys(metadata).length ? metadata : {}) as object
          }
        });

        void trackAnalyticsEvent({
          type: "form_submitted",
          participantId: result.participant.id,
          programmeId,
          cohortId: page.cohortId,
          organisationId: page.cohort.organisationId ?? undefined,
          payload: {
            source: "registration",
            registrationPageId: page.id,
            registrationSlug: slug
          }
        }).catch((trackError) => console.error("failed to track registration submission", trackError));
      } catch (error) {
        if (isRecord(error) && error.code === "P2002") return c.json({ success: false, error: "Participant already exists." }, 409);
        throw error;
      }

      return c.json({ success: true }, 201);
    })
  );
