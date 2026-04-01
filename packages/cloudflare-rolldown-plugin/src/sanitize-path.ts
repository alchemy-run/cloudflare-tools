const POSTFIX_REGEX = /[?#].*$/;

export function sanitizePath(path: string): string {
  return path.replace(POSTFIX_REGEX, "");
}
