#!/bin/bash
set -e
npm install -g pnpm@9
pnpm install --frozen-lockfile || pnpm install
pnpm run build:packages
cd apps/web
npx next build
