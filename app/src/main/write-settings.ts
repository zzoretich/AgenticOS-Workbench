// Which write surfaces are on (src/shared/write-policy.ts). The app is the Workbench, so every verified surface is on.
// $AOS_APP_WRITE narrows that for tests and one-off runs ("todo,notifications", "all", or "" for none). Writes outside
// every surface stay refused either way: the surface table is the allow-list the sandboxed build enforces too.

import { SURFACES, parseSurfaces, type Surface } from "../shared/write-policy";
import type { WriteSource } from "../shared/ipc";

export interface WriteSettings { surfaces: string[]; source: WriteSource }

/** The ids of surfaces whose writes are verified end to end. `table` is the surface table (the tests pass their own). */
const verified = (table: readonly Surface[]): string[] => table.filter((s) => s.verified).map((s) => s.id);

export function loadWriteSettings(env: NodeJS.ProcessEnv = process.env, table: readonly Surface[] = SURFACES): WriteSettings {
  const spec = env.AOS_APP_WRITE;
  if (spec !== undefined) {
    const { ids, unknown } = parseSurfaces(spec);
    if (unknown.length) console.warn(`[main] AOS_APP_WRITE names unknown surfaces: ${unknown.join(", ")}`);
    return { surfaces: ids, source: "AOS_APP_WRITE" };
  }
  return { surfaces: verified(table), source: "default" };
}
