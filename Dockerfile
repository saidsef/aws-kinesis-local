FROM node:alpine
MAINTAINER Said Sef <saidsef@gmail.com>

LABEL "uk.co.saidsef.aws-kinesis"="Said Sef Associates Ltd"
LABEL version="1.0"

ARG PORT=""

ENV NODE_ENV production
ENV PORT ${PORT:-4567}
# https://github.com/mhart/kinesalite
RUN npm install -g kinesalite

EXPOSE $PORT

WORKDIR /usr/bin

CMD "/usr/bin/kinesalite"
