import { compositionPrograms } from './composition-programs';
import { programs } from './programs';
import {
  dashboardPromptOptions,
  exampleDashboard,
  exampleShoppingList,
  exampleSteps,
  exampleTrip,
  promptOptions,
} from './prompt-options';
import { toolPrograms } from './tool-programs';

export type GenUIGallerySectionId = 'composition' | 'working-tools' | 'components' | 'prompt-examples';

export interface GenUIGalleryProgram {
  id: string;
  title: string;
  note: string;
  code: string;
  section: GenUIGallerySectionId;
  requiresTools?: boolean;
  prompt?: string;
  example?: string;
}

const asGalleryProgram = (
  program: { id: string; title: string; note: string; code: string },
  section: GenUIGallerySectionId,
  metadata: Partial<Pick<GenUIGalleryProgram, 'requiresTools' | 'prompt' | 'example'>> = {},
): GenUIGalleryProgram => ({ ...program, section, ...metadata });

export const compositionGalleryPrograms = compositionPrograms.map(program => asGalleryProgram(program, 'composition'));
export const componentGalleryPrograms = programs.map(program => asGalleryProgram(program, 'components'));
export const toolGalleryPrograms = toolPrograms.map(program => asGalleryProgram(program, 'working-tools', {
  example: program.example,
  prompt: program.prompt,
  requiresTools: program.example === 'dash-sales' || program.example === 'dash-support',
}));

/**
 * A OpenBitFun-specific fixture for the request that motivated this migration.
 * It combines the patterns from savings, steps, garden and analytics instead
 * of falling back to a static Text-only answer.
 */
export const lifePlanProgram: GenUIGalleryProgram = {
  id: 'life-plan',
  section: 'working-tools',
  example: 'life-plan',
  title: 'Life plan dashboard',
  prompt: 'Make an interactive life planning app with goals, weekly actions and a progress view',
  note: 'A worked example combining KPI cards, inputs, a selectable focus area, a 12-week chart, a plan table and a weekly checklist.',
  code: `root = Col([head, kpis, controls, progress, plan, review])
$focus = "Career"
$energy = 7
$weeks = 12
$done = []
head = Row([Col([Title("Life plan", "xl"), Text("Choose one direction, turn it into a 12-week system, and review the actions every Sunday.", "sm", "muted")], 2), Spacer(), Badge("12-week cycle", "info")], 3, "start")
kpis = Grid([Card([Caption("Focus area"), Title($focus, "lg"), Text("One direction for this cycle", "xs", "muted")], "soft", 3, 1), Card([Caption("Energy budget"), Title($energy + "/10", "lg"), Text("A realistic pace beats a perfect plan", "xs", "muted")], "soft", 3, 1), Card([Caption("Actions checked"), Title(@Count($done) + "/4", "lg"), Text("Keep the weekly loop small", "xs", "muted")], "soft", 3, 1)], 3, 150, 3)
controls = Card([Title("Set the shape of the plan", "md"), SegmentedControl($focus, ["Career", "Health", "Money", "Relationships", "Learning"]), Slider($energy, 1, 10, 1, "Weekly energy", "points"), Row([Caption("Cycle length"), Spacer(), Text($weeks + " weeks", "sm", null, "semibold")], 2)], "soft", 4, 3)
rows = @Each(@Range(0, $weeks + 1), "i", {week: "W" + i, progress: @Round(@Clamp(i * $energy * 1.3, 0, 100))})
progress = Card([Row([Title("Progress view", "md"), Spacer(), Badge($focus, "purple")], 2), Chart("area", rows, "week", ["progress"], "percent", null, false, 180), Caption("The curve is a planning model, not a prediction. Adjust the actions when your real week gives you new information.")], null, 4, 3)
actions = [{area: "Direction", action: "Write one sentence describing the outcome", cadence: "Once"}, {area: "Practice", action: "Block two 45-minute sessions", cadence: "Weekly"}, {area: "Evidence", action: "Record one measurable result", cadence: "Weekly"}, {area: "Review", action: "Keep, change or drop one action", cadence: "Sunday"}]
plan = Card([Row([Title("The next four actions", "md"), Spacer(), Text(@Count(actions) + " actions", "sm", "muted")], 2), Table(["Area", "Action", "Cadence"], @Each(actions, "a", [a.area, a.action, a.cadence]))], null, 4, 3)
review = Card([Row([Title("Sunday review", "md"), Spacer(), Text(@Count($done) + " of 4 checked", "sm", "muted")], 2), Col(@Each(actions, "a", Pressable([Row([Icon(@Includes($done, a.area) ? "check-circle" : "circle", "sm"), Text(a.area + " · " + a.action, "sm", null, "semibold", false, @Includes($done, a.area))], 2)], @Set($done, @Toggle($done, a.area)), @Includes($done, a.area), 2)), 2), Text("Keep the direction stable; change the next action when the evidence changes.", "xs", "muted")], "soft", 4, 3)`,
};

export const promptGalleryPrograms: GenUIGalleryProgram[] = [
  asGalleryProgram({ id: 'prompt-shopping-list', title: 'Prompt example · Shopping list', note: 'Worked example injected into the normal prompt: bindings, @Each, @Toggle and copy action.', code: exampleShoppingList }, 'prompt-examples'),
  asGalleryProgram({ id: 'prompt-trip', title: 'Prompt example · Travel planning', note: 'Worked example showing photos, facts, day rows and a short form.', code: exampleTrip }, 'prompt-examples'),
  asGalleryProgram({ id: 'prompt-steps', title: 'Prompt example · SVG steps', note: 'Worked example showing a state-driven instruction drawing and navigation.', code: exampleSteps }, 'prompt-examples'),
  asGalleryProgram({ id: 'prompt-dashboard', title: 'Prompt example · Data dashboard', note: 'Worked example showing Query rows, transformations and Chart/Table output.', code: exampleDashboard }, 'prompt-examples', { requiresTools: true }),
];

export const gallerySections: Array<{ id: GenUIGallerySectionId; title: string; programs: GenUIGalleryProgram[] }> = [
  { id: 'composition', title: 'Composition', programs: compositionGalleryPrograms },
  { id: 'working-tools', title: 'Working tools', programs: [...toolGalleryPrograms, lifePlanProgram, ...promptGalleryPrograms] },
  { id: 'components', title: 'Components', programs: componentGalleryPrograms },
  { id: 'prompt-examples', title: 'Prompt worked examples', programs: promptGalleryPrograms },
];

export { dashboardPromptOptions, promptOptions };
