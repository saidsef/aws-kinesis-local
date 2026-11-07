import type { AccountSettings } from '../store/types.ts'
import {
  CHANNEL_LIMIT, ON_DEMAND_STREAM_LIMIT, nowSeconds, provisionedOpenShards, streamMode, type Context, type Input,
} from './common.ts'

const COMMITMENT_WINDOW_SECONDS = 24 * 60 * 60

export function describeLimits(context: Context) {
  const { store } = context
  return {
    ShardLimit: store.options.shardLimit,
    OpenShardCount: provisionedOpenShards(context),
    OnDemandStreamCount: [...store.streams.values()].filter(stream => streamMode(stream) === 'ON_DEMAND').length,
    OnDemandStreamCountLimit: ON_DEMAND_STREAM_LIMIT,
    ChannelCount: store.channels.size,
    ChannelCountLimit: CHANNEL_LIMIT,
  }
}

export function describeAccountSettings(context: Context) {
  return { MinimumThroughputBillingCommitment: context.store.settings.MinimumThroughputBillingCommitment }
}

export function updateAccountSettings(context: Context, data: Input) {
  const requested = data.MinimumThroughputBillingCommitment.Status as 'ENABLED' | 'DISABLED'
  const current = context.store.settings.MinimumThroughputBillingCommitment
  const now = nowSeconds()
  let next: AccountSettings['MinimumThroughputBillingCommitment']
  if (requested === 'ENABLED') {
    next = current.Status === 'ENABLED' ? current : { Status: 'ENABLED', StartedAt: now, EarliestAllowedEndAt: now + COMMITMENT_WINDOW_SECONDS }
  } else {
    next = current.Status === 'DISABLED' ? current : { Status: 'DISABLED', ...(current.StartedAt ? { StartedAt: current.StartedAt } : {}), EndedAt: now }
  }
  context.store.saveSettings({ MinimumThroughputBillingCommitment: next })
  return { MinimumThroughputBillingCommitment: next }
}
