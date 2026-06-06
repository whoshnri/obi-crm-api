import { Hono } from "hono";
import { Prisma } from "../generated/client.js";
import { z } from "zod";
import { handleRoute } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import { serializeBaseParticipant, serializeCohort, serializeOrganisation } from "../lib/serializers.js";
import { createOrganisationSchema, idParamSchema, updateOrganisationSchema } from "../lib/schemas.js";
import { uniqueSlug } from "../lib/slug.js";

const addOrganisationParticipantSchema = z.object({
  participantId: z.string().min(1),
  role: z.string().optional(),
  isPrimary: z.boolean().optional()
});

export const organisationsRouter = new Hono()
  .get("/", (c) =>
    handleRoute(c, async () => {
      const organisations = await prisma.organisation.findMany({
        orderBy: { name: "asc" },
        include: {
          _count: {
            select: { cohorts: true, participants: true }
          }
        }
      });

      return organisations.map(serializeOrganisation);
    })
  )
  .post("/", (c) =>
    handleRoute(c, async () => {
      const input = createOrganisationSchema.parse(await c.req.json());
      const slug =
        input.slug ??
        (await uniqueSlug(input.name, async (candidate) => {
          const existing = await prisma.organisation.findUnique({ where: { slug: candidate } });
          return Boolean(existing);
        }, "org"));

      const organisation = await prisma.organisation.create({
        data: {
          name: input.name,
          slug,
          logoUrl: input.logoUrl ?? null,
          website: input.website ?? null,
          size: input.size ?? null,
          industry: input.industry ?? null,
          address: input.address ?? null,
          contactName: input.contactName ?? null,
          contactEmail: input.contactEmail ?? null,
          contactPhone: input.contactPhone ?? null,
          parentOrganisationId: input.parentOrganisationId ?? null,
          metadata: (input.metadata ?? {}) as Prisma.InputJsonValue
        },
        include: {
          _count: {
            select: { cohorts: true, participants: true }
          }
        }
      });

      return serializeOrganisation(organisation);
    })
  )
  .get("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const organisation = await prisma.organisation.findUnique({
        where: { id },
        include: {
          cohorts: { orderBy: { createdAt: "desc" } },
          _count: {
            select: { participants: true, cohorts: true }
          }
        }
      });

      return organisation ? serializeOrganisation(organisation) : null;
    })
  )
  .patch("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = updateOrganisationSchema.parse(await c.req.json());

      let slug = input.slug;
      if (input.slug) {
        const taken = await prisma.organisation.findFirst({
          where: { slug: input.slug, NOT: { id } }
        });
        if (taken) throw new Error("Slug is already in use.");
      }

      const organisation = await prisma.organisation.update({
        where: { id },
        data: {
          name: input.name,
          slug,
          logoUrl: input.logoUrl,
          website: input.website,
          size: input.size,
          industry: input.industry,
          address: input.address,
          contactName: input.contactName,
          contactEmail: input.contactEmail,
          contactPhone: input.contactPhone,
          parentOrganisationId: input.parentOrganisationId,
          metadata: input.metadata as Prisma.InputJsonValue | undefined
        },
        include: {
          _count: {
            select: { cohorts: true, participants: true }
          }
        }
      });

      return serializeOrganisation(organisation);
    })
  )
  .delete("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      await prisma.organisation.delete({ where: { id } });
      return { ok: true };
    })
  )
  .get("/:id/cohorts", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const cohorts = await prisma.cohort.findMany({
        where: { organisationId: id },
        orderBy: { createdAt: "desc" },
        include: {
          _count: {
            select: { participants: true, programmes: true, registrationPages: true }
          }
        }
      });

      return cohorts.map(serializeCohort);
    })
  )
  .get("/:id/participants", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const links = await prisma.organisationParticipant.findMany({
        where: { organisationId: id },
        include: { participant: true },
        orderBy: { joinedAt: "desc" }
      });

      return links.map((link) => ({
        id: link.id,
        organisationId: link.organisationId,
        participantId: link.participantId,
        role: link.role ?? undefined,
        isPrimary: link.isPrimary,
        joinedAt: link.joinedAt.toISOString(),
        participant: serializeBaseParticipant(link.participant)
      }));
    })
  )
  .post("/:id/participants", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = addOrganisationParticipantSchema.parse(await c.req.json());

      const participant = await prisma.participant.findUnique({ where: { id: input.participantId } });
      if (!participant) {
        return c.json({ error: "Participant not found" }, 404);
      }
      console.log("here")

      const link = await prisma.organisationParticipant.upsert({
        where: {
          organisationId_participantId: {
            organisationId: id,
            participantId: input.participantId
          }
        },
        create: {
          organisationId: id,
          participantId: input.participantId,
          role: input.role ?? null,
          isPrimary: input.isPrimary ?? false
        },
        update: {
          role: input.role ?? undefined,
          isPrimary: input.isPrimary ?? undefined
        },
        include: { participant: true }
      });

      return {
        id: link.id,
        organisationId: link.organisationId,
        participantId: link.participantId,
        role: link.role ?? undefined,
        isPrimary: link.isPrimary,
        joinedAt: link.joinedAt.toISOString(),
        participant: serializeBaseParticipant(link.participant)
      };
    })
  );
