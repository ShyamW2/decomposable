import { contractSuite } from '#conformance'

contractSuite({
  dir: import.meta.dirname,
  // The contract runs on the baseline profile: no GPU, small model (ADR-002).
  config: { version: 1, device: 'cpu', profile: 'lite' },
})
