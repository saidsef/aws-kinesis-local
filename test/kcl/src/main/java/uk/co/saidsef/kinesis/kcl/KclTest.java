package uk.co.saidsef.kinesis.kcl;

import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;
import java.util.stream.Collectors;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.SdkBytes;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.cloudwatch.CloudWatchAsyncClient;
import software.amazon.awssdk.services.dynamodb.DynamoDbAsyncClient;
import software.amazon.awssdk.services.kinesis.KinesisAsyncClient;
import software.amazon.awssdk.services.kinesis.model.Consumer;
import software.amazon.awssdk.services.kinesis.model.ConsumerStatus;
import software.amazon.awssdk.services.kinesis.model.PutRecordsRequestEntry;
import software.amazon.awssdk.services.kinesis.model.PutRecordsResponse;
import software.amazon.awssdk.services.kinesis.model.PutRecordsResultEntry;
import software.amazon.awssdk.services.kinesis.model.StreamDescriptionSummary;
import software.amazon.awssdk.services.kinesis.model.StreamStatus;
import software.amazon.kinesis.common.ConfigsBuilder;
import software.amazon.kinesis.common.InitialPositionInStream;
import software.amazon.kinesis.common.InitialPositionInStreamExtended;
import software.amazon.kinesis.common.KinesisClientUtil;
import software.amazon.kinesis.coordinator.Scheduler;
import software.amazon.kinesis.metrics.MetricsLevel;
import software.amazon.kinesis.metrics.NullMetricsFactory;
import software.amazon.kinesis.processor.SingleStreamTracker;
import software.amazon.kinesis.retrieval.RetrievalConfig;
import software.amazon.kinesis.retrieval.polling.PollingConfig;

public final class KclTest {
    private static final Region REGION = Region.EU_WEST_1;
    private static final String STREAM = "kcl-test";
    private static final int SHARDS = 2;
    private static final int BACKLOG = 200;
    private static final int LIVE = 50;
    private static final Duration READY_DEADLINE = Duration.ofSeconds(60);
    private static final Duration MODE_DEADLINE = Duration.ofSeconds(120);
    private static final Duration SHARD_SYNC_INTERVAL = Duration.ofSeconds(1);

    private final Map<String, String> expected = new ConcurrentHashMap<>();
    private final KinesisAsyncClient kinesis;
    private final DynamoDbAsyncClient dynamo;
    private final CloudWatchAsyncClient cloudWatch;

    private KclTest() {
        var credentials = StaticCredentialsProvider.create(AwsBasicCredentials.create("test", "test"));
        String kinesisEndpoint = env("KINESIS_ENDPOINT", "http://localhost:4567");
        kinesis = KinesisClientUtil.createKinesisAsyncClient(KinesisAsyncClient.builder()
                .endpointOverride(URI.create(kinesisEndpoint))
                .region(REGION)
                .credentialsProvider(credentials));
        dynamo = DynamoDbAsyncClient.builder()
                .endpointOverride(URI.create(env("DYNAMODB_ENDPOINT", "http://localhost:8000")))
                .region(REGION)
                .credentialsProvider(credentials)
                .build();
        cloudWatch = CloudWatchAsyncClient.builder()
                .endpointOverride(URI.create(env("CLOUDWATCH_ENDPOINT", kinesisEndpoint)))
                .region(REGION)
                .credentialsProvider(credentials)
                .build();
    }

    public static void main(String[] args) {
        int status = 0;
        try {
            new KclTest().run();
            System.out.println("PASS: the KCL processed every record in polling and enhanced fan-out mode");
        } catch (Throwable e) {
            System.err.println("FAIL: " + (e.getMessage() == null ? e : e.getMessage()));
            e.printStackTrace();
            status = 1;
        }
        System.exit(status);
    }

    private void run() throws Exception {
        Instant ready = Instant.now().plus(READY_DEADLINE);
        await(() -> "aws-kinesis-local to answer ListStreams", ready, () -> kinesis.listStreams(r -> { }).join() != null);
        await(() -> "DynamoDB Local to answer ListTables", ready, () -> dynamo.listTables(r -> { }).join() != null);
        kinesis.createStream(r -> r.streamName(STREAM).shardCount(SHARDS)).join();
        await(() -> STREAM + " to become ACTIVE", ready, () -> summary().streamStatus() == StreamStatus.ACTIVE);
        Set<String> shards = put("backlog", BACKLOG);
        if (shards.size() != SHARDS) {
            throw new IllegalStateException("PutRecords spread " + BACKLOG + " records over " + shards + " instead of " + SHARDS + " shards");
        }
        consume("polling", true);
        consume("fan-out", false);
        List<Consumer> consumers = kinesis.listStreamConsumers(r -> r.streamARN(summary().streamARN())).join().consumers();
        if (consumers.stream().noneMatch(c -> c.consumerName().equals(application("fan-out")) && c.consumerStatus() == ConsumerStatus.ACTIVE)
                || consumers.stream().anyMatch(c -> c.consumerName().equals(application("polling")))) {
            throw new IllegalStateException("Unexpected stream consumers: " + consumers);
        }
    }

