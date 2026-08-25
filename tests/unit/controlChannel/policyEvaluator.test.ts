import { describe, expect, it } from 'vitest';
import { evaluateInterimPolicy } from '../../../src/main/controlChannel/policyEvaluator';

describe('evaluateInterimPolicy (§20.2: deny-by-default, small hardcoded allow-list, no partial policy engine)', () => {
  it.each(['Read', 'Grep', 'Glob'])('allows the exact hardcoded read tool "%s"', (tool) => {
    expect(evaluateInterimPolicy(tool)).toBe('allow');
  });

  it('allows every bureau_* tool — §11.3\'s "bureau" class is always allowed', () => {
    expect(evaluateInterimPolicy('bureau_report_status')).toBe('allow');
    expect(evaluateInterimPolicy('bureau_task_done')).toBe('allow');
    expect(evaluateInterimPolicy('bureau_anything_at_all')).toBe('allow');
  });

  it('denies everything else by default — Write, Bash, Edit, and anything unrecognised', () => {
    expect(evaluateInterimPolicy('Write')).toBe('deny');
    expect(evaluateInterimPolicy('Bash')).toBe('deny');
    expect(evaluateInterimPolicy('Edit')).toBe('deny');
    expect(evaluateInterimPolicy('SomeUnknownTool')).toBe('deny');
  });

  it('is case-sensitive — "read" (lowercase) is not the same as "Read"', () => {
    expect(evaluateInterimPolicy('read')).toBe('deny');
  });

  it('does not treat a tool merely containing "bureau_" mid-string as the bureau class — prefix only', () => {
    expect(evaluateInterimPolicy('not_bureau_report_status')).toBe('deny');
  });
});
