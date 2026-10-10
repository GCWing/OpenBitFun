import {
  RemoteCommandCatalog,
  RemoteSkillCatalogEntry,
  REMOTE_SKILL_SOURCE_BUILTIN,
  REMOTE_SKILL_SOURCE_PROJECT,
  REMOTE_SKILL_SOURCE_USER
} from '../model/RemoteModels';
import { CommandPalettePolicy } from './CommandPalettePolicy';

/**
 * Turns the host's skill catalog into the rows the picker sheet renders.
 *
 * Two shapes meet here. The host sends `get_mode_skill_configs` rows — each a
 * `SkillInfo` flattened beside its mode availability flags — and the palette
 * wants one entry per invocable skill, with the host's own group taxonomy kept
 * for ordering and its availability flags kept as filtering truth.
 *
 * Pure and host-tolerant: a row is dropped only when it has no id, and the two
 * sides of the sheet — the built-in catalog and the skills the user authored —
 * never merge, so a user skill that reuses a built-in name stays its own row in
 * the custom group instead of shadowing the built-in one.
 */

export const COMMAND_CATALOG_FILTER_ALL: string = 'all';
export const COMMAND_CATALOG_FILTER_BUILTIN: string = 'builtin';
export const COMMAND_CATALOG_FILTER_CUSTOM: string = 'custom';

/**
 * One raw host row.
 *
 * Everything but the id is optional so a partially instrumented or older host
 * still yields entries instead of failing the whole read. Absent flags read as
 * `false` — with `allow_user_invocation` the sole exception, whose contract
 * default is `true` — so a host that stops serializing the availability flags
 * hides nothing it meant to offer, and offers nothing it meant to hold back.
 */
export interface RemoteModeSkillRow {
  key?: string;
  name?: string;
  description?: string;
  groupKey?: string;
  group_key?: string;
  isBuiltin?: boolean;
  is_builtin?: boolean;
  level?: string;
  isShadowed?: boolean;
  is_shadowed?: boolean;
  allowUserInvocation?: boolean;
  allow_user_invocation?: boolean;
  selectedForRuntime?: boolean;
  selected_for_runtime?: boolean;
  effectiveEnabled?: boolean;
  effective_enabled?: boolean;
  globallyEnabled?: boolean;
  globally_enabled?: boolean;
}

export class SkillCatalogRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly group: string;
  readonly source: string;
  readonly isBuiltin: boolean;
  /**
   * The exact token the message will carry, e.g. `[$Plan]`.
   *
   * Built from the skill's name rather than its key, because that is the token
   * the desktop's own picker inserts; the key stays the row's identity, which is
   * what the picker keys on and what the composer compares against.
   */
  readonly insertHint: string;

  constructor(entry: RemoteSkillCatalogEntry, isBuiltin: boolean) {
    this.id = entry.id;
    this.name = entry.name;
    this.description = entry.description;
    this.group = entry.group;
    this.source = entry.source;
    this.isBuiltin = isBuiltin;
    this.insertHint = CommandPalettePolicy.skillTokenLabel(entry.name);
  }
}

export class SkillCatalogSection {
  readonly id: string;
  readonly titleKey: string;
  readonly count: number;
  readonly rows: SkillCatalogRow[];

  constructor(id: string, titleKey: string, rows: SkillCatalogRow[]) {
    this.id = id;
    this.titleKey = titleKey;
    this.count = rows.length;
    this.rows = rows;
  }
}

export class SkillCatalogFilter {
  readonly id: string;
  readonly labelKey: string;
  readonly count: number;

  constructor(id: string, labelKey: string, count: number) {
    this.id = id;
    this.labelKey = labelKey;
    this.count = count;
  }
}

export class SkillCatalogPresentation {
  readonly sections: SkillCatalogSection[];
  readonly filters: SkillCatalogFilter[];
  readonly totalCount: number;
  readonly builtinCount: number;
  readonly customCount: number;
  /** Nothing to show at all: the catalog is empty or the host never sent one. */
  readonly isEmpty: boolean;
  readonly hasNoMatches: boolean;

  constructor(
    sections: SkillCatalogSection[],
    filters: SkillCatalogFilter[],
    totalCount: number,
    builtinCount: number,
    customCount: number,
    isEmpty: boolean,
    hasNoMatches: boolean
  ) {
    this.sections = sections;
    this.filters = filters;
    this.totalCount = totalCount;
    this.builtinCount = builtinCount;
    this.customCount = customCount;
    this.isEmpty = isEmpty;
    this.hasNoMatches = hasNoMatches;
  }
}

export class CommandCatalogProjection {
  static readonly builtinSectionKey: string = 'commands.skills.sectionBuiltin';
  static readonly customSectionKey: string = 'commands.skills.sectionCustom';

