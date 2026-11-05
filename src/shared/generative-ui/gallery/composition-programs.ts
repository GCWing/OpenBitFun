// Hand-written programs that show composition: small primitives the model
// positions itself (rows of bars from Box, a retention grid from @MixColor,
// photos in a Carousel, cards that flip). Rendered by the dev-only /gallery page.

import type { Program } from "./programs";

const analytics = `root = Col([head, kpis, trend, Grid([sources, pages], 2, 300, 4), Grid([funnel, retention], 2, 300, 4)], 4)
$range = "30d"
$metric = "Visitors"
days = $range == "7d" ? 7 : $range == "30d" ? 30 : 90
traffic = @Each(@Range(0, days), "i", {day: @FormatDate(@AddDays(@Today(), i - days + 1), "short"), Visitors: 1700 + 380 * ((i * 7) % 5) + i * 9 + (((i + 2) % 7) < 2 ? -520 : 0), Pageviews: 4200 + 820 * ((i * 3) % 4) + i * 21 + (((i + 2) % 7) < 2 ? -1300 : 0)})
visitors = @Sum(traffic.Visitors)
views = @Sum(traffic.Pageviews)
head = Row([Col([Title("Web analytics", "xl"), Caption("yoursite.com · sample data")], 1), Spacer(), SegmentedControl($range, [{value: "7d", label: "7 days"}, {value: "30d", label: "30 days"}, {value: "90d", label: "90 days"}])], 3, null, null, true)
kpiRows = [{label: "Visitors", value: @Format(visitors, "compact", 1), change: 12.4, good: true}, {label: "Pageviews", value: @Format(views, "compact", 1), change: 8.1, good: true}, {label: "Session length", value: "3m 12s", change: -4.2, good: true}, {label: "Bounce rate", value: "41%", change: -2.6, good: false}]
kpis = Grid(@Each(kpiRows, "k", Card([Caption(k.label), Title(k.value, "2xl"), Badge((k.change > 0 ? "+" : "") + k.change + "%", (k.change > 0) == k.good ? "success" : "danger")], null, 4, 1)), 4, 150, 3)
trend = Card([Row([Title("Traffic", "sm"), Spacer(), SegmentedControl($metric, ["Visitors", "Pageviews"])], 2), Chart("area", traffic, "day", [$metric], "number", null, false, 220)], null, 5, 3)
shares = [{name: "Google", icon: "search", share: 41}, {name: "Direct", icon: "mouse-pointer-click", share: 24}, {name: "Hacker News", icon: "newspaper", share: 15}, {name: "Twitter / X", icon: "at-sign", share: 11}, {name: "Newsletter", icon: "mail", share: 9}]
sources = Card([Title("Top sources", "sm"), Col(@Each(shares, "s", Col([Row([Icon(s.icon, "sm", "muted"), Text(s.name, "sm"), Spacer(), Text(@Format(visitors * s.share / 100, "compact", 1), "sm", null, "medium", false, false, true)], 2), Box([Box([], null, null, null, "chart1", "full", null, (s.share / 41 * 100) + "%", 6)], null, null, null, "surface", "full", null, "100%", 6)], 1)), 3)], null, 5, 3)
pageRows = [{path: "/", share: 31, time: "0:48"}, {path: "/pricing", share: 18, time: "1:52"}, {path: "/blog/launch-week", share: 14, time: "4:05"}, {path: "/docs/quickstart", share: 11, time: "3:31"}, {path: "/signup", share: 6, time: "1:10"}]
pages = Card([Title("Top pages", "sm"), Table(["Page", "Views", "Avg. time"], @Each(pageRows, "p", [p.path, @Format(views * p.share / 100, "compact", 1), p.time]))], null, 5, 3)
steps = [{step: "Visited site", rate: 100}, {step: "Viewed pricing", rate: 38}, {step: "Started signup", rate: 12.5}, {step: "Activated", rate: 7.4}]
funnel = Card([Title("Signup funnel", "sm"), Col(@Each(steps, "f", Col([Row([Text(f.step, "sm"), Spacer(), Text(@Format(visitors * f.rate / 100, "compact", 1) + " · " + f.rate + "%", "sm", "muted", null, false, false, true)], 2), Box([], null, null, null, "chart3", "sm", null, f.rate + "%", 22)], 1)), 3)], null, 5, 3)
cohorts = [{week: "Sep 7", users: 1840, r: [100, 41, 30, 26, 23]}, {week: "Sep 14", users: 2015, r: [100, 44, 33, 27]}, {week: "Sep 21", users: 1922, r: [100, 39, 29]}, {week: "Sep 28", users: 2210, r: [100, 46]}, {week: "Oct 5", users: 2390, r: [100]}]
retention = Card([Title("Weekly retention", "sm"), Row([Box([Caption("Cohort")], null, null, null, null, null, null, 64), Box([Row(@Each(["W0", "W1", "W2", "W3", "W4"], "w", Box([Caption(w)], null, null, null, null, null, null, null, null, 1, "center")), 1)], null, null, null, null, null, null, null, null, 1)], 2), Col(@Each(cohorts, "c", Row([Box([Text(c.week, "xs", null, "medium"), Caption(@Format(c.users))], null, null, null, null, null, null, 64), Box([Row(@Each(@Range(0, 5), "i", i < @Count(c.r) ? Box([Text(c.r[i] + "%", "xs", null, "medium", false, false, true)], null, null, 1, @MixColor("#EDF5FF", "#0068BC", c.r[i] / 100), "sm", null, null, 32, 1, "center", "center") : Box([], null, null, null, "surface", "sm", null, null, 32, 1)), 1)], null, null, null, null, null, null, null, null, 1)], 2)), 1)], null, 5, 3)`;

