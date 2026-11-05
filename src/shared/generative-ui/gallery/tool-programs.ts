// Hand-written OpenUI Lang 1.0 answers for the 16 Intelligent UI example
// prompts and two dashboards, built only from the library and its @functions.
// They work in the page with $variables and @Set; nothing goes back to the
// assistant. The benchmark harness also uses them as fake model outputs, so
// this file has no runtime imports.

import type { Program } from "./programs";

/** example: the prompt id in the benchmark (the Intelligent UI example ids, or dash-*). */
export type ToolProgram = Program & { example: string; prompt: string };

const roast = `root = Col([head, dishes, planner, Grid([shopping, schedule], 2, 300, 5)], 5)
$guests = 6
$got = []
$done = []
head = Col([Title("Sunday roast with friends", "xl"), Text("Rosemary and garlic lamb, golden potatoes and all the good things on the side. The shopping list grows with your guest list.", "md", "muted")], 2)
dishes = Grid([d1, d2, d3], 3, 170, 3)
d1 = Col([SearchImage("Lamb roast dinner", 1.4, "lg"), Text("Rosemary & garlic lamb", "sm", null, "semibold"), Caption("The centerpiece, with gravy and mint sauce")], 1)
d2 = Col([SearchImage("Roast potato", 1.4, "lg"), Text("Extra-crispy potatoes", "sm", null, "semibold"), Caption("Fluffy inside, golden edges")], 1)
d3 = Col([SearchImage("Apple crumble", 1.4, "lg"), Text("Bramley apple crumble", "sm", null, "semibold"), Caption("Warm, with custard or cream")], 1)
planner = Card([Row([Col([Text("Guests", "sm", null, "semibold"), Caption("Quantities follow the guest count")], 0), Spacer(), IconButton("minus", @Set($guests, @Clamp($guests - 1, 2, 16)), "Fewer guests"), Title($guests + "", "lg"), IconButton("plus", @Set($guests, @Clamp($guests + 1, 2, 16)), "More guests")], 3)], "soft", 4)
lines = @Each(ingredients, "i", {name: i.name, amount: i.unit == "kg" ? @Format(i.qty * $guests / 6, "number", 1) + " kg" : i.unit == "g" ? @Format(@Round(i.qty * $guests / 300) * 50) + " g" : @Ceil(i.qty * $guests / 6) + ""})
shopping = Card([Row([Title("Shopping list", "md"), Spacer(), Badge(@Count($got) + " of " + @Count(lines) + " in the basket", @Count($got) == @Count(lines) ? "success" : "neutral")], 2), Col(@Each(lines, "l", Pressable([Row([Icon(@Includes($got, l.name) ? "check-circle" : "circle", "sm", @Includes($got, l.name) ? "success" : "faint"), Text(l.name, "sm", null, null, false, @Includes($got, l.name)), Spacer(), Text(l.amount, "sm", "muted", "medium", false, false, true)], 2)], @Set($got, @Toggle($got, l.name)), @Includes($got, l.name), 2)), 1), Button("Copy shopping list", @CopyToClipboard("Sunday roast for " + $guests + "\\n" + @Join(@Each(lines, "l", "- " + l.amount + " " + l.name), "\\n")), "outline", null, "sm", "copy")], null, 4, 3)
schedule = Card([Row([Title("Cooking plan", "md"), Spacer(), Text(@Count($done) + " of " + @Count(steps) + " done", "sm", "muted")], 2), Col(@Each(steps, "s", Pressable([Row([Icon(@Includes($done, s.title) ? "check-circle" : "circle", "sm", @Includes($done, s.title) ? "success" : "faint"), Col([Text(s.time + " · " + s.title, "sm", null, "semibold", false, @Includes($done, s.title)), Caption(s.description)], 0)], 3, "start")], @Set($done, @Toggle($done, s.title)), @Includes($done, s.title), 2)), 1), Button("Start over", @Reset($done, $got), "ghost", null, "sm", "rotate-ccw")], null, 4, 3)
ingredients = [{name: "Bone-in leg of lamb", qty: 2.4, unit: "kg"}, {name: "Potatoes", qty: 1800, unit: "g"}, {name: "Carrots", qty: 9, unit: ""}, {name: "Parsnips", qty: 6, unit: ""}, {name: "Tenderstem broccoli", qty: 750, unit: "g"}, {name: "Apples for the crumble", qty: 5, unit: ""}, {name: "Bunches of rosemary", qty: 1, unit: ""}]
steps = [{time: "Saturday", title: "Get ahead", description: "Make the crumble, marinate the lamb and set the table."}, {time: "12:30 PM", title: "Lamb in", description: "200°C for 20 minutes, then 180°C for about 25 minutes per 500 g."}, {time: "1:15 PM", title: "Potatoes in", description: "Parboil, rough up the edges and roast in hot fat."}, {time: "2:30 PM", title: "Rest and carve", description: "Rest the lamb for 20 minutes while the vegetables finish."}, {time: "3:00 PM", title: "Serve", description: "The crumble goes in as you sit down."}]`;

const bill = `root = Card([head, people, addPerson, Divider(), itemsHead, items, addItem, Divider(), rates, summary], null, 5, 4)
$mode = "item"
$people = ["You", "Alex", "Sam", "Jordan"]
$items = [{name: "Burrata & sourdough", amount: 18, people: ["You", "Alex", "Sam", "Jordan"]}, {name: "Mains", amount: 96, people: ["You", "Alex", "Sam", "Jordan"]}, {name: "A bottle of red", amount: 42, people: ["You", "Alex", "Jordan"]}]
$name = ""
$itemName = ""
$itemAmount = null
$tax = 8.5
$tip = 20
head = Row([Col([Title("The check, please", "lg"), Text($mode == "item" ? "Tap names on an item to say who shared it." : "Everyone pays the same share.", "sm", "muted")], 1), Spacer(), SegmentedControl($mode, [{value: "item", label: "By item"}, {value: "equal", label: "Equally"}])], 3, null, null, true)
people = Row(@Each($people, "p", Button(p, Action([@Set($people, @Remove($people, "", p)), @Set($items, @Each($items, "it", {name: it.name, amount: it.amount, people: @Remove(it.people, "", p)}))]), "soft", null, "sm", "x")), 2, null, null, true)
addPerson = Row([Input($name, null, "text", "Add a person"), Button("Add", Action([@Set($people, @Append($people, $name)), @Set($items, @Each($items, "it", {name: it.name, amount: it.amount, people: @Append(it.people, $name)})), @Reset($name)]), "outline", null, null, "user-plus", $name == "" || @Includes($people, $name))], 2)
itemsHead = Row([Title("Items", "md"), Spacer(), Text(@Format(subtotal, "currency"), "sm", "muted", "medium", false, false, true)])
items = Col(@Each($items, "it", Card([Row([Text(it.name, "sm", null, "semibold"), Spacer(), Text(@Format(it.amount, "currency"), "sm", null, "medium", false, false, true), IconButton("trash-2", @Set($items, @Remove($items, "name", it.name)), "Remove " + it.name, "ghost")], 2), $mode == "item" ? Row(@Each($people, "p", Button(p, @Set($items, @Update($items, "name", it.name, "people", @Toggle(it.people, p))), @Includes(it.people, p) ? "solid" : "outline", null, "sm", @Includes(it.people, p) ? "check" : null)), 1, null, null, true) : null], null, 3, 2)), 2)
addItem = Row([Input($itemName, null, "text", "Item"), Input($itemAmount, null, "number", "Price"), Button("Add item", Action([@Set($items, @Append($items, {name: $itemName, amount: $itemAmount, people: $people})), @Reset($itemName, $itemAmount)]), "outline", null, null, "plus", $itemName == "" || $itemAmount <= 0)], 2)
rates = Grid([Slider($tax, 0, 15, 0.5, "Tax", "%"), Slider($tip, 0, 30, 1, "Tip", "%")], 2, 220, 6)
subtotal = @Sum($items.amount)
factor = 1 + ($tax + $tip) / 100
unassigned = $mode == "equal" ? 0 : @Sum(@Each($items, "it", @Count(it.people) == 0 ? it.amount : 0))
raw = @Each($people, "p", factor * ($mode == "equal" ? subtotal / @Max([@Count($people), 1]) : @Sum(@Each($items, "it", @Includes(it.people, p) ? it.amount / @Count(it.people) : 0))))
cents = @Sum(raw) > 0 ? @Allocate(@Round(@Sum(raw), 2), raw) : raw
shares = @Each(@Range(0, @Count($people)), "i", {name: $people[i], amount: cents[i]})
summary = Card([Col(@Each(shares, "s", Row([Text(s.name), Spacer(), Text(@Format(s.amount, "currency"), null, null, "semibold", false, false, true)])), 2), Divider(), Row([Text("Total with tax and tip", "sm", "muted"), Spacer(), Title(@Format(subtotal * factor, "currency"), "lg")]), unassigned > 0 ? Text(@Format(unassigned, "currency") + " is not assigned to anyone yet.", "xs", "warning") : null, Button("Copy the split", @CopyToClipboard(@Join(@Each(shares, "s", s.name + ": " + @Format(s.amount, "currency")), "\\n")), "solid", null, "sm", "copy")], "soft", 4, 3)`;

