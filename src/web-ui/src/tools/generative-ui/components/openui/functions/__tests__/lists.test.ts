import { afterEach, describe, expect, it, vi } from "vitest";
import { run, value } from "./run";

afterEach(() => vi.restoreAllMocks());

const cases: Record<string, [string, unknown][]> = {
  Append: [
    ["@Append([1, 2], 3)", [1, 2, 3]],
    ['@Append([], "a")', ["a"]],
    ["@Append([1], [2])", [1, [2]]],
    ["@Append(null, 1)", null],
    ['@Append("x", 1)', null],
  ],
  Prepend: [
    ["@Prepend([2, 3], 1)", [1, 2, 3]],
    ['@Prepend([], "a")', ["a"]],
    ["@Prepend(5, 1)", null],
  ],
  Concat: [
    ["@Concat([1], [2, 3])", [1, 2, 3]],
    ["@Concat([], [])", []],
    ["@Concat([1], 2)", null],
  ],
  Remove: [
    ['@Remove(["a", "b", "a"], "", "a")', ["b"]],
    ["@Remove([{id: 1}, {id: 2}], \"id\", 2)", [{ id: 1 }]],
    ['@Remove([{id: 1}], "id", "1")', []],
    ['@Remove([{p: {id: 1}}, {p: {id: 2}}], "p.id", 1)', [{ p: { id: 2 } }]],
    ['@Remove([], "id", 1)', []],
    ['@Remove(["a"], "", "z")', ["a"]],
    ["@Remove([1], 5, 1)", null],
  ],
  RemoveAt: [
    ['@RemoveAt(["a", "b", "c"], 1)', ["a", "c"]],
    ['@RemoveAt(["a", "b", "c"], -1)', ["a", "b"]],
    ['@RemoveAt(["a", "b", "c"], 9)', ["a", "b", "c"]],
    ["@RemoveAt([], 0)", []],
    ['@RemoveAt(["a"], "0")', null],
  ],
  Update: [
    [
      '@Update([{id: 1, done: false}, {id: 2, done: false}], "id", 2, "done", true)',
      [{ id: 1, done: false }, { id: 2, done: true }],
    ],
    ['@Update([1, {id: 1}], "id", 1, "x", 5)', [1, { id: 1, x: 5 }]],
    ['@Update([{id: 1}], "id", 3, "x", 5)', [{ id: 1 }]],
    ['@Update([], "id", 1, "x", 5)', []],
    ['@Update([{id: 1}], "id", 1, null, 5)', null],
  ],
  Toggle: [
    ['@Toggle(["a"], "b")', ["a", "b"]],
    ['@Toggle(["a", "b"], "a")', ["b"]],
    ["@Toggle([], 1)", [1]],
    ['@Toggle([1, 2], "2")', [1]],
  ],
  Includes: [
    ["@Includes([1, 2], 2)", true],
    ["@Includes([1, 2], 3)", false],
    ['@Includes("Hello world", "world")', true],
    ['@Includes("Hello", "z")', false],
    ['@Includes([], "a")', false],
    ["@Includes(5, 5)", null],
  ],
  Find: [
    ['@Find([{n: "a", v: 1}, {n: "b", v: 2}], "n", "b")', { n: "b", v: 2 }],
    ['@Find([{n: "a"}], "n", "z")', null],
    ['@Find([], "n", "z")', null],
  ],
  IndexOf: [
    ['@IndexOf(["a", "b"], "b")', 1],
    ['@IndexOf(["a", "b"], "z")', -1],
    ["@IndexOf([], 1)", -1],
    ['@IndexOf([{a: 1, b: [2]}, {a: 2}], {b: [2], a: 1})', 0],
  ],
  Take: [
    ["@Take([1, 2, 3], 2)", [1, 2]],
    ["@Take([1, 2, 3], -1)", [3]],
    ["@Take([1, 2, 3], 0)", []],
    ["@Take([], 5)", []],
  ],
  Slice: [
    ["@Slice([1, 2, 3, 4], 1, 3)", [2, 3]],
    ["@Slice([1, 2, 3], -2)", [2, 3]],
    ["@Slice([], 0, 2)", []],
    ['@Slice("Saturday", 0, 3)', "Sat"],
    ['@Slice("report.pdf", -3)', "pdf"],
    ['@Slice([1, 2], "a")', null],
  ],
  Unique: [
    ['@Unique([1, 1, 2, "a", "a"])', [1, 2, "a"]],
    ["@Unique([{a: 1}, {a: 1}, {a: 2}])", [{ a: 1 }, { a: 2 }]],
    ["@Unique([])", []],
  ],
  Reverse: [
    ["@Reverse([1, 2, 3])", [3, 2, 1]],
    ["@Reverse([])", []],
  ],
  Flatten: [
    ["@Flatten([[1, 2], [3], 4])", [1, 2, 3, 4]],
    ["@Flatten([])", []],
  ],
  Chunk: [
    ["@Chunk([1, 2, 3, 4, 5], 2)", [[1, 2], [3, 4], [5]]],
    ["@Chunk([1], 0)", null],
  ],
  Range: [
    ["@Range(0, 3)", [0, 1, 2]],
    ["@Range(1, 10, 3)", [1, 4, 7]],
    ["@Range(3, 0, -1)", [3, 2, 1]],
    ["@Range(0, 0.3, 0.1)", [0, 0.1, 0.2]],
    ["@Range(5, 0)", []],
    ["@Range(0, 5, 0)", null],
    ["@Range(0, 100000)", null],
    ["@Range(0)", null],
  ],
};

describe.each(Object.entries(cases))("@%s", (_name, rows) => {
  it.each(rows)("%s", (expr, expected) => expect(value(expr)).toEqual(expected));
});

describe("random list functions", () => {
  it("@Pick returns a random item, or null for an empty list", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect(value('@Pick(["a", "b", "c"])')).toBe("b");
    expect(value("@Pick([])")).toBeNull();
    expect(value('@Pick("abc")')).toBeNull();
  });

  it("@Shuffle returns a permutation and leaves the input alone", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const result = run("@Shuffle($xs)", "$xs = [1, 2, 3, 4]");
    expect(result.value).toEqual([2, 3, 4, 1]);
    vi.restoreAllMocks();
    const shuffled = value("@Shuffle([1, 2, 3, 4, 5])") as number[];
    expect([...shuffled].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(value("@Shuffle([])")).toEqual([]);
  });
});

describe("bad arguments", () => {
  it("report a parse error for a wrong literal and evaluate to null", () => {
    const result = run('@Take("abc", 1)');
    expect(result.value).toBeNull();
    expect(result.parseErrors.join()).toMatch(/expects array/);
  });

  it("evaluate to null when a $variable holds the wrong type", () => {
    const result = run("@Append($xs, 1)", "$xs = []", { $xs: "not a list" });
    expect(result.value).toBeNull();
    expect(result.runtimeErrors.join()).toMatch(/expects array/);
  });
});
