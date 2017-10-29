FROM node:slim
MAINTAINER Said Sef <saidsef@gmail.com>

LABEL "uk.co.saidsef.aws-kinesis"="Said Sef Associates Ltd"
LABEL version="1.0"

ENV NODE_ENV production

# https://github.com/mhart/kinesalite
RUN npm install -g kinesalite

EXPOSE 4567

WORKDIR /usr/bin

CMD "/usr/bin/kinesalite"
