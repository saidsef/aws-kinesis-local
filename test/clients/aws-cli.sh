#!/bin/sh
set -eu

ENDPOINT="${KINESIS_ENDPOINT:-http://127.0.0.1:4567}"
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=eu-west-1 AWS_PAGER=""
STREAM="cli-$(date +%s)-$$"

kinesis() {
  aws --endpoint-url "$ENDPOINT" kinesis "$@"
}

expect() {
  if [ "$2" != "$3" ]; then
    echo "FAIL: $1: expected '$3' but got '$2'" >&2
    exit 1
  fi
  echo "ok: $1"
}

kinesis create-stream --stream-name "$STREAM" --shard-count 2
kinesis wait stream-exists --stream-name "$STREAM"
ARN=$(kinesis describe-stream-summary --stream-name "$STREAM" --query StreamDescriptionSummary.StreamARN --output text)
expect "stream ARN" "$ARN" "arn:aws:kinesis:eu-west-1:000000000000:stream/$STREAM"

SHARD=$(kinesis put-record --stream-name "$STREAM" --partition-key cli --data "$(printf 'from the cli' | base64)" --query ShardId --output text)
kinesis put-records --stream-arn "$ARN" --records Data="$(printf one | base64)",PartitionKey=a Data="$(printf two | base64)",PartitionKey=b >/dev/null
ITERATOR=$(kinesis get-shard-iterator --stream-name "$STREAM" --shard-id "$SHARD" --shard-iterator-type TRIM_HORIZON --query ShardIterator --output text)
FIRST=$(kinesis get-records --shard-iterator "$ITERATOR" --query 'Records[0].Data' --output text | base64 -d)
expect "first record" "$FIRST" "from the cli"

expect "streams listed" "$(kinesis list-streams --query 'StreamNames[]' --output text | tr '\t' '\n' | grep -cx "$STREAM")" "1"
expect "open shards" "$(kinesis list-shards --stream-name "$STREAM" --shard-filter Type=AT_LATEST --query 'length(Shards)' --output text)" "2"

kinesis add-tags-to-stream --stream-name "$STREAM" --tags team=data
kinesis tag-resource --resource-arn "$ARN" --tags env=test
expect "tags" "$(kinesis list-tags-for-resource --resource-arn "$ARN" --query 'Tags[].Key' --output text)" "env	team"

kinesis increase-stream-retention-period --stream-name "$STREAM" --retention-period-hours 168
kinesis enable-enhanced-monitoring --stream-name "$STREAM" --shard-level-metrics IncomingBytes >/dev/null

CONSUMER=$(kinesis register-stream-consumer --stream-arn "$ARN" --consumer-name cli --query Consumer.ConsumerARN --output text)
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  STATUS=$(kinesis describe-stream-consumer --consumer-arn "$CONSUMER" --query ConsumerDescription.ConsumerStatus --output text)
  [ "$STATUS" = ACTIVE ] && break
  sleep 0.5
done
expect "consumer status" "$STATUS" "ACTIVE"
expect "consumer count" "$(kinesis describe-stream-summary --stream-name "$STREAM" --query StreamDescriptionSummary.ConsumerCount --output text)" "1"
kinesis deregister-stream-consumer --consumer-arn "$CONSUMER"

kinesis update-shard-count --stream-name "$STREAM" --target-shard-count 4 --scaling-type UNIFORM_SCALING >/dev/null
kinesis wait stream-exists --stream-name "$STREAM"
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  STATUS=$(kinesis describe-stream-summary --stream-name "$STREAM" --query StreamDescriptionSummary.StreamStatus --output text)
  [ "$STATUS" = ACTIVE ] && break
  sleep 0.5
done
expect "shards after scaling" "$(kinesis describe-stream-summary --stream-name "$STREAM" --query StreamDescriptionSummary.OpenShardCount --output text)" "4"

expect "shard limit" "$(kinesis describe-limits --query 'ShardLimit > `0`' --output text)" "True"

kinesis delete-stream --stream-name "$STREAM" --enforce-consumer-deletion
kinesis wait stream-not-exists --stream-name "$STREAM"
echo "AWS CLI tests passed"
