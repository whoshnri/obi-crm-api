import { Hono } from "hono";
import type { Context } from "hono";
import { prisma } from "../lib/prisma";
import { handleRoute } from "../lib/http";

type ParticipantField = {
  key: string;
  label: string;
  type: "text" | "email" | "textarea";
  required: boolean;
  visible: boolean;
};

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

function getParticipantFields(value: unknown): ParticipantField[] | null {
  if (!isRecord(value) || !Array.isArray(value.fields)) return null;
  return value.fields.filter((field): field is ParticipantField => {
    if (!isRecord(field)) return false;
    return (
      typeof field.key === "string" &&
      typeof field.label === "string" &&
      ["text", "email", "textarea"].includes(String(field.type)) &&
      typeof field.required === "boolean" &&
      (typeof field.visible === "boolean" || field.visible === undefined)
    );
  }).map((field) => ({ ...field, visible: field.visible ?? true }));
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
          participantDefinition: true
        }
      });

      if (!programme) return null;

      const fields = getParticipantFields(programme.participantDefinition);

      return {
        id: programme.id,
        name: programme.name,
        startDate: programme.startDate.toISOString(),
        participantDefinition: {
          fields: fields?.filter((field) => field.visible) ?? []
        }
      };
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
        select: { id: true, participantDefinition: true }
      });

      if (!programme) return c.json({ success: false, error: "Programme not found." }, 404);

      const fields = getParticipantFields(programme.participantDefinition)?.filter((field) => field.visible);
      if (!fields) return c.json({ success: false, error: "Programme participant fields are not configured." }, 422);

      const missingRequiredField = fields.find((field) => field.required && !getStringValue(payload, field.key));
      if (missingRequiredField) {
        return badRequest(c, "Required field is missing.", {
          field: missingRequiredField.key,
          label: missingRequiredField.label
        });
      }

      const emailField = fields.find((field) => field.type === "email")?.key ?? "email";
      const nameField =
        fields.find((field) => field.key === "name")?.key ??
        fields.find((field) => field.label.toLowerCase().includes("name"))?.key ??
        fields.find((field) => field.type === "text")?.key ??
        "name";

      const email = getStringValue(payload, emailField);
      const name =
        getStringValue(payload, nameField) ||
        getStringValue(payload, "name") ||
        getStringValue(payload, "fullName") ||
        getStringValue(payload, "full_name");
      const organisation = getStringValue(payload, "organisation") || getStringValue(payload, "organization") || undefined;
      const phone = getStringValue(payload, "phone") || undefined;
      const address = getStringValue(payload, "address") || undefined;
      const directNotes = getStringValue(payload, "notes") || undefined;

      if (!name) return badRequest(c, "Name is required.");
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return badRequest(c, "A valid email address is required.");

      const knownColumns = new Set([
        nameField,
        "name",
        "fullName",
        "full_name",
        emailField,
        "email",
        "organisation",
        "organization",
        "phone",
        "address",
        "notes"
      ]);
      const customFields = fields.reduce<Record<string, string>>((acc, field) => {
        if (!knownColumns.has(field.key)) {
          const value = getStringValue(payload, field.key);
          if (value) acc[field.key] = value;
        }
        return acc;
      }, {});

      const notes = Object.keys(customFields).length
        ? JSON.stringify({ notes: directNotes, participantData: customFields })
        : directNotes;

      try {
        await prisma.$transaction(async (tx) => {
          const participant = await tx.participant.upsert({
            where: { email },
            create: {
              name,
              email,
              organisation,
              phone,
              address,
              notes,
              metadata: Object.keys(customFields).length ? { participantData: customFields } : {}
            },
            update: {
              name,
              organisation,
              phone,
              address,
              notes,
              metadata: Object.keys(customFields).length ? { participantData: customFields } : undefined
            }
          });

          await tx.programmeParticipant.upsert({
            where: {
              programmeId_participantId: {
                programmeId: programme.id,
                participantId: participant.id
              }
            },
            create: {
              programmeId: programme.id,
              participantId: participant.id
            },
            update: {}
          });
        });
      } catch (error) {
        if (isRecord(error) && error.code === "P2002") return c.json({ success: false, error: "Participant already exists." }, 409);
        throw error;
      }

      return c.json({ success: true }, 201);
    })
  );
