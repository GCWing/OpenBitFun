// Hand-written OpenUI Lang 1.0 programs that exercise every component and the
// main interactions. Rendered by the dev-only /gallery page.

export type Program = { id: string; title: string; note: string; code: string };

const bridge = "https://upload.wikimedia.org/wikipedia/commons/thumb/b/bf/Golden_Gate_Bridge_as_seen_from_Battery_East.jpg/960px-Golden_Gate_Bridge_as_seen_from_Battery_East.jpg";

// A small canvas game for HtmlView: catch the dot before the time runs out.
const game = `<style>body{display:flex;flex-direction:column;gap:10px;padding:14px}canvas{width:100%;height:220px;border-radius:12px;background:light-dark(#f7f7f8,#2a2a2a);touch-action:none;cursor:crosshair}.bar{display:flex;justify-content:space-between;font-size:13px}button{font:inherit;font-weight:500;padding:7px 14px;border-radius:999px;border:0;background:light-dark(#0d0d0d,#ececec);color:light-dark(#fff,#171717);cursor:pointer}</style>
<div class="bar"><span id="score">Score 0</span><span id="time">Press start</span></div>
<canvas id="c"></canvas>
<div><button id="go">Start</button></div>
<script>
const c=document.getElementById('c'),g=c.getContext('2d'),dpr=devicePixelRatio||1;
let dot={x:.5,y:.5,vx:.004,vy:.003},score=0,end=0,raf;
function fit(){c.width=c.clientWidth*dpr;c.height=c.clientHeight*dpr}
function draw(){fit();g.clearRect(0,0,c.width,c.height);g.fillStyle='#0285ff';g.beginPath();g.arc(dot.x*c.width,dot.y*c.height,16*dpr,0,7);g.fill()}
function tick(){const left=Math.max(0,end-Date.now());document.getElementById('time').textContent=(left/1000).toFixed(1)+' s';
dot.x+=dot.vx;dot.y+=dot.vy;if(dot.x<.05||dot.x>.95)dot.vx*=-1;if(dot.y<.08||dot.y>.92)dot.vy*=-1;draw();
if(left>0)raf=requestAnimationFrame(tick);else document.getElementById('time').textContent='Time! Final score '+score}
c.addEventListener('pointerdown',e=>{if(Date.now()>end)return;const r=c.getBoundingClientRect(),dx=(e.clientX-r.left)/r.width-dot.x,dy=(e.clientY-r.top)/r.height-dot.y;
if(Math.hypot(dx*r.width,dy*r.height)<26){score++;document.getElementById('score').textContent='Score '+score;dot.vx=(Math.random()-.5)*.02;dot.vy=(Math.random()-.5)*.02;dot.x=.1+Math.random()*.8;dot.y=.15+Math.random()*.7}});
document.getElementById('go').onclick=()=>{score=0;document.getElementById('score').textContent='Score 0';end=Date.now()+15000;cancelAnimationFrame(raf);tick()};
draw();
</script>`;