const phones = `root = Col([title, intro, Grid([iphone, pixel], 2, 240, 4), Title("Side by side", "md"), specs, Title("Which suits you?", "md"), picker, verdict])
$care = "Camera"
title = Title("iPhone 17 vs Pixel 11", "xl")
intro = Text("Two flagship phones at the same price. The iPhone is the safer all-rounder; the Pixel wins on photos and AI features.")
iphone = Col([Box([SearchImage("iPhone 17", 1, "xl", "contain")], null, null, 4, "surface", "xl"), Row([Title("iPhone 17", "md"), Spacer(), Badge("From $799")], 2), Text([Icon("cpu", "sm"), " A19 · 6.3-inch 120 Hz"], "sm", "muted")], 2)
pixel = Col([Box([SearchImage("Pixel 11", 1, "xl", "contain")], null, null, 4, "surface", "xl"), Row([Title("Pixel 11", "md"), Spacer(), Badge("From $799")], 2), Text([Icon("cpu", "sm"), " Tensor G6 · 6.3-inch 120 Hz"], "sm", "muted")], 2)
rows = [{f: "Main camera", a: "48 MP", b: "50 MP", win: "b"}, {f: "Battery life", a: "Up to 30 h video", b: "Up to 31 h video", win: "b"}, {f: "Updates", a: "About 6 years", b: "7 years", win: "b"}, {f: "Charging", a: "40 W wired · MagSafe", b: "30 W wired · Qi2", win: "a"}, {f: "Ecosystem", a: "iMessage, Watch, Mac", b: "Gemini, Android", win: ""}]
specs = Table(["", "iPhone 17", "Pixel 11"], @Each(rows, "r", [r.f, Text([r.win == "a" ? Icon("check-circle", "sm", "success") : "", " " + r.a], "sm"), Text([r.win == "b" ? Icon("check-circle", "sm", "success") : "", " " + r.b], "sm")]))
picker = RadioGroup($care, [{value: "Camera", label: "Photos", description: "Low light, zoom, editing"}, {value: "Apps", label: "My other devices", description: "Mac, Watch, iMessage"}, {value: "Battery", label: "Battery", description: "A long day of use"}], null, "cards")
pick = $care == "Apps" ? "iPhone 17" : "Pixel 11"
verdict = Card([Row([Box([SearchImage(pick, 1, "lg", "contain")], null, null, 2, "canvas", "lg", null, 64, 64), Col([Caption("Our pick for you"), Title(pick, "lg"), Text($care == "Camera" ? "Its 50 MP sensor and editing tools take the better low-light shots." : $care == "Apps" ? "It works best with the Apple devices you already own." : "A little more screen-on time and slower battery wear.", "sm", "muted")], 1)], 4)], "soft")`;

