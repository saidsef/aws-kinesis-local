#!/bin/sh
set -eu

here=$(cd "$(dirname "$0")" && pwd)
image=${IMAGE:-aws-kinesis-local:dev}
maven_image=${MAVEN_IMAGE:-maven:3.9.16-eclipse-temurin-21}
dynamodb_image=${DYNAMODB_IMAGE:-amazon/dynamodb-local:3.3.2}
maven_cache=${MAVEN_CACHE:-aws-kinesis-local-kcl-m2}
deadline=${DEADLINE_SECONDS:-600}
name=kcl-test-$$
network=$name
kinesis=$name-kinesis
dynamodb=$name-dynamodb
runner=$name-runner

cleanup() {
  rc=$?
  trap - EXIT INT TERM
  if [ "$rc" -ne 0 ] && docker container inspect "$kinesis" >/dev/null 2>&1; then
    echo "Server logs from $image:" >&2
    docker logs "$kinesis" >&2 2>&1 || true
  fi
  docker rm -f "$runner" "$kinesis" "$dynamodb" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  if [ "$rc" -eq 0 ]; then
    echo "KCL integration test passed against $image"
  else
    echo "KCL integration test failed against $image with exit status $rc" >&2
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker network create "$network" >/dev/null
docker run -d --name "$dynamodb" --network "$network" --network-alias dynamodb \
  "$dynamodb_image" -jar DynamoDBLocal.jar -inMemory -sharedDb >/dev/null
docker run -d --name "$kinesis" --network "$network" --network-alias kinesis "$image" >/dev/null

docker run --name "$runner" --network "$network" \
  -e KINESIS_ENDPOINT=http://kinesis:4567 \
  -e DYNAMODB_ENDPOINT=http://dynamodb:8000 \
  -e LOG_LEVEL="${LOG_LEVEL:-warn}" \
  -v "$here:/src:ro" \
  -v "$maven_cache:/root/.m2" \
  "$maven_image" \
  timeout "$deadline" sh -c 'cp -R /src /build && exec mvn -B -q -f /build/pom.xml -Dlog.level="$LOG_LEVEL" compile exec:exec'
