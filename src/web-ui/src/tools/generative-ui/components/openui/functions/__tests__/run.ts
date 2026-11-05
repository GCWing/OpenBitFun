import {
  action,
  createLibrary,
  createParser,
  defineComponent,
  evaluate,
  evaluateElementProps,
  type ActionPlan,
  type OpenUIError,
} from "@openuidev/lang-core";
import { z } from "zod/v4";
import { actions } from "../../actions";
import { functions } from "..";

// A one-prop component, so any expression can be parsed and evaluated by the
// real 1.0 parser and evaluator with the library's functions and actions.
const Out = defineComponent({
  name: "Out",
  props: z.object({ value: z.any(), action: action().optional() }),
  description: "Test output",
  component: null,
});
const library = createLibrary({ root: "Out", components: [Out], functions, actions });
const schema = library.toJSONSchema();
const parser = createParser(schema, "Out");
const fns = Object.fromEntries(
  Object.entries(schema.functions ?? {}).map(([name, s]) => [name, { ...s, fn: library.functions[name]!.fn }]),
);

/** Evaluates `root = Out(expr)` plus extra statements, with $state overrides. */
export function run(expr: string, extra = "", state: Record<string, unknown> = {}) {
  const parsed = parser.parse(`root = Out(${expr})\n${extra}`);
  const store: Record<string, unknown> = { ...parsed.stateDeclarations, ...state };
  const errors: OpenUIError[] = [];
  const ctx = { getState: (n: string) => store[n], resolveRef: () => undefined, functions: fns, actions: schema.actions };
  const el = evaluateElementProps(parsed.root!, { ctx, library, store: null, errors });
  const props = el.props as { value: unknown; action?: ActionPlan };
  return {
    value: props.value,
    action: props.action,
    parseErrors: parsed.meta.errors.map((e) => e.message),
    runtimeErrors: errors.map((e) => e.message),
    /** Runs a plan's @Set steps in order against the store, as a click does. */
    click(plan: ActionPlan | undefined = props.action) {
      for (const step of plan?.steps ?? []) {
        if (step.type === "set") store[step.target] = evaluate(step.valueAST, ctx);
      }
      return store;
    },
  };
}

/** The value of `@Name(args)`. */
export const value = (expr: string) => run(expr).value;
