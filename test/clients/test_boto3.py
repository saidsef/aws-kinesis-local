import os
import time
import unittest
import uuid

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

ENDPOINT = os.environ.get("KINESIS_ENDPOINT", "http://127.0.0.1:4567")


def client():
    return boto3.client(
        "kinesis",
        endpoint_url=ENDPOINT,
        region_name="eu-west-1",
        aws_access_key_id="test",
        aws_secret_access_key="test",
        config=Config(retries={"max_attempts": 1}),
    )


def unique(prefix):
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def wait_until(read, done, timeout=20):
    deadline = time.monotonic() + timeout
    while True:
        value = read()
        if done(value):
            return value
        if time.monotonic() > deadline:
            raise AssertionError(f"Condition not met within {timeout} seconds: {value}")
        time.sleep(0.05)


class Boto3Test(unittest.TestCase):
    def setUp(self):
        self.kinesis = client()

    def create(self, name, shards=1):
        self.kinesis.create_stream(StreamName=name, ShardCount=shards)
        self.kinesis.get_waiter("stream_exists").wait(StreamName=name, WaiterConfig={"Delay": 1, "MaxAttempts": 20})
        return self.kinesis.describe_stream_summary(StreamName=name)["StreamDescriptionSummary"]

    def test_records_round_trip(self):
        name = unique("boto3")
        summary = self.create(name, 2)
        self.assertEqual(summary["OpenShardCount"], 2)
        put = self.kinesis.put_record(StreamName=name, PartitionKey="p", Data=b"hello")
        batch = self.kinesis.put_records(
            StreamARN=summary["StreamARN"],
            Records=[{"PartitionKey": f"k{i}", "Data": f"item {i}".encode()} for i in range(20)],
        )
        self.assertEqual(batch["FailedRecordCount"], 0)
        shards = self.kinesis.list_shards(StreamName=name, ShardFilter={"Type": "AT_LATEST"})["Shards"]
        self.assertEqual(len(shards), 2)
        iterator = self.kinesis.get_shard_iterator(
            StreamName=name,
            ShardId=put["ShardId"],
            ShardIteratorType="AT_SEQUENCE_NUMBER",
            StartingSequenceNumber=put["SequenceNumber"],
        )["ShardIterator"]
        records = self.kinesis.get_records(ShardIterator=iterator)["Records"]
        self.assertEqual(records[0]["Data"], b"hello")
        self.assertEqual(records[0]["PartitionKey"], "p")
        self.assertLess(abs(records[0]["ApproximateArrivalTimestamp"].timestamp() - time.time()), 60)

    def test_paginators_and_errors(self):
        prefix = unique("boto3-page")
        for i in range(12):
            self.kinesis.create_stream(StreamName=f"{prefix}-{i:02d}", ShardCount=1)
        names = []
        for page in self.kinesis.get_paginator("list_streams").paginate(PaginationConfig={"PageSize": 5}):
            names.extend(page["StreamNames"])
        self.assertEqual(len([name for name in names if name.startswith(prefix)]), 12)
        with self.assertRaises(ClientError) as raised:
            self.kinesis.describe_stream(StreamName=unique("missing"))
        self.assertEqual(raised.exception.response["Error"]["Code"], "ResourceNotFoundException")
        with self.assertRaises(ClientError) as raised:
            self.kinesis.increase_stream_retention_period(StreamName=f"{prefix}-00", RetentionPeriodHours=9000)
        self.assertEqual(raised.exception.response["Error"]["Code"], "InvalidArgumentException")

    def test_resharding(self):
        name = unique("boto3-scale")
        self.create(name, 2)
        result = self.kinesis.update_shard_count(StreamName=name, TargetShardCount=4, ScalingType="UNIFORM_SCALING")
        self.assertEqual(result["TargetShardCount"], 4)
        summary = wait_until(
            lambda: self.kinesis.describe_stream_summary(StreamName=name)["StreamDescriptionSummary"],
            lambda value: value["StreamStatus"] == "ACTIVE",
        )
        self.assertEqual(summary["OpenShardCount"], 4)

    def test_enhanced_fan_out(self):
        name = unique("boto3-efo")
        summary = self.create(name)
        consumer = self.kinesis.register_stream_consumer(StreamARN=summary["StreamARN"], ConsumerName="boto3")["Consumer"]
        wait_until(
            lambda: self.kinesis.describe_stream_consumer(ConsumerARN=consumer["ConsumerARN"])["ConsumerDescription"],
            lambda value: value["ConsumerStatus"] == "ACTIVE",
        )
        self.kinesis.put_record(StreamName=name, PartitionKey="p", Data=b"pushed")
        response = self.kinesis.subscribe_to_shard(
            ConsumerARN=consumer["ConsumerARN"],
            ShardId="shardId-000000000000",
            StartingPosition={"Type": "TRIM_HORIZON"},
        )
        received = []
        for event in response["EventStream"]:
            received.extend(record["Data"] for record in event.get("SubscribeToShardEvent", {}).get("Records", []))
            if received:
                break
        response["EventStream"].close()
        self.assertEqual(received, [b"pushed"])
        self.kinesis.deregister_stream_consumer(ConsumerARN=consumer["ConsumerARN"])

    def test_account_operations(self):
        limits = self.kinesis.describe_limits()
        self.assertGreater(limits["ShardLimit"], 0)
        settings = self.kinesis.describe_account_settings()
        self.assertIn(settings["MinimumThroughputBillingCommitment"]["Status"], ["ENABLED", "DISABLED"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
