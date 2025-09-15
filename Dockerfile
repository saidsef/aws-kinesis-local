FROM docker.io/node:24.8-alpine

LABEL org.opencontainers.image.authors="Said Sef <saidsef@gmail.com> (saidsef.co.uk/)"
LABEL "uk.co.saidsef.aws-kinesis"="Said Sef Associates Ltd"
LABEL version="3.1"
LABEL org.opencontainers.image.source="https://github.com/saidsef/aws-kinesis-local"
LABEL org.opencontainers.image.documentation="https://github.com/saidsef/aws-kinesis-local/blob/main/README.md"
LABEL org.opencontainers.image.licenses="MIT"

ARG PORT=""
ARG CREATESTREAMMS=""
ARG DELETESTREAMMS=""
ARG KPATH=""
ARG UPDATESTREAMMS=""
ARG SHARDLIMIT=""

ENV AWS_DEFAULT_REGION="eu-west-1"
ENV CREATESTREAMMS=${CREATESTREAMMS:-50}
ENV DELETESTREAMMS=${DELETESTREAMMS:-50}
ENV KPATH=${KPATH:-/data}
ENV NODE_ENV=production
ENV NODE_PENDING_DEPRECATION=1
ENV NPM_CONFIG_CACHE=/data
ENV PORT=${PORT:-4567}
ENV SHARDLIMIT=${SHARDLIMIT:-50}
ENV UPDATESTREAMMS=${UPDATESTREAMMS:-50}

WORKDIR /data

RUN mkdir -p /.npm /data && \
    npm install -g kinesalite@3.3.3 && \
    chown -R nobody:nobody /data /.npm /data

USER nobody

EXPOSE ${PORT}

VOLUME ["/data"]

HEALTHCHECK --interval=60s --timeout=10s CMD nc -zvw3 127.0.0.1 4567 || exit 1

CMD ["/usr/local/bin/kinesalite", "--port", ${PORT}, "--path", ${KPATH}, "--shardLimit", ${SHARDLIMIT}, "--createStreamMs", ${CREATESTREAMMS}, "--deleteStreamMs", ${DELETESTREAMMS}]
ENTRYPOINT ["/usr/local/bin/kinesalite"]
