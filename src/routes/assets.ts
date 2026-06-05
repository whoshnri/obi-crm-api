import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { handleRoute } from "../lib/http.js";

const assetsRoot = normalize(fileURLToPath(new URL("../../../assets", import.meta.url)));

function safeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-");
}

function assertInsideAssets(path: string) {
  const normalized = normalize(path);
  if (!normalized.startsWith(assetsRoot)) {
    throw new Error("Invalid asset path");
  }
  return normalized;
}

export const assetsRouter = new Hono()
  .post("/upload", (c) =>
    handleRoute(c, async () => {
      const body = await c.req.parseBody();
      const file = body.file;
      const formId = typeof body.formId === "string" ? body.formId : "unassigned";
      const questionId = typeof body.questionId === "string" ? body.questionId : "unknown";

      if (!(file instanceof File)) {
        return c.json({ error: "Missing file" }, 400);
      }

      const folder = assertInsideAssets(join(assetsRoot, "forms", safeSegment(formId)));
      await mkdir(folder, { recursive: true });

      const fileName = `${Date.now()}-${safeSegment(basename(file.name))}`;
      const storageKey = `forms/${safeSegment(formId)}/${fileName}`;
      const path = assertInsideAssets(join(assetsRoot, storageKey));
      await writeFile(path, Buffer.from(await file.arrayBuffer()));

      return {
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        url: `/assets/${storageKey}`,
        storageKey,
        questionId
      };
    })
  )
  .get("/*", (c) =>
    handleRoute(c, async () => {
      const key = c.req.path.replace(/^\/assets\//, "");
      const path = assertInsideAssets(join(assetsRoot, key));
      let file: Buffer;
      try {
        file = await readFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return c.json({ error: "Asset not found" }, 404);
        }
        throw error;
      }

      if (!file) {
        return c.json({ error: "Asset not found" }, 404);
      }

      return new Response(new Uint8Array(file));
    })
  );
