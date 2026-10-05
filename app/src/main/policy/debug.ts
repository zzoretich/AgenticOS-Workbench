// The command-line switches that open a packaged app to a debugger: Chromium's remote debugging (a port, a pipe, an
// address), Node's inspector, and V8 flags. The fuses already turn off --inspect and NODE_OPTIONS; remote debugging has
// no fuse, so main refuses to start with any of these (index.ts). Chromium reads a switch with one dash or two.

const SWITCH = /^--?(remote-debugging-(port|pipe|address|targets)|remote-allow-origins|inspect(-brk|-port|-publish-uid)?|js-flags)(=.*)?$/i;

/** The debugging switches in `argv`, as given. */
export function debugSwitches(argv: readonly string[]): string[] {
  return argv.filter((a) => SWITCH.test(a));
}
