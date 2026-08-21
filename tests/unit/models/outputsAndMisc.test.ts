import { describe, expect, it } from 'vitest';
import { newId, nowIso } from '../../../src/shared/models/ids';
import { DeliverableSchema } from '../../../src/shared/models/deliverable';
import { ArtifactSchema } from '../../../src/shared/models/artifact';
import { MemorySchema } from '../../../src/shared/models/memory';
import { EventSchema, ActivityLogEntrySchema } from '../../../src/shared/models/event';
import { UsageSchema } from '../../../src/shared/models/usage';
import { PrereqSchema } from '../../../src/shared/models/prereq';
import { SecretsMetaSchema } from '../../../src/shared/models/secretsMeta';
import { SettingRowSchema } from '../../../src/shared/models/setting';
import { SchemaMigrationSchema } from '../../../src/shared/models/schemaMigration';
import { CounterSchema } from '../../../src/shared/models/counter';

describe('DeliverableSchema', () => {
  it('parses every documented type', () => {
    const now = nowIso();
    for (const type of ['repository', 'document', 'report', 'dataset', 'design', 'other']) {
      const parsed = DeliverableSchema.parse({
        id: newId(),
        project_id: newId(),
        phase_id: null,
        type,
        title: 'x',
        path: null,
        summary: 'x',
        status: 'draft',
        version: 1,
        created_at: now,
        updated_at: now,
      });
      expect(parsed.type).toBe(type);
    }
  });
});

describe('ArtifactSchema', () => {
  it('has no updated_at — compact single-line §5.1 definition taken as complete', () => {
    const now = nowIso();
    const parsed = ArtifactSchema.parse({
      id: newId(),
      task_id: newId(),
      employee_id: newId(),
      kind: 'diff',
      title: 'x',
      path: null,
      content: 'diff --git ...',
      content_sha256: 'abc',
      bytes: 100,
      mime: 'text/plain',
      pinned: 0,
      created_at: now,
    });
    expect('updated_at' in parsed).toBe(false);
  });
});

describe('MemorySchema', () => {
  it('has an explicit numeric rowid and parses tags JSON', () => {
    const now = nowIso();
    const parsed = MemorySchema.parse({
      rowid: 1,
      id: newId(),
      scope: 'project',
      scope_ref: newId(),
      path: 'memory/x.md',
      title: 'Deploy notes',
      body: 'Use the pipeline',
      content_sha256: 'abc',
      tags: JSON.stringify(['deploy', 'ci']),
      source: 'observed',
      pinned: 0,
      created_at: now,
      updated_at: now,
    });
    expect(parsed.tags).toEqual(['deploy', 'ci']);
    expect(typeof parsed.rowid).toBe('number');
  });
});

describe('EventSchema / ActivityLogEntrySchema', () => {
  it('events row has both ts (original) and created_at (mirror-insert time) — finding #3', () => {
    const original = nowIso();
    const insertedLater = nowIso();
    const parsed = EventSchema.parse({
      seq: 1,
      id: newId(),
      ts: original,
      actor: 'director',
      type: 'task.completed',
      severity: 'info',
      project_id: null,
      task_id: null,
      employee_id: null,
      checkpoint_id: null,
      payload: null,
      created_at: insertedLater,
    });
    expect(parsed.ts).toBe(original);
    expect(parsed.created_at).toBe(insertedLater);
  });

  it('severity is not a closed enum — "security" (§10.3.1) is a real value the model must accept', () => {
    expect(() =>
      ActivityLogEntrySchema.parse({
        seq: 1,
        id: newId(),
        ts: nowIso(),
        actor: 'core',
        type: 'git.validator_failed',
        severity: 'security',
      }),
    ).not.toThrow();
  });
});

describe('UsageSchema', () => {
  it('allows cost_usd_micros to be null — "cost not reported", never a fabricated $0 (§21)', () => {
    const parsed = UsageSchema.parse({
      id: newId(),
      employee_id: newId(),
      task_id: newId(),
      engine: 'generic-pty',
      model: null,
      tokens_in: null,
      tokens_out: null,
      tokens_cache_read: null,
      tokens_cache_write: null,
      cost_usd_micros: null,
      turn_index: null,
      source: 'turn',
      ts: nowIso(),
    });
    expect(parsed.cost_usd_micros).toBeNull();
  });

  it('accepts source: oneshot with nullable correlation columns (§22.4)', () => {
    const parsed = UsageSchema.parse({
      id: newId(),
      employee_id: null,
      task_id: null,
      engine: 'claude-code',
      model: 'balanced',
      tokens_in: 100,
      tokens_out: 50,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
      cost_usd_micros: 1500,
      turn_index: null,
      source: 'oneshot',
      ts: nowIso(),
    });
    expect(parsed.source).toBe('oneshot');
  });
});

describe('PrereqSchema / SecretsMetaSchema / SettingRowSchema / SchemaMigrationSchema / CounterSchema', () => {
  it('all parse their compact §5.1 shapes', () => {
    expect(() =>
      PrereqSchema.parse({ key: 'git', status: 'found', version: '2.44', path: 'C:\\git.exe', detected_at: nowIso(), notes: null }),
    ).not.toThrow();

    expect(() =>
      SecretsMetaSchema.parse({
        key: 'anthropic_api_key',
        provider: 'anthropic',
        storage_ref: 'safeStorage:1',
        last_set_at: nowIso(),
        last_used_at: null,
      }),
    ).not.toThrow();

    expect(() =>
      SettingRowSchema.parse({ key: 'general.theme', value_json: '"system"', updated_at: nowIso() }),
    ).not.toThrow();

    expect(() =>
      SchemaMigrationSchema.parse({ version: 1, name: '0001_initial.sql', applied_at: nowIso(), checksum: 'abc' }),
    ).not.toThrow();

    expect(() => CounterSchema.parse({ name: 'project', value: 3 })).not.toThrow();
  });
});
