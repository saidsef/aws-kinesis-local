import type { Store } from '../store/store.ts'
import { describeAccountSettings, describeLimits, updateAccountSettings } from './account.ts'
import {
  registerCapacityTransitions, updateMaxRecordSize, updateStreamMode, updateStreamRecordDistributionStrategy, updateStreamWarmThroughput,
} from './capacity.ts'
import { createChannel, deleteChannel, describeChannel, listChannels, registerChannelTransitions, updateChannel } from './channels.ts'
import type { Handler } from './common.ts'
import {
  deregisterStreamConsumer, describeStreamConsumer, listStreamConsumers, registerConsumerTransitions, registerStreamConsumer,
} from './consumers.ts'
import { registerEncryptionTransitions, startStreamEncryption, stopStreamEncryption } from './encryption.ts'
import { disableEnhancedMonitoring, enableEnhancedMonitoring } from './monitoring.ts'
import { deleteResourcePolicy, getResourcePolicy, putResourcePolicy } from './policies.ts'
import { getRecords, getShardIterator, putRecord, putRecords } from './records.ts'
import { decreaseStreamRetentionPeriod, increaseStreamRetentionPeriod } from './retention.ts'
import { listShards, mergeShards, registerShardTransitions, splitShard, updateShardCount } from './shards.ts'
import { createStream, deleteStream, describeStream, describeStreamSummary, listStreams, registerStreamTransitions } from './streams.ts'
import { subscribeToShard } from './subscribe.ts'
import {
  addTagsToStream, listTagsForResource, listTagsForStream, removeTagsFromStream, tagResource, untagResource,
} from './tags.ts'

export const handlers: Record<string, Handler> = {
  AddTagsToStream: addTagsToStream,
  CreateChannel: createChannel,
  CreateStream: createStream,
  DecreaseStreamRetentionPeriod: decreaseStreamRetentionPeriod,
  DeleteChannel: deleteChannel,
  DeleteResourcePolicy: deleteResourcePolicy,
  DeleteStream: deleteStream,
  DeregisterStreamConsumer: deregisterStreamConsumer,
  DescribeAccountSettings: describeAccountSettings,
  DescribeChannel: describeChannel,
  DescribeLimits: describeLimits,
  DescribeStream: describeStream,
  DescribeStreamConsumer: describeStreamConsumer,
  DescribeStreamSummary: describeStreamSummary,
  DisableEnhancedMonitoring: disableEnhancedMonitoring,
  EnableEnhancedMonitoring: enableEnhancedMonitoring,
  GetRecords: getRecords,
  GetResourcePolicy: getResourcePolicy,
  GetShardIterator: getShardIterator,
  IncreaseStreamRetentionPeriod: increaseStreamRetentionPeriod,
  ListChannels: listChannels,
  ListShards: listShards,
  ListStreamConsumers: listStreamConsumers,
  ListStreams: listStreams,
  ListTagsForResource: listTagsForResource,
  ListTagsForStream: listTagsForStream,
  MergeShards: mergeShards,
  PutRecord: putRecord,
  PutRecords: putRecords,
  PutResourcePolicy: putResourcePolicy,
  RegisterStreamConsumer: registerStreamConsumer,
  RemoveTagsFromStream: removeTagsFromStream,
  SplitShard: splitShard,
  StartStreamEncryption: startStreamEncryption,
  StopStreamEncryption: stopStreamEncryption,
  SubscribeToShard: subscribeToShard,
  TagResource: tagResource,
  UntagResource: untagResource,
  UpdateAccountSettings: updateAccountSettings,
  UpdateChannel: updateChannel,
  UpdateMaxRecordSize: updateMaxRecordSize,
  UpdateShardCount: updateShardCount,
  UpdateStreamMode: updateStreamMode,
  UpdateStreamRecordDistributionStrategy: updateStreamRecordDistributionStrategy,
  UpdateStreamWarmThroughput: updateStreamWarmThroughput,
}

export function registerTransitions(store: Store) {
  registerStreamTransitions(store)
  registerShardTransitions(store)
  registerCapacityTransitions(store)
  registerConsumerTransitions(store)
  registerEncryptionTransitions(store)
  registerChannelTransitions(store)
}
