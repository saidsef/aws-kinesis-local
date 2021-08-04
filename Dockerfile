FROM node:14-alpine

LABEL maintainer="Said Sef <saidsef@gmail.com> (saidsef.co.uk/)"
LABEL "uk.co.saidsef.aws-kinesis"="Said Sef Associates Ltd"
LABEL version="2.6"

ARG PORT=""

ENV NODE_ENV production
ENV PORT ${PORT:-4567}

WORKDIR /app

RUN npm install -g kinesalite@3.3.3 && \
    mkdir -p /.npm /data && \
    chown -R nobody:nobody /app /.npm /data

USER nobody

EXPOSE ${PORT}

VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=10s CMD nc -zvw3 127.0.0.1 4567 || exit 1 

CMD ["/usr/local/bin/kinesalite"]
ENTRYPOINT ["/usr/local/bin/kinesalite"]
