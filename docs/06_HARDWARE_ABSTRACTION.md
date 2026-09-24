# Hardware abstraction

`src/hardware/simulator.ts` is the seam for a future certified reader.

```text
initialize
getDeviceInfo
presentCard
startContactless
startChip
cancelTransaction
display
print
beep
getBattery
getNetworkStatus
```

`presentCard` returns `{ presented: true }`. It does not return a PAN, track, expiry, PIN, or CVV. The web simulator sends the same four signals to the payment engine. A manufacturer SDK later replaces `SimulatorHardware` and still must not hand raw card data to Red Face application code.

`getDeviceInfo` reports `certified: false` until a real device adapter exists.
