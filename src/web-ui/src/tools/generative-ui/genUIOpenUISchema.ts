import { z } from 'zod/v4';

export function zodForSchema(schema: Record<string, unknown> | undefined): z.ZodTypeAny {
  if (!schema) return z.any();
  if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every(value => typeof value === 'string')) {
    return z.enum(schema.enum as [string, ...string[]]);
  }
  const union = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
  if (union) {
    const branches = union.map(branch => zodForSchema(branch as Record<string, unknown>));
    return branches.length > 1 ? z.union(branches as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]) : branches[0] ?? z.any();
  }
  switch (schema.type) {
    case 'string': return z.string();
    case 'number': return z.number();
    case 'integer': return z.number().int();
    // Models commonly serialize boolean component flags as 0/1. Accept those
    // exact JSON equivalents at the library boundary so one malformed flag
    // does not leave a visible render error above an otherwise valid page.
    case 'boolean': return z.union([
      z.boolean(),
      z.literal(0),
      z.literal(1),
    ]);
    case 'array': return z.array(zodForSchema(schema.items as Record<string, unknown> | undefined));
    case 'object': {
      const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      const required = new Set(Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === 'string') : []);
      const shape = Object.fromEntries(Object.entries(properties).map(([key, value]) => {
        const field = zodForSchema(value);
        return [key, required.has(key) ? field : field.optional()];
      }));
      const object = z.object(shape);
      return schema.additionalProperties === false ? object.strict() : object.catchall(z.any());
    }
    case 'null': return z.null();
    default: return z.any();
  }
}