  /**
   * The host's raw rows, as palette entries.
   *
   * This is the whole of the host-shape translation: the id is the skill key —
   * the same string the `[$key]` message token carries — and the availability
   * flags are copied through so nothing downstream re-reads the payload. Rows
   * without an id are dropped; rows repeating an id collapse onto one entry,
   * because a row's key is what the picker lists and keys on and two rows with
   * the same key would be the same choice offered twice.
   */
  static parseHostCatalog(value?: RemoteModeSkillRow[]): RemoteCommandCatalog {
    const parsed: RemoteSkillCatalogEntry[] = [];
    if (!value || value.length === 0) {
      return { skills: parsed };
    }
    for (const row of value) {
      const id = CommandCatalogProjection.trimmed(row.key);
      if (id.length === 0) {
        continue;
      }
      const builtin = CommandCatalogProjection.flag(row.isBuiltin, row.is_builtin);
      parsed.push({
        id,
        name: CommandCatalogProjection.rowName(row.name, id),
        description: CommandCatalogProjection.trimmed(row.description),
        // A user-authored skill has no host group of its own; the picker then
        // groups it by source, which is the only taxonomy it actually has.
        group: CommandCatalogProjection.trimmed(row.groupKey ?? row.group_key),
        source: CommandCatalogProjection.source(builtin, row.level),
        shadowed: CommandCatalogProjection.flag(row.isShadowed, row.is_shadowed),
        selectedForRuntime: CommandCatalogProjection.flag(row.selectedForRuntime, row.selected_for_runtime),
        effectiveEnabled: CommandCatalogProjection.flag(row.effectiveEnabled, row.effective_enabled),
        globallyEnabled: CommandCatalogProjection.flag(row.globallyEnabled, row.globally_enabled),
        allowUserInvocation: CommandCatalogProjection.defaultTrue(row.allowUserInvocation, row.allow_user_invocation)
      });
    }
    return { skills: CommandCatalogProjection.collapseById(parsed) };
  }

  /**
   * One entry per skill key, in the host's own order.
   *
   * Which duplicate wins is the part worth being careful about: the host lists
   * both the winner and the skill it shadows under the same key, so keeping the
   * first row could keep the shadowed one and hide the very skill the user can
   * actually invoke. A later row therefore replaces an earlier one when it is
   * the invocable of the two, and the position stays the first row's.
   */
  private static collapseById(entries: RemoteSkillCatalogEntry[]): RemoteSkillCatalogEntry[] {
    const order: string[] = [];
    const byId: Map<string, RemoteSkillCatalogEntry> = new Map<string, RemoteSkillCatalogEntry>();
    for (const entry of entries) {
      const kept = byId.get(entry.id);
      if (kept === undefined) {
        order.push(entry.id);
        byId.set(entry.id, entry);
        continue;
      }
      if (!CommandCatalogProjection.invocable(kept) && CommandCatalogProjection.invocable(entry)) {
        byId.set(entry.id, entry);
      }
    }
    const collapsed: RemoteSkillCatalogEntry[] = [];
    for (const id of order) {
      const entry = byId.get(id);
      if (entry !== undefined) {
        collapsed.push(entry);
      }
    }
    return collapsed;
  }

  /**
   * Whether the host offered this skill to the user in the active mode.
   *
   * Mirrors the desktop composer's own rule: the host's winner for the name,
   * enabled for this mode, enabled globally, and allowed to be invoked by hand.
   * A shadowed row is a duplicate of the winner and never a second choice.
   */
  static invocable(entry: RemoteSkillCatalogEntry): boolean {
    return !entry.shadowed && entry.selectedForRuntime && entry.effectiveEnabled &&
      entry.globallyEnabled && entry.allowUserInvocation;
  }

  /** The invocable catalog as rows, in the host's own order. */
  static rows(catalog?: RemoteCommandCatalog): SkillCatalogRow[] {
    const skills = catalog?.skills;
    if (!skills || skills.length === 0) {
      return [];
    }
    const rows: SkillCatalogRow[] = [];
    for (const skill of skills) {
      if (!CommandCatalogProjection.invocable(skill)) {
        continue;
      }
      rows.push(new SkillCatalogRow(skill, CommandCatalogProjection.isBuiltin(skill.source)));
    }
    return rows;
  }

  static builtinCount(rows: SkillCatalogRow[]): number {
    return rows.filter((row: SkillCatalogRow): boolean => row.isBuiltin).length;
  }

  static customCount(rows: SkillCatalogRow[]): number {
    return rows.filter((row: SkillCatalogRow): boolean => !row.isBuiltin).length;
  }

  static filters(rows: SkillCatalogRow[]): SkillCatalogFilter[] {
    return [
      new SkillCatalogFilter(COMMAND_CATALOG_FILTER_ALL, 'commands.skills.filterAll', rows.length),
      new SkillCatalogFilter(
        COMMAND_CATALOG_FILTER_BUILTIN, 'commands.skills.filterBuiltin',
        CommandCatalogProjection.builtinCount(rows)),
      new SkillCatalogFilter(
        COMMAND_CATALOG_FILTER_CUSTOM, 'commands.skills.filterCustom',
        CommandCatalogProjection.customCount(rows))
    ];
  }

