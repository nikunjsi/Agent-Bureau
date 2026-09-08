import { describe, expect, it } from 'vitest';
import { describeAddress, parseMessageAddress } from '../../../src/main/messages/addressing';

/**
 * §9.7's address forms. Three producers write `to_addr` and they do not
 * agree on spelling, because two of them cannot — see addressing.ts.
 */
describe('§9.7 address parsing', () => {
  it("parses answerCheckpoint's explicit `employee:<id>` form", () => {
    expect(parseMessageAddress('employee:emp-1')).toEqual({
      kind: 'employee',
      employeeId: 'emp-1',
    });
  });

  it('parses a bare id, which is what an agent actually writes', () => {
    // §7.9 makes `to` agent-suppliable on purpose ("that is the point of
    // the tool"), so this is the ordinary case, not a fallback.
    expect(parseMessageAddress('emp-1')).toEqual({ kind: 'employee', employeeId: 'emp-1' });
  });

  it('parses `role:<key>` and keeps the key exactly as written', () => {
    expect(parseMessageAddress('role:engineering.developer')).toEqual({
      kind: 'role',
      roleKey: 'engineering.developer',
    });
  });

  it('parses director and user case-insensitively', () => {
    expect(parseMessageAddress('director')).toEqual({ kind: 'director' });
    expect(parseMessageAddress('Director')).toEqual({ kind: 'director' });
    expect(parseMessageAddress('user')).toEqual({ kind: 'user' });
  });

  it('trims surrounding whitespace an agent may have included', () => {
    expect(parseMessageAddress('  role:ops.director  ')).toEqual({
      kind: 'role',
      roleKey: 'ops.director',
    });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'whitespace only'],
    ['role:', 'a prefix with no key'],
    ['employee:', 'a prefix with no id'],
    ['team:engineering', 'an unknown prefix'],
  ])('refuses to guess at %s (%s)', (raw) => {
    const parsed = parseMessageAddress(raw);
    // Unparseable is a real outcome with a real consequence — §9.7's dead
    // letter, and a blocker checkpoint if it was a question. Guessing would
    // deliver someone's question to the wrong person.
    expect(parsed.kind).toBe('unparseable');
  });

  it('describes every address form for checkpoint prose', () => {
    expect(describeAddress(parseMessageAddress('employee:emp-9'))).toContain('emp-9');
    expect(describeAddress(parseMessageAddress('role:engineering.tester'))).toContain(
      'engineering.tester',
    );
    expect(describeAddress(parseMessageAddress('director'))).toBe('the Director');
    expect(describeAddress(parseMessageAddress('team:x'))).toContain('unrecognised');
  });
});