const monty = `root = Card([head, doors, status, actions, record, sim], null, 5, 4)
$choice = -1
$opened = -1
$final = -1
$prize = 0
$switched = 0
$switchWins = 0
$stayed = 0
$stayWins = 0
$simStay = 0
$simGames = 0
head = Col([Title("Should you switch doors?", "lg"), Text("One car. Two goats. A surprisingly good reason to switch.", "sm", "muted")], 1)
doors = Grid(@Each(@Range(0, 3), "d", Pressable([Col([Text("Door " + (d + 1), "sm", "muted", "medium"), Title(d == $opened || $final >= 0 ? (d == $prize ? "🚗" : "🐐") : "🚪", "3xl"), Text(d == $choice ? "Your pick" : d == $opened ? "Opened by the host" : "Closed", "xs", d == $choice ? "info" : "muted", "medium")], 1, "center")], $choice < 0 ? Action([@Set($choice, d), @Set($prize, @Random(0, 2, true)), @Set($opened, $prize == d ? (d + 1 + @Random(0, 1, true)) % 3 : 3 - d - $prize)]) : null, d == $choice, 5, d == $opened || $final >= 0 ? "surface" : "warning", "lg")), 3, null, 3)
status = Box([Title($final >= 0 ? ($final == $prize ? "You found the car!" : "A goat this time.") : $choice >= 0 ? "Door " + ($opened + 1) + " has a goat." : "Start by choosing a door.", "md"), Text($final >= 0 ? "Switching wins whenever your first pick was a goat: 2 out of 3 times." : $choice >= 0 ? "Your door still has a 1 in 3 chance. The other closed door has 2 in 3. Switch or stay?" : "The host knows where the car is and will open another door with a goat behind it.", "sm", "muted")], null, 1, 4, "info", "lg")
actions = Row([$choice >= 0 && $final < 0 ? Button("Switch doors", Action([@Set($final, 3 - $choice - $opened), @Set($switched, $switched + 1), @Set($switchWins, $switchWins + ($final == $prize ? 1 : 0))]), "solid", null, null, "shuffle") : null, $choice >= 0 && $final < 0 ? Button("Keep my door", Action([@Set($final, $choice), @Set($stayed, $stayed + 1), @Set($stayWins, $stayWins + ($final == $prize ? 1 : 0))]), "outline") : null, $final >= 0 ? Button("Play again", @Reset($choice, $opened, $final), "solid", null, null, "rotate-ccw") : null, Button("Simulate 1,000 games", Action([@Set($simStay, $simStay + @Count(@Filter(@Each(@Range(0, 1000), "g", @Random(0, 2, true) == @Random(0, 2, true)), "", "==", true))), @Set($simGames, $simGames + 1000)]), "ghost", null, null, "dices")], 2, null, null, true)
record = $switched + $stayed > 0 ? Text("Your games: switched " + @Plural($switched, "time") + " and won " + $switchWins + "; stayed " + @Plural($stayed, "time") + " and won " + $stayWins + ".", "sm", "muted") : null
sim = $simGames > 0 ? Card([Row([Title("Simulated games", "sm"), Spacer(), Caption(@Format($simGames) + " games")]), Chart("bar", [{strategy: "Stay", wins: @Percent($simStay, $simGames)}, {strategy: "Switch", wins: 100 - @Percent($simStay, $simGames)}], "strategy", ["wins"], "percent", null, false, 160)], "soft", 4, 2) : null`;

const savings = `root = Card([head, kpis, chart, milestone, controls, Text("Assumes monthly compounding and contributions at the end of each month. Returns are not guaranteed; this is an illustration, not advice.", "xs", "muted")], null, 5, 4)
$initial = 10000
$monthly = 500
$years = 30
$rate = 5
head = Row([Col([Title("Retirement savings", "lg"), Text("Turn today's contributions into a picture of tomorrow.", "sm", "muted")], 1), Spacer(), Button("Reset", @Reset($initial, $monthly, $years, $rate), "ghost", null, "sm", "rotate-ccw")], 3, "start")
rows = @Each(@Range(0, $years + 1), "y", {year: "Year " + y, Contributions: $initial + $monthly * 12 * y, Balance: $rate == 0 ? $initial + $monthly * 12 * y : $initial * @Pow(1 + $rate / 1200, 12 * y) + $monthly * (@Pow(1 + $rate / 1200, 12 * y) - 1) / ($rate / 1200)})
final = @Last(rows)
million = @First(@Filter(rows, "Balance", ">=", 1000000))
kpis = Grid([k1, k2, k3], 3, 150, 3)
k1 = Card([Caption("Balance in " + @Plural($years, "year")), Title(@Format(final.Balance, "currency", 0), "xl")], "soft", 3, 1)
k2 = Card([Caption("You put in"), Title(@Format(final.Contributions, "currency", 0), "xl")], "soft", 3, 1)
k3 = Card([Caption("Growth"), Title(@Format(final.Balance - final.Contributions, "currency", 0), "xl", "success")], "soft", 3, 1)
chart = Chart("area", rows, "year", ["Contributions", "Balance"], "currency")
milestone = Row([Icon(million == null ? "hourglass" : "party-popper", "sm", million == null ? "muted" : "success"), Text(million == null ? "At this pace the balance stays under $1 million." : "You pass **$1 million** in " + million.year + ", " + @Format(@Percent(million.Balance - million.Contributions, million.Balance), "percent", 0) + " of it from growth.", "sm")], 2)
controls = Grid([Slider($initial, 0, 200000, 1000, "Starting balance", "$"), Slider($monthly, 0, 5000, 50, "Monthly contribution", "$"), Slider($years, 1, 50, 1, "Years", " yrs"), Slider($rate, 0, 12, 0.5, "Annual return", "%")], 2, 240, 6)`;

const gdp = `root = Card([head, Caption("Total output"), total, bar, legend, note, sliders, Row([Button("Reset economy", @Reset($c, $i, $g, $x), "ghost", null, "sm", "rotate-ccw"), Spacer(), Badge("GDP = C + I + G + (X − M)", "purple")], 2, null, null, true), Text("GDP counts the value of final goods and services produced within a country. Imports are subtracted because they were produced elsewhere.", "sm", "muted"), quiz], null, 5, 4)
$c = 600
$i = 200
$g = 170
$x = 30
$answer = ""
gdp = $c + $i + $g + $x
parts = [{label: "Consumer spending", value: $c, color: "chart1"}, {label: "Business investment", value: $i, color: "chart2"}, {label: "Government spending", value: $g, color: "chart4"}, {label: "Net exports", value: $x, color: "chart3"}]
head = Row([Col([Title("What makes up GDP?", "lg"), Text("An economy, in four parts.", "sm", "muted")], 1), Spacer(), Badge("Illustrative economy")], 3, "start")
total = Title("$" + @Format(gdp / 1000, "number", 2) + " trillion", "2xl")
bar = Box(@Each(parts, "p", Box([p.value >= 80 ? Text("$" + p.value + "B", "xs", "#ffffff", "medium") : null], null, null, null, p.color, 0, null, null, "100%", @Max([p.value, 0]), "center", "center")), "row", 0.5, null, null, "md", null, "100%", 38)
legend = Grid(@Each(parts, "p", Row([Box([], null, null, null, p.color, "full", null, 10, 10), Text(p.label, "sm"), Spacer(), Text((p.value < 0 ? "-$" : "$") + @Format(@Abs(p.value)) + "B", "sm", "muted", "medium", false, false, true)], 2)), 2, 220, 2)
note = $x < 0 ? Text("Positive contributions add up to $" + ($c + $i + $g) + "B. Net imports subtract $" + @Abs($x) + "B, leaving $" + gdp + "B of output.", "sm", "warning") : null
sliders = Grid([Slider($c, 0, 1200, 10, "Consumer spending, $ billions"), Slider($i, 0, 600, 10, "Business investment, $ billions"), Slider($g, 0, 500, 10, "Government spending, $ billions"), Slider($x, -200, 300, 10, "Net exports, $ billions")], 2, 240, 6)
quiz = Card([RadioGroup($answer, [{value: "a", label: "Real GDP increases by 10%"}, {value: "b", label: "Nominal GDP rises; real GDP is unchanged"}, {value: "c", label: "Both measures stay the same"}], "The same goods cost 10% more this year. What changes?"), $answer == "" ? null : Text(($answer == "b" ? "**Correct.** " : "**Not quite.** ") + "Real GDP adjusts for price changes, so higher prices alone raise nominal GDP but not real output.", "sm")], "soft", 4, 2)`;

const clt = `root = Card([head, SegmentedControl($dist, ["Skewed", "Uniform", "Bimodal"]), Grid([popCard, meanCard], 2, 260, 4), Slider($n, 1, 50, 1, "Values per sample"), buttons, stats, Text("As the sample size grows, the averages of samples pile up in a bell shape around the population mean, even when the population itself is skewed.", "sm", "muted"), quiz], null, 5, 4)
$dist = "Skewed"
$n = 5
$means = []
$answer = ""
head = Col([Title("The central limit theorem", "lg"), Text("Different populations. The same bell-shaped pattern.", "sm", "muted")], 1)
pop = @Each(@Range(0.0025, 1, 0.005), "u", $dist == "Skewed" ? @Pow(u, 3) : $dist == "Uniform" ? u : (u < 0.5 ? 0.05 + 0.4 * u : 0.55 + 0.4 * u))
current = @Filter(@Filter($means, "dist", "==", $dist), "n", "==", $n).mean
draw = @Each(@Range(0, 100), "s", {dist: $dist, n: $n, mean: @Avg(@Each(@Each(@Range(0, $n), "k", @Random(0, 1)), "u", $dist == "Skewed" ? @Pow(u, 3) : $dist == "Uniform" ? u : (u < 0.5 ? 0.05 + 0.4 * u : 0.55 + 0.4 * u)))})
popCard = Col([Title("Population", "sm"), Caption("The values we draw from"), Chart("bar", @Histogram(pop, 20, 0, 1), "key", ["value"], null, null, false, 150)], 1)
meanCard = Col([Title("Sample means", "sm"), Caption("The average of each sample of " + $n), @Count(current) == 0 ? Box([Text("Draw samples to see the pattern", "sm", "muted")], null, null, 6, "surface", "lg", true, "100%", 150, null, "center", "center") : Chart("bar", @Histogram(current, 20, 0, 1), "key", ["value"], null, null, false, 150)], 1)
buttons = Row([Button("Draw 100 samples", @Set($means, @Take(@Concat($means, draw), -6000)), "solid", null, null, "dices"), Button("Draw 500", Action([@Set($means, @Take(@Concat($means, draw), -6000)), @Set($means, @Take(@Concat($means, draw), -6000)), @Set($means, @Take(@Concat($means, draw), -6000)), @Set($means, @Take(@Concat($means, draw), -6000)), @Set($means, @Take(@Concat($means, draw), -6000))]), "outline"), Button("Reset", @Reset($means), "ghost", null, null, "rotate-ccw")], 2, null, null, true)
stats = Grid([s1, s2, s3], 3, 140, 3)
s1 = Card([Caption("Samples"), Title(@Format(@Count(current)), "xl")], "soft", 3, 1)
s2 = Card([Caption("Mean of the means"), Title(@Count(current) == 0 ? "-" : @Format(@Stats(current).mean, "number", 3), "xl"), Caption("Population: " + @Format(@Stats(pop).mean, "number", 3))], "soft", 3, 1)
s3 = Card([Caption("Spread of the means"), Title(@Count(current) == 0 ? "-" : @Format(@Stats(current).stdev, "number", 3), "xl"), Caption("Theory, σ/√n: " + @Format(@Stats(pop).stdev / @Sqrt($n), "number", 3))], "soft", 3, 1)
quiz = Card([RadioGroup($answer, [{value: "a", label: "The population becomes normal"}, {value: "b", label: "The sample means form a narrower bell shape"}, {value: "c", label: "Every mean becomes exactly the same"}], "What changes when the sample size grows?"), $answer == "" ? null : Text(($answer == "b" ? "**Correct.** " : "**Not quite.** ") + "The population stays the same. The means become more normal and their spread shrinks like 1/√n.", "sm")], "soft", 4, 2)`;

