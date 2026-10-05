// Renders build/icon.svg to build/icon.png (1024 × 1024, transparent), which electron-builder turns into the app's
// .icns. Run it after changing the SVG, and commit both: `npx electron scripts/make-icon.cjs`.

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const build = path.resolve(__dirname, "..", "build");
const SIZE = 1024;

app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "aos-make-icon-")));
app.dock?.hide();

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE, height: SIZE, show: false, frame: false, transparent: true, backgroundColor: "#00000000",
    webPreferences: { offscreen: true },
  });
  win.webContents.setFrameRate(1);
  const svg = fs.readFileSync(path.join(build, "icon.svg"), "utf8");
  const html = `<!doctype html><html><body style="margin:0;overflow:hidden;background:transparent"><img style="display:block" width="${SIZE}" height="${SIZE}" src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}"></body></html>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString("base64")}`);
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  const { width, height } = image.getSize();
  if (width !== SIZE || height !== SIZE) throw new Error(`rendered ${width}×${height}, expected ${SIZE}×${SIZE}`);
  // BGRA: the corners lie outside the tile and its shadow, so they must be fully transparent.
  const px = image.toBitmap();
  const alpha = (x, y) => px[(y * width + x) * 4 + 3];
  if ([alpha(0, 0), alpha(width - 1, 0), alpha(0, height - 1), alpha(width - 1, height - 1)].some((a) => a !== 0)) throw new Error("the corners are not transparent");
  fs.writeFileSync(path.join(build, "icon.png"), image.toPNG());
  console.log(`wrote build/icon.png (${width}×${height})`);
  app.quit();
}).catch((err) => { console.error(err); app.exit(1); });
