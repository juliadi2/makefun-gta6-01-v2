// CAYO VERDE — gta6-01 entry program (Node 22, standard library only).
//
// The game lives in this directory's game/ folder: plain static files a desktop
// browser loads offline (game/index.html plus its ES modules and the vendored
// three.js UMD build), with no network request at all. This program hands the
// game in: it copies game/ and screenshots/ from beside this file into the
// output directory and writes /output/dossier.json, the summary the judge reads,
// using the vendored make.fun library (vendor/makefun-game.ts, the kit's copy).
//
// Run it locally with MAKEFUN_OUTPUT_DIR standing in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
// Play the game itself with `node serve.ts`, then open http://localhost:8080.

import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

mkdirSync(outDir, { recursive: true });
cpSync(join(repoRoot, 'game'), join(outDir, 'game'), { recursive: true });
mkdirSync(join(outDir, 'screenshots'), { recursive: true });
if (existsSync(join(repoRoot, 'screenshots'))) {
  cpSync(join(repoRoot, 'screenshots'), join(outDir, 'screenshots'), { recursive: true });
}

// The gate's caps, as buildDossier takes them: the dossier text is capped at
// 160 KiB, screenshots at 4 files of at most 256 KiB each, and game/ at 993
// files and 48 MiB in all with no path over 1000 bytes.
writeFileSync(
  join(outDir, 'dossier.json'),
  buildDossier(outDir, {
    text_max_bytes: 163840,
    screenshots: { max: 4, max_bytes: 262144 },
    game_max_files: 993,
    game_max_bytes: 50331648,
    game_path_max_bytes: 1000,
  }),
);