const sales = `root = Col([head, kpis, Grid([trend, mix], 2, 300, 4), Grid([regions, top], 2, 300, 4)], 4)
$days = "90"
$channel = "All"
$view = "Weekly"
orders = Query("get_orders", {days: $days}, {rows: []}, 300)
rows = $channel == "All" ? orders.rows : @Filter(orders.rows, "channel", "==", $channel)
weekly = @Bucket(rows, "date", "week", "amount")
daily = @Bucket(rows, "date", "day", "amount")
last7 = @Sum(@Take(daily, -7).value)
prev7 = @Sum(@Slice(daily, -14, -7).value)
change = @Change(last7, prev7)
head = Row([Col([Title("Store performance", "lg"), Caption("Demo data, refreshed every 5 minutes")], 1), Spacer(), Box([Select($channel, [{value: "All", label: "All channels"}, "Web", "Mobile", "Retail"])], null, null, null, null, null, null, 150), SegmentedControl($days, [{value: "30", label: "30d"}, {value: "90", label: "90d"}, {value: "365", label: "1y"}])], 3, null, null, true)
kpis = Grid([k1, k2, k3, k4], 4, 150, 3)
k1 = Card([Caption("Revenue"), Title(@Format(@Sum(rows.amount), "compact", 1, "USD"), "xl")], null, 3, 1)
k2 = Card([Caption("Orders"), Title(@Format(@Count(rows)), "xl")], null, 3, 1)
k3 = Card([Caption("Average order"), Title(@Format(@Avg(rows.amount), "currency"), "xl")], null, 3, 1)
k4 = Card([Caption("Last 7 days"), Row([Title(@Format(last7, "compact", 1, "USD"), "xl"), change == null ? null : Badge((change >= 0 ? "+" : "") + @Format(change, "percent", 1) + " vs prior 7", change >= 0 ? "success" : "danger")], 2, null, null, true)], null, 3, 1)
trend = Card([Row([Title("Revenue", "sm"), Spacer(), SegmentedControl($view, ["Weekly", "Cumulative"])], 2), Chart("area", $view == "Weekly" ? weekly : @Cumulative(weekly, "value"), "key", ["value"], "currency")], null, 4, 2)
mix = Card([Title("Channel mix", "sm"), Chart("donut", @GroupBy(orders.rows, "channel", "amount"), "key", ["value"], "currency")], null, 4, 2)
regions = Card([Title("Revenue by region and category", "sm"), Chart("bar", @Pivot(rows, "region", "category", "amount"), "key", null, "currency", null, true)], null, 4, 2)
top = Card([Title("Top products", "sm"), Table(["Product", "Units", "Revenue"], @Each(@Top(@GroupBy(rows, "product", "amount"), "value", 5), "p", [p.key, @Sum(@Filter(rows, "product", "==", p.key).units), @Format(p.value, "currency", 0)]))], null, 4, 2)`;

const support = `root = Col([head, kpis, Grid([weekly, teams], 2, 300, 4), Grid([spread, csat], 2, 300, 4), queue], 4)
$days = "60"
$team = "All"
tickets = Query("get_tickets", {days: $days}, {rows: []})
rows = $team == "All" ? tickets.rows : @Filter(tickets.rows, "team", "==", $team)
solved = @Filter(rows, "status", "==", "solved")
waiting = @Filter(rows, "status", "!=", "solved")
hours = @Stats(solved.hours)
weeks = @Each(@Bucket(rows, "opened", "week"), "w", {week: @FormatDate(w.key, "short"), Opened: w.value, Solved: @Count(@Between(solved, "opened", w.key, @AddDays(w.key, 6)))})
head = Row([Col([Title("Support desk", "lg"), Caption("Tickets opened in the selected period")], 1), Spacer(), Box([Select($team, [{value: "All", label: "All teams"}, "Billing", "Technical", "Accounts", "Shipping"])], null, null, null, null, null, null, 150), SegmentedControl($days, [{value: "30", label: "30d"}, {value: "60", label: "60d"}, {value: "180", label: "6m"}])], 3, null, null, true)
kpis = Grid([k1, k2, k3, k4], 4, 150, 3)
k1 = Card([Caption("Opened"), Title(@Format(@Count(rows)), "xl")], null, 3, 1)
k2 = Card([Caption("Waiting"), Title(@Format(@Count(waiting)), "xl", @Count(waiting) > 40 ? "danger" : null), Caption(@Count(@Filter(waiting, "priority", "==", "urgent")) + " urgent")], null, 3, 1)
k3 = Card([Caption("Median time to solve"), Title(@Format(hours.median, "number", 1) + " h", "xl"), Caption("Slowest " + @Format(hours.max, "number", 0) + " h")], null, 3, 1)
k4 = Card([Caption("Satisfaction"), Title(@Format(@Avg(@Filter(solved, "csat", ">", 0).csat), "number", 2) + " / 5", "xl")], null, 3, 1)
weekly = Card([Title("Opened and solved by week", "sm"), Chart("bar", weeks, "week", ["Opened", "Solved"])], null, 4, 2)
teams = Card([Title("Average hours to solve, by team", "sm"), Chart("bar", @Sort(@GroupBy(solved, "team", "hours", "avg"), "value", "desc"), "key", ["value"])], null, 4, 2)
spread = Card([Title("How long tickets take (hours)", "sm"), Chart("bar", @Histogram(solved.hours, 12), "key", ["value"])], null, 4, 2)
csat = Card([Title("Satisfaction, 7-day average", "sm"), Chart("line", @MovingAvg(@Bucket(@Filter(solved, "csat", ">", 0), "opened", "day", "csat", "avg"), "value", 7), "key", ["value"])], null, 4, 2)
queue = Card([Title("Waiting longest", "sm"), Table(["Ticket", "Team", "Priority", "Waiting"], @Each(@Top(@Each(waiting, "t", {id: t.id, team: t.team, priority: t.priority, age: @DaysBetween(t.opened, @Now())}), "age", 6), "t", [t.id, t.team, Badge(t.priority, t.priority == "urgent" ? "danger" : t.priority == "high" ? "warning" : "neutral"), @Plural(t.age, "day")]))], null, 4, 2)`;

const bicycle = `root = Col([head, photos, Title("The main parts", "md"), parts, Title("How power reaches the wheel", "md"), flow, explorer, Title("Freewheel or cassette?", "md"), hubs, closing])
$gear = 3
$rpm = 80
head = Col([Title("Inside a 7-speed bike", "xl"), Text("One chainring at the front, seven sprockets at the back and a derailleur that moves the chain between them. Small sprockets make each pedal stroke go further; big ones make hills easier.", "md", "muted")], 2)
photos = Grid([SearchImage("City bicycle", 1.3, "lg"), SearchImage("Derailleur", 1.3, "lg"), SearchImage("Bicycle shifter", 1.3, "lg")], 3, 150, 2)
parts = Table(["Part", "What it does"], [["Frame and fork", "Hold everything together, steer and set the riding position"], ["Crankset and pedals", "Turn leg power into rotation"], ["Chainring", "The single front gear, here 40 teeth"], ["Chain", "Carries the power to the rear wheel"], ["7 rear sprockets", "Seven sizes, so seven gear ratios"], ["Rear derailleur", "Moves the chain from sprocket to sprocket"], ["Shifter and cable", "Pull or release the cable to pick a gear"], ["Brakes, wheels and tires", "Stop, roll and grip the road"]])
flow = Card([Row(@Each(chain, "s", Row([Box([Text(s, "sm", null, "medium")], null, null, 2, "surface", "md"), s == "Rear wheel" ? null : Icon("arrow-right", "sm", "faint")], 1)), 1, "center", "center", true), Caption("The shifter pulls a cable; the derailleur guides the chain onto the sprocket you choose.")], "soft", 3, 2)
chain = ["Pedals", "Chainring", "Chain", "Rear sprocket", "Rear wheel"]
teeth = [28, 24, 21, 18, 16, 14, 12]
tooth = teeth[$gear - 1]
ratio = 40 / tooth
speed = $rpm * ratio * 2.1 * 60 / 1000
mode = $gear <= 2 ? "Easy, for climbing" : $gear <= 5 ? "Moderate, for cruising" : "Hard, for speed"
explorer = Card([exHead, cogs, Slider($gear, 1, 7, 1, "Gear", null, [{value: 1, label: "1 · Easy"}, {value: 4, label: "4"}, {value: 7, label: "7 · Fast"}]), stats, Slider($rpm, 50, 110, 5, "Pedaling cadence", " rpm"), Text(feel, "sm"), Caption("Assumes a 40-tooth chainring, a 12-28 freewheel and a 700c wheel (2.1 m around). Real bikes vary.")], null, 4, 3)
exHead = Row([Col([Label("Explore the seven gears"), Title("Gear " + $gear + " of 7", "xl")], 1), Spacer(), Badge(mode, $gear <= 2 ? "success" : $gear <= 5 ? "info" : "warning")], 3, null, null, true)
cogs = Svg(@Each(@Range(0, 7), "i", G([Circle(26 + i * 45, 52, 6 + teeth[i] * 0.55, i == $gear - 1 ? "info" : "surface", i == $gear - 1 ? "info" : "faint", 2, i == $gear - 1 ? 0.85 : 1), Circle(26 + i * 45, 52, 4, "muted"), SvgText(teeth[i] + "T", 26 + i * 45, 104, 11, i == $gear - 1 ? "info" : "muted", "middle", i == $gear - 1 ? "semibold" : "normal")])), "0 0 320 112")
stats = Grid([s1, s2, s3], 3, 90, 2)
s1 = Card([Caption("Rear sprocket"), Title(tooth + " teeth", "lg")], "soft", 3, 1)
s2 = Card([Caption("Gear ratio"), Title(@Format(ratio, "number", 2) + " : 1", "lg")], "soft", 3, 1)
s3 = Card([Caption("Speed at " + $rpm + " rpm"), Title(@Format(speed, "number", 1) + " km/h", "lg")], "soft", 3, 1)
feel = "Each turn of the pedals turns the rear wheel " + @Format(ratio, "number", 2) + " times. " + ($gear <= 2 ? "Light to push, good for hills and starting from a stop." : $gear <= 5 ? "Balanced effort for flat roads and everyday riding." : "Heavy to push but fast, for descents and tailwinds.")
hubs = Col([SearchImage("Cassette (bicycle)", 2.4, "lg"), Grid([h1, h2], 2, 220, 3)], 3)
h1 = Card([Text("Freewheel", "sm", null, "semibold"), Caption("The ratchet sits inside the sprocket cluster, which screws onto the hub. Common on budget and youth bikes.")], "soft", 3, 1)
h2 = Card([Text("Cassette", "sm", null, "semibold"), Caption("The sprockets slide onto a freehub that holds the ratchet. Better axle support and easy gear swaps.")], "soft", 3, 1)
closing = Text("Seven speeds keep the drivetrain simple, light and cheap to maintain: one shifter, one derailleur and no front gear changes to think about.", "sm", "muted")`;

