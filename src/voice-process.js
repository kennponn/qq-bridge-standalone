import os from 'node:os';
import { spawn } from 'node:child_process';

export function lowerAudioProcessPriority(child, setPriority = os.setPriority) {
  child.once('spawn', () => {
    // Only lower this owned child; never change the bridge, gateway or desktop.
    if (!Number.isInteger(child.pid) || child.pid <= 0) return;
    try { setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); }
    catch { /* Unsupported/denied priority changes must not break voice delivery. */ }
  });
  return child;
}

export function spawnAudioProcess(command, args, options = {}) {
  return lowerAudioProcessPriority(spawn(command, args, { ...options, windowsHide: true }));
}
