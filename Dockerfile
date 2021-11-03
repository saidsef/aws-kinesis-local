FROM node:16-alpine

LABEL maintainer="Said Sef <saidsef@gmail.com> (saidsef.co.uk/)"
LABEL "uk.co.saidsef.aws-kinesis"="Said Sef Associates Ltd"
LABEL version="3.1"

ARG PORT=""

ENV NODE_ENV production
ENV PORT ${PORT:-4567}

WORKDIR /app

RUN mkdir -p /.npm /data && \
    npm install -g kinesalite@3.3.3 && \
    chown -R nobody:nobody /app /.npm /data

USER nobody

EXPOSE ${PORT}

VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=10s CMD nc -zvw3 127.0.0.1 4567 || exit 1 

CMD ["/usr/local/bin/kinesalite"]
ENTRYPOINT ["/usr/local/bin/kinesalite"]