  /**
   * The sheet's sections for one query and filter.
   *
   * Built-in skills are grouped and sorted by their group key, which is the
   * catalog's own taxonomy; the custom section always comes last so a user skill
   * can never be mistaken for a built-in one.
   */
  static present(catalog: RemoteCommandCatalog | undefined, query: string, filterId: string): SkillCatalogPresentation {
    const rows = CommandCatalogProjection.rows(catalog);
    const filters = CommandCatalogProjection.filters(rows);
    if (rows.length === 0) {
      return new SkillCatalogPresentation([], filters, 0, 0, 0, true, false);
    }
    const normalizedQuery = query.trim().toLowerCase();
    const matched = rows.filter((row: SkillCatalogRow): boolean =>
      CommandCatalogProjection.matches(row, normalizedQuery));
    const sections: SkillCatalogSection[] = [];
    if (filterId !== COMMAND_CATALOG_FILTER_CUSTOM) {
      const builtin = CommandCatalogProjection.sortBuiltin(
        matched.filter((row: SkillCatalogRow): boolean => row.isBuiltin));
      if (builtin.length > 0) {
        sections.push(new SkillCatalogSection(
          COMMAND_CATALOG_FILTER_BUILTIN,
          CommandCatalogProjection.builtinSectionKey,
          builtin));
      }
    }
    if (filterId !== COMMAND_CATALOG_FILTER_BUILTIN) {
      const custom = CommandCatalogProjection.sortCustom(
        matched.filter((row: SkillCatalogRow): boolean => !row.isBuiltin));
      if (custom.length > 0) {
        sections.push(new SkillCatalogSection(
          COMMAND_CATALOG_FILTER_CUSTOM,
          CommandCatalogProjection.customSectionKey,
          custom));
      }
    }
    return new SkillCatalogPresentation(
      sections,
      filters,
      rows.length,
      CommandCatalogProjection.builtinCount(rows),
      CommandCatalogProjection.customCount(rows),
      false,
      sections.length === 0);
  }

  static matches(row: SkillCatalogRow, normalizedQuery: string): boolean {
    if (normalizedQuery.length === 0) {
      return true;
    }
    return row.name.toLowerCase().indexOf(normalizedQuery) >= 0 ||
      row.id.toLowerCase().indexOf(normalizedQuery) >= 0 ||
      row.group.toLowerCase().indexOf(normalizedQuery) >= 0 ||
      row.description.toLowerCase().indexOf(normalizedQuery) >= 0;
  }

  static isBuiltin(source?: string): boolean {
    return CommandCatalogProjection.trimmed(source).toLowerCase() === REMOTE_SKILL_SOURCE_BUILTIN;
  }

  /**
   * Which side of the sheet a row belongs to.
   *
   * The host says whether the row is a built-in; anything else is user-authored,
   * and `level` only decides whether it was written for this project or for the
   * user's own directory.
   */
  private static source(builtin: boolean, level?: string): string {
    if (builtin) {
      return REMOTE_SKILL_SOURCE_BUILTIN;
    }
    return CommandCatalogProjection.trimmed(level).toLowerCase() === REMOTE_SKILL_SOURCE_PROJECT ?
      REMOTE_SKILL_SOURCE_PROJECT : REMOTE_SKILL_SOURCE_USER;
  }

  /** A flag an older host may omit; absent reads as `false`. */
  private static flag(camel?: boolean, snake?: boolean): boolean {
    const value = camel ?? snake;
    return value === undefined ? false : value;
  }

  /** A flag whose host default is `true`: absent must not read as a refusal. */
  private static defaultTrue(camel?: boolean, snake?: boolean): boolean {
    const value = camel ?? snake;
    return value === undefined ? true : value;
  }

  private static sortBuiltin(rows: SkillCatalogRow[]): SkillCatalogRow[] {
    return CommandCatalogProjection.sortRows(rows);
  }

  /** The custom section sorts on the same keys; only its place in the sheet differs. */
  private static sortCustom(rows: SkillCatalogRow[]): SkillCatalogRow[] {
    return CommandCatalogProjection.sortRows(rows);
  }

  private static sortRows(rows: SkillCatalogRow[]): SkillCatalogRow[] {
    return rows.slice().sort((left: SkillCatalogRow, right: SkillCatalogRow): number => {
      const byGroup = CommandCatalogProjection.compare(left.group, right.group);
      if (byGroup !== 0) {
        return byGroup;
      }
      const byName = CommandCatalogProjection.compare(left.name, right.name);
      return byName !== 0 ? byName : CommandCatalogProjection.compare(left.id, right.id);
    });
  }

  private static compare(left: string, right: string): number {
    if (left === right) {
      return 0;
    }
    return left < right ? -1 : 1;
  }

  /**
   * The row's display name, falling back to its key.
   *
   * The fallback is the same string the token would carry, so a host row that
   * never named its skill still yields a pick that can be sent rather than an
   * empty `[$]`.
   */
  private static rowName(name: string | undefined, fallback: string): string {
    const resolved = CommandCatalogProjection.trimmed(name);
    return resolved.length > 0 ? resolved : fallback;
  }

  private static trimmed(value?: string): string {
    return value === undefined ? '' : value.trim();
  }
}
