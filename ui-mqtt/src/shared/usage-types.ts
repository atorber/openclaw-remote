/**
 * Minimal usage types for standalone openclaw-remote UI.
 */

export type SessionCostSummary = {
  tokens?: number;
  cost?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  messages?: number;
  toolCalls?: number;
  errors?: number;
  [key: string]: unknown;
};

export type SessionUsageEntry = {
  key: string;
  label?: string;
  sessionId?: string;
  updatedAt?: number;
  agentId?: string;
  channel?: string;
  chatType?: string;
  origin?: Record<string, unknown>;
  modelOverride?: string;
  providerOverride?: string;
  modelProvider?: string;
  model?: string;
  usage: SessionCostSummary | null;
  contextWeight?: unknown;
};

export type SessionsUsageTotalsLike = {
  tokens: number;
  cost: number;
  inputTokens?: number;
  outputTokens?: number;
  messages?: number;
  toolCalls?: number;
  errors?: number;
  [key: string]: unknown;
};

export type SessionMessageCounts = Record<string, number>;
export type SessionToolUsage = Record<string, number>;
export type SessionModelUsage = { model?: string; provider?: string; tokens?: number; cost?: number };
export type SessionLatencyStats = Record<string, unknown>;
export type SessionDailyLatency = Record<string, unknown>;
export type SessionDailyModelUsage = Record<string, unknown>;

export type SessionsUsageAggregates = {
  messages: SessionMessageCounts;
  tools: SessionToolUsage;
  byModel: SessionModelUsage[];
  byProvider: SessionModelUsage[];
  byAgent: Array<{ agentId: string; totals: SessionsUsageTotalsLike }>;
  byChannel: Array<{ channel: string; totals: SessionsUsageTotalsLike }>;
  latency?: SessionLatencyStats;
  dailyLatency?: SessionDailyLatency[];
  modelDaily?: SessionDailyModelUsage[];
  daily: Array<{
    date: string;
    tokens: number;
    cost: number;
    messages: number;
    toolCalls: number;
    errors: number;
  }>;
};

export type SessionsUsageResult = {
  updatedAt: number;
  startDate: string;
  endDate: string;
  sessions: SessionUsageEntry[];
  totals: SessionsUsageTotalsLike;
  aggregates: SessionsUsageAggregates;
};