const bikeRepair = `root = Col([head, meta, setup, tools, Title("Assembly, step by step", "md"), progress, checklist, Title("Visual references", "md"), refs, fit, safety])
$done = []
$brakes = "Rim"
$inseam = 56
head = Col([Title("Assemble a youth bike", "xl"), Text("Most youth bikes arrive about 85% built. You fit the handlebars, front wheel, pedals and saddle, then set up the brakes. Tap each step as you finish it.", "md", "muted")], 2)
meta = Row([Badge("45 to 90 minutes", "info"), Badge("Beginner friendly", "success"), Badge("Adult job, kid helper", "purple")], 2, null, null, true)
setup = Row([Label("Brake type"), SegmentedControl($brakes, ["Rim", "Disc", "Coaster"])], 3, null, null, true)
tools = Card([Label("You will need"), List(["4, 5 and 6 mm Allen keys", "15 mm pedal wrench", "Phillips screwdriver", "Pump with a pressure gauge", "Scissors for the zip ties"])], "soft", 3, 2)
stepList = [{title: "Unbox and check", detail: "Cut the zip ties, remove the packaging and lay the parts out: front wheel, pedals marked L and R, saddle and reflectors."}, {title: "Fit the handlebars", detail: "Seat the stem, line the bars up with the front wheel and tighten the bolts evenly, a little at a time."}, {title: "Install the front wheel", detail: "Seat the axle fully in the fork, then close the quick release or tighten both axle nuts. Spin it: it should run straight."}, {title: "Attach the pedals", detail: "The right pedal threads clockwise, the left anticlockwise. Start both by hand, then snug them with the 15 mm wrench."}, {title: "Set the saddle height", detail: "Insert the seat post at least to its minimum insertion mark, set the height below and tighten the clamp."}, {title: brakeTitle, detail: brakeDetail}, {title: "Inflate the tires", detail: "Pump to the pressure printed on the sidewall and check the bead sits evenly all round."}, {title: "Final safety check", detail: "Check every bolt, fit the reflectors and the bell, and test the brakes at walking pace."}]
brakeTitle = $brakes == "Coaster" ? "Check the coaster brake" : $brakes == "Disc" ? "Center the disc brakes" : "Set up the rim brakes"
brakeDetail = $brakes == "Rim" ? "Hook the cable noodle into the V-brake arms and center the pads on the rim, not the tire. The wheel should lock before the lever reaches the grip." : $brakes == "Disc" ? "Spin the wheel: the rotor should pass through the caliper without rubbing. If it rubs, loosen the caliper bolts, squeeze the brake and retighten." : "Pedal backwards: the rear wheel should lock. Make sure the brake arm is bolted to the frame strap."
progress = Col([Row([Text(@Count($done) + " of " + @Count(stepList) + " steps done", "sm", "muted"), Spacer(), @Count($done) == @Count(stepList) ? Badge("Ready to ride", "success") : Button("Reset", @Reset($done), "ghost", null, "sm", "rotate-ccw")], 2), Box([Box([], null, null, null, "chart2", "full", null, @Percent(@Count($done), @Count(stepList)) + "%", 6)], null, null, null, "border", "full", null, "100%", 6)], 2)
checklist = Col(@Each(@Range(0, @Count(stepList)), "i", Pressable([Row([Icon(@Includes($done, i) ? "check-circle" : "circle", "md", @Includes($done, i) ? "success" : "faint"), Col([Text((i + 1) + ". " + stepList[i].title, "sm", null, "semibold", false, @Includes($done, i)), Caption(stepList[i].detail)], 1)], 3, "start")], @Set($done, @Toggle($done, i)), @Includes($done, i), 3)), 1)
refs = Grid([r1, r2, r3, r4], 2, 160, 3)
r1 = Col([SearchImage("Bicycle wheel quick release", 1.4, "lg"), Caption("Front wheel seated in the fork")], 1)
r2 = Col([SearchImage("Bicycle pedal", 1.4, "lg"), Caption("Pedals: right clockwise, left anticlockwise")], 1)
r3 = Col([SearchImage("V-brake", 1.4, "lg"), Caption("Brake pads meet the rim squarely")], 1)
r4 = Col([SearchImage("Seatpost", 1.4, "lg"), Caption("Never above the minimum insertion mark")], 1)
fit = Card([Title("Saddle height", "sm"), Input($inseam, "Your child's inseam, in cm", "number"), Text($inseam > 0 ? "Start with the top of the saddle about **" + @Round($inseam - 2) + " cm** from the ground so both feet touch flat. Once your child rides confidently, raise it to about **" + @Round($inseam + 3) + " cm**, where only the balls of the feet touch." : "Measure from the floor to the crotch, in socks, with the back against a wall.", "sm")], "soft", 4, 2)
safety = Box([Row([Icon("shield-check", "md", "success"), Text("Before the first ride: the brakes stop the bike, both wheels are tight, the bars do not twist against the front wheel and the helmet fits snugly.", "sm")], 2, "start")], null, null, 3, "success", "lg")`;

const route = `root = Col([head, photos, badges, map, selected, Row([Title("Stop by stop", "md"), Spacer(), SegmentedControl($pace, ["Relaxed", "Balanced", "Packed"])], 3, null, null, true), itinerary, closing])
$stop = "Ferry Building"
$pace = "Balanced"
head = Col([Title("San Francisco in one day", "xl"), Text("A scenic loop from the waterfront to the Golden Gate, with time to eat, walk and take photos. Tap a pin or a stop for details.", "md", "muted")], 2)
photos = Grid([SearchImage("Golden Gate Bridge", 1.4, "lg"), SearchImage("Painted Ladies Alamo Square", 1.4, "lg"), SearchImage("San Francisco cable car", 1.4, "lg")], 3, 140, 2)
badges = Row([Badge(@Plural(@Count(places), "stop"), "info"), Badge("About " + @Format(@Last(ends).mins / 60, "number", 1) + " hours", "neutral"), Badge("Walk, cable car and bus", "purple")], 2, null, null, true)
map = Map(@Each(places, "p", MapMarker(p.name, p.lat, p.lng, p.category)), true, $stop, 340)
factor = $pace == "Relaxed" ? 1.3 : $pace == "Packed" ? 0.75 : 1
plan = @Each(places, "p", {name: p.name, mins: @Round(p.minutes * factor / 5) * 5 + 20})
ends = @Cumulative(plan, "mins")
starts = @Each(@Range(0, @Count(places)), "i", 540 + ends[i].mins - plan[i].mins)
rows = @Each(@Range(0, @Count(places)), "i", {name: places[i].name, desc: places[i].desc, category: places[i].category, stay: @Round(places[i].minutes * factor / 5) * 5, time: (@Floor(starts[i] / 60) > 12 ? @Floor(starts[i] / 60) - 12 : @Floor(starts[i] / 60)) + ":" + @Pad(starts[i] % 60, 2) + (starts[i] >= 720 ? " PM" : " AM")})
sel = @Find(rows, "name", $stop)
selected = sel == null ? null : Card([Row([Icon("map-pin", "md", "info"), Col([Text(sel.name, "md", null, "semibold"), Caption(sel.time + " · " + sel.stay + " min · " + sel.category)], 0), Spacer(), Button("Directions", @OpenUrl("https://www.google.com/maps/search/?api=1&query=" + sel.name + " San Francisco"), "outline", null, "sm", "navigation")], 3, null, null, true), Text(sel.desc, "sm")], "soft", 3, 2)
itinerary = Col(@Each(rows, "r", Pressable([Row([Box([SearchImage(r.name + " San Francisco", 1, "md")], null, null, null, null, "md", null, 64, 64), Col([Row([Text(r.time, "sm", "info", "semibold", false, false, true), Caption(r.stay + " min")], 2), Text(r.name, "sm", null, "semibold"), Caption(r.desc)], 0)], 3)], @Set($stop, r.name), r.name == $stop, 2)), 1)
closing = Col([Text("Times are estimates and include about 20 minutes to get to each next stop. Cable cars run every 10 minutes or so; a Muni day pass covers them and the buses.", "xs", "muted"), Row([Button("Plan a second day", @ToAssistant("Plan a second day in San Francisco that avoids these stops"), "outline", null, "sm", "calendar-plus")])], 2)
places = [{name: "Ferry Building", lat: 37.7955, lng: -122.3937, category: "Food", minutes: 45, desc: "Coffee and pastries in the 1898 market hall on the bay."}, {name: "Coit Tower", lat: 37.8024, lng: -122.4058, category: "Views", minutes: 45, desc: "Climb Telegraph Hill for Depression-era murals and a 360° view."}, {name: "Lombard Street", lat: 37.8021, lng: -122.4187, category: "Landmarks", minutes: 30, desc: "Walk down the crooked block of brick switchbacks and hydrangeas."}, {name: "Fisherman's Wharf", lat: 37.808, lng: -122.4177, category: "Food", minutes: 60, desc: "Sea lions at Pier 39 and clam chowder in a sourdough bowl."}, {name: "Palace of Fine Arts", lat: 37.8029, lng: -122.4484, category: "Landmarks", minutes: 40, desc: "A Roman-style rotunda reflected in a quiet lagoon."}, {name: "Golden Gate Bridge", lat: 37.8077, lng: -122.4752, category: "Views", minutes: 75, desc: "Walk out to the first tower for the classic view back at the city."}, {name: "Golden Gate Park", lat: 37.7694, lng: -122.4862, category: "Parks", minutes: 60, desc: "The Japanese Tea Garden and the Conservatory of Flowers."}, {name: "Alamo Square", lat: 37.7764, lng: -122.4346, category: "Views", minutes: 30, desc: "End with the Painted Ladies and the skyline at sunset."}]`;

