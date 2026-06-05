export function slugify(name: string, fallback = "item") {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || fallback
  );
}

export async function uniqueSlug(
  baseName: string,
  checkExists: (slug: string) => Promise<boolean>,
  fallback = "item"
) {
  let slug = slugify(baseName, fallback);
  let suffix = 0;
  while (await checkExists(slug)) {
    suffix += 1;
    slug = `${slugify(baseName, fallback)}-${suffix}`;
  }
  return slug;
}
