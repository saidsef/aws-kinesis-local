FROM ubuntu:16.04
MAINTAINER Said Sef <saidsef@gmail.com>

ENV NODE_ENV=production

RUN apt-get update
RUN apt-get install -y curl
RUN curl -sL https://deb.nodesource.com/setup_7.x | bash
RUN apt-get update
RUN apt-get install -y build-essential nodejs

# https://github.com/mhart/kinesalite
RUN npm install -g kinesalite

EXPOSE 4567

CMD "/usr/bin/kinesalite"