const roadtrip = `root = Col([head, photos, badges, map, Title("Day by day", "md"), days, budget, before, ask])
$stop = "Seattle"
$tier = "Mid-range"
$travelers = 2
head = Col([Title("Ten days in the Pacific Northwest", "xl"), Text("Rain forest, wild beaches, the Columbia River Gorge and a volcano, in one loop from Seattle. Tap a day to find it on the map.", "md", "muted")], 2)
photos = Grid([SearchImage("Mount Rainier Paradise", 1.4, "lg"), SearchImage("Hoh Rain Forest", 1.4, "lg"), SearchImage("Cannon Beach Haystack Rock", 1.4, "lg")], 3, 140, 2)
badges = Row([Badge("Best July to September", "info"), Badge("About 1,150 miles", "neutral"), Badge("9 nights", "purple")], 2, null, null, true)
map = Map(@Each(stops, "s", MapMarker(s.name, s.lat, s.lng, s.kind)), true, $stop, 360)
stops = [{name: "Seattle", lat: 47.6062, lng: -122.3321, kind: "City"}, {name: "Port Angeles", lat: 48.1181, lng: -123.4307, kind: "Town"}, {name: "Hoh Rain Forest", lat: 47.8601, lng: -123.9348, kind: "Nature"}, {name: "Ruby Beach", lat: 47.7107, lng: -124.4152, kind: "Nature"}, {name: "Astoria", lat: 46.1879, lng: -123.8313, kind: "Town"}, {name: "Cannon Beach", lat: 45.8918, lng: -123.9615, kind: "Nature"}, {name: "Portland", lat: 45.5152, lng: -122.6784, kind: "City"}, {name: "Multnomah Falls", lat: 45.5762, lng: -122.1158, kind: "Nature"}, {name: "Mount Rainier", lat: 46.786, lng: -121.7353, kind: "Nature"}]
plan = [{day: 1, title: "Seattle", place: "Seattle", drive: "Arrive", night: "Seattle", text: "Pike Place Market, the waterfront and the Space Needle at dusk."}, {day: 2, title: "Ferry to the Olympic Peninsula", place: "Port Angeles", drive: "2.5 h with the ferry", night: "Port Angeles", text: "Take the Edmonds ferry, then drive up to Hurricane Ridge for mountain views."}, {day: 3, title: "Hoh Rain Forest", place: "Hoh Rain Forest", drive: "2 h", night: "Forks", text: "Walk the Hall of Mosses under moss-draped maples; stop at Lake Crescent on the way."}, {day: 4, title: "The wild coast", place: "Ruby Beach", drive: "1 h", night: "Kalaloch", text: "Sea stacks, driftwood and tide pools at Ruby Beach and Rialto Beach."}, {day: 5, title: "South to Astoria", place: "Astoria", drive: "3.5 h", night: "Astoria", text: "Cross the Columbia at its mouth and climb the Astoria Column."}, {day: 6, title: "Cannon Beach", place: "Cannon Beach", drive: "40 min", night: "Cannon Beach", text: "Haystack Rock at low tide, then the trail at Ecola State Park."}, {day: 7, title: "Portland", place: "Portland", drive: "1.5 h", night: "Portland", text: "Food carts, Powell's Books and the Japanese Garden."}, {day: 8, title: "Columbia River Gorge", place: "Multnomah Falls", drive: "1 h each way", night: "Portland", text: "Multnomah Falls and the waterfall corridor; check whether a timed permit is needed."}, {day: 9, title: "Mount Rainier", place: "Mount Rainier", drive: "3.5 h", night: "Ashford", text: "Wildflower meadows and glacier views on the Skyline Trail at Paradise."}, {day: 10, title: "Back to Seattle", place: "Seattle", drive: "2.5 h", night: "", text: "A last morning hike, then return the car in Seattle."}]
days = Col(@Each(plan, "d", Pressable([Row([Box([Title(d.day + "", "md")], null, null, 2, d.place == $stop ? "info" : "surface", "md", null, 44, 44, null, "center", "center"), Col([Text(d.title, "sm", null, "semibold"), Caption(d.night == "" ? d.drive : d.drive + " · overnight in " + d.night), Text(d.text, "sm", "muted")], 0)], 3, "start")], @Set($stop, d.place), d.place == $stop, 2)), 1)
tiers = [{name: "Budget", lodging: 115, car: 45, food: 40}, {name: "Mid-range", lodging: 190, car: 60, food: 65}, {name: "Comfort", lodging: 320, car: 90, food: 110}]
t = @Find(tiers, "name", $tier)
rooms = @Ceil($travelers / 2)
costs = [{item: "Lodging", amount: t.lodging * 9 * rooms}, {item: "Rental car", amount: t.car * 10}, {item: "Gas", amount: @Round(1150 / 27 * 4.6)}, {item: "Food", amount: t.food * 10 * $travelers}, {item: "Park pass", amount: 80}, {item: "Ferries and extras", amount: 250}]
total = @Sum(costs.amount)
budget = Card([Row([Title("Estimated budget", "md"), Spacer(), SegmentedControl($tier, ["Budget", "Mid-range", "Comfort"])], 3, null, null, true), Row([Text("Travelers", "sm"), Spacer(), IconButton("minus", @Set($travelers, @Clamp($travelers - 1, 1, 6)), "Fewer travelers"), Text($travelers + "", "md", null, "semibold", false, false, true), IconButton("plus", @Set($travelers, @Clamp($travelers + 1, 1, 6)), "More travelers")], 2), Grid([k1, k2], 2, 150, 3), Chart("bar", costs, "item", ["amount"], "currency", null, false, 200), Caption("Summer prices for 9 nights, " + @Plural(rooms, "room") + ", one rental car. Treat it as a starting point.")], null, 4, 3)
k1 = Card([Caption("Trip total"), Title(@Format(total, "currency", 0), "xl")], "soft", 3, 1)
k2 = Card([Caption("Per person"), Title(@Format(total / $travelers, "currency", 0), "xl")], "soft", 3, 1)
before = Card([Title("Before you go", "sm"), List(["Book lodges near Olympic and Rainier months ahead for summer.", "Multnomah Falls may need a timed-use permit in peak season.", "Check wildfire closures and air quality the week you leave.", "An America the Beautiful pass covers both national parks."])], "soft", 4, 2)
ask = Row([Button("Swap a day for the San Juan Islands", @ToAssistant("Swap one day of this Pacific Northwest road trip for the San Juan Islands"), "outline", null, "sm", "ship")])`;

const room = `root = Col([head, preview, Title("Tell me about your room", "md"), quiz, Title("Your best matches", "md"), matches, Title("All six colors", "md"), swatches, tip])
$mood = "calm"
$light = "north"
$sofa = "grey"
$pick = "Warm ivory"
head = Col([Title("Find your living room color", "xl"), Text("Answer three questions and the matches update. Tap any color to paint the room.", "md", "muted")], 2)
colors = [{name: "Warm ivory", hex: "#EFE6D3", note: "Soft and bright, never stark", moods: ["calm", "bright"], lights: ["north", "low"], sofas: ["grey", "blue", "green", "brown"]}, {name: "Sage green", hex: "#B5BFA1", note: "Grounded and restful", moods: ["calm", "cozy"], lights: ["south", "east"], sofas: ["grey", "brown", "white"]}, {name: "Greige", hex: "#CFC5B8", note: "A warm neutral that goes with everything", moods: ["calm", "bright"], lights: ["north", "south", "east", "low"], sofas: ["grey", "blue", "green", "brown", "white"]}, {name: "Dusty blue", hex: "#9DB0BF", note: "Airy and cool", moods: ["calm", "bright"], lights: ["south", "east"], sofas: ["white", "brown", "grey"]}, {name: "Terracotta", hex: "#C9785A", note: "Warm and full of character", moods: ["cozy", "bold"], lights: ["north", "low", "east"], sofas: ["white", "green", "blue"]}, {name: "Deep navy", hex: "#2F3E55", note: "Dramatic and enveloping", moods: ["bold", "cozy"], lights: ["south", "east"], sofas: ["white", "brown", "green"]}]
scored = @Each(colors, "c", {name: c.name, hex: c.hex, note: c.note, score: (@Includes(c.moods, $mood) ? 2 : 0) + (@Includes(c.lights, $light) ? 2 : 0) + (@Includes(c.sofas, $sofa) ? 1 : 0)})
best = @Take(@Sort(scored, "score", "desc"), 3)
picked = @Find(colors, "name", $pick)
sofaHex = $sofa == "grey" ? "#8D9197" : $sofa == "blue" ? "#3F5A7A" : $sofa == "green" ? "#4F6B52" : $sofa == "brown" ? "#7A5236" : "#EFEEEA"
tint = $light == "north" ? "#9EC5FF" : $light == "south" ? "#FFC870" : $light == "east" ? "#FFE6B0" : "#000000"
tintOpacity = $light == "north" ? 0.14 : $light == "south" ? 0.16 : $light == "east" ? 0.08 : 0.22
lightNote = $light == "north" ? "North light is cool and flat: warm colors stay warm" : $light == "south" ? "South light is warm: cool colors keep it fresh" : $light == "east" ? "The color shifts from morning to evening" : "Low light deepens every color"
room = Svg([Rect(0, 0, 320, 132, picked.hex), Rect(0, 132, 320, 48, "#B08D6A"), Rect(0, 128, 320, 6, "#E9E4DA"), Rect(28, 24, 70, 76, "#DCE9F5", "#FFFFFF", 5), Line(63, 24, 63, 100, "#FFFFFF", 4), Line(28, 62, 98, 62, "#FFFFFF", 4), Rect(196, 30, 70, 44, "#F4F1EA", "#8A7A66", 3), Circle(214, 52, 9, "#C9785A", null, null, 0.7), Circle(238, 48, 12, "#9DB0BF", null, null, 0.7), Rect(150, 98, 150, 40, sofaHex, null, null, 1, 10), Rect(160, 84, 62, 26, sofaHex, null, null, 1, 8), Rect(228, 84, 62, 26, sofaHex, null, null, 1, 8), Rect(144, 104, 16, 34, sofaHex, null, null, 1, 6), Rect(290, 104, 16, 34, sofaHex, null, null, 1, 6), Rect(0, 0, 320, 180, tint, null, null, tintOpacity)], "0 0 320 180")
preview = Card([room, Row([Box([], null, null, null, picked.hex, "full", true, 18, 18), Text(picked.name, "sm", null, "semibold"), Spacer(), Caption(lightNote)], 2, null, null, true)], null, 3, 2)
quiz = Grid([RadioGroup($mood, [{value: "calm", label: "Calm and restful"}, {value: "cozy", label: "Warm and cozy"}, {value: "bright", label: "Light and airy"}, {value: "bold", label: "A bold statement"}], "How should it feel?"), RadioGroup($light, [{value: "north", label: "North facing, cool light"}, {value: "south", label: "South facing, warm sun"}, {value: "east", label: "East or west, changing"}, {value: "low", label: "Little daylight"}], "What light does it get?"), RadioGroup($sofa, [{value: "grey", label: "Grey"}, {value: "blue", label: "Blue"}, {value: "green", label: "Green"}, {value: "brown", label: "Brown leather"}, {value: "white", label: "White or cream"}], "Your sofa")], 3, 200, 4)
matches = Grid(@Each(best, "c", Pressable([Box([], null, null, null, c.hex, "md", true, "100%", 64), Text(c.name, "sm", null, "semibold"), Caption(c.note), Badge(c.score >= 4 ? "Great match" : c.score >= 2 ? "Good match" : "Worth a look", c.score >= 4 ? "success" : c.score >= 2 ? "info" : "neutral")], @Set($pick, c.name), c.name == $pick, 2)), 3, 150, 3)
swatches = Row(@Each(colors, "c", Pressable([Col([Box([], null, null, null, c.hex, "full", true, 40, 40), Caption(c.name)], 1, "center")], @Set($pick, c.name), c.name == $pick, 2)), 2, null, null, true)
tip = Text("Paint chips look different on the wall. Try a large sample on two walls and look at it in the morning and the evening before you commit.", "sm", "muted")`;

