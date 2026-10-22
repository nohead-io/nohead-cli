import { EventEmitter } from "node:events"

import { describe, expect, it } from "vitest"

import { CliError } from "./errors.ts"
import { readSecret } from "./secret.ts"

/** A terminal's stdin, recording raw mode. */
function terminal() {
  const input = Object.assign(new EventEmitter(), {
    raw: [] as boolean[],
    setRawMode(mode: boolean) {
      this.raw.push(mode)
    },
    setEncoding() {},
    resume() {},
    pause() {},
  })
  const written: string[] = []
  return { input, written, write: (text: string) => void written.push(text) }
}

describe("readSecret", () => {
  it("reads a pasted line without echoing it, and ends on Enter", async () => {
    const t = terminal()
    const secret = readSecret(t.input, t.write, "Key: ")
    t.input.emit("data", "nohead_sk_abc")
    t.input.emit("data", "123\r")

    expect(await secret).toBe("nohead_sk_abc123")
    expect(t.written.join("")).toBe("Key: \n") // the prompt, never the key
    expect(t.input.raw).toEqual([true, false])
    expect(t.input.listenerCount("data")).toBe(0)
  })

  it("handles Backspace and ends on Ctrl-D", async () => {
    const t = terminal()
    const secret = readSecret(t.input, t.write, "")
    t.input.emit("data", "sk_x\u007fy\u0004ignored")

    expect(await secret).toBe("sk_y")
  })

  it("skips arrow keys and bracketed paste markers", async () => {
    const t = terminal()
    const secret = readSecret(t.input, t.write, "")
    t.input.emit("data", "\u001b[200~nohead_sk_abc\u001b[201~")
    t.input.emit("data", "\u001b[D\u001bOA\u001b") // split across chunks
    t.input.emit("data", "[1;5Cdef\r")

    expect(await secret).toBe("nohead_sk_abcdef")
  })

  it("ends when the input does", async () => {
    const t = terminal()
    const secret = readSecret(t.input, t.write, "")
    t.input.emit("data", "sk_partial")
    t.input.emit("end")

    expect(await secret).toBe("sk_partial")
    expect(t.input.listenerCount("end")).toBe(0)
  })

  it("cancels on Ctrl-C, and leaves the terminal as it was", async () => {
    const t = terminal()
    const secret = readSecret(t.input, t.write, "")
    t.input.emit("data", "sk_\u0003")

    await expect(secret).rejects.toBeInstanceOf(CliError)
    expect(t.input.raw).toEqual([true, false])
  })
})
