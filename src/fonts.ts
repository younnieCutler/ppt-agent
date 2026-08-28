import { execFileSync } from "node:child_process";

export type InstalledFont = { family: string; source: string };

function normalize(font: string): string {
  return font.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function listInstalledFontsMac(): InstalledFont[] {
  let raw: string;
  try { raw = execFileSync("fc-list", [":", "family"], { encoding: "utf8" }); }
  catch { throw new Error("Font preflight on macOS requires fontconfig's `fc-list` (install with `brew install fontconfig`)."); }
  const families = new Set<string>();
  for (const line of raw.split("\n")) for (const name of line.split(",")) if (name.trim()) families.add(name.trim());
  return [...families].sort().map((family) => ({ family, source: "fc-list" }));
}

export function listInstalledFonts(): InstalledFont[] {
  if (process.platform === "darwin") return listInstalledFontsMac();
  if (process.platform !== "win32") {
    throw new Error("Font preflight requires Windows or macOS (with fontconfig) so installed font families can be verified.");
  }

  const script = `
$keys = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
  'HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'
)
$rows = @()
foreach ($key in $keys) {
  if (Test-Path $key) {
    $props = Get-ItemProperty -Path $key
    foreach ($prop in $props.PSObject.Properties) {
      if ($prop.Name -notmatch '^PS') {
        $family = ($prop.Name -replace '\\s+\\((TrueType|OpenType|PostScript)\\)$', '')
        foreach ($face in ($family -split '\\s*&\\s*')) {
          if ($face) { $rows += [PSCustomObject]@{ family = $face; source = $key } }
        }
      }
    }
  }
}
$rows | Sort-Object family -Unique | ConvertTo-Json -Compress
`;
  const raw = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" }).trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw) as InstalledFont | InstalledFont[];
  const fonts = Array.isArray(parsed) ? parsed : [parsed];
  return fonts.sort((a, b) => a.family.localeCompare(b.family));
}

export function assertFontsInstalled(fonts: { heading: string; body: string }, available = listInstalledFonts()): void {
  const families = new Set(available.map((font) => normalize(font.family)));
  const missing = [fonts.heading, fonts.body].filter((font) => !families.has(normalize(font)));
  if (missing.length > 0) {
    throw new Error(`Selected font family is not installed: ${missing.join(", ")}. Choose from the preflight list; no fallback is allowed.`);
  }
}