const origami = `root = Col([head, viewer, Title("All six steps", "md"), strip, tip])
$step = 0
head = Col([Title("Fold an origami fox", "xl"), Text("A simple fox face from one square of paper: no cutting, about five minutes. Orange on one side and white on the other works best.", "md", "muted"), Row([Badge("Beginner", "success"), Badge("5 minutes", "info"), Badge("One square sheet", "neutral")], 2, null, null, true)], 2)
steps = [{title: "Start with a diamond", text: "Place the square white side up, with a corner pointing at you."}, {title: "Fold it in half", text: "Fold the top corner down to the bottom corner to make a triangle. Crease well."}, {title: "Corners to the point", text: "Fold the left and right corners down to the bottom point, making a small diamond."}, {title: "Make the ears", text: "Fold each flap's bottom tip back up and out past the top edge. These are the ears."}, {title: "Fold the forehead", text: "Fold the top point down a little to give the fox a flat forehead."}, {title: "Turn over and add a face", text: "Turn the paper over. Draw two eyes and a nose near the bottom point."}]
o = "#F28C38"
w = "#FBE6D2"
e = "#B85E1C"
d0 = Svg([Polygon("100,20 180,100 100,180 20,100", w, e, 2), Line(20, 100, 180, 100, e, 1.5, 0.5), Line(100, 34, 100, 156, e, 2, 0.8), Polygon("93,150 107,150 100,164", e)], "0 0 200 200")
d1 = Svg([Polygon("20,100 180,100 100,180", o, e, 2), Line(100, 100, 100, 180, e, 1.5, 0.5)], "0 0 200 200")
d2 = Svg([Polygon("100,100 60,140 100,180 140,140", w, e, 2), Line(100, 100, 100, 180, e, 1.5)], "0 0 200 200")
d3 = Svg([Polygon("60,140 100,100 140,140 100,180", o, e, 2), Polygon("62,138 98,124 70,58", w, e, 2), Polygon("138,138 102,124 130,58", w, e, 2)], "0 0 200 200")
d4 = Svg([Polygon("60,140 80,118 120,118 140,140 100,180", o, e, 2), Polygon("62,138 98,124 70,58", w, e, 2), Polygon("138,138 102,124 130,58", w, e, 2), Polygon("80,118 120,118 100,136", w, e, 1.5)], "0 0 200 200")
d5 = Svg([Polygon("60,140 80,118 120,118 140,140 100,180", o, e, 2), Polygon("62,138 98,124 70,58", o, e, 2), Polygon("138,138 102,124 130,58", o, e, 2), Polygon("70,124 88,122 74,82", w), Polygon("130,124 112,122 126,82", w), Circle(86, 142, 4.5, "#2B2B2B"), Circle(114, 142, 4.5, "#2B2B2B"), Circle(100, 168, 5, "#2B2B2B")], "0 0 200 200")
drawings = [d0, d1, d2, d3, d4, d5]
viewer = Card([Row([Badge("Step " + ($step + 1) + " of 6", "info"), Spacer(), Caption(@Percent($step + 1, 6) + "% folded")], 2), Box([drawings[$step]], null, null, 3, "surface", "lg", null, "100%", null, null, "center", "center"), Title(steps[$step].title, "md"), Text(steps[$step].text, "sm"), Box([Box([], null, null, null, "chart1", "full", null, @Percent($step + 1, 6) + "%", 4)], null, null, null, "border", "full", null, "100%", 4), Row([Button("Back", @Set($step, @Clamp($step - 1, 0, 5)), "outline", null, null, "arrow-left", $step == 0), Spacer(), $step < 5 ? Button("Next fold", @Set($step, $step + 1), "solid", null, null, "arrow-right") : Button("Start again", @Set($step, 0), "solid", null, null, "rotate-ccw")], 2)], null, 4, 3)
strip = Grid(@Each(@Range(0, 6), "i", Pressable([drawings[i], Caption((i + 1) + ". " + steps[i].title)], @Set($step, i), i == $step, 2)), 6, 96, 2)
tip = Row([Icon("lightbulb", "sm", "warning"), Text("Sharp creases make the difference: run a fingernail along each fold before the next one.", "sm", "muted")], 2)`;

const garden = `root = Col([head, size, Title("Pick what to grow", "md"), picker, sunNote, Title("Your bed, square by square", "md"), bed, Caption("Each square is one foot across; the number is how many plants fit in it."), Title("Planting summary", "md"), summary, Title("What you will need", "md"), needs])
$w = 4
$l = 6
$sun = 7
$chosen = ["Tomatoes", "Lettuce", "Beans", "Radishes", "Basil", "Carrots"]
$got = []
head = Col([Title("Plan a small vegetable garden", "xl"), Text("Set the bed size and how much sun it gets, choose your crops, and the square-foot plan fills itself in.", "md", "muted")], 2)
crops = [{name: "Tomatoes", icon: "🍅", per: 1, weeks: 10, sun: 8, color: "#F6D5CF"}, {name: "Peppers", icon: "🌶️", per: 1, weeks: 11, sun: 8, color: "#F7DCC4"}, {name: "Beans", icon: "🌱", per: 9, weeks: 8, sun: 6, color: "#DCEBD0"}, {name: "Lettuce", icon: "🥬", per: 4, weeks: 6, sun: 4, color: "#E2F0D3"}, {name: "Spinach", icon: "🍃", per: 9, weeks: 6, sun: 4, color: "#D5EAD6"}, {name: "Carrots", icon: "🥕", per: 16, weeks: 10, sun: 6, color: "#FBE2C9"}, {name: "Radishes", icon: "🔴", per: 16, weeks: 4, sun: 4, color: "#F8D9E2"}, {name: "Basil", icon: "🌿", per: 4, weeks: 8, sun: 6, color: "#D8ECCF"}]
picked = @Each($chosen, "n", @Find(crops, "name", n))
cells = @Count(picked) == 0 ? [] : @Each(@Range(0, $w * $l), "i", picked[i % @Count(picked)])
size = Card([Grid([Slider($w, 2, 8, 1, "Bed width", " ft"), Slider($l, 2, 12, 1, "Bed length", " ft"), Slider($sun, 2, 12, 1, "Direct sun", " h")], 3, 200, 5), Row([Badge(@Plural($w * $l, "square foot", "square feet"), "info"), Badge("About " + @Plural(@Ceil($w * $l * 0.83 / 1.5), "bag") + " of soil for 10 inches deep", "neutral")], 2, null, null, true)], "soft", 4, 3)
picker = Row(@Each(crops, "c", Pressable([Row([Text(c.icon, "md"), Text(c.name, "sm", null, "medium")], 1)], @Set($chosen, @Toggle($chosen, c.name)), @Includes($chosen, c.name), 2, null, "full")), 2, null, null, true)
shady = @Filter(picked, "sun", ">", $sun)
sunNote = @Count(shady) > 0 ? Box([Text("With " + @Plural($sun, "hour") + " of sun, " + @Join(shady, ", ", "name") + " will struggle. Leafy greens and radishes cope with 4 hours.", "sm", "warning")], null, null, 3, "warning", "lg") : Box([Text(@Count(picked) == 0 ? "Choose at least one crop to see the plan." : "Everything you picked gets enough sun.", "sm", @Count(picked) == 0 ? "muted" : "success")], null, null, 3, @Count(picked) == 0 ? "surface" : "success", "lg")
bed = Box([Grid(@Each(cells, "c", Box([Text(c.icon, "lg"), Caption(c.per + "")], null, 0, 1, c.color, "sm", null, null, 56, null, "center", "center")), $w, null, 1)], null, null, 2, "#8B6A4E", "lg")
summary = Table(["Crop", "Squares", "Plants", "First harvest", "Sun"], @Each(picked, "p", [p.icon + " " + p.name, @Count(@Filter(cells, "name", "==", p.name)), @Count(@Filter(cells, "name", "==", p.name)) * p.per, p.weeks + " weeks", p.sun + "+ h"]))
items = ["A raised bed or a dug-over plot", "Compost-rich soil", "Seeds or seedlings", "Mulch", "A watering can or drip hose", "Stakes or a trellis"]
needs = Card([Row([Text(@Count($got) + " of " + @Count(items) + " ready", "sm", "muted"), Spacer(), Button("Reset", @Reset($got), "ghost", null, "sm", "rotate-ccw")], 2), Col(@Each(items, "it", Pressable([Row([Icon(@Includes($got, it) ? "check-circle" : "circle", "sm", @Includes($got, it) ? "success" : "faint"), Text(it, "sm", null, null, false, @Includes($got, it))], 2)], @Set($got, @Toggle($got, it)), @Includes($got, it), 2)), 1)], null, 4, 2)`;

