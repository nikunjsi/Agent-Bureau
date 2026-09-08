import { describe, expect, it } from 'vitest';
import { SecretRegistry, redactText, redactDeep } from '../../../src/main/secrets/redactor';

describe('SecretRegistry (§11.4)', () => {
  it('tracks registered values and reports the longest one', () => {
    const registry = new SecretRegistry();
    registry.register(['short', 'a-much-longer-secret-value']);
    expect(registry.values()).toContain('short');
    expect(registry.values()).toContain('a-much-longer-secret-value');
    expect(registry.longestValueLength()).toBe('a-much-longer-secret-value'.length);
  });

  it('never tracks an empty string — would redact everything', () => {
    const registry = new SecretRegistry();
    registry.register(['', 'real']);
    expect(registry.values()).toEqual(['real']);
  });

  it('reports 0 longest length when nothing is registered', () => {
    expect(new SecretRegistry().longestValueLength()).toBe(0);
  });
});

describe('redactText — exact secret values (§11.4)', () => {
  it('redacts a known secret value, named in the output', () => {
    const registry = new SecretRegistry();
    registry.register(['sk-realvaluehere1234567890abcdef']);
    const out = redactText('the key is sk-realvaluehere1234567890abcdef in this log', registry);
    expect(out).not.toContain('sk-realvaluehere1234567890abcdef');
    expect(out).toContain('«redacted:');
  });

  it('redacts every occurrence, not just the first', () => {
    const registry = new SecretRegistry();
    registry.register(['topsecret123']);
    const out = redactText('topsecret123 appears twice: topsecret123', registry);
    expect(out).not.toContain('topsecret123');
    expect(out.split('«redacted:').length - 1).toBe(2);
  });

  it('leaves ordinary text completely untouched when nothing matches', () => {
    const registry = new SecretRegistry();
    registry.register(['unrelated-secret']);
    const text = 'a perfectly ordinary log line with a host like example.com';
    expect(redactText(text, registry)).toBe(text);
  });

  it('a null registry default (no explicit registry) still works against an isolated call site', () => {
    // Uses the module's own default param (globalSecretRegistry) — just
    // confirms the call succeeds and doesn't throw for plain text.
    expect(redactText('plain text, no secrets')).toBe('plain text, no secrets');
  });
});

describe('redactText — high-confidence patterns (§11.4)', () => {
  const registry = new SecretRegistry(); // empty — proves these are pattern-only catches

  it('redacts a JWT', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const out = redactText(`Authorization info: ${jwt}`, registry);
    expect(out).not.toContain(jwt);
    expect(out).toContain('«redacted:jwt»');
  });

  it('redacts an OpenAI-style sk- key', () => {
    const out = redactText('key=sk-abcdefghijklmnopqrstuvwxyz123456', registry);
    expect(out).toContain('«redacted:openai_key»');
    expect(out).not.toMatch(/sk-abcdefghijklmnopqrstuvwxyz123456/);
  });

  it('redacts a Groq-style gsk_ key', () => {
    const out = redactText('key=gsk_abcdefghijklmnopqrstuvwxyz123456', registry);
    expect(out).toContain('«redacted:groq_key»');
  });

  it('redacts a Databricks-style dapi token', () => {
    const out = redactText('token=dapi1234567890abcdef1234567890abcdef', registry);
    expect(out).toContain('«redacted:databricks_token»');
  });

  it('redacts an AWS access key ID', () => {
    const out = redactText('AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE', registry);
    expect(out).toContain('«redacted:aws_access_key_id»');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('redacts a PEM block, including its multi-line body', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\nmore lines here\n-----END RSA PRIVATE KEY-----';
    const out = redactText(`here is the key:\n${pem}\ndone`, registry);
    expect(out).not.toContain('MIIEowIBAAKCAQEA');
    expect(out).toContain('«redacted:pem_block»');
    expect(out).toContain('here is the key:');
    expect(out).toContain('done');
  });

  it('redacts a Bearer header', () => {
    const out = redactText('Authorization: Bearer abcDEF123456789012345678901234567890', registry);
    expect(out).toContain('«redacted:bearer_header»');
    expect(out).not.toContain('abcDEF123456789012345678901234567890');
  });

  it('redacts a connection string with embedded credentials', () => {
    const out = redactText('DATABASE_URL=postgres://admin:hunter2@db.internal:5432/prod', registry);
    expect(out).toContain('«redacted:connection_string»');
    expect(out).not.toContain('hunter2');
  });

  it('does NOT redact a plain URL with no embedded credentials', () => {
    const text = 'see https://docs.python.org/3/ for details';
    expect(redactText(text, registry)).toBe(text);
  });
});

describe('redactDeep — structured payloads (event payloads, state-delta)', () => {
  it('redacts a secret nested inside an object/array shape', () => {
    const registry = new SecretRegistry();
    registry.register(['deep-secret-value']);
    const payload = {
      a: 'no secret here',
      b: { nested: 'contains deep-secret-value inline' },
      c: ['array item with deep-secret-value too', 42, null],
    };
    const out = redactDeep(payload, registry);
    expect(JSON.stringify(out)).not.toContain('deep-secret-value');
    expect(JSON.stringify(out)).toContain('«redacted:');
    expect(out.a).toBe('no secret here');
    expect(out.c[1]).toBe(42);
    expect(out.c[2]).toBeNull();
  });

  it('passes non-string scalars through unchanged', () => {
    const registry = new SecretRegistry();
    expect(redactDeep(42, registry)).toBe(42);
    expect(redactDeep(true, registry)).toBe(true);
    expect(redactDeep(null, registry)).toBeNull();
  });
});