    private void consume(String mode, boolean polling) throws Exception {
        Instant start = Instant.now();
        Instant deadline = start.plus(MODE_DEADLINE);
        Map<String, Integer> seen = new ConcurrentHashMap<>();
        List<String> problems = new CopyOnWriteArrayList<>();
        var tracker = new SingleStreamTracker(STREAM,
                InitialPositionInStreamExtended.newInitialPosition(InitialPositionInStream.TRIM_HORIZON));
        var configs = new ConfigsBuilder(tracker, application(mode), kinesis, dynamo, cloudWatch,
                UUID.randomUUID().toString(), () -> new Processor(expected, seen, problems));
        RetrievalConfig retrieval = configs.retrievalConfig();
        if (polling) {
            retrieval.retrievalSpecificConfig(new PollingConfig(kinesis));
        }
        var scheduler = new Scheduler(configs.checkpointConfig(), configs.coordinatorConfig(),
                configs.leaseManagementConfig().shardSyncIntervalMillis(SHARD_SYNC_INTERVAL.toMillis()),
                configs.lifecycleConfig(),
                configs.metricsConfig().metricsLevel(MetricsLevel.NONE).metricsFactory(new NullMetricsFactory()),
                configs.processorConfig(), retrieval);
        Thread worker = new Thread(scheduler, application(mode));
        worker.setDaemon(true);
        worker.start();
        int backlog = expected.size();
        awaitRecords(mode, seen, problems, deadline);
        Instant backlogDone = Instant.now();
        put(mode + "-live", LIVE);
        awaitRecords(mode, seen, problems, deadline);
        Instant liveDone = Instant.now();
        if (!scheduler.startGracefulShutdown().get(Math.max(1, Duration.between(Instant.now(), deadline).toMillis()), TimeUnit.MILLISECONDS)) {
            throw new IllegalStateException(mode + " scheduler did not shut down cleanly");
        }
        verify(mode, seen, problems);
        System.out.printf("%s: expected %d records (%d backlog, %d live), processed %d exactly once;"
                        + " backlog after %.1f s, live records within %.1f s of the put, %.1f s in total, shutdown %.1f s%n",
                mode, expected.size(), backlog, LIVE, seen.size(), seconds(start, backlogDone),
                seconds(backlogDone, liveDone), seconds(start, liveDone), seconds(liveDone, Instant.now()));
    }

    private void awaitRecords(String mode, Map<String, Integer> seen, List<String> problems, Instant deadline) throws Exception {
        Set<String> keys = Set.copyOf(expected.keySet());
        await(() -> mode + " to process " + keys.size() + " records, " + seen.keySet().stream().filter(keys::contains).count()
                        + " done within the " + MODE_DEADLINE.toSeconds() + " s deadline",
                deadline, () -> !problems.isEmpty() || seen.keySet().containsAll(keys));
        verify(mode, seen, problems);
    }

    private void verify(String mode, Map<String, Integer> seen, List<String> problems) {
        List<String> errors = new ArrayList<>(problems);
        seen.forEach((key, count) -> {
            if (count != 1) {
                errors.add(key + " processed " + count + " times");
            }
        });
        if (!errors.isEmpty()) {
            throw new IllegalStateException(mode + " found " + errors.size() + " problems: "
                    + String.join("; ", errors.subList(0, Math.min(20, errors.size()))));
        }
    }

    private Set<String> put(String prefix, int count) {
        List<PutRecordsRequestEntry> entries = new ArrayList<>();
        for (int i = 0; i < count; i++) {
            String key = prefix + "-" + i;
            String data = "record " + i + " of " + prefix;
            expected.put(key, data);
            entries.add(PutRecordsRequestEntry.builder().partitionKey(key).data(SdkBytes.fromUtf8String(data)).build());
        }
        PutRecordsResponse response = kinesis.putRecords(r -> r.streamName(STREAM).records(entries)).join();
        if (response.failedRecordCount() != null && response.failedRecordCount() > 0) {
            throw new IllegalStateException("PutRecords failed for " + response.failedRecordCount() + " " + prefix + " records");
        }
        return response.records().stream().map(PutRecordsResultEntry::shardId).collect(Collectors.toSet());
    }

    private StreamDescriptionSummary summary() {
        return kinesis.describeStreamSummary(r -> r.streamName(STREAM)).join().streamDescriptionSummary();
    }

    private static void await(Supplier<String> what, Instant deadline, Callable<Boolean> check) throws Exception {
        Exception last = null;
        while (true) {
            try {
                if (check.call()) {
                    return;
                }
            } catch (Exception e) {
                last = e;
            }
            if (Instant.now().isAfter(deadline)) {
                throw new IllegalStateException("Timed out waiting for " + what.get(), last);
            }
            Thread.sleep(250);
        }
    }

    private static String application(String mode) {
        return "kcl-test-" + mode;
    }

    private static double seconds(Instant from, Instant to) {
        return Duration.between(from, to).toMillis() / 1000.0;
    }

    private static String env(String name, String fallback) {
        String value = System.getenv(name);
        return value == null || value.isBlank() ? fallback : value;
    }
}
