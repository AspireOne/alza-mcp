const URL_PATTERN = /\b(?:https?|wss?|socks5?):\/\/[^\s"'<>]+/gi;

export function redactSensitiveText(text: string, secrets: readonly string[] = []): string {
  let redacted = text;
  for (const secret of secrets) {
    if (!secret) continue;
    redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted.replace(URL_PATTERN, (url) => redactUrl(url));
}

export function sensitiveUrlParts(value: string | undefined): string[] {
  if (!value) return [];
  const parts = [value];
  try {
    const url = new URL(value);
    parts.push(decode(url.username), decode(url.password));
    for (const segment of url.pathname.split("/")) parts.push(decode(segment));
    for (const queryValue of url.searchParams.values()) parts.push(decode(queryValue));
  } catch {
    // The complete malformed value is still redacted.
  }
  return parts.filter((part) => part.length > 0);
}

export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!/^(?:https?|wss?|socks5?):$/.test(url.protocol)) return "[redacted-url]";
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return "[redacted-url]";
  }
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
