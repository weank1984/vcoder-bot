FROM node:26-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git git-lfs ripgrep \
  && git lfs install --system \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY .build/validation-cloud/runner.cjs /app/runner.cjs

USER node
ENTRYPOINT ["node", "/app/runner.cjs"]
