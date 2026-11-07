export const memberOrder: Record<string, string[]> = {
  AddTagsToStreamInput: ['Tags', 'StreamName'],
  CreateStreamInput: ['ShardCount', 'StreamName'],
  DecreaseStreamRetentionPeriodInput: ['RetentionPeriodHours', 'StreamName'],
  DeleteStreamInput: ['StreamName'],
  DescribeStreamInput: ['Limit', 'ExclusiveStartShardId', 'StreamName'],
  DescribeStreamSummaryInput: ['StreamName'],
  GetRecordsInput: ['Limit', 'ShardIterator'],
  GetShardIteratorInput: ['ShardId', 'ShardIteratorType', 'StartingSequenceNumber', 'StreamName', 'Timestamp'],
  IncreaseStreamRetentionPeriodInput: ['RetentionPeriodHours', 'StreamName'],
  ListShardsInput: ['ExclusiveStartShardId', 'MaxResults', 'NextToken', 'StreamCreationTimestamp', 'StreamName'],
  ListStreamsInput: ['Limit', 'ExclusiveStartStreamName'],
  ListTagsForStreamInput: ['Limit', 'ExclusiveStartTagKey', 'StreamName'],
  MergeShardsInput: ['ShardToMerge', 'AdjacentShardToMerge', 'StreamName'],
  PutRecordInput: ['SequenceNumberForOrdering', 'PartitionKey', 'ExplicitHashKey', 'Data', 'StreamName'],
  PutRecordsInput: ['Records', 'StreamName'],
  PutRecordsRequestEntry: ['PartitionKey', 'ExplicitHashKey', 'Data'],
  RemoveTagsFromStreamInput: ['TagKeys', 'StreamName'],
  SplitShardInput: ['NewStartingHashKey', 'StreamName', 'ShardToSplit'],
}

export const enumOrder: Record<string, string[]> = {
  ShardIteratorType: ['AFTER_SEQUENCE_NUMBER', 'LATEST', 'AT_TIMESTAMP', 'AT_SEQUENCE_NUMBER', 'TRIM_HORIZON'],
}

export const listMemberLabels: Record<string, string> = {
  PutRecordsRequestEntry: 'com.amazonaws.kinesis.v20131202.PutRecordsRequestEntry@c965e310',
}

export const streamNameOptional = new Set(['ListShardsInput', 'ListStreamsInput'])

export const partitionKeyShapes = new Set(['PutRecordInput', 'PutRecordsRequestEntry'])

export const recordDataShapes = new Set(['PutRecordInput', 'PutRecordsRequestEntry'])
