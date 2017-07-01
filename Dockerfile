FROM ubuntu:16.04
MAINTAINER Said Sef <saidsef@gmail.com>

LABEL "uk.co.saidsef.aws-kinesis"="Said Sef Associates Ltd"
LABEL version="1.0"

ENV NODE_ENV production

RUN apt-get update
RUN apt-get install -y curl
RUN curl -sL https://deb.nodesource.com/setup_7.x | bash
RUN apt-get update
RUN apt-get install -y --no-install-recommends build-essential nodejs

# https://github.com/mhart/kinesalite
RUN npm install -g kinesalite

EXPOSE 4567

WORKDIR /usr/bin

CMD "/usr/bin/kinesalite"
