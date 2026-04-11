/**
 * Tests for deepEqual utility
 */

import { describe, it, expect } from "vitest";
import { deepEqual } from "../deep-equal";

describe("deepEqual", () => {
  describe("primitives", () => {
    it("should return true for identical strings", () => {
      expect(deepEqual("hello", "hello")).toBe(true);
    });

    it("should return true for identical numbers", () => {
      expect(deepEqual(42, 42)).toBe(true);
    });

    it("should return true for identical booleans", () => {
      expect(deepEqual(true, true)).toBe(true);
      expect(deepEqual(false, false)).toBe(true);
    });

    it("should return true for undefined", () => {
      expect(deepEqual(undefined, undefined)).toBe(true);
    });

    it("should return true for null", () => {
      expect(deepEqual(null, null)).toBe(true);
    });

    it("should return false for different strings", () => {
      expect(deepEqual("hello", "world")).toBe(false);
    });

    it("should return false for different numbers", () => {
      expect(deepEqual(42, 43)).toBe(false);
    });

    it("should return false for different types", () => {
      expect(deepEqual(42, "42")).toBe(false);
      expect(deepEqual(null, undefined)).toBe(false);
    });
  });

  describe("null/undefined handling", () => {
    it("should return false when comparing null with object", () => {
      expect(deepEqual(null, {})).toBe(false);
    });

    it("should return false when comparing undefined with null", () => {
      expect(deepEqual(undefined, null)).toBe(false);
    });

    it("should return false when comparing object with null", () => {
      expect(deepEqual({}, null)).toBe(false);
    });
  });

  describe("arrays", () => {
    it("should return true for identical arrays", () => {
      expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    });

    it("should return false for different length arrays", () => {
      expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    });

    it("should return false for arrays with different values", () => {
      expect(deepEqual([1, 2, 3], [1, 2, 4])).toBe(false);
    });

    it("should handle nested arrays", () => {
      expect(
        deepEqual(
          [
            [1, 2],
            [3, 4],
          ],
          [
            [1, 2],
            [3, 4],
          ],
        ),
      ).toBe(true);
      expect(
        deepEqual(
          [
            [1, 2],
            [3, 4],
          ],
          [
            [1, 2],
            [3, 5],
          ],
        ),
      ).toBe(false);
    });

    it("should handle empty arrays", () => {
      expect(deepEqual([], [])).toBe(true);
    });

    it("should handle arrays with mixed types", () => {
      expect(deepEqual([1, "two", true], [1, "two", true])).toBe(true);
    });
  });

  describe("objects", () => {
    it("should return true for identical plain objects", () => {
      expect(deepEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
    });

    it("should return false for objects with different values", () => {
      expect(deepEqual({ a: 1, b: 2 }, { a: 1, b: 3 })).toBe(false);
    });

    it("should return false for objects with different keys", () => {
      expect(deepEqual({ a: 1, b: 2 }, { a: 1, c: 2 })).toBe(false);
    });

    it("should return false for objects with different key counts", () => {
      expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    });

    it("should handle nested objects", () => {
      const obj1 = { a: { b: { c: 1 } }, d: 2 };
      const obj2 = { a: { b: { c: 1 } }, d: 2 };
      expect(deepEqual(obj1, obj2)).toBe(true);
    });

    it("should handle nested objects with differences", () => {
      const obj1 = { a: { b: { c: 1 } }, d: 2 };
      const obj2 = { a: { b: { c: 2 } }, d: 2 };
      expect(deepEqual(obj1, obj2)).toBe(false);
    });

    it("should handle empty objects", () => {
      expect(deepEqual({}, {})).toBe(true);
    });

    it("should handle objects with array values", () => {
      expect(deepEqual({ arr: [1, 2] }, { arr: [1, 2] })).toBe(true);
      expect(deepEqual({ arr: [1, 2] }, { arr: [1, 3] })).toBe(false);
    });
  });

  describe("Date objects", () => {
    it("should return true for identical dates", () => {
      const d1 = new Date("2024-01-01");
      const d2 = new Date("2024-01-01");
      expect(deepEqual(d1, d2)).toBe(true);
    });

    it("should return false for different dates", () => {
      const d1 = new Date("2024-01-01");
      const d2 = new Date("2024-01-02");
      expect(deepEqual(d1, d2)).toBe(false);
    });

    it("should handle dates in objects", () => {
      const obj1 = { date: new Date("2024-01-01") };
      const obj2 = { date: new Date("2024-01-01") };
      expect(deepEqual(obj1, obj2)).toBe(true);
    });
  });

  describe("RegExp objects", () => {
    it("should return true for identical regexes", () => {
      expect(deepEqual(/test/gi, /test/gi)).toBe(true);
    });

    it("should return false for different regex patterns", () => {
      expect(deepEqual(/test/gi, /other/gi)).toBe(false);
    });

    it("should return false for different regex flags", () => {
      expect(deepEqual(/test/g, /test/gi)).toBe(false);
    });
  });

  describe("complex structures", () => {
    it("should handle complex nested structures", () => {
      const obj1 = {
        users: [
          { name: "Alice", roles: ["admin", "user"], active: true },
          { name: "Bob", roles: ["user"], active: false },
        ],
        meta: {
          total: 2,
          updatedAt: new Date("2024-01-01"),
          pattern: /^test/gi,
        },
      };

      const obj2 = {
        users: [
          { name: "Alice", roles: ["admin", "user"], active: true },
          { name: "Bob", roles: ["user"], active: false },
        ],
        meta: {
          total: 2,
          updatedAt: new Date("2024-01-01"),
          pattern: /^test/gi,
        },
      };

      expect(deepEqual(obj1, obj2)).toBe(true);
    });

    it("should detect deep differences in complex structures", () => {
      const obj1 = {
        users: [{ name: "Alice", roles: ["admin"] }],
        meta: { total: 1 },
      };

      const obj2 = {
        users: [{ name: "Alice", roles: ["user"] }],
        meta: { total: 1 },
      };

      expect(deepEqual(obj1, obj2)).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("should handle same reference", () => {
      const obj = { a: 1 };
      expect(deepEqual(obj, obj)).toBe(true);
    });

    it("should handle objects with undefined values", () => {
      expect(deepEqual({ a: undefined }, { a: undefined })).toBe(true);
    });

    it("should not confuse class instances with plain objects", () => {
      class Foo {
        constructor(public a: number) {}
      }
      const foo1 = new Foo(1);
      const foo2 = new Foo(1);
      // Class instances are not treated as plain objects
      expect(deepEqual(foo1, foo2)).toBe(false);
    });
  });
});
