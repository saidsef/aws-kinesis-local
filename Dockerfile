FROM node:stretch-slim
MAINTAINER Said Sef <saidsef@gmail.com>

LABEL "uk.co.saidsef.aws-kinesis"="Said Sef Associates Ltd"
LABEL version="2.0"

ARG PORT=""

ENV NODE_ENV production
ENV PORT ${PORT:-4567}

RUN npm install -g kinesalite

EXPOSE ${PORT}

WORKDIR /data

CMD ["/usr/local/bin/kinesalite"]
ENTRYPOINT ["/usr/local/bin/kinesalite"]