export const programs: Program[] = [
  {
    id: "answer",
    title: "An answer, composed",
    note: "Root Col without a gap spaces blocks like an article. Title, Text, Markdown, Grid, Card.",
    code: `root = Col([title, intro, photos, h2, md, stats, closing])
title = Title("A slow Saturday in Lisbon", "lg")
intro = Text("Start by the river, climb into **Alfama** for lunch, and end the day at a *miradouro* with the city below you.")
photos = Grid([SearchImage("Belém Tower Lisbon"), SearchImage("Alfama Lisbon"), SearchImage("Miradouro da Senhora do Monte")], 3, 100, 2)
h2 = Title("Before you go", "md")
md = Markdown("- Trams 28 and 12 get crowded after 10 AM.\\n- Wear shoes with grip: the cobbles are polished smooth.\\n- Most museums close on **Mondays**.")
stats = Grid([s1, s2, s3], 3, 150, 3)
s1 = Card([Caption("Walking"), Title("6.4 km", "xl")], null, 4, 1)
s2 = Card([Caption("Day pass"), Title("€6.80", "xl")], null, 4, 1)
s3 = Card([Caption("Sunset"), Title("7:42 PM", "xl")], null, 4, 1)
closing = Text("Times are estimates, not live data.", "xs", "muted")`,
  },
  {
    id: "text",
    title: "Text",
    note: "Title sizes, Text with inline marks, Caption, Label, Badge colors, Link, Markdown with a table.",
    code: `root = Card([t, sub, body, sizes, badges, link, Divider(), md])
t = Title("A little clarity goes a long way", "lg")
sub = Text("Typography that keeps the answer easy to read.", "sm", "muted")
body = Text("The best interface brings the useful details forward: **emphasis where it matters**, *a quiet aside*, \`inline code\` and [a link](https://openui.com).")
sizes = Grid([z1, z2, z3], 3, 150, 4)
z1 = Col([Caption("Big number, 2xl"), Title("$1.00T", "2xl")], 1)
z2 = Col([Caption("Card title, lg"), Title("What makes up GDP?", "lg")], 1)
z3 = Col([Caption("Section, sm"), Title("Explore a growth scenario", "sm"), Text("Struck through", "sm", "muted", null, false, true)], 1)
badges = Row([Badge("Illustrative"), Badge("Available", "success"), Badge("In progress", "info"), Badge("Needs review", "warning"), Badge("Sold out", "danger"), Badge("New", "purple"), Badge("Popular", "pink")], 2, null, null, true)
link = Row([Label("Source"), Link("Bureau of Economic Analysis", "https://www.bea.gov"), Link("Unsafe links render as text", "javascript:alert(1)")], 3, null, null, true)
md = Markdown("### Markdown prose\\nA paragraph with **bold**, *italic* and ~~strike~~.\\n\\n1. Numbered steps\\n2. Read in order\\n\\n> A quote stays quiet.\\n\\n| Plan | Seats | Price |\\n|---|---|---|\\n| Basic | 1 | $9 |\\n| Team | 10 | $49 |")`,
  },
  {
    id: "lists",
    title: "Lists and timeline",
    note: "List markers bullet, number and none; ListItem with a text marker; the timeline connector.",
    code: `root = Card([Title("Sunday cooking schedule", "lg"), Text("Assuming you serve at **2:00 PM**.", "sm", "muted"), schedule, Divider(), Grid([packing, steps], 2, 240, 6)])
schedule = List([a, b, c, d], "none", true)
a = ListItem("Prepare everything", "Season the lamb, peel the potatoes and trim the beans.", "10:45 AM")
b = ListItem("Start roasting", "The lamb goes into a 200°C oven until it reaches 60°C inside.", "11:15 AM")
c = ListItem("Potatoes in", "Parboil for 10 minutes, rough up the edges and roast in hot oil.", "12:00 PM")
d = ListItem("Rest and carve", "Rest the lamb for 20 minutes while the gravy simmers.", "1:30 PM")
packing = Col([Title("Packing", "sm"), List(["Light rain jacket", "Comfortable shoes", "A reusable bottle"])], 2)
steps = Col([Title("Steps", "sm"), List(["Choose a direction", "Explore the answer", "Keep the conversation going"], "number")], 2)`,
  },
  {
    id: "buttons",
    title: "Buttons",
    note: "Variants, colors, sizes, icons, disabled, block; IconButton. Buttons without an action send their label.",
    code: `root = Card([main, sizes, colors, icons, Button("Add to my route", @ToAssistant("Add Lands End to my route"), "solid", null, "lg", "plus", false, true)])
main = Row([Button("Customize my capsule", @ToAssistant("Customize my capsule"), "solid", null, null, "arrow-right"), Button("Copy split", null, "outline", null, null, "copy"), Button("Reset", null, "ghost", null, null, "rotate-ccw"), Button("Soft", null, "soft")], 2, null, null, true)
sizes = Row([Button("Small", null, "outline", null, "sm"), Button("Medium", null, "outline"), Button("Large", null, "outline", null, "lg"), Button("Disabled", null, "solid", null, null, null, true)], 2, null, null, true)
colors = Row([Button("Delete", null, "solid", "danger"), Button("Confirm", null, "solid", "success"), Button("Remove", null, "outline", "danger", null, "trash-2"), Button("Open docs", @OpenUrl("https://openui.com"), "ghost", null, null, "external-link")], 2, null, null, true)
icons = Row([IconButton("heart", null, "Save"), IconButton("share", null, "Share", "ghost"), IconButton("plus", null, "Add", "solid"), IconButton("bookmark", null, "Bookmark")], 2)`,
  },
  {
    id: "layout",
    title: "Layout",
    note: "Box backgrounds, radius, border, sizes and flex; Grid with minChildWidth; Card outline and soft; Spacer.",
    code: `root = Col([stats, swatches, tints, summary], 4)
stats = Grid([st1, st2], 2, 220, 4)
st1 = Card([Caption("Photography services · demo estimate"), Title("$617M", "xl"), Caption("2025, U.S. · narrow market definition")], null, 4, 2)
st2 = Card([Caption("Commercial drones · demo estimate"), Title("$4.1B", "xl"), Caption("2024, U.S. · broader market definition")], null, 4, 2)
swatches = Row([Box([], null, null, null, "#d9c9b0", "lg", null, 44, 44), Box([], null, null, null, "#9fb4a4", "lg", null, 44, 44), Box([], null, null, null, "#4f5d75", "lg", null, 44, 44), Box([], null, null, null, "#c96f53", "full", null, 44, 44), Spacer(), Badge("Warm neutrals")], 2)
tints = Grid([Box([Text("Info tint", "sm", "info")], null, null, 3, "info", "lg"), Box([Text("Success tint", "sm", "success")], null, null, 3, "success", "lg"), Box([Text("Warning tint", "sm", "warning")], null, null, 3, "warning", "lg"), Box([Text("On a hex color", "sm"), Caption("Text stays readable")], null, 1, 3, "#f5e6c8", "lg")], 4, 130, 2)
summary = Card([Row([Text("Subtotal"), Spacer(), Text("$156.00", null, null, null, null, null, true)]), Row([Text("Tax · 8.5%", "sm", "muted"), Spacer(), Text("$13.26", "sm", "muted", null, null, null, true)]), Divider(), Row([Text("Total"), Spacer(), Title("$169.26", "xl")])], "soft", null, 2)`,
  },
  {
    id: "gdp",
    title: "Sliders bound to state",
    note: "Four Slider($x) bindings; a computed total, a split bar sized by flex, and @Reset.",
    code: `root = Card([head, Caption("Total output"), total, bar, sliders, reset, Text("GDP = C + I + G + (X − M). Move any slider: the total and the bar follow.", "sm", "muted")])
$c = 600
$i = 200
$g = 170
$x = 30
gdp = $c + $i + $g + $x
head = Row([Col([Title("What makes up GDP?", "lg"), Text("An economy, in four parts.", "sm", "muted")], 1), Spacer(), Badge("Illustrative economy")], 3, "start")
total = Title("$" + @Round(gdp / 1000, 2) + " trillion", "2xl")
bar = Box([seg1, seg2, seg3, seg4], "row", 0.5, null, null, "md", null, "100%", 38)
seg1 = Box([Text("$" + $c + "B", "xs", "#ffffff", "medium")], null, null, null, "chart1", 0, null, null, "100%", $c, "center", "center")
seg2 = Box([Text("$" + $i + "B", "xs", "#ffffff", "medium")], null, null, null, "chart2", 0, null, null, "100%", $i, "center", "center")
seg3 = Box([Text("$" + $g + "B", "xs", "#ffffff", "medium")], null, null, null, "chart4", 0, null, null, "100%", $g, "center", "center")
seg4 = Box([], null, null, null, "chart3", 0, null, null, "100%", $x > 0 ? $x : 0)
sliders = Grid([Slider($c, 0, 1200, 10, "Consumer spending", "B"), Slider($i, 0, 600, 10, "Business investment", "B"), Slider($g, 0, 500, 10, "Government spending", "B"), Slider($x, -200, 300, 10, "Net exports", "B")], 2, 240, 6)
reset = Button("Reset economy", @Reset($c, $i, $g, $x), "ghost", null, "sm", "rotate-ccw")`,
  },
  {
    id: "segmented",
    title: "Segmented control",
    note: "SegmentedControl($mode) switches what renders; number Input and a Slider feed the per-person total.",
    code: `root = Card([head, body, summary])
$mode = "item"
$people = 4
$tip = 18
head = Row([Title("What are you splitting?", "md"), Spacer(), SegmentedControl($mode, [{value: "item", label: "By item"}, {value: "equal", label: "Equally"}])], 3, null, null, true)
body = $mode == "item" ? items : equal
items = Col([Row([Text("Burrata & sourdough"), Spacer(), Text("$18", null, null, "medium", null, null, true)]), Row([Text("Mains"), Spacer(), Text("$96", null, null, "medium", null, null, true)]), Row([Text("A bottle of red"), Spacer(), Text("$42", null, null, "medium", null, null, true)])], 3)
equal = Grid([Input($people, "People at the table", "number"), Slider($tip, 0, 30, 1, "Tip", "%", [{value: 0, label: "None"}, {value: 15, label: "15%"}, {value: 30, label: "30%"}])], 2, 220, 6)
summary = Card([Row([Text("Total with tip"), Spacer(), Title("$" + @Round(156 * (1 + $tip / 100), 2), "lg")]), Row([Text("Each of " + $people, "sm", "muted"), Spacer(), Text("$" + @Round(156 * (1 + $tip / 100) / ($people > 0 ? $people : 1), 2), "sm", null, "medium", null, null, true)])], "soft", null, 2)`,
  },
  {
    id: "checklist",
    title: "Checkbox list",
    note: "Six Checkbox($pN) bindings with lineThrough; @Count(@Filter(...)) drives the progress text and bar.",
    code: `root = Card([Row([Title("Your suitcase", "md"), Spacer(), Text(done + "/6 packed", "sm", "muted", null, null, null, true)]), bar, list, Button("Clear", @Reset($p1, $p2, $p3, $p4, $p5, $p6), "outline", null, "sm")], "soft")
$p1 = true
$p2 = false
$p3 = true
$p4 = false
$p5 = false
$p6 = false
done = @Count(@Filter([$p1, $p2, $p3, $p4, $p5, $p6], "", "==", true))
bar = Box([Box([], null, null, null, "ink", "full", null, (done / 6 * 100) + "%", 4)], null, null, null, "border", "full", null, "100%", 4)
list = Grid([Checkbox($p1, "The everyday tee", true), Checkbox($p2, "Relaxed Oxford shirt", true), Checkbox($p3, "Unstructured jacket", true), Checkbox($p4, "Straight-leg trousers", true), Checkbox($p5, "Minimal leather sneakers", true), Checkbox($p6, "Everywhere tote", true)], 2, 220, 2)`,
  },
  {
    id: "pressable",
    title: "Pressable grid",
    note: "Pressable tiles set $bed with @Set and show the selected ring; the detail line reads $bed.",
    code: `root = Card([Title("Your 4 × 4 ft garden plan", "lg"), Text("Tap a planter to see what grows there.", "sm", "muted"), grid, detail])
$bed = "Lettuce + radishes"
grid = Grid([p1, p2, p3, p4], 2, null, 3)
p1 = Pressable([Col([Icon("leafy-green", "lg"), Text("Lettuce + radishes", "sm", null, "medium"), Caption("24-inch planter")], 1, "center")], @Set($bed, "Lettuce + radishes"), $bed == "Lettuce + radishes", 6, "#d6e8cf", "lg")
p2 = Pressable([Col([Icon("bean", "lg"), Text("Snap peas", "sm", null, "medium"), Caption("Pot + trellis")], 1, "center")], @Set($bed, "Snap peas"), $bed == "Snap peas", 6, "#d6e8cf", "lg")
p3 = Pressable([Col([Icon("leaf", "lg"), Text("Kale", "sm", null, "medium"), Caption("12-inch pot")], 1, "center")], @Set($bed, "Kale"), $bed == "Kale", 6, "#ecdfc3", "lg")
p4 = Pressable([Col([Icon("sprout", "lg"), Text("Herbs", "sm", null, "medium"), Caption("1 to 2 small pots")], 1, "center")], @Set($bed, "Herbs"), $bed == "Herbs", 6, "#ecdfc3", "lg")
detail = Row([Icon("sun", "sm", "warning"), Text("Selected: **" + $bed + "**. Give it 6+ hours of sunlight.", "sm")], 2)`,
  },
  {
    id: "inputs",
    title: "Inputs and form",
    note: "Input (text and number), DatePicker, Select, RadioGroup, TextArea inside a Form; the button sends the values as context.",
    code: `root = Card([Title("Make it yours", "lg"), form])
$name = ""
$people = 4
$date = "2026-10-24"
$pace = "balanced"
$weather = "mild"
$notes = ""
form = Form([Grid([Input($name, "Name", "text", "Your name"), Input($people, "Travelers", "number")], 2, 200, 4), Grid([DatePicker($date, "Start date"), Select($pace, [{value: "relaxed", label: "Relaxed"}, {value: "balanced", label: "Balanced"}, {value: "active", label: "Active"}], "Preferred pace")], 2, 200, 4), RadioGroup($weather, [{value: "hot", label: "Hot / tropical"}, {value: "mild", label: "Mild / mixed weather"}, {value: "cold", label: "Cold / rainy"}], "What weather are you packing for?"), TextArea($notes, "Anything else?", "A place you would love to visit…", 3), submit])
submit = Button("Customize my trip", @ToAssistant("Customize my trip", {name: $name, people: $people, date: $date, pace: $pace, weather: $weather, notes: $notes}), "solid", null, null, "arrow-right")`,
  },
  {
    id: "svg",
    title: "Svg driven by a slider",
    note: "G transforms and SvgText read $angle; every shape component appears.",
    code: `root = Card([Title("Turn the crank", "md"), Text("The rear sprocket turns " + ratio + " times as far as the chainring.", "sm", "muted"), drawing, Slider($angle, 0, 360, 5, "Crank angle", "°"), shapes])
$angle = 40
ratio = 2.5
drawing = Svg([chain, front, rear, readout], "0 0 320 160")
chain = Path("M 90 40 L 240 62 A 18 18 0 0 1 240 98 L 90 120 A 40 40 0 0 1 90 40 Z", null, "faint", 2)
front = G([Circle(90, 80, 40, "surface", "ink", 3), Line(90, 80, 90, 44, "ink", 4), Circle(90, 80, 6, "ink")], "rotate(" + $angle + " 90 80)")
rear = G([Circle(240, 80, 18, "surface", "ink", 3), Line(240, 80, 240, 64, "info", 3), Circle(240, 80, 4, "ink")], "rotate(" + $angle * ratio + " 240 80)")
readout = SvgText("Rear " + @Round($angle * ratio % 360, 0) + "°", 240, 132, 12, "muted", "middle")
shapes = Svg([Rect(10, 10, 60, 40, "info", null, null, 0.8, 8), Ellipse(120, 30, 34, 20, "success"), Polygon("180,50 205,10 230,50", "warning"), Polyline("250,45 265,15 280,40 295,12", "danger", 3), SvgText("Rect · Ellipse · Polygon · Polyline", 160, 72, 11, "muted", "middle")], "0 0 320 80", null, null)`,
  },
  {
    id: "chart",
    title: "Charts",
    note: "SegmentedControl switches Chart($type); currency and percent formats; stacked bars; pie and donut.",
    code: `root = Card([head, chart, Grid([pie, donut], 2, 260, 6)])
$type = "bar"
head = Row([Col([Title("Drone services revenue", "md"), Caption("Illustrative revenue path, not a forecast")], 1), Spacer(), SegmentedControl($type, ["bar", "line", "area"])], 3, null, null, true)
chart = Chart($type, rows, "year", ["Photography", "Inspection"], "currency", null, $type != "line")
rows = [{year: "2025", Photography: 617000000, Inspection: 410000000}, {year: "2027", Photography: 820000000, Inspection: 690000000}, {year: "2030", Photography: 1240000000, Inspection: 1310000000}, {year: "2034", Photography: 1900000000, Inspection: 2350000000}]
pie = Col([Title("How people get around", "sm"), Chart("pie", modes, "mode", ["share"], "percent")], 2)
donut = Col([Title("Budget", "sm"), Chart("donut", budget, "item", ["amount"], "currency", "EUR")], 2)
modes = [{mode: "Walking", share: 52}, {mode: "Transit", share: 31}, {mode: "Cycling", share: 17}]
budget = [{item: "Lodging", amount: 840}, {item: "Food", amount: 420}, {item: "Transport", amount: 260}, {item: "Museums", amount: 90}]`,
  },
  {
    id: "table",
    title: "Table",
    note: "Rows of cells in column order; number columns align right; a cell can be a component.",
    code: `root = Card([Title("Who makes money in this market?", "md"), Table(["Player", "Business model", "Typical margin", "Difficulty"], [["Drone manufacturers", "Sell drones, cameras and accessories", "38%", Badge("Hard", "danger")], ["Freelance pilots", "Charge per shoot or project", "55%", Badge("Easy", "success")], ["Mapping companies", "SaaS and data processing fees", "24%", Badge("Medium", "warning")], ["Enterprises", "Operate their own fleets", "n/a", Badge("Medium", "warning")]]), Table(["Month", "Shoots", "Revenue"], [["January", 8, "$2,000"], ["February", 12, "$3,000"], ["March", 15, "$3,750"]])])`,
  },
  {
    id: "images",
    title: "Images",
    note: "A working src; no src (search by alt); a failing src that falls back to search; a failing src with nothing found.",
    code: `root = Card([Title("Golden hour in San Francisco", "md"), Grid([i1, i2, i3, i4], 4, 150, 3)])
i1 = Col([Image("${bridge}", "Golden Gate Bridge from Battery East"), Text("Working src", "sm", null, "semibold"), Caption("Loads the given URL")], 2)
i2 = Col([SearchImage("Alcatraz Island"), Text("No src", "sm", null, "semibold"), Caption("Found by searching the query")], 2)
i3 = Col([Image("https://example.invalid/palace.jpg", "Palace of Fine Arts"), Text("Broken src", "sm", null, "semibold"), Caption("Falls back to search")], 2)
i4 = Col([Image("https://example.invalid/none.jpg", "qzxv unfindable subject 0000", 1.5, "xl"), Text("Nothing found", "sm", null, "semibold"), Caption("Quiet placeholder")], 2)`,
  },
  {
    id: "map",
    title: "Map with a route",
    note: "Map(markers, route, $stop): street route via /api/street-route, category filter, emoji and numbered pins; clicking a pin sets $stop.",
    code: `root = Col([Title("San Francisco, your way", "md"), Text("Tap a pin to choose where to start.", "sm", "muted"), map, Card([Row([Icon("map-pin", "sm"), Text("Starting at **" + $stop + "**", "sm")], 2)], "soft", 3)])
$stop = "Ferry Building"
map = Map([m1, m2, m3, m4], true, $stop)
m1 = MapMarker("Ferry Building", 37.7955, -122.3937, "Food", "☕")
m2 = MapMarker("Coit Tower", 37.8024, -122.4058, "Views")
m3 = MapMarker("Palace of Fine Arts", 37.8029, -122.4484, "Landmarks", "🏛️")
m4 = MapMarker("Golden Gate Bridge", 37.8199, -122.4783, "Views", "🌉")`,
  },
  {
    id: "html",
    title: "HtmlView game",
    note: "A sandboxed canvas game (allow-scripts, opaque origin, strict CSP) that sizes itself to its content.",
    code: `root = Card([Title("Take a little break", "md"), Text("Catch the dot as many times as you can in 15 seconds.", "sm", "muted"), HtmlView(${JSON.stringify(game)}, null, "Catch the dot")])`,
  },
  {
    id: "timer",
    title: "Timer",
    note: "Timer($left) counts the bound seconds down; preset buttons @Set it, and a statement reacts when $left reaches 0.",
    code: `root = Card([Title("Steep your tea", "md"), presets, Timer($left, "Time left"), done])
$left = 180
presets = Row([Button("Green · 2 min", @Set($left, 120), "outline", null, "sm"), Button("Black · 4 min", @Set($left, 240), "outline", null, "sm"), Button("Herbal · 6 min", @Set($left, 360), "outline", null, "sm")], 2, null, null, true)
done = $left == 0 ? Text("**Ready.** Take the leaves out now.", "sm", "success") : Caption("Start the timer when the water reaches the leaves.")`,
  },
  {
    id: "heatmap",
    title: "Color scale",
    note: "@MixColor turns a value into a color between two hex colors, for heatmaps and tints.",
    code: `root = Card([Title("When the café is busiest", "md"), Caption("Average customers per hour, last 4 weeks"), Grid(@Each(days, "d", Caption(d)), 7, null, 1), Grid(@Each(visits, "v", Box([Text(v + "", "xs", null, "medium", false, false, true)], null, null, 1, @MixColor("#EEF6FF", "#0068BC", v / 60), "sm", null, null, 32, null, "center", "center")), 7, null, 1), Row([Caption("Quiet"), Row(@Each([0, 0.25, 0.5, 0.75, 1], "t", Box([], null, null, null, @MixColor("#EEF6FF", "#0068BC", t), "sm", null, 20, 10)), 1), Caption("Busy")], 2)])
days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
visits = [12, 14, 13, 15, 18, 34, 30, 28, 30, 29, 31, 36, 52, 47, 41, 44, 40, 45, 50, 58, 49, 22, 24, 23, 27, 38, 44, 35]`,
  },
  {
    id: "icons",
    title: "Icons",
    note: "Lucide names at each size and in a few colors. An unknown name renders nothing.",
    code: `root = Card([Row([Icon("sparkles", "sm"), Icon("map-pin"), Icon("camera", "lg"), Icon("bike", "xl"), Icon("heart", "lg", "danger"), Icon("check-circle", "lg", "success"), Icon("info", "lg", "info"), Icon("alert-triangle", "lg", "warning"), Icon("no-such-icon", "lg")], 4, null, null, true)])`,
  },
];
