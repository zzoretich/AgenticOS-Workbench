// Vault-relative daily-note paths. Single source of truth on the plugin side;
// MUST stay in lockstep with brain/scripts/lib/paths.js dailyNotePath().
const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

export function dailyNotePath(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}/${y}-${m}-${MONTHS[d.getMonth()]}/${y}-${m}-${day}.md`;
}

// A daily note is <year>/.../<YYYY-MM-DD>.md (month subfolder optional — a few
// strays live at the year root). brain/sessions/ never existed; not matched.
export function isDailyNotePath(p: string): boolean {
  return /^\d{4}\/(?:[^/]+\/)?\d{4}-\d{2}-\d{2}\.md$/.test(p);
}
