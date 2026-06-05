import { Hono } from "hono";
import type { Context } from "hono";
import { enrollParticipant } from "../lib/enrollment.js";
import { prisma } from "../lib/prisma.js";
import { handleRoute } from "../lib/http.js";
import { serializeRegistrationPage } from "../lib/serializers.js";
import { trackAnalyticsEvent } from "../lib/analytics.js";

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

export const publicRouter = new Hono()
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

      return {
        id: programme.id,
        name: programme.name,
        startDate: programme.startDate.toISOString(),
        registrationResourceId: programme.registrationResourceId ?? undefined,
        registrationResource: programme.registrationResource ?? undefined
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
      const organisation = getStringValue(payload, "organisation") || getStringValue(payload, "organization") || undefined;
      const phone = getStringValue(payload, "phone") || undefined;
      const address = getStringValue(payload, "address") || undefined;
      const directNotes = getStringValue(payload, "notes") || undefined;

      if (!name) return badRequest(c, "Name is required.");
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return badRequest(c, "A valid email address is required.");

      const knownColumns = new Set([
        "programId",
        "programmeId",
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
      const extraFields = Object.entries(payload).reduce<Record<string, string>>((acc, [key, value]) => {
        if (!knownColumns.has(key) && value !== undefined && value !== null && String(value).trim()) acc[key] = String(value).trim();
        return acc;
      }, {});

      const notes = directNotes;
      const metadata = Object.keys(extraFields).length ? { enrollment: extraFields } : {};

      try {
        await enrollParticipant({
          programmeId: programme.id,
          name,
          email,
          organisation,
          phone,
          address,
          notes,
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
      const organisation = getStringValue(payload, "organisation") || getStringValue(payload, "organization") || undefined;
      const phone = getStringValue(payload, "phone") || undefined;
      const address = getStringValue(payload, "address") || undefined;
      const notes = getStringValue(payload, "notes") || undefined;

      if (!name) return badRequest(c, "Name is required.");
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return badRequest(c, "A valid email address is required.");

      const knownColumns = new Set([
        "programId",
        "programmeId",
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
          organisation,
          phone,
          address,
          notes,
          metadata: Object.keys(metadata).length ? metadata : undefined,
          organisationId: page.cohort.organisationId ?? undefined
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
