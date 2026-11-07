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

LABEL org.opencontainers.image.authors="Said Sef <saidsef@gmail.com> (saidsef.co.uk/)"
LABEL uk.co.saidsef.aws-kinesis="Said Sef Associates Ltd"
ARG VERSION=1.0.0
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.source="https://github.com/saidsef/aws-kinesis-local"
LABEL org.opencontainers.image.documentation="https://aws-kinesis-local.readthedocs.io/"
LABEL org.opencontainers.image.licenses="MIT"

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
