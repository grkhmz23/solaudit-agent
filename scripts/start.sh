#!/bin/bash
set -e
export PORT=5000
export HOSTNAME=0.0.0.0
cd apps/web
npx next start -p 5000 -H 0.0.0.0
