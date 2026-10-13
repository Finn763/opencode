import { expect, test } from "bun:test"
import { noTimeoutFetch } from "../src/util/no-timeout-fetch"

test("the TUI fetch disables Bun's five-minute deadline and preserves the init", async () => {
  const original = globalThis.fetch
  const calls: Array<{ input: RequestInfo | URL; init: RequestInit | undefined }> = []
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init })
    return Promise.resolve(new Response("ok"))
  }) as typeof fetch
  try {
    const response = await noTimeoutFetch("http://example.test/cmd", { method: "POST", headers: { "x-a": "b" } })
    expect(await response.text()).toBe("ok")
    expect(calls).toHaveLength(1)
    expect(calls[0].input).toBe("http://example.test/cmd")
    expect(calls[0].init?.method).toBe("POST")
    expect(calls[0].init?.headers).toEqual({ "x-a": "b" })
    expect((calls[0].init as { timeout?: unknown } | undefined)?.timeout).toBe(false)
  } finally {
    globalThis.fetch = original
  }
})

test("works when no init is passed", async () => {
  const original = globalThis.fetch
  let captured: RequestInit | undefined
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    captured = init
    return Promise.resolve(new Response("ok"))
  }) as typeof fetch
  try {
    await noTimeoutFetch("http://example.test/cmd")
    expect((captured as { timeout?: unknown } | undefined)?.timeout).toBe(false)
  } finally {
    globalThis.fetch = original
  }
})
