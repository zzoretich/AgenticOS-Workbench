// Renders build/icon.svg to build/icon.png (1024 × 1024, transparent), which electron-builder turns into the app's
// .icns, and build/trayTemplate.svg to the menu bar's template image, trayTemplate.png (30 × 16) and @2x (60 × 32).
// Run it after changing an SVG, and commit the SVGs with their PNGs: `npx electron scripts/make-icon.cjs`.

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const build = path.resolve(__dirname, "..", "build");
const SIZE = 1024;
const RENDERS = [
  { svg: "icon.svg", png: "icon.png", width: SIZE, height: SIZE, clearCorners: true },
  { svg: "trayTemplate.svg", png: "trayTemplate.png", width: 30, height: 16 },
  { svg: "trayTemplate.svg", png: `trayTemplate${"@2x"}.png`, width: 60, height: 32 },
];

app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "aos-make-icon-")));
app.dock?.hide();

async function render(win, { svg, png, width, height, clearCorners }) {
  const src = fs.readFileSync(path.join(build, svg), "utf8");
  const html = `<!doctype html><html><body style="margin:0;overflow:hidden;background:transparent"><img style="display:block" width="${width}" height="${height}" src="data:image/svg+xml;base64,${Buffer.from(src).toString("base64")}"></body></html>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString("base64")}`);
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width, height });
  const size = image.getSize();
  if (size.width !== width || size.height !== height) throw new Error(`${png}: rendered ${size.width}×${size.height}, expected ${width}×${height}`);
  // BGRA: the icon's corners lie outside the tile and its shadow, so they must be fully transparent.
  const px = image.toBitmap();
  const alpha = (x, y) => px[(y * width + x) * 4 + 3];
  if (clearCorners && [alpha(0, 0), alpha(width - 1, 0), alpha(0, height - 1), alpha(width - 1, height - 1)].some((a) => a !== 0)) throw new Error(`${png}: the corners are not transparent`);
  fs.writeFileSync(path.join(build, png), image.toPNG());
  console.log(`wrote build/${png} (${width}×${height})`);
}

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE, height: SIZE, show: false, frame: false, transparent: true, backgroundColor: "#00000000",
    webPreferences: { offscreen: true },
  });
  win.webContents.setFrameRate(1);
  for (const r of RENDERS) await render(win, r);
  app.quit();
}).catch((err) => { console.error(err); app.exit(1); });
