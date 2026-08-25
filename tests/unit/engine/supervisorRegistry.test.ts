import { describe, expect, it } from 'vitest';
import { SupervisorRegistry } from '../../../src/main/engine/supervisorRegistry';
import type { Supervisor } from '../../../src/main/engine/supervisor';

describe('SupervisorRegistry (M4 session 2: the control channel -> supervisor addressing mechanism)', () => {
  it('get returns the registered supervisor for its employeeId', () => {
    const registry = new SupervisorRegistry();
    const fake = {} as Supervisor;
    registry.register('emp1', fake);
    expect(registry.get('emp1')).toBe(fake);
  });

  it('get returns undefined for an employee never registered', () => {
    const registry = new SupervisorRegistry();
    expect(registry.get('nobody')).toBeUndefined();
  });

  it('unregister removes the entry', () => {
    const registry = new SupervisorRegistry();
    registry.register('emp1', {} as Supervisor);
    registry.unregister('emp1');
    expect(registry.get('emp1')).toBeUndefined();
  });

  it('registering a second supervisor for the same employeeId replaces the first', () => {
    const registry = new SupervisorRegistry();
    const first = {} as Supervisor;
    const second = {} as Supervisor;
    registry.register('emp1', first);
    registry.register('emp1', second);
    expect(registry.get('emp1')).toBe(second);
  });
});
