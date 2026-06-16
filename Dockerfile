FROM docker.io/node:26.3-alpine

LABEL org.opencontainers.image.authors="Said Sef <saidsef@gmail.com> (saidsef.co.uk/)"
LABEL uk.co.saidsef.aws-kinesis="Said Sef Associates Ltd"
LABEL org.opencontainers.image.version="3.3.3"
LABEL org.opencontainers.image.source="https://github.com/saidsef/aws-kinesis-local"
LABEL org.opencontainers.image.documentation="https://github.com/saidsef/aws-kinesis-local/blob/main/README.md"
LABEL org.opencontainers.image.licenses="MIT"

ENV AWS_DEFAULT_REGION=eu-west-1 \
    CREATESTREAMMS=50 \
    DELETESTREAMMS=50 \
    KPATH=/data \
    NODE_ENV=production \
    NODE_PENDING_DEPRECATION=1 \
    NPM_CONFIG_CACHE=/data \
    PORT=4567 \
    SHARDLIMIT=50 \
    UPDATESTREAMMS=50

WORKDIR /data

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /.npm /data \
 && npm install -g kinesalite@3.3.3 \
 && chmod +x /usr/local/bin/docker-entrypoint.sh \
 && chown -R nobody:nobody /data /.npm

USER nobody

EXPOSE 4567

VOLUME ["/data"]

HEALTHCHECK --interval=60s --timeout=10s CMD nc -zvw3 127.0.0.1 "$PORT" || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
