#!/bin/bash
set -e
corepack enable
corepack prepare pnpm@9 --activate
pnpm install
pnpm run build:packages
cd apps/web
npx next build
