import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const result = await build({ entryPoints: ['web/app.js'], bundle: true, format: 'esm', write: false, minify: true });
const js = result.outputFiles[0].text.replaceAll('</script', '<\\/script');
const css = readFileSync('web/style.css', 'utf8');
mkdirSync('public', { recursive: true });
writeFileSync('public/board.html', `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Issue Kanban</title><style>${css}</style></head><body><main id="app"></main><script type="module">${js}</script></body></html>`);
