#!/bin/sh
set -eu

exec node /opt/aws-kinesis-local/cli.js \
  --port "${PORT:-4567}" \
  --path "${KPATH:-/data}" \
  --shardLimit "${SHARDLIMIT:-50}" \
  --createStreamMs "${CREATESTREAMMS:-50}" \
  --deleteStreamMs "${DELETESTREAMMS:-50}" \
  --updateStreamMs "${UPDATESTREAMMS:-50}" \
  "$@"
