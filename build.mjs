import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');
mkdirSync('dist', { recursive: true });

const copy = () => {
  copyFileSync('manifest.json', 'dist/manifest.json');
  copyFileSync('src/options.html', 'dist/options.html');
};

const ctx = await esbuild.context({
  entryPoints: { inject: 'src/inject.ts', content: 'src/content.ts', background: 'src/background.ts', options: 'src/options.ts' },
  outdir: 'dist',
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  sourcemap: 'inline',
  logLevel: 'info',
  plugins: [{ name: 'copy', setup: (b) => b.onEnd(copy) }],
});

if (watch) await ctx.watch();
else {
  await ctx.rebuild();
  await ctx.dispose();
}
