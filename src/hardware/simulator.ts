import type { SimulatorSignal } from "../domain/types.ts";

export type DeviceInfo = {
  model: string;
  serial: string;
  certified: false;
};

/**
 * Hardware boundary. Certified readers implement this later.
 * Nothing in this interface returns a PAN, track, PIN, or CVV.
 */
export interface TerminalHardware {
  initialize(): Promise<void>;
  getDeviceInfo(): Promise<DeviceInfo>;
  presentCard(signal: SimulatorSignal): Promise<{ presented: true }>;
  startContactless(): Promise<void>;
  startChip(): Promise<void>;
  cancelTransaction(): Promise<void>;
  display(message: string): Promise<void>;
  print(receipt: string): Promise<void>;
  beep(): Promise<void>;
  getBattery(): Promise<{ percent: number }>;
  getNetworkStatus(): Promise<{ online: boolean }>;
}

export class SimulatorHardware implements TerminalHardware {
  networkOnline = true;
  lastDisplay = "";
  printed: string[] = [];

  async initialize(): Promise<void> {}

  async getDeviceInfo(): Promise<DeviceInfo> {
    return { model: "Red Face Simulator", serial: "SIM-000001", certified: false };
  }

  async presentCard(_signal: SimulatorSignal): Promise<{ presented: true }> {
    return { presented: true };
  }

  async startContactless(): Promise<void> {}
  async startChip(): Promise<void> {}
  async cancelTransaction(): Promise<void> {}

  async display(message: string): Promise<void> {
    this.lastDisplay = message;
  }

  async print(receipt: string): Promise<void> {
    this.printed.push(receipt);
  }

  async beep(): Promise<void> {}

  async getBattery(): Promise<{ percent: number }> {
    return { percent: 100 };
  }

  async getNetworkStatus(): Promise<{ online: boolean }> {
    return { online: this.networkOnline };
  }
}
