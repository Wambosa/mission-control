import { describe, expect, it } from "vitest";
import {
  formatRendererConsoleLine,
  rendererFrameLabel,
  rendererLogMethod,
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

  it("keeps the message verbatim", () => {
    const message = "Error: boom\n  at thing (app://x.js:1:1)";
    expect(formatRendererConsoleLine(details({ message }))).toContain(message);
  });
});