const spanish = `root = Col([title, intro, cards, Title("Quick quiz", "md"), quiz, Celebration($score == 4)])
$score = 0
$q = 0
$picked = ""
title = Title("8 Spanish words for the kitchen", "xl")
intro = Text([Icon("hand", "sm"), " Tap a card to see the English, then try the quiz."], "md", "muted")
words = [{es: "la cuchara", en: "the spoon", emoji: "🥄"}, {es: "el cuchillo", en: "the knife", emoji: "🔪"}, {es: "el tenedor", en: "the fork", emoji: "🍴"}, {es: "la sartén", en: "the frying pan", emoji: "🍳"}, {es: "la olla", en: "the pot", emoji: "🍲"}, {es: "el horno", en: "the oven", emoji: "🔥"}, {es: "la nevera", en: "the fridge", emoji: "🧊"}, {es: "el vaso", en: "the glass", emoji: "🥛"}]
cards = Carousel(@Each(words, "w", Flashcard([Title(w.emoji, "2xl"), Title(w.es, "lg")], [Title(w.en, "md"), Caption(w.es)])), 180)
questions = [{es: "la sartén", options: ["the pot", "the frying pan", "the oven"], answer: "the frying pan"}, {es: "el tenedor", options: ["the fork", "the knife", "the spoon"], answer: "the fork"}, {es: "la nevera", options: ["the glass", "the oven", "the fridge"], answer: "the fridge"}, {es: "la olla", options: ["the pot", "the spoon", "the fork"], answer: "the pot"}]
current = questions[$q]
quiz = $q < 4 ? Card([Row([Caption("Question " + ($q + 1) + " of 4"), Spacer(), Badge("Score " + $score, "info")], 2), Title("What is " + current.es + "?", "lg"), Row(@Each(current.options, "o", Button(o, Action([@Set($picked, o), @Set($score, o == current.answer ? $score + 1 : $score), @Set($q, $q + 1)]), "outline")), 2, null, null, true), $picked == "" ? null : Caption("Last answer: " + $picked)], null, 5, 3) : Card([Title($score == 4 ? "Perfect, 4 of 4!" : "You got " + $score + " of 4", "lg"), Text($score == 4 ? "¡Muy bien! You know your way around a Spanish kitchen." : "Flip the cards again and have another go."), Button("Try again", Action([@Reset($score, $q, $picked)]), "solid", null, null, "rotate-ccw")], "soft", 5, 3)`;

const primitives = `root = Col([Title("New primitives", "lg"), Text(["Text can mix ", Badge("inline", "purple"), " components, ", Icon("sparkles", "sm"), " icons and ", Math("\\\\sqrt{2}", true), " math."]), Carousel([SearchImage("Golden Gate Bridge", 1.4), SearchImage("Alcatraz Island", 1.4), SearchImage("Painted Ladies", 1.4), SearchImage("Lombard Street", 1.4)], 220), Row([Text("Inflation adjusts nominal GDP"), Popover(Icon("info", "sm", "muted"), [Text("**Real GDP** removes price changes, so it measures output.", "sm"), Link("Read more", "https://www.bea.gov")])], 2), Quote("Simplicity is the ultimate sophistication.", "Leonardo da Vinci"), Math("\\\\bar{x} \\\\sim \\\\mathcal{N}\\\\left(\\\\mu, \\\\frac{\\\\sigma^2}{n}\\\\right)"), Code("const total = items.reduce((sum, i) => sum + i.price, 0)", "javascript"), RadioGroup($size, ["S", "M", "L", "XL"], "Size", "pills"), Chart("scatter", [{car: "Civic", hp: 158, mpg: 36}, {car: "Model 3", hp: 271, mpg: 132}, {car: "F-150", hp: 400, mpg: 20}, {car: "Prius", hp: 194, mpg: 57}, {car: "Mustang", hp: 480, mpg: 19}], "hp", ["mpg"]), Grid([Flashcard("Bonjour", "Hello"), Flashcard("Merci", "Thank you")], 2, 160, 3), YouTube("dQw4w9WgXcQ", "A music video")])
$size = "M"`;

export const compositionPrograms: Program[] = [
  {
    id: "web-analytics",
    title: "Web analytics, PostHog style",
    note: "A date range drives every number. KPI cards with change badges, an area trend with a metric switch, source bars and a funnel from Box widths, a top-pages Table and a retention grid from @MixColor.",
    code: analytics,
  },
  {
    id: "compare-phones",
    title: "Compare two phones",
    note: "Images found by query, a spec Table with component cells, RadioGroup cards that change the pick below.",
    code: phones,
  },
  {
    id: "flashcards",
    title: "Spanish flashcards and a quiz",
    note: "Flashcards in a Carousel, then a quiz that keeps score with @Set and bursts a Celebration on 4 of 4.",
    code: spanish,
  },
  {
    id: "primitives",
    title: "New primitives",
    note: "Text with inline components, Carousel, Popover, Quote, Math, Code, RadioGroup pills, a scatter Chart, Flashcard and YouTube.",
    code: primitives,
  },
];
