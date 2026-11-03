import { afterEach, describe, expect, it, vi } from "vitest";
import { run, value } from "./run";

afterEach(() => vi.useRealTimers());

const rows = `[{region: "West", product: "A", amount: 10, date: "2026-10-01"}, {region: "East", product: "B", amount: 5, date: "2026-10-02"}, {region: "West", product: "B", amount: 7, date: "2026-10-09"}]`;
const R = (expr: string) => value(expr.replaceAll("ROWS", rows));

const cases: Record<string, [string, unknown][]> = {
  FormatDate: [
    ['@FormatDate("2026-10-09")', "Oct 9, 2026"],
    ['@FormatDate("2026-10-09", "short")', "Oct 9"],
    ['@FormatDate("2026-10-09", "long")', "Friday, October 9, 2026"],
    ['@FormatDate("2026-10-09", "weekday")', "Fri"],
    ['@FormatDate("2026-10-09", "month")', "Oct 2026"],
    ['@FormatDate("2026-10-09", "iso")', "2026-10-09"],
    ['@FormatDate("2026-10-09T21:30:00Z", "time")', "9:30 PM"],
    ['@FormatDate("2026-10-09T21:30:00Z", "datetime")', "Oct 9, 9:30 PM"],
    ['@FormatDate(0, "iso")', "1970-01-01"],
    ['@FormatDate("2026-02-30")', null],
    ['@FormatDate("soon")', null],
  ],
  AddDays: [
    ['@AddDays("2026-10-09", 3)', "2026-10-12"],
    ['@AddDays("2026-12-30", 5)', "2027-01-04"],
    ['@AddDays("2026-03-01", -1)', "2026-02-28"],
    ['@AddDays("2026-10-09T23:00:00Z", 1)', "2026-10-10"],
    ['@AddDays("bad", 1)', null],
  ],
  DaysBetween: [
    ['@DaysBetween("2026-10-09", "2026-12-25")', 77],
    ['@DaysBetween("2026-12-25", "2026-10-09")', -77],
    ['@DaysBetween("2026-10-09", "2026-10-09")', 0],
    ['@DaysBetween("2026-10-09", null)', null],
  ],
  AddMonths: [
    ['@AddMonths("2026-01-31", 1)', "2026-02-28"],
    ['@AddMonths("2026-10-09", -12)', "2025-10-09"],
    ['@AddMonths("2026-11-15", 3)', "2027-02-15"],
  ],
  MonthsBetween: [
    ['@MonthsBetween("1990-05-20", "2026-05-19")', 431],
    ['@MonthsBetween("1990-05-20", "2026-05-20")', 432],
    ['@MonthsBetween("2026-03-15", "2026-01-20")', -1],
  ],
  StartOf: [
    ['@StartOf("2026-10-09", "week")', "2026-10-05"],
    ['@StartOf("2026-10-05", "week")', "2026-10-05"],
    ['@StartOf("2026-10-11", "week")', "2026-10-05"],
    ['@StartOf("2026-10-09", "month")', "2026-10-01"],
    ['@StartOf("2026-10-09", "year")', "2026-01-01"],
  ],
  GroupBy: [
    ['@GroupBy(ROWS, "region", "amount")', [{ key: "West", value: 17 }, { key: "East", value: 5 }]],
    ['@GroupBy(ROWS, "region")', [{ key: "West", value: 2 }, { key: "East", value: 1 }]],
    ['@GroupBy(ROWS, "region", "amount", "avg")', [{ key: "West", value: 8.5 }, { key: "East", value: 5 }]],
    ['@GroupBy(ROWS, "region", "amount", "max")', [{ key: "West", value: 10 }, { key: "East", value: 5 }]],
    ['@GroupBy([{a: 1}, {b: 2}], "a")', [{ key: 1, value: 1 }, { key: "Unknown", value: 1 }]],
    ['@GroupBy([], "region")', []],
  ],
  Pivot: [
    [
      '@Pivot(ROWS, "region", "product", "amount")',
      [{ key: "West", A: 10, B: 7 }, { key: "East", A: 0, B: 5 }],
    ],
    ['@Pivot(ROWS, "product", "region")', [{ key: "A", West: 1, East: 0 }, { key: "B", West: 1, East: 1 }]],
    ['@Pivot([], "a", "b")', []],
  ],
  Top: [
    ['@Top(ROWS, "amount", 2).amount', [10, 7]],
    ['@Top(ROWS, "amount", 1, "asc").amount', [5]],
    ['@Top([{v: "x"}, {v: 2}, {v: 9}], "v", 3).v', [9, 2, "x"]],
    ['@Top(ROWS, "amount", 0)', []],
    ['@Top([], "amount", 3)', []],
  ],
  Between: [
    ['@Between(ROWS, "date", "2026-10-02", "2026-10-09").amount', [5, 7]],
    ['@Between(ROWS, "date", "2026-10-02").amount', [5, 7]],
    ['@Between(ROWS, "date", null, "2026-10-01").amount', [10]],
    ['@Between(ROWS, "amount", 6, 10).amount', [10, 7]],
    ['@Between([{v: 9}, {v: 10}, {w: 1}], "v", 9, 9.5)', [{ v: 9 }]],
    ['@Between([], "date", "2026-01-01")', []],
    ['@Between(ROWS, 3, 1)', null],
  ],
  Bucket: [
    [
      '@Bucket(ROWS, "date", "week", "amount")',
      [{ key: "2026-09-28", value: 15 }, { key: "2026-10-05", value: 7 }],
    ],
    ['@Bucket(ROWS, "date", "month", "amount")', [{ key: "2026-10", value: 22 }]],
    ['@Bucket(ROWS, "date", "day").value', [1, 1, 0, 0, 0, 0, 0, 0, 1]],
    ['@Bucket(ROWS, "date", "day", "amount", "avg").key', ["2026-10-01", "2026-10-02", "2026-10-09"]],
    ['@Bucket([{d: "nope"}, {d: "2026-01-31"}, {d: "2026-03-02"}], "d", "month").key', ["2026-01", "2026-02", "2026-03"]],
    ['@Bucket([], "date", "day")', []],
    ['@Bucket(ROWS, "date", "year")', null],
  ],
  Cumulative: [
    ['@Cumulative([1, 2, 3], "")', [1, 3, 6]],
    ['@Cumulative([{d: 1, v: 2}, {d: 2, v: 3}], "v")', [{ d: 1, v: 2 }, { d: 2, v: 5 }]],
    ['@Cumulative([{v: "x"}, {v: 4}], "v").v', [0, 4]],
    ['@Cumulative([], "v")', []],
  ],
  MovingAvg: [
    ['@MovingAvg([2, 4, 6, 8], "", 2)', [2, 3, 5, 7]],
    ['@MovingAvg([{v: 3}, {v: 6}, {v: 9}], "v", 3).v', [3, 4.5, 6]],
    ['@MovingAvg([1, 2], "", 0)', null],
    ['@MovingAvg([], "", 7)', []],
  ],
  Change: [
    ["@Change(120, 100)", 20],
    ["@Change(80, 100)", -20],
    ["@Change(-50, -100)", 50],
    ["@Change(5, 0)", null],
  ],
  Histogram: [
    [
      "@Histogram([0.1, 0.2, 0.3, 0.9], 2, 0, 1)",
      [{ key: "0", value: 3, start: 0, end: 0.5 }, { key: "0.5", value: 1, start: 0.5, end: 1 }],
    ],
    ["@Histogram([0, 1, 2], 2, 0, 1).value", [1, 1]],
    ["@Histogram([0.1, 0.6], 4, 0, 1).key", ["0", "0.25", "0.5", "0.75"]],
    ["@Histogram([1200, 1350, 1990], 2).key", ["1200", "1595"]],
    ["@Histogram([], 3).value", [0, 0, 0]],
    ["@Histogram([5, 5], 1).value", [2]],
    ["@Histogram([1, 2], 0)", null],
    ["@Histogram([{v: 0.2}, {w: 1}].v, 2, 0, 1).value", [1, 0]],
  ],
  Stats: [
    ["@Stats([2, 4, 4, 4, 5, 5, 7, 9])", { count: 8, min: 2, max: 9, mean: 5, median: 4.5, stdev: 2 }],
    ["@Stats([3, 1, 2]).median", 2],
    ["@Stats([])", { count: 0, min: 0, max: 0, mean: 0, median: 0, stdev: 0 }],
    ['@Stats("1, 2")', null],
    ["@Stats([{v: 1}, {w: 2}, {v: 3}].v).mean", 2],
  ],
};

