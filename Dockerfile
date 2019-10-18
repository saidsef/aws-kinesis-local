FROM node:12-alpine
MAINTAINER Said Sef <saidsef@gmail.com>

LABEL "uk.co.saidsef.aws-kinesis"="Said Sef Associates Ltd"
LABEL version="2.0"

ARG PORT=""

ENV NODE_ENV production
ENV PORT ${PORT:-4567}

WORKDIR /app

RUN npm install -g kinesalite

EXPOSE ${PORT}

HEALTHCHECK --interval=30s --timeout=10s CMD nc -zvw3 127.0.0.1 4567 || exit 1 

CMD ["/usr/local/bin/kinesalite"]
ENTRYPOINT ["/usr/local/bin/kinesalite"]
