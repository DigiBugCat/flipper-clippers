#!/usr/bin/env node

import esbuild from 'esbuild';

const isProduction = process.env.NODE_ENV === 'production';
const isWatch = process.argv.includes('--watch');

const entryPoints = [
  { in: 'src/frontend/app.ts', out: 'public/js/app' },
  { in: 'src/frontend/compare.ts', out: 'public/js/compare' },
  { in: 'src/frontend/leaderboard.ts', out: 'public/js/leaderboard' },
  { in: 'src/frontend/saved.ts', out: 'public/js/saved' },
  { in: 'src/frontend/feed.ts', out: 'public/js/feed' },
  { in: 'src/frontend/comments.ts', out: 'public/js/comments' },
  { in: 'src/frontend/social.ts', out: 'public/js/social' },
  { in: 'src/frontend/clipdle/game.ts', out: 'public-clipdle/game' },
];

const buildOptions = {
  entryPoints: entryPoints.map(e => e.in),
  outdir: '.',
  outbase: '.',
  bundle: false,
  minify: isProduction,
  sourcemap: true,
  target: ['es2020'],
  format: 'iife',
  logLevel: 'info',
};

// Custom plugin to handle output paths
const outputPlugin = {
  name: 'output-paths',
  setup(build) {
    build.onEnd(result => {
      if (result.errors.length === 0) {
        console.log(`Frontend build completed${isProduction ? ' (production)' : ''}`);
      }
    });
  },
};

async function build() {
  // Build each entry point separately to control output paths
  const buildPromises = entryPoints.map(entry => {
    const options = {
      entryPoints: [entry.in],
      outfile: `${entry.out}.js`,
      bundle: true,  // Bundle imports so they work in browser
      minify: isProduction,
      sourcemap: true,
      target: ['es2020'],
      format: 'iife',
    };

    if (isWatch) {
      return esbuild.context(options).then(ctx => {
        ctx.watch();
        return ctx;
      });
    } else {
      return esbuild.build(options);
    }
  });

  try {
    await Promise.all(buildPromises);
    console.log(`Frontend build completed${isProduction ? ' (production)' : ''}`);

    if (isWatch) {
      console.log('Watching for changes...');
    }
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

build();
