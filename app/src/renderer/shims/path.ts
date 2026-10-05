// `path` for the sandboxed page, which has no Node (phase 4): Node's POSIX path functions the HUD and the compat layer
// use, ported from Node's own algorithm (lib/path.js) so they agree on every input (tests/unit/path-shim.test.ts checks
// them against node:path). macOS only, so POSIX only. `resolve` has no working directory of its own: a relative path
// resolves against "/", and every path the HUD resolves is absolute already.

/** Resolves `.` and `..` in a path with no leading slash. */
function normalizeString(p: string, allowAboveRoot: boolean): string {
  let res = "";
  let lastSegmentLength = 0;
  let lastSlash = -1;
  let dots = 0;
  let code = 0;
  for (let i = 0; i <= p.length; ++i) {
    if (i < p.length) code = p.charCodeAt(i);
    else if (code === 47) break;
    else code = 47;
    if (code === 47) {
      if (lastSlash === i - 1 || dots === 1) {
        // a run of slashes, or "."
      } else if (dots === 2) {
        if (res.length < 2 || lastSegmentLength !== 2 || res.charCodeAt(res.length - 1) !== 46 || res.charCodeAt(res.length - 2) !== 46) {
          if (res.length > 2) {
            const lastSlashIndex = res.lastIndexOf("/");
            if (lastSlashIndex === -1) { res = ""; lastSegmentLength = 0; }
            else { res = res.slice(0, lastSlashIndex); lastSegmentLength = res.length - 1 - res.lastIndexOf("/"); }
            lastSlash = i;
            dots = 0;
            continue;
          } else if (res.length !== 0) {
            res = "";
            lastSegmentLength = 0;
            lastSlash = i;
            dots = 0;
            continue;
          }
        }
        if (allowAboveRoot) { res += res.length > 0 ? "/.." : ".."; lastSegmentLength = 2; }
      } else {
        if (res.length > 0) res += `/${p.slice(lastSlash + 1, i)}`;
        else res = p.slice(lastSlash + 1, i);
        lastSegmentLength = i - lastSlash - 1;
      }
      lastSlash = i;
      dots = 0;
    } else if (code === 46 && dots !== -1) {
      ++dots;
    } else {
      dots = -1;
    }
  }
  return res;
}

export const sep = "/";
export const delimiter = ":";

export function isAbsolute(p: string): boolean { return p.length > 0 && p.charCodeAt(0) === 47; }

export function normalize(p: string): string {
  if (p.length === 0) return ".";
  const absolute = isAbsolute(p);
  const trailing = p.charCodeAt(p.length - 1) === 47;
  let out = normalizeString(p, !absolute);
  if (out.length === 0) {
    if (absolute) return "/";
    return trailing ? "./" : ".";
  }
  if (trailing) out += "/";
  return absolute ? `/${out}` : out;
}

export function join(...parts: string[]): string {
  if (parts.length === 0) return ".";
  const joined = parts.filter((a) => a.length > 0).join("/");
  return joined.length === 0 ? "." : normalize(joined);
}

export function resolve(...parts: string[]): string {
  let resolved = "";
  let absolute = false;
  for (let i = parts.length - 1; i >= -1 && !absolute; i--) {
    const p = i >= 0 ? parts[i] : "/";
    if (p.length === 0) continue;
    resolved = `${p}/${resolved}`;
    absolute = p.charCodeAt(0) === 47;
  }
  resolved = normalizeString(resolved, !absolute);
  if (absolute) return `/${resolved}`;
  return resolved.length > 0 ? resolved : ".";
}

export function relative(from: string, to: string): string {
  if (from === to) return "";
  from = resolve(from);
  to = resolve(to);
  if (from === to) return "";
  const fromStart = 1;
  const fromEnd = from.length;
  const fromLen = fromEnd - fromStart;
  const toStart = 1;
  const toLen = to.length - toStart;
  const length = fromLen < toLen ? fromLen : toLen;
  let lastCommonSep = -1;
  let i = 0;
  for (; i < length; i++) {
    const fromCode = from.charCodeAt(fromStart + i);
    if (fromCode !== to.charCodeAt(toStart + i)) break;
    else if (fromCode === 47) lastCommonSep = i;
  }
  if (i === length) {
    if (toLen > length) {
      if (to.charCodeAt(toStart + i) === 47) return to.slice(toStart + i + 1);
      if (i === 0) return to.slice(toStart + i);
    } else if (fromLen > length) {
      if (from.charCodeAt(fromStart + i) === 47) lastCommonSep = i;
      else if (i === 0) lastCommonSep = 0;
    }
  }
  let out = "";
  for (i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i) {
    if (i === fromEnd || from.charCodeAt(i) === 47) out += out.length === 0 ? ".." : "/..";
  }
  return `${out}${to.slice(toStart + lastCommonSep)}`;
}

export function dirname(p: string): string {
  if (p.length === 0) return ".";
  const hasRoot = p.charCodeAt(0) === 47;
  let end = -1;
  let matchedSlash = true;
  for (let i = p.length - 1; i >= 1; --i) {
    if (p.charCodeAt(i) === 47) {
      if (!matchedSlash) { end = i; break; }
    } else {
      matchedSlash = false;
    }
  }
  if (end === -1) return hasRoot ? "/" : ".";
  if (hasRoot && end === 1) return "//";
  return p.slice(0, end);
}

export function basename(p: string, suffix?: string): string {
  let start = 0;
  let end = -1;
  let matchedSlash = true;
  if (suffix !== undefined && suffix.length > 0 && suffix.length <= p.length) {
    if (suffix === p) return "";
    let extIdx = suffix.length - 1;
    let firstNonSlashEnd = -1;
    for (let i = p.length - 1; i >= 0; --i) {
      const code = p.charCodeAt(i);
      if (code === 47) {
        if (!matchedSlash) { start = i + 1; break; }
      } else {
        if (firstNonSlashEnd === -1) { matchedSlash = false; firstNonSlashEnd = i + 1; }
        if (extIdx >= 0) {
          if (code === suffix.charCodeAt(extIdx)) { if (--extIdx === -1) end = i; }
          else { extIdx = -1; end = firstNonSlashEnd; }
        }
      }
    }
    if (start === end) end = firstNonSlashEnd;
    else if (end === -1) end = p.length;
    return p.slice(start, end);
  }
  for (let i = p.length - 1; i >= 0; --i) {
    if (p.charCodeAt(i) === 47) {
      if (!matchedSlash) { start = i + 1; break; }
    } else if (end === -1) {
      matchedSlash = false;
      end = i + 1;
    }
  }
  return end === -1 ? "" : p.slice(start, end);
}

export function extname(p: string): string {
  let startDot = -1;
  let startPart = 0;
  let end = -1;
  let matchedSlash = true;
  let preDotState = 0;
  for (let i = p.length - 1; i >= 0; --i) {
    const code = p.charCodeAt(i);
    if (code === 47) {
      if (!matchedSlash) { startPart = i + 1; break; }
      continue;
    }
    if (end === -1) { matchedSlash = false; end = i + 1; }
    if (code === 46) {
      if (startDot === -1) startDot = i;
      else if (preDotState !== 1) preDotState = 1;
    } else if (startDot !== -1) {
      preDotState = -1;
    }
  }
  if (startDot === -1 || end === -1 || preDotState === 0 || (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) return "";
  return p.slice(startDot, end);
}

const posix = { sep, delimiter, isAbsolute, normalize, join, resolve, relative, dirname, basename, extname };
export { posix };
export default { ...posix, posix };
