#!/bin/sh
# One image, three Railway services: SERVICE_ROLE picks which process this one runs.
set -e
case "${SERVICE_ROLE:-app}" in
  app)
    pnpm db:migrate
    exec pnpm --filter @tapeverify/api start
    ;;
  workers) exec pnpm --filter @tapeverify/workers start ;;
  bots) exec pnpm --filter @tapeverify/bots start ;;
  *)
    echo "Unknown SERVICE_ROLE: $SERVICE_ROLE (use app, workers or bots)" >&2
    exit 1
    ;;
esac
