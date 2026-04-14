const POSTFIX_REGEX = /[?#].*$/;

export function sanitizePath(path: string): string {
  return path.replace(POSTFIX_REGEX, "");
}

export function hasNodejsCompat(flags?: ReadonlyArray<string>): boolean {
  return flags?.some((flag) => flag === "nodejs_compat" || flag === "nodejs_compat_v2") ?? false;
}

export function hasNodejsAls(flags?: ReadonlyArray<string>): boolean {
  return flags?.some((flag) => flag === "nodejs_als") ?? false;
}