describe.each(Object.entries(cases))("@%s", (_name, list) => {
  it.each(list)("%s", (expr, expected) => expect(R(expr)).toEqual(expected));
});

describe("@Now", () => {
  it("returns the current instant as ISO", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
    expect(value("@Now()")).toBe("2026-10-09T12:00:00.000Z");
    expect(value('@FormatDate(@AddDays(@Now(), 1), "short")')).toBe("Oct 10");
  });
});

describe("@Today", () => {
  it("returns the viewer's calendar day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 9, 23, 30));
    expect(value("@Today()")).toBe("2026-10-09");
  });
});

describe("an invalid optional argument", () => {
  it("is dropped with an error, so its default applies", () => {
    const style = run('@FormatDate("2026-10-09", "fancy")');
    expect(style.value).toBe("Oct 9, 2026");
    expect(style.parseErrors.join()).toMatch(/one of/);
    const how = run(`@GroupBy(${rows}, "region", "amount", "median")`);
    expect(how.value).toEqual([{ key: "West", value: 17 }, { key: "East", value: 5 }]);
    expect(how.parseErrors).toHaveLength(1);
  });
});

describe("@Stats with a bad item", () => {
  it("drops the item, reports it and summarizes the rest", () => {
    const result = run("@Stats([1, $x, 3])", "$x = 2", { $x: "two" });
    expect(result.value).toEqual({ count: 2, min: 1, max: 3, mean: 2, median: 2, stdev: 1 });
    expect(result.runtimeErrors.join()).toMatch(/expects number/);
  });
});
