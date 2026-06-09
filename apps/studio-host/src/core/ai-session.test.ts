import { describe, expect, it, vi } from 'vitest';
import { AiSessionMachine } from './ai-session';

describe('AiSessionMachine', () => {
  it('runs the happy path IDLE→REQUESTING→DIFF_PENDING→IDLE on accept', () => {
    const machine = new AiSessionMachine();
    expect(machine.state).toBe('IDLE');
    machine.startRequest();
    expect(machine.state).toBe('REQUESTING');
    expect(machine.onReady()).toBe(true);
    expect(machine.state).toBe('DIFF_PENDING');
    expect(machine.accept()).toBe(true);
    expect(machine.state).toBe('IDLE');
  });

  it('reject rolls back from DIFF_PENDING and fires onRollback', () => {
    const onRollback = vi.fn();
    const machine = new AiSessionMachine({ onRollback });
    machine.startRequest();
    machine.onReady();
    expect(machine.reject()).toBe(true);
    expect(onRollback).toHaveBeenCalledTimes(1);
    expect(machine.state).toBe('IDLE');
  });

  it('auto-rolls back a pending diff when a new request starts', () => {
    const onRollback = vi.fn();
    const machine = new AiSessionMachine({ onRollback });
    machine.startRequest();
    machine.onReady();
    expect(machine.isPending).toBe(true);

    machine.startRequest();
    expect(onRollback).toHaveBeenCalledTimes(1);
    expect(machine.state).toBe('REQUESTING');
  });

  it('onFailed returns REQUESTING to IDLE', () => {
    const machine = new AiSessionMachine();
    machine.startRequest();
    machine.onFailed();
    expect(machine.state).toBe('IDLE');
  });

  it('complete() ends an edit-less answer (REQUESTING→IDLE) and is a no-op otherwise', () => {
    const machine = new AiSessionMachine();
    expect(machine.complete()).toBe(false); // IDLE에서는 무효
    machine.startRequest();
    expect(machine.complete()).toBe(true);
    expect(machine.state).toBe('IDLE');
  });

  it('ignores accept/onReady from invalid states', () => {
    const machine = new AiSessionMachine();
    expect(machine.accept()).toBe(false);
    expect(machine.onReady()).toBe(false);
    expect(machine.reject()).toBe(false);
    expect(machine.state).toBe('IDLE');
  });

  it('cancel during REQUESTING goes to IDLE; during DIFF_PENDING rolls back', () => {
    const onRollback = vi.fn();
    const machine = new AiSessionMachine({ onRollback });
    machine.startRequest();
    machine.cancel();
    expect(machine.state).toBe('IDLE');

    machine.startRequest();
    machine.onReady();
    machine.cancel();
    expect(onRollback).toHaveBeenCalledTimes(1);
    expect(machine.state).toBe('IDLE');
  });
});
