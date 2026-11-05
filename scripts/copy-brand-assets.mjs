import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { URL } from 'node:url';
import sharp from 'sharp';

// The original SVG is the only manually edited logo geometry.
// Browser favicons are derived reproducibly and embedded in npm release builds.
const sourceDir = new URL('../src/assets/branding/', import.meta.url);
const distDir = new URL('../dist/assets/branding/', import.meta.url);
mkdirSync(sourceDir, { recursive: true });
mkdirSync(distDir, { recursive: true });

const svg = readFileSync(new URL('openbutler.svg', sourceDir));
const sourceText = svg.toString('utf8');
if (!sourceText.includes('</svg>')) throw new Error('The canonical brand SVG is invalid.');
// Both logo eras have to work. A currentColor logo flips the one inherited token for the dark
// favicon (overriding fill there would repaint stroked and fill="none" shapes); an explicit-fill
// logo keeps the old fill override.
const usesCurrentColor = sourceText.includes('currentColor');
const darkRule = usesCurrentColor ? 'svg { color: #fff; }' : 'path { fill: #fff; }';
const themedSvg = sourceText.replace('</svg>', `<style>@media (prefers-color-scheme: dark) { ${darkRule} }</style></svg>`);
const generated = new Map([['favicon.svg', Buffer.from(themedSvg)]]);

// sharp builds no DOM: a currentColor logo rasterizes from the file's own declared color token.
const colorToken = sourceText.match(/color="(#[0-9A-Fa-f]{3,8})"/)?.[1] ?? '#000000';
const rasterSource = usesCurrentColor ? Buffer.from(sourceText.replaceAll('currentColor', colorToken)) : svg;

for (const size of [16, 32, 48, 180]) {
  const png = await sharp(rasterSource)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  generated.set(`favicon-${size}.png`, png);
}

// ICO accepts PNG-encoded frames; all frames retain transparent backgrounds.
const iconSizes = [16, 32, 48];
const header = Buffer.alloc(6 + 16 * iconSizes.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(iconSizes.length, 4);
let offset = header.length;
const frames = iconSizes.map((size, index) => {
  const frame = generated.get(`favicon-${size}.png`);
  if (!frame) throw new Error(`Missing icon size ${size}`);
  const entry = 6 + index * 16;
  header.writeUInt8(size, entry);
  header.writeUInt8(size, entry + 1);
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(frame.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += frame.length;
  return frame;
});
generated.set('favicon.ico', Buffer.concat([header, ...frames]));

copyFileSync(new URL('openbutler.svg', sourceDir), new URL('openbutler.svg', distDir));
for (const [filename, bytes] of generated) {
  writeFileSync(new URL(filename, sourceDir), bytes);
  writeFileSync(new URL(filename, distDir), bytes);
}
