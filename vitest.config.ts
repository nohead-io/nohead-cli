import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Random order: a test that passes only after another is a defect.
    sequence: { shuffle: true },
    // A test that asserts nothing passes whatever the code does.
    expect: { requireAssertions: true },
  },
})
