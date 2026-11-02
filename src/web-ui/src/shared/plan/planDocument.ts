import yaml from 'yaml';

export interface PlanTodo {
  id: string;
  content: string;
  status?: string;
}

export interface PlanDocument {
  name: string;
  overview: string;
  todos: PlanTodo[];
  planContent: string;
  frontmatter: Record<string, unknown>;
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Plan frontmatter field '${field}' must be a non-empty string`);
  }
  return value;
}

function parseTodos(value: unknown): PlanTodo[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new Error("Plan frontmatter field 'todos' must be an array");
  }

  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`Plan todo at index ${index} must be an object`);
    }

    const todo = item as Record<string, unknown>;
    if (todo.status != null && typeof todo.status !== 'string') {
      throw new Error(`Plan todo '${String(todo.id ?? index)}' has an invalid status`);
    }

    return {
      id: requireNonEmptyString(todo.id, `todos[${index}].id`),
      content: requireNonEmptyString(todo.content, `todos[${index}].content`),
      status: todo.status as string | undefined,
    };
  });
}

export function parsePlanMarkdown(content: string): PlanDocument {
  const match = content.match(FRONTMATTER_PATTERN);
  if (!match) {
    throw new Error('Plan file must start with YAML frontmatter');
  }

  const parsed = yaml.parse(match[1]);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Plan frontmatter must be a YAML object');
  }

  const frontmatter = parsed as Record<string, unknown>;
  const planContent = content.slice(match[0].length).trim();
  if (!planContent) {
    throw new Error('Plan markdown body must not be empty');
  }

  return {
    name: requireNonEmptyString(frontmatter.name, 'name'),
    overview: requireNonEmptyString(frontmatter.overview, 'overview'),
    todos: parseTodos(frontmatter.todos),
    planContent,
    frontmatter,
  };
}

export function serializePlanMarkdown(
  document: PlanDocument,
  overrides: Partial<Pick<PlanDocument, 'name' | 'overview' | 'todos' | 'planContent'>> = {},
): string {
  const name = overrides.name ?? document.name;
  const overview = overrides.overview ?? document.overview;
  const todos = overrides.todos ?? document.todos;
  const planContent = overrides.planContent ?? document.planContent;
  const frontmatter = yaml.stringify({
    ...document.frontmatter,
    name,
    overview,
    ...(overrides.todos !== undefined || 'todos' in document.frontmatter ? { todos } : {}),
  });

  return `---\n${frontmatter}---\n\n${planContent}`;
}
