import type { MqttClient } from 'mqtt';
import type { Redis } from 'ioredis';
import type { IngestEngine } from '@pulse/core';

/** Shared singletons wired in server.ts and reached from route modules. */
export interface AppContext {
  redis: Redis;
  mqtt: MqttClient;
  ingest: IngestEngine;
}

let ctx: AppContext | null = null;

export function setContext(value: AppContext): void {
  ctx = value;
}

export function getContext(): AppContext {
  if (!ctx) throw new Error('app context not initialised');
  return ctx;
}
