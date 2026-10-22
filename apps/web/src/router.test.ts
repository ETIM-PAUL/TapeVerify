import { describe, expect, it } from "vitest";
import { internalPath } from "./router.js";

const O = "https://app.example";
describe("which links stay inside the app", () => {
  it("keeps in-app links, with their query and hash", () => {
    expect(internalPath("/feed", O)).toBe("/feed");
    expect(internalPath("/verify?q=abc#top", O)).toBe("/verify?q=abc#top");
    expect(internalPath(`${O}/t/alice`, O)).toBe("/t/alice");
    expect(internalPath("call/xyz", O)).toBe("/call/xyz");
  });
  it("leaves other sites and server-handled paths to the browser", () => {
    expect(internalPath("https://x.com/intent/post?text=a", O)).toBeNull();
    expect(internalPath("https://t.me/share/url?url=a", O)).toBeNull();
    expect(internalPath("/c/abc12345", O)).toBeNull(); // share link: the server renders it
    expect(internalPath("/og/abc12345.png", O)).toBeNull();
    expect(internalPath("/v1/records/1", O)).toBeNull();
    expect(internalPath("mailto:a@b.c", O)).toBeNull();
    expect(internalPath("http://[bad", O)).toBeNull();
  });
  it("doesn't mistake an app path that merely starts with the same letter", () => {
    expect(internalPath("/call/abc", O)).toBe("/call/abc"); // /call, not /c/
    expect(internalPath("/connections", O)).toBe("/connections");
  });
});
