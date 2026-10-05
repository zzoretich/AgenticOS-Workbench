// Remembers the window's size and position in userData, and only restores a position that is still on a display.

import { screen, type BrowserWindow, type Rectangle } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT = { width: 1480, height: 940 };

export interface WindowState { bounds: Partial<Rectangle>; maximized: boolean }

function file(userData: string): string { return path.join(userData, "window-state.json"); }

function onSomeDisplay(b: Rectangle): boolean {
  return screen.getAllDisplays().some(({ workArea: w }) =>
    b.x < w.x + w.width - 80 && b.x + b.width > w.x + 80 && b.y >= w.y - 10 && b.y < w.y + w.height - 80);
}

export function loadWindowState(userData: string): WindowState {
  try {
    const s = JSON.parse(fs.readFileSync(file(userData), "utf8")) as WindowState;
    const b = s.bounds as Rectangle;
    const valid = [b.x, b.y, b.width, b.height].every((n) => Number.isFinite(n)) && b.width >= 600 && b.height >= 400;
    if (valid && onSomeDisplay(b)) return { bounds: b, maximized: !!s.maximized };
    if (Number.isFinite(b.width) && Number.isFinite(b.height)) return { bounds: { width: b.width, height: b.height }, maximized: !!s.maximized };
  } catch { /* first run */ }
  return { bounds: DEFAULT, maximized: false };
}

export function trackWindowState(win: BrowserWindow, userData: string): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (win.isDestroyed()) return;
      const state: WindowState = { bounds: win.isMaximized() ? win.getNormalBounds() : win.getBounds(), maximized: win.isMaximized() };
      try {
        fs.mkdirSync(userData, { recursive: true });
        fs.writeFileSync(file(userData), `${JSON.stringify(state)}\n`);
      } catch (err) { console.error("[main] could not save window state", err); }
    }, 400);
  };
  for (const ev of ["resize", "move", "maximize", "unmaximize"] as const) win.on(ev as "resize", save);
}
