FROM docker.io/node:26.13-alpine AS build

WORKDIR /src

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json ./
COPY model ./model
COPY scripts ./scripts
COPY src ./src
RUN npm run build \
 && cp package.json dist/package.json

FROM docker.io/node:26.13-alpine

ARG VERSION=dev

LABEL org.opencontainers.image.title="aws-kinesis-local" \
      org.opencontainers.image.description="Amazon Kinesis Data Streams API on your machine, for development and CI" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.authors="Said Sef <saidsef@gmail.com>" \
      org.opencontainers.image.vendor="Said Sef Associates Ltd" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.url="https://github.com/saidsef/aws-kinesis-local" \
      org.opencontainers.image.source="https://github.com/saidsef/aws-kinesis-local" \
      org.opencontainers.image.documentation="https://aws-kinesis-local.readthedocs.io/"

ENV AWS_DEFAULT_REGION=eu-west-1 \
    CREATESTREAMMS=50 \
    DELETESTREAMMS=50 \
    KPATH=/data \
    NODE_ENV=production \
    PORT=4567 \
    SHARDLIMIT=50 \
    UPDATESTREAMMS=50

RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* /usr/local/include/node /root/.npm \
 && mkdir -p /data \
 && chown nobody:nobody /data

COPY --from=build /src/dist /opt/aws-kinesis-local
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

USER nobody

WORKDIR /data

EXPOSE 4567

VOLUME ["/data"]

HEALTHCHECK --interval=60s --timeout=10s CMD nc -zvw3 127.0.0.1 "$PORT" || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