const wardrobe = `root = Col([head, photos, setup, Title("The palette", "md"), palette, Title("Packing list", "md"), packing, Title("Outfits, day by day", "md"), outfits, tip])
$days = 7
$weather = "Mild"
$packed = []
head = Col([Title("A capsule wardrobe for a week away", "xl"), Text("A dozen pieces in one palette that all work together. Change the trip and the list and the outfits follow.", "md", "muted")], 2)
photos = Grid([SearchImage("Folded clothes", 1.2, "lg"), SearchImage("Capsule wardrobe", 1.2, "lg"), SearchImage("Suitcase", 1.2, "lg")], 3, 140, 2)
setup = Card([Grid([Slider($days, 3, 14, 1, "Trip length", " days"), Col([Label("Weather"), SegmentedControl($weather, ["Warm", "Mild", "Cool"])], 2)], 2, 220, 5)], "soft", 4)
colors = [{name: "Navy", hex: "#2F3E55"}, {name: "White", hex: "#F7F5F0"}, {name: "Stone", hex: "#CFC5B8"}, {name: "Olive", hex: "#6B7350"}, {name: "Tan", hex: "#B98B5E"}]
palette = Row(@Each(colors, "c", Col([Box([], null, null, null, c.hex, "full", true, 40, 40), Caption(c.name)], 1, "center")), 4, null, null, true)
tops = $weather == "Warm" ? ["White linen shirt", "Navy tee", "Striped tee", "Olive camp shirt"] : $weather == "Cool" ? ["Merino crewneck", "White Oxford shirt", "Navy long-sleeve tee", "Stone knit"] : ["White tee", "Navy Oxford shirt", "Striped long-sleeve tee", "Stone knit polo"]
bottoms = $weather == "Warm" ? ["Stone linen trousers", "Navy shorts"] : $weather == "Cool" ? ["Dark jeans", "Olive chinos"] : ["Dark jeans", "Stone chinos"]
layers = $weather == "Warm" ? ["Light overshirt"] : $weather == "Cool" ? ["Wool coat", "Navy cardigan"] : ["Unstructured navy jacket"]
shoes = $weather == "Cool" ? ["Leather boots", "White sneakers"] : ["White sneakers", "Tan loafers"]
nTops = @Clamp(@Ceil($days / 2) + 1, 3, @Count(tops))
list = @Concat(@Concat(@Each(@Take(tops, nTops), "x", {group: "Top", name: x}), @Each(bottoms, "x", {group: "Bottom", name: x})), @Concat(@Concat(@Each(layers, "x", {group: "Layer", name: x}), @Each(shoes, "x", {group: "Shoes", name: x})), [{group: "Basics", name: "Socks and underwear × " + @Min([$days, 7])}, {group: "Basics", name: "Sleepwear"}, {group: "Basics", name: $weather == "Warm" ? "Swimsuit and sunglasses" : "Compact umbrella"}]))
done = @Count(@Filter(@Each(list, "it", @Includes($packed, it.name)), "", "==", true))
packing = Card([Row([Text(done + " of " + @Count(list) + " packed", "sm", "muted", null, false, false, true), Spacer(), Button("Reset", @Reset($packed), "ghost", null, "sm", "rotate-ccw")], 2), Box([Box([], null, null, null, "ink", "full", null, @Percent(done, @Count(list)) + "%", 4)], null, null, null, "border", "full", null, "100%", 4), Col(@Each(list, "it", Pressable([Row([Icon(@Includes($packed, it.name) ? "check-circle" : "circle", "sm", @Includes($packed, it.name) ? "success" : "faint"), Text(it.name, "sm", null, null, false, @Includes($packed, it.name)), Spacer(), Caption(it.group)], 2)], @Set($packed, @Toggle($packed, it.name)), @Includes($packed, it.name), 2)), 1), $days > 7 ? Caption("Plan one laundry stop around day " + @Ceil($days / 2) + ".") : null], null, 4, 2)
outfits = Card([Col(@Each(@Range(0, $days), "d", Row([Box([Text("Day " + (d + 1), "xs", null, "semibold")], null, null, 1, "surface", "md", null, 56, null, null, "center", "center"), Text(tops[d % nTops] + " with " + bottoms[d % @Count(bottoms)] + ($weather == "Warm" ? "" : ", " + layers[d % @Count(layers)]), "sm"), Spacer(), Caption(shoes[d % @Count(shoes)])], 2)), 2)], null, 3)
tip = Text("Wear the bulkiest shoes and layer on the travel day, and roll rather than fold to fit everything in a carry-on.", "sm", "muted")`;

const drones = `root = Col([head, Title("How the market is structured", "md"), segments, Title("How big is it?", "md"), sizeCard, Title("Who makes money", "md"), players, Title("Try the economics of a drone photo business", "md"), sim, Title("What is changing", "md"), changes, ask])
$projects = 12
$price = 450
$cost = 90
$fixed = 1800
head = Col([Title("The drone photography market", "xl"), Text("Aerial photos and video for property, events, inspection and media: a young market where cheap hardware meets licensed, skilled work.", "md", "muted")], 2)
segs = [{name: "Real estate and architecture", query: "Suburb aerial view", text: "Listing photos and video, the steadiest source of work."}, {name: "Weddings and events", query: "Wedding photography", text: "Seasonal and priced per event, often sold with a ground crew."}, {name: "Inspection and surveying", query: "Solar farm aerial", text: "Roofs, solar farms and building sites; more training, better pay."}, {name: "Media and tourism", query: "Aerial photography coastline", text: "Stock footage, tourism boards and film: visible but competitive."}]
segments = Grid(@Each(segs, "s", Card([SearchImage(s.query, 1.7, "md"), Text(s.name, "sm", null, "semibold"), Caption(s.text)], null, 3, 2)), 2, 220, 3)
market = [{year: "2024", size: 860000000}, {year: "2026", size: 1110000000}, {year: "2028", size: 1520000000}, {year: "2030", size: 2260000000}]
sizeCard = Card([Row([Col([Caption("Drone photography services, worldwide, 2026"), Title(@Format(1110000000, "compact", 1, "USD"), "2xl")], 1), Spacer(), Badge("About 19% a year", "success")], 3, null, null, true), Chart("bar", market, "year", ["size"], "currency", null, false, 200), Caption("Illustrative figures in the range of public market reports; estimates vary widely with the market definition.")], null, 4, 2)
players = Table(["Who", "How they earn", "Margin"], [["Drone makers", "Hardware, cameras and accessories", Badge("Medium", "warning")], ["Freelance pilots", "Per shoot or per project", Badge("High", "success")], ["Agencies", "Bundles of photo, video and editing", Badge("Medium", "warning")], ["Software platforms", "Mapping and processing subscriptions", Badge("High", "success")]])
revenue = $projects * $price
costs = $fixed + $projects * $cost
profit = revenue - costs
margin = revenue > 0 ? profit / revenue * 100 : 0
breakeven = $price > $cost ? @Ceil($fixed / ($price - $cost)) : null
curve = @Each(@Range(0, 41, 5), "n", {projects: n + "", Revenue: n * $price, Costs: $fixed + n * $cost})
sim = Card([Grid([Slider($projects, 0, 40, 1, "Projects per month"), Slider($price, 100, 1500, 25, "Price per project", "$"), Slider($cost, 0, 400, 10, "Cost per project", "$"), Slider($fixed, 0, 6000, 100, "Fixed costs per month", "$")], 2, 240, 5), Grid([k1, k2, k3, k4], 4, 130, 3), Chart("line", curve, "projects", ["Revenue", "Costs"], "currency", null, false, 200), Text(breakevenText, "sm"), Caption("Illustrative. Fixed costs cover insurance, gear, software and marketing; project costs cover editing and travel.")], null, 4, 4)
k1 = Card([Caption("Revenue a month"), Title(@Format(revenue, "currency", 0), "lg")], "soft", 3, 1)
k2 = Card([Caption("Profit a month"), Title(@Format(profit, "currency", 0), "lg", profit >= 0 ? "success" : "danger")], "soft", 3, 1)
k3 = Card([Caption("Margin"), Title(@Format(margin, "percent", 1), "lg")], "soft", 3, 1)
k4 = Card([Caption("Break-even"), Title(breakeven == null ? "Never" : @Plural(breakeven, "project"), "lg")], "soft", 3, 1)
breakevenText = breakeven == null ? "Each project costs more than it earns, so more work only loses more money." : breakeven > 40 ? "You would need " + @Plural(breakeven, "project") + " a month just to cover fixed costs: raise the price or cut costs." : "Fixed costs are covered from project " + breakeven + " each month; every project after that adds " + @Format($price - $cost, "currency", 0) + " of profit."
changes = List(["Cheaper drones with better cameras push basic photo prices down.", "Licensing, such as FAA Part 107 in the US, keeps casual competition out of paid work.", "Inspection, mapping and thermal imaging grow faster than photography alone.", "Clients increasingly want edited video and 3D models, not just photos."])
ask = Row([Button("Compare with drone inspection services", @ToAssistant("Compare the drone photography market with drone inspection services"), "outline", null, "sm", "arrow-right")])`;

