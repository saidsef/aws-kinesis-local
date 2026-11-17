#!/bin/sh
set -eu

here=$(cd "$(dirname "$0")" && pwd)
image=${IMAGE:-aws-kinesis-local:dev}
s3_image=${S3_IMAGE:-chrislusf/seaweedfs:4.53}
deadline=${DEADLINE_SECONDS:-300}
name=delivery-test-$$
network=$name
kinesis=$name-kinesis
s3=$name-s3
runner=$name-runner

cleanup() {
  rc=$?
  trap - EXIT INT TERM
  if [ "$rc" -ne 0 ]; then
    for container in "$kinesis" "$s3"; do
      if docker container inspect "$container" >/dev/null 2>&1; then
        echo "Logs from $container:" >&2
        docker logs "$container" >&2 2>&1 || true
      fi
    done
  fi
  docker rm -f "$runner" "$kinesis" "$s3" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  if [ "$rc" -eq 0 ]; then
    echo "Channel delivery test passed against $image"
  else
    echo "Channel delivery test failed against $image with exit status $rc" >&2
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker network create "$network" >/dev/null
# Without an S3 configuration, SeaweedFS accepts any credentials.
docker run -d --name "$s3" --network "$network" --network-alias s3 \
  "$s3_image" server -s3 -master.volumeSizeLimitMB=64 >/dev/null
docker run -d --name "$kinesis" --network "$network" --network-alias kinesis \
  -e S3ENDPOINT=http://s3:8333 -e DELIVERYINTERVALMS=1000 -e LOGLEVEL=info \
  -e S3_ACCESS_KEY_ID=test -e S3_SECRET_ACCESS_KEY=test \
  "$image" >/dev/null

# busybox timeout runs the test in its own process, and only --init keeps that process from being PID 1, which ignores SIGTERM.
docker run --init --name "$runner" --network "$network" \
  -e KINESIS_ENDPOINT=http://kinesis:4567 \
  -e S3_ENDPOINT=http://s3:8333 \
  -v "$here:/test:ro" \
  --entrypoint timeout \
  "$image" "$deadline" node /test/delivery.mjs
