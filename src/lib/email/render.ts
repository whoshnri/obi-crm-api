type RenderContext = {
  participant: Record<string, unknown>;
  // programme: Record<string, unknown>;
};

function getPathValue(context: RenderContext, path: string) {
  const parts = path.split(".").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return "";

  if (parts.length === 1) {
    const key = parts[0];
    return context.participant[key]
  }

  const root = parts[0] === "participant" ? context.participant : null;
  if (!root) return "";

  return parts.slice(1).reduce<unknown>((value, key) => {
    if (value && typeof value === "object" && key in value) {
      return (value as Record<string, unknown>)[key];
    }

    return "";
  }, root);
}

function stringifyVariable(value: unknown) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function renderEmailTemplate(template: string, context: RenderContext) {
  return template.replace(/\$\{\s*([^}]+?)\s*\}/g, (_match, path) => stringifyVariable(getPathValue(context, String(path))));
}
