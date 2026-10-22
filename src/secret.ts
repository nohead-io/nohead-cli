import { CliError, ExitCode } from "./errors.ts"

/** The part of a terminal's stdin that readSecret uses (a tty.ReadStream). */
export interface SecretInput {
  setRawMode(mode: boolean): unknown
  setEncoding(encoding: BufferEncoding): unknown
  resume(): unknown
  pause(): unknown
  on(event: "data", listener: (chunk: string) => void): unknown
  on(event: "end", listener: () => void): unknown
  off(event: "data", listener: (chunk: string) => void): unknown
  off(event: "end", listener: () => void): unknown
}

/**
 * A line typed or pasted at an interactive terminal, without echoing it, so
 * a secret (an API key) never lands on screen, in scrollback or in a screen
 * recording. Ends on Enter, Ctrl-D or the end of input;
 * Backspace deletes, and Ctrl-C cancels. Escape sequences (arrow keys, the
 * markers of a bracketed paste) are skipped, never taken as part of the key.
 * Raw mode is always turned back off.
 */
export function readSecret(
  input: SecretInput,
  write: (text: string) => void,
  prompt: string
): Promise<string> {
  write(prompt)
  return new Promise((resolve, reject) => {
    let value = ""
    // Inside an escape sequence: "\x1b", then "[" or "O", then up to a
    // final byte from "@" to "~" (ECMA-48), possibly split across chunks.
    let escape: "" | "start" | "body" = ""
    const finish = (error?: CliError) => {
      input.off("data", onData)
      input.off("end", onEnd)
      input.setRawMode(false)
      input.pause()
      if (prompt) write("\n")
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (escape === "start") {
          escape = char === "[" || char === "O" ? "body" : ""
          continue
        }
        if (escape === "body") {
          if (char >= "@" && char <= "~") escape = ""
          continue
        }
        if (char === "\u001b") {
          escape = "start"
          continue
        }
        if (char === "\r" || char === "\n" || char === "\u0004") return finish()
        if (char === "\u0003")
          return finish(
            new CliError(ExitCode.Usage, {
              type: "cancelled",
              message: "Cancelled",
            })
          )
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1)
        else if (char >= " ") value += char
      }
    }
    const onEnd = () => finish()
    input.setEncoding("utf8")
    input.setRawMode(true)
    input.resume()
    input.on("data", onData)
    input.on("end", onEnd)
  })
}
