export type TemplateVariableDefinition = {
  key: string;
  label?: string;
  description?: string;
};

export type TemplateButtonDefinition = {
  id: string;
  label: string;
  url: string;
  style: "button" | "link";
};

export type TemplateMetadata = {
  attachments?: Array<{ url: string; filename: string; mimeType?: string }>;
  variables?: TemplateVariableDefinition[];
  buttons?: TemplateButtonDefinition[];
};

const VARIABLE_PATTERN = /\{\{\s*([^}]+?)\s*\}\}|\$\{\s*([^}]+?)\s*\}/g;

export function parseTemplateMetadata(metadata: unknown): TemplateMetadata {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }
  const record = metadata as Record<string, unknown>;
  const variables = Array.isArray(record.variables)
    ? record.variables
        .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
        .map((item) => ({
          key: typeof item.key === "string" ? item.key : "",
          label: typeof item.label === "string" ? item.label : undefined,
          description: typeof item.description === "string" ? item.description : undefined,
        }))
        .filter((item) => item.key)
    : [];

  const buttons = Array.isArray(record.buttons)
    ? record.buttons
        .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
        .map((item, index) => ({
          id: typeof item.id === "string" ? item.id : `button-${index}`,
          label: typeof item.label === "string" ? item.label : "",
          url: typeof item.url === "string" ? item.url : "",
          style: item.style === "link" ? ("link" as const) : ("button" as const),
        }))
        .filter((item) => item.label && item.url)
    : [];

  const attachments = Array.isArray(record.attachments)
    ? record.attachments
        .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
        .map((item) => ({
          url: typeof item.url === "string" ? item.url : "",
          filename: typeof item.filename === "string" ? item.filename : "",
          mimeType: typeof item.mimeType === "string" ? item.mimeType : undefined,
        }))
        .filter((item) => item.url && item.filename)
    : undefined;

  return { attachments, variables, buttons };
}

export function extractVariableKeys(...sources: string[]) {
  const keys = new Set<string>();
  for (const source of sources) {
    if (!source) continue;
    for (const match of source.matchAll(VARIABLE_PATTERN)) {
      const raw = (match[1] ?? match[2] ?? "").trim();
      if (!raw) continue;
      keys.add(raw);
    }
  }
  return [...keys];
}

export function buildDefaultBindings(variables: TemplateVariableDefinition[]) {
  const scopePaths = [
    "participant.name",
    "participant.email",
    "participant.organisation",
    "participant.phone",
    "participant.address",
    "participant.notes",
    "participant.id",
    "programme.name",
    "event.name",
  ];
  return variables.reduce<Record<string, string>>((bindings, variable) => {
    if (scopePaths.includes(variable.key)) {
      bindings[variable.key] = variable.key;
      return bindings;
    }
    const suffix = scopePaths.find((path) => path.endsWith(`.${variable.key}`));
    if (suffix) bindings[variable.key] = suffix;
    return bindings;
  }, {});
}

export function getVariableBindingsFromConfig(config: Record<string, unknown>) {
  const raw = config.variableBindings;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

export function validateVariableBindings(
  variables: TemplateVariableDefinition[],
  bindings: Record<string, string> | undefined,
) {
  const missing = variables
    .map((variable) => variable.key)
    .filter((key) => !bindings?.[key]?.trim());
  return {
    valid: missing.length === 0,
    missing,
  };
}

export async function validatePipelineStepBindings(
  steps: Array<{ name: string; config: unknown }>,
  loadTemplate: (templateId: string) => Promise<{ metadata: unknown } | null>,
) {
  const issues: string[] = [];

  for (const step of steps) {
    const config =
      step.config && typeof step.config === "object" && !Array.isArray(step.config)
        ? (step.config as Record<string, unknown>)
        : {};
    const templateId = typeof config.templateId === "string" ? config.templateId.trim() : "";
    if (!templateId) {
      issues.push(`Step "${step.name}" is missing an email template.`);
      continue;
    }

    const template = await loadTemplate(templateId);
    if (!template) {
      issues.push(`Step "${step.name}" references a template that was not found.`);
      continue;
    }

    const metadata = parseTemplateMetadata(template.metadata);
    const validation = validateVariableBindings(
      metadata.variables ?? [],
      getVariableBindingsFromConfig(config),
    );
    if (!validation.valid) {
      issues.push(
        `Step "${step.name}" has unmapped variables: ${validation.missing.map((key) => `{{${key}}}`).join(", ")}`,
      );
    }
  }

  return { valid: issues.length === 0, issues };
}
