import type { ActionPlan } from "@openuidev/lang-core";
import { describe, expect, it, vi } from "vitest";
import { run } from "./run";

// The patterns the working-tool prompt teaches, run by the 1.0 evaluator.
describe("working-tool patterns", () => {
  it("@Each maps a @Range into rows that follow $state", () => {
    const src = `rows = @Each(@Range(0, $years + 1), "y", {year: y, balance: @Round($p * @Pow(1 + $r / 100, y), 2)})\n$years = 2\n$p = 1000\n$r = 5`;
    expect(run("rows", src).value).toEqual([
      { year: 0, balance: 1000 },
      { year: 1, balance: 1050 },
      { year: 2, balance: 1102.5 },
    ]);
    expect((run("rows", src, { $years: 4 }).value as unknown[]).length).toBe(5);
  });

  it("@Set evaluates functions at click time, in step order", () => {
    const r = run(
      '$people, Action([@Set($people, @Append($people, $name)), @Set($name, "")])',
      '$people = ["You"]\n$name = "Alex"',
    );
    expect(r.click()).toMatchObject({ $people: ["You", "Alex"], $name: "" });
  });

  it("a nested @Each toggles one person on one item with @Update and @Toggle", () => {
    const r = run(
      '$items, @Each($items, "it", @Each(["A", "B"], "p", @Set($items, @Update($items, "name", it.name, "people", @Toggle(it.people, p)))))',
      '$items = [{name: "Mains", people: ["A", "B"]}, {name: "Wine", people: ["A"]}]',
    );
    const buttons = r.action as unknown as ActionPlan[][];
    // The (Wine, B) button adds B to the wine; then (Mains, A) takes A off the mains
    r.click(buttons[1]![1]);
    expect(r.click(buttons[0]![0]).$items).toEqual([
      { name: "Mains", people: ["B"] },
      { name: "Wine", people: ["A", "B"] },
    ]);
  });

  it("per-person shares from a nested @Each and @Includes", () => {
    const src = `shares = @Each($people, "p", {name: p, amount: @Sum(@Each($items, "it", @Includes(it.people, p) ? it.amount / @Count(it.people) : 0))})
$people = ["A", "B"]
$items = [{amount: 30, people: ["A", "B"]}, {amount: 10, people: ["A"]}]`;
    expect(run("shares", src).value).toEqual([
      { name: "A", amount: 25 },
      { name: "B", amount: 15 },
    ]);
  });

  it("@CopyToClipboard becomes a custom step with the joined text", () => {
    const r = run('"x", @CopyToClipboard(@Join(["a", "b"], "\\n"))');
    expect(r.action?.steps).toEqual([{ type: "custom_action", name: "CopyToClipboard", params: { text: "a\nb" } }]);
  });

  it("@Random inside @Set draws once per click", () => {
    const spy = vi.spyOn(Math, "random").mockReturnValue(0.4);
    const r = run("$door, @Set($door, @Random(0, 2, true))", "$door = -1");
    expect(r.click().$door).toBe(1);
    spy.mockRestore();
  });
});
