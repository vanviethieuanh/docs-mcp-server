import { describe, expect, it } from "vitest";
import { parseIntegerAtLeast } from "./number";

describe("parseIntegerAtLeast", () => {
  it("accepts zero when the lower bound is zero", () => {
    expect(parseIntegerAtLeast("0", 0)).toBe(0);
  });

  it("rejects values below the lower bound", () => {
    expect(parseIntegerAtLeast("0", 1)).toBeUndefined();
  });

  it("returns undefined for blank and non-numeric input", () => {
    expect(parseIntegerAtLeast("", 0)).toBeUndefined();
    expect(parseIntegerAtLeast("not a number", 0)).toBeUndefined();
  });
});
