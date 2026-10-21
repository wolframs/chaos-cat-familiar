export function parseCcfProtocolUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") {
    return null;
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.protocol !== "ccf:") {
    return null;
  }

  const host = (url.host ?? "").toLowerCase();
  const pathParts = url.pathname.split("/").map((item) => item.trim()).filter(Boolean);

  if (host === "install") {
    const slug = (url.searchParams.get("slug") ?? pathParts[0] ?? "").trim().toLowerCase();
    return slug ? { action: "install", slug } : null;
  }

  return null;
}

export function findCcfProtocolArg(argv = []) {
  return argv.find((value) => typeof value === "string" && value.startsWith("ccf://")) ?? null;
}
