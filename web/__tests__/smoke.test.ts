import { describe, it, expect } from "vitest";
describe("runner", () => {
  it("has localStorage (jsdom)", () => {
    localStorage.setItem("x", "1");
    expect(localStorage.getItem("x")).toBe("1");
    localStorage.clear();
  });
});
