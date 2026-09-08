import { describe, expect, it } from "vitest";
import {
  MAX_RENDERER_MESSAGE_CHARS,
  formatRendererConsoleLine,
  rendererFrameLabel,
  rendererLogMethod,
  sanitizeRendererText,
  type RendererConsoleDetails,
  type RendererFrame,
} from "../renderer-console-log";

function details(over: Partial<RendererConsoleDetails> = {}): RendererConsoleDetails {
  return {
    message: "something happened",
    level: "info",
    lineNumber: 42,
    sourceId: "app://index.js",
    frame: topFrame(),
    ...over,
  };
}

function topFrame(): RendererFrame {
  return { detached: false, parent: null, routingId: 1 };
}

describe("rendererLogMethod", () => {
  // The severity on the `details` object is a string; the deprecated positional
  // argument is a 0-3 integer. Indexing this map with the integer yields
  // nothing, so the mapping is asserted by its documented names.
  it("maps each renderer severity to its intended electron-log level", () => {
    expect(rendererLogMethod("debug")).toBe("debug");
    expect(rendererLogMethod("info")).toBe("info");
    expect(rendererLogMethod("warning")).toBe("warn");
    expect(rendererLogMethod("error")).toBe("error");
  });

  it("keeps 'warning' distinct from 'error' so a warn is not read as a failure", () => {
    expect(rendererLogMethod("warning")).not.toBe(rendererLogMethod("error"));
  });

  it("falls back to info for a severity the map has not seen", () => {
    expect(rendererLogMethod("verbose" as never)).toBe("info");
  });

  // Renderer debug output routes to electron-log's `debug` method, which the
  // file transport's "info" threshold then drops. That is intended: this
  // asserts the level it is filed under, not that it reaches the file.
  it("files debug output under the level the file threshold drops", () => {
    expect(rendererLogMethod("debug")).toBe("debug");
    expect(["info", "warn", "error"]).not.toContain(rendererLogMethod("debug"));
  });
});

describe("rendererFrameLabel", () => {
  it("labels the top document", () => {
    expect(rendererFrameLabel(topFrame())).toBe("top");
  });

  it("distinguishes a subframe by its routing id", () => {
    const parent = topFrame();
    expect(rendererFrameLabel({ detached: false, parent, routingId: 7 })).toBe("subframe#7");
  });

  it("reports a detached frame without touching its other properties", () => {
    // Every other WebFrameMain property throws once the frame is detached, so
    // the detached check has to come first.
    const frame = {
      detached: true,
      get parent(): unknown {
        throw new Error("frame is detached");
      },
      get routingId(): number {
        throw new Error("frame is detached");
      },
    } as unknown as RendererFrame;
    expect(rendererFrameLabel(frame)).toBe("detached");
  });

  it("survives a frame that goes away mid-read", () => {
    const frame = {
      detached: false,
      get parent(): unknown {
        throw new Error("frame was destroyed");
      },
      routingId: 3,
    } as unknown as RendererFrame;
    expect(rendererFrameLabel(frame)).toBe("gone");
  });

  it("survives a missing frame", () => {
    expect(rendererFrameLabel(null)).toBe("?");
    expect(rendererFrameLabel(undefined)).toBe("?");
  });
});

describe("sanitizeRendererText", () => {
  it("escapes every newline form to a literal, losing no content", () => {
    expect(sanitizeRendererText("a\nb\r\nc\rd")).toBe("a\\nb\\nc\\nd");
  });

  it("replaces other control characters rather than emitting them", () => {
    expect(sanitizeRendererText("a\u0000b\u001bc\u007f")).toBe("a?b?c?");
  });

  it("leaves ordinary text untouched", () => {
    expect(sanitizeRendererText("Error: boom at thing")).toBe("Error: boom at thing");
  });

  it("reports the original length when it truncates", () => {
    const out = sanitizeRendererText("y".repeat(MAX_RENDERER_MESSAGE_CHARS + 5));
    expect(out).toContain(`(${MAX_RENDERER_MESSAGE_CHARS + 5} chars)`);
  });

  it("leaves text exactly at the cap alone", () => {
    const exact = "y".repeat(MAX_RENDERER_MESSAGE_CHARS);
    expect(sanitizeRendererText(exact)).toBe(exact);
  });
});

describe("formatRendererConsoleLine", () => {
  it("records the originating frame alongside the message", () => {
    expect(formatRendererConsoleLine(details())).toBe(
      "[renderer:top] something happened (app://index.js:42)",
    );
  });

  it("attributes a subframe line to that frame rather than the app", () => {
    const line = formatRendererConsoleLine(
      details({ frame: { detached: false, parent: topFrame(), routingId: 9 } }),
    );
    expect(line).toContain("[renderer:subframe#9]");
    expect(line).not.toContain("[renderer:top]");
  });

  it("omits the source location when the event carries none", () => {
    expect(formatRendererConsoleLine(details({ sourceId: "", lineNumber: 0 }))).toBe(
      "[renderer:top] something happened",
    );
  });

  it("keeps the message's content while collapsing it onto one line", () => {
    // A stack trace stays fully readable, but its newlines are escaped rather
    // than emitted -- one console message must be exactly one log line.
    const line = formatRendererConsoleLine(
      details({ message: "Error: boom\n  at thing (app://x.js:1:1)" }),
    );
    expect(line.split("\n")).toHaveLength(1);
    expect(line).toContain("Error: boom");
    expect(line).toContain("at thing (app://x.js:1:1)");
  });

  // `console-message` fires for every frame, and one of them renders arbitrary
  // project HTML with scripts enabled. Without escaping, that page could end
  // the log line and write its own.
  it("stops a frame from forging a log line with an embedded newline", () => {
    const line = formatRendererConsoleLine(
      details({
        frame: { detached: false, parent: topFrame(), routingId: 4 },
        message: 'x\n[2026-09-08 12:00:00.000] [info]  [mc-event] {"event":"app.quit"}',
      }),
    );
    expect(line.split("\n")).toHaveLength(1);
    expect(line).toMatch(/^\[renderer:subframe#4]/);
  });

  it("stops a frame from forging the structured-event marker on its own line", () => {
    // The README tells operators to grep for this marker, so a forged one is
    // worse than noise.
    const line = formatRendererConsoleLine(
      details({ message: '\r\n[mc-event] {"event":"session.deleted"}' }),
    );
    expect(line.split(/\r|\n/)).toHaveLength(1);
  });

  it("sanitizes the source URL too, since the frame controls it", () => {
    const line = formatRendererConsoleLine(
      details({ sourceId: "app://x.js\n[mc-event] {}", lineNumber: 1 }),
    );
    expect(line.split("\n")).toHaveLength(1);
  });

  it("caps an oversized message so one line cannot flood the transport", () => {
    const line = formatRendererConsoleLine(details({ message: "z".repeat(50_000) }));
    expect(line.length).toBeLessThan(MAX_RENDERER_MESSAGE_CHARS + 200);
    expect(line).toContain("(50000 chars)");
  });
});
