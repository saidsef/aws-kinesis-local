package uk.co.saidsef.kinesis.kcl;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import software.amazon.kinesis.lifecycle.events.InitializationInput;
import software.amazon.kinesis.lifecycle.events.LeaseLostInput;
import software.amazon.kinesis.lifecycle.events.ProcessRecordsInput;
import software.amazon.kinesis.lifecycle.events.ShardEndedInput;
import software.amazon.kinesis.lifecycle.events.ShutdownRequestedInput;
import software.amazon.kinesis.processor.RecordProcessorCheckpointer;
import software.amazon.kinesis.processor.ShardRecordProcessor;
import software.amazon.kinesis.retrieval.KinesisClientRecord;

final class Processor implements ShardRecordProcessor {
    private final Map<String, String> expected;
    private final Map<String, Integer> seen;
    private final List<String> problems;
    private String shardId;
    private BigInteger last;

    Processor(Map<String, String> expected, Map<String, Integer> seen, List<String> problems) {
        this.expected = expected;
        this.seen = seen;
        this.problems = problems;
    }

    @Override
    public void initialize(InitializationInput input) {
        shardId = input.shardId();
    }

    @Override
    public void processRecords(ProcessRecordsInput input) {
        for (KinesisClientRecord record : input.records()) {
            String key = record.partitionKey();
            String data = StandardCharsets.UTF_8.decode(record.data()).toString();
            BigInteger sequence = new BigInteger(record.sequenceNumber());
            if (last != null && sequence.compareTo(last) <= 0) {
                problems.add(shardId + " delivered " + sequence + " after " + last);
            }
            last = sequence;
            if (!data.equals(expected.get(key))) {
                problems.add(shardId + " delivered an unexpected record " + key + "=" + data);
            }
            seen.merge(key, 1, Integer::sum);
        }
        checkpoint(input.checkpointer());
    }

    @Override
    public void leaseLost(LeaseLostInput input) {
    }

    @Override
    public void shardEnded(ShardEndedInput input) {
        checkpoint(input.checkpointer());
    }

    @Override
    public void shutdownRequested(ShutdownRequestedInput input) {
        checkpoint(input.checkpointer());
    }

    private void checkpoint(RecordProcessorCheckpointer checkpointer) {
        try {
            checkpointer.checkpoint();
        } catch (Exception e) {
            problems.add(shardId + " failed to checkpoint: " + e);
        }
    }
}