// A small space shooter for HtmlView: keyboard and on-screen buttons, waves that speed up.
const arcadeHtml = `<style>
body{padding:12px;display:flex;flex-direction:column;gap:10px;align-items:center;background:#0b0b1a;color:#e6e6ff;font-family:ui-monospace,Menlo,monospace}
.top{display:flex;justify-content:space-between;width:100%;max-width:400px;font-size:13px;letter-spacing:.06em}
canvas{width:100%;max-width:400px;aspect-ratio:4/5;border-radius:10px;background:#05050f;box-shadow:0 0 0 1px #2a2a55,0 0 24px #3b1d6e66;touch-action:none;outline:none}
.pad{display:flex;gap:8px;width:100%;max-width:400px}
.pad button{flex:1;padding:12px 0;font:600 14px ui-monospace,Menlo,monospace;color:#e6e6ff;background:#1a1a3a;border:1px solid #3a3a7a;border-radius:10px;user-select:none;-webkit-user-select:none;touch-action:none;cursor:pointer}
.pad button:active{background:#2c2c66}
#start{background:#ff2bd6;border-color:#ff2bd6;color:#0b0b1a}
p{margin:0;font-size:12px;opacity:.7}
</style>
<div class="top"><span id="score">SCORE 0</span><span id="wave">WAVE 1</span><span id="lives">♥♥♥</span></div>
<canvas id="c" width="400" height="500" tabindex="0"></canvas>
<div class="pad"><button id="left" aria-label="Move left">◀</button><button id="fire">FIRE</button><button id="right" aria-label="Move right">▶</button></div>
<div class="pad"><button id="start">START GAME</button></div>
<p>Arrow keys move, space fires. On a phone, use the buttons.</p>
<script>
const c=document.getElementById('c'),g=c.getContext('2d'),W=400,H=500,S=id=>document.getElementById(id),keys={};
let ship,shots,bombs,aliens,dir,speed,score=0,lives=3,wave=1,running=false,over=false,last=0,cool=0;
const stars=Array.from({length:60},()=>[Math.random()*W,Math.random()*H,Math.random()*1.5+.3]);
const colors=['#ff2bd6','#ffb000','#2bf0ff','#7dff5a'];
function newWave(){aliens=[];for(let r=0;r<4;r++)for(let k=0;k<8;k++)aliens.push({x:40+k*42,y:50+r*34,r});dir=1;speed=20+wave*8}
function reset(){ship={x:W/2};shots=[];bombs=[];score=0;lives=3;wave=1;over=false;newWave();hud()}
function hud(){S('score').textContent='SCORE '+score;S('wave').textContent='WAVE '+wave;S('lives').textContent='♥'.repeat(Math.max(lives,0))||'-'}
function fire(){if(running&&cool<=0&&shots.length<3){shots.push({x:ship.x,y:H-48});cool=.28}}
function step(dt){
const mv=(keys.ArrowLeft||keys.left?-1:0)+(keys.ArrowRight||keys.right?1:0);
ship.x=Math.max(20,Math.min(W-20,ship.x+mv*240*dt));cool-=dt;if(keys[' ']||keys.fire)fire();
shots.forEach(s=>s.y-=420*dt);
let edge=false;aliens.forEach(a=>{a.x+=dir*speed*dt;if(a.x<16||a.x>W-16)edge=true});
if(edge){dir*=-1;aliens.forEach(a=>{a.y+=14;a.x+=dir*2})}
if(aliens.length&&Math.random()<dt*(.8+wave*.3)){const a=aliens[Math.floor(Math.random()*aliens.length)];bombs.push({x:a.x,y:a.y+10})}
bombs.forEach(b=>b.y+=(150+wave*15)*dt);
for(const s of shots)for(const a of aliens)if(!a.dead&&!s.hit&&Math.abs(s.x-a.x)<14&&Math.abs(s.y-a.y)<11){a.dead=s.hit=true;score+=10*(4-a.r)}
aliens=aliens.filter(a=>!a.dead);shots=shots.filter(s=>!s.hit&&s.y>-10);
for(const b of bombs)if(Math.abs(b.x-ship.x)<16&&b.y>H-46&&b.y<H-20){b.hit=true;lives--}
bombs=bombs.filter(b=>!b.hit&&b.y<H);
if(aliens.some(a=>a.y>H-70))lives=0;
if(!aliens.length){wave++;newWave()}
if(lives<=0){running=false;over=true;S('start').textContent='PLAY AGAIN'}
hud()}
function draw(){
g.fillStyle='#05050f';g.fillRect(0,0,W,H);g.fillStyle='#fff';
stars.forEach(s=>{g.globalAlpha=s[2]/2;g.fillRect(s[0],s[1],s[2],s[2])});g.globalAlpha=1;
aliens.forEach(a=>{g.fillStyle=colors[a.r];g.shadowColor=colors[a.r];g.shadowBlur=8;g.fillRect(a.x-12,a.y-7,24,14);g.shadowBlur=0;g.fillStyle='#05050f';g.fillRect(a.x-7,a.y-3,4,4);g.fillRect(a.x+3,a.y-3,4,4)});
g.shadowBlur=10;g.shadowColor='#2bf0ff';g.fillStyle='#2bf0ff';g.beginPath();g.moveTo(ship.x,H-46);g.lineTo(ship.x+16,H-24);g.lineTo(ship.x-16,H-24);g.closePath();g.fill();
g.fillStyle='#fff';shots.forEach(s=>g.fillRect(s.x-1.5,s.y-8,3,10));
g.fillStyle='#ff4d4d';g.shadowColor='#ff4d4d';bombs.forEach(b=>g.fillRect(b.x-2,b.y-6,4,9));g.shadowBlur=0;
if(!running){g.fillStyle='rgba(5,5,15,.75)';g.fillRect(0,H/2-50,W,100);g.textAlign='center';g.fillStyle='#ff2bd6';g.font='bold 28px ui-monospace,Menlo,monospace';g.fillText(over?'GAME OVER':'NEON INVADERS',W/2,H/2-5);g.fillStyle='#e6e6ff';g.font='13px ui-monospace,Menlo,monospace';g.fillText(over?'Score '+score+'. Press play again':'Press start to play',W/2,H/2+22)}}
function loop(t){const dt=Math.min(.05,(t-last)/1000||0);last=t;if(running)step(dt);draw();requestAnimationFrame(loop)}
addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight',' '].includes(e.key)){keys[e.key]=true;e.preventDefault()}});
addEventListener('keyup',e=>{keys[e.key]=false});
for(const id of ['left','right','fire']){const b=S(id);b.addEventListener('pointerdown',e=>{keys[id]=true;b.setPointerCapture(e.pointerId)});b.addEventListener('pointerup',()=>{keys[id]=false});b.addEventListener('pointercancel',()=>{keys[id]=false})}
S('start').onclick=()=>{reset();running=true;S('start').textContent='RESTART';c.focus()};
reset();requestAnimationFrame(loop);
</script>`;

const arcade = `root = Col([Title("Neon Invaders", "lg"), Text("A tiny retro shooter. Clear each wave before the invaders land; every wave is faster than the last.", "sm", "muted"), HtmlView(${JSON.stringify(arcadeHtml)}, null, "Neon Invaders")], 3)`;

export const toolPrograms: ToolProgram[] = [
  {
    id: "recipe",
    example: "recipe",
    title: "Sunday roast",
    prompt: "Plan a Sunday roast for friends, with a shopping list",
    note: "A guest stepper rescales the shopping list (@Each, @Clamp, @Format); tick items and steps with @Toggle; @CopyToClipboard with @Join.",
    code: roast,
  },
  {
    id: "bill",
    example: "bill",
    title: "Split the bill",
    prompt: "Make a bill splitter for dinner with friends",
    note: "Add and remove people and items (@Append, @Remove); who shared what with @Update and @Toggle; tax and tip; @Allocate keeps the cents adding up; copy the split.",
    code: bill,
  },
  {
    id: "monty",
    example: "monty",
    title: "The Monty Hall problem",
    prompt: "Explain the Monty Hall problem with an interactive game",
    note: "Pick a door: @Random inside @Set hides the car and opens a goat door. Switch or stay, and simulate 1,000 games with @Range and @Each.",
    code: monty,
  },
  {
    id: "savings",
    example: "savings",
    title: "Retirement savings",
    prompt: "Help me explore how my retirement savings could grow",
    note: "@Each over @Range builds the yearly balance with @Pow; four sliders drive the chart, the totals and the $1 million milestone.",
    code: savings,
  },
  {
    id: "gdp-explained",
    example: "gdp",
    title: "GDP, explained",
    prompt: "How does GDP work? Let me explore an economy",
    note: "Four sliders; the bar and legend come from one parts list with @Each; negative net exports explain themselves; a knowledge check.",
    code: gdp,
  },
  {
    id: "clt",
    example: "clt",
    title: "Central limit theorem",
    prompt: "Help me understand the central limit theorem intuitively",
    note: "Draw samples with @Random inside @Set; @Histogram and @Stats show the means narrowing like 1/√n for three populations.",
    code: clt,
  },
  {
    id: "bicycle",
    example: "bicycle",
    title: "A 7-speed bike",
    prompt: "Break down the design of a 7-speed bike",
    note: "A gear slider drives an Svg of seven sprockets (@Each over @Range, index access), the ratio and the speed at a cadence.",
    code: bicycle,
  },
  {
    id: "bike-repair",
    example: "bike-repair",
    title: "Assemble a youth bike",
    prompt: "Help me assemble a youth bicycle, step by step",
    note: "Tap steps to tick them (@Toggle on indexes) with a progress bar; the brake type rewrites one step; the inseam sets the saddle height.",
    code: bikeRepair,
  },
  {
    id: "route",
    example: "route",
    title: "San Francisco in a day",
    prompt: "Plan a sightseeing route in San Francisco",
    note: "Map markers from @Each with a street route; the pace rescales the schedule (@Cumulative, @Pad); a pin or a row selects the stop.",
    code: route,
  },
  {
    id: "roadtrip",
    example: "roadtrip",
    title: "Pacific Northwest road trip",
    prompt: "Plan a ten-day road trip through the Pacific Northwest",
    note: "Nine stops on a driving route; tap a day to select its stop; the budget tier and traveler stepper recompute the totals and the chart.",
    code: roadtrip,
  },
  {
    id: "room",
    example: "room",
    title: "Find your paint color",
    prompt: "Help me choose a new paint color for my living room",
    note: "Three answers score six colors (@Includes, @Sort, @Take); the room Svg takes the picked color, the sofa and a light tint over the top.",
    code: room,
  },
  {
    id: "origami",
    example: "origami",
    title: "Fold an origami fox",
    prompt: "Show me how to fold an origami baby fox",
    note: "Six Svg diagrams in a list; Back and Next step through them with @Clamp, and the thumbnails jump to a step.",
    code: origami,
  },
  {
    id: "garden",
    example: "garden",
    title: "Plan a vegetable garden",
    prompt: "Help me plan a small backyard vegetable garden",
    note: "Bed size and sun sliders, crop chips with @Toggle; a square-foot Grid with $w columns, a sun warning, a summary Table and a checklist.",
    code: garden,
  },
  {
    id: "wardrobe",
    example: "wardrobe",
    title: "Capsule wardrobe",
    prompt: "Build me a versatile capsule wardrobe for a week away",
    note: "Trip length and weather rebuild the packing list (@Concat, @Take) and the day-by-day outfits (modulo indexes); a packing checklist.",
    code: wardrobe,
  },
  {
    id: "drones",
    example: "drones",
    title: "The drone photography market",
    prompt: "Help me understand the drone photography market",
    note: "Segments, a market-size Chart and a players Table; four sliders run a business model with profit, margin and break-even.",
    code: drones,
  },
  {
    id: "game",
    example: "game",
    title: "A retro arcade game",
    prompt: "Make a retro arcade game I can play here",
    note: "HtmlView runs a canvas space shooter with keyboard and on-screen controls, in the sandboxed iframe.",
    code: arcade,
  },
  {
    id: "dash-sales",
    example: "dash-sales",
    title: "Sales dashboard",
    prompt: "Build a live sales dashboard for the last 90 days: revenue, orders, average order value, revenue by week and by region, and the top products.",
    note: "Query(get_orders) with channel and period filters; @Bucket, @Cumulative, @Change, @GroupBy, @Pivot and @Top.",
    code: sales,
  },
  {
    id: "dash-support",
    example: "dash-support",
    title: "Support dashboard",
    prompt: "Make a support dashboard: open tickets, median resolution time, tickets by week, the slowest teams and satisfaction.",
    note: "Query(get_tickets); weekly opened vs solved with @Bucket and @Between; @Stats, @Histogram, @MovingAvg; the oldest waiting tickets.",
    code: support,
  },
];
