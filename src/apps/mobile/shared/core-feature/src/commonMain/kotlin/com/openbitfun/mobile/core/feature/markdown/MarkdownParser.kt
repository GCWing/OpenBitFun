package com.openbitfun.mobile.core.feature.markdown

public data class MarkdownInline public constructor(
    public val id: String,
    public val type: String,
    public val text: String,
    public val url: String,
)

public data class MarkdownListItem public constructor(
    public val id: String,
    public val marker: String,
    public val text: String,
    public val inlines: List<MarkdownInline>,
)

public data class MarkdownBlock public constructor(
    public val id: String,
    public val type: String,
    public val level: Int,
    public val language: String,
    public val text: String,
    public val items: List<MarkdownListItem>,
    public val inlines: List<MarkdownInline>,
)

public class MarkdownParseCache public constructor() {
    private var text: String = ""
    private var blocks: List<MarkdownBlock> = emptyList()
    private var initialized: Boolean = false

    public fun blocksFor(text: String): List<MarkdownBlock> {
        if (initialized && this.text == text) return blocks
        this.text = text
        blocks = MarkdownParser.parse(text)
        initialized = true
        return blocks
    }
}

public object MarkdownParser {
    public fun parse(text: String): List<MarkdownBlock> {
        val lines = text.replace("\r\n", "\n").split('\n')
        val blocks = mutableListOf<MarkdownBlock>()
        var index = 0
        while (index < lines.size) {
            val trimmed = lines[index].trim()
            when {
                trimmed.isEmpty() -> index += 1
                trimmed.startsWith("```") -> index = readCodeBlock(lines, index, blocks)
                isDivider(trimmed) -> {
                    pushBlock(blocks, "divider", 0, "", "", emptyList())
                    index += 1
                }
                isHeading(trimmed) -> {
                    val level = headingLevel(trimmed)
                    pushBlock(blocks, "heading", level, "", trimmed.drop(level).trim(), emptyList())
                    index += 1
                }
                isQuote(trimmed) -> index = readQuoteBlock(lines, index, blocks)
                isListLine(trimmed) -> index = readListBlock(lines, index, blocks)
                isTableStart(lines, index) -> index = readTableBlock(lines, index, blocks)
                else -> index = readParagraphBlock(lines, index, blocks)
            }
        }
        if (blocks.isEmpty()) pushBlock(blocks, "paragraph", 0, "", text, emptyList())
        return blocks
    }

    public fun formatInlineText(value: String): String = plainInlineText(parseInlineText(value))

    private fun plainInlineText(inlines: List<MarkdownInline>): String = inlines.joinToString("") {
        if (it.type == "link" && it.text != it.url) "${it.text} (${it.url})" else it.text
    }

    public fun parseInlineText(value: String): List<MarkdownInline> = parseInlineText(value, "inline")

    public fun parseInlineText(value: String, prefix: String): List<MarkdownInline> {
        val inlines = mutableListOf<MarkdownInline>()
        var index = 0
        while (index < value.length) {
            val next = nextInlineMarker(value, index)
            if (next < 0) {
                pushInline(inlines, prefix, "text", unescapeText(value.substring(index)), "")
                break
            }
            if (next > index) pushInline(inlines, prefix, "text", unescapeText(value.substring(index, next)), "")
            val consumed = readInlineAt(value, next, prefix, inlines)
            if (consumed <= next) {
                pushInline(inlines, prefix, "text", value[next].toString(), "")
                index = next + 1
            } else {
                index = consumed
            }
        }
        return inlines.filter { it.text.isNotEmpty() }
    }

    private fun readCodeBlock(
        lines: List<String>,
        start: Int,
        blocks: MutableList<MarkdownBlock>,
    ): Int {
        val language = lines[start].trim().drop(3).trim()
        val body = mutableListOf<String>()
        var index = start + 1
        while (index < lines.size) {
            if (lines[index].trim().startsWith("```")) {
                index += 1
                break
            }
            body += lines[index]
            index += 1
        }
        pushBlock(blocks, "code", 0, language, body.joinToString("\n"), emptyList())
        return index
    }

    private fun readQuoteBlock(
        lines: List<String>,
        start: Int,
        blocks: MutableList<MarkdownBlock>,
    ): Int {
        val body = mutableListOf<String>()
        var index = start
        while (index < lines.size && isQuote(lines[index].trim())) {
            body += lines[index].trim().drop(1).trim()
            index += 1
        }
        pushBlock(blocks, "quote", 0, "", body.joinToString("\n"), emptyList())
        return index
    }

    private fun readListBlock(
        lines: List<String>,
        start: Int,
        blocks: MutableList<MarkdownBlock>,
    ): Int {
        val items = mutableListOf<MarkdownListItem>()
        var index = start
        while (index < lines.size && isListLine(lines[index].trim())) {
            val raw = lines[index].trim()
            val text = listText(raw)
            val id = "li-" + start + "-" + items.size
            val inlines = parseInlineText(text, id)
            items += MarkdownListItem(id, listMarker(raw), plainInlineText(inlines), inlines)
            index += 1
        }
        pushBlock(blocks, "list", 0, "", "", items)
        return index
    }

    private fun readTableBlock(
        lines: List<String>,
        start: Int,
        blocks: MutableList<MarkdownBlock>,
    ): Int {
        val rows = mutableListOf<String>()
        var index = start
        while (index < lines.size && hasTablePipes(lines[index].trim())) {
            rows += lines[index].trim()
            index += 1
        }
        pushBlock(blocks, "table", 0, "", rows.joinToString("\n"), emptyList())
        return index
    }

    private fun readParagraphBlock(
        lines: List<String>,
        start: Int,
        blocks: MutableList<MarkdownBlock>,
    ): Int {
        val body = mutableListOf<String>()
        var index = start
        while (index < lines.size) {
            val trimmed = lines[index].trim()
            if (trimmed.isEmpty() || trimmed.startsWith("```") || isDivider(trimmed) ||
                isHeading(trimmed) || isQuote(trimmed) || isListLine(trimmed) || isTableStart(lines, index)
            ) {
                break
            }
            body += trimmed
            index += 1
        }
        pushBlock(blocks, "paragraph", 0, "", body.joinToString("\n"), emptyList())
        return index
    }

    private fun pushBlock(
        blocks: MutableList<MarkdownBlock>,
        type: String,
        level: Int,
        language: String,
        text: String,
        items: List<MarkdownListItem>,
    ) {
        val id = "md-" + blocks.size + "-" + type
        val parseInline = shouldParseInline(type)
        val inlines = if (parseInline) parseInlineText(text, id) else emptyList()
        blocks += MarkdownBlock(
            id = id,
            type = type,
            level = level,
            language = language,
            text = if (parseInline) plainInlineText(inlines) else text,
            items = items,
            inlines = inlines,
        )
    }

    private fun readInlineAt(
        value: String,
        start: Int,
        prefix: String,
        inlines: MutableList<MarkdownInline>,
    ): Int {
        if (value[start] == '`') {
            val end = value.indexOf('`', start + 1)
            if (end > start + 1) return pushAndReturn(inlines, prefix, "code", value.substring(start + 1, end), "", end + 1)
        }
        listOf("**", "__").forEach { marker ->
            if (value.startsWith(marker, start)) {
                val end = value.indexOf(marker, start + 2)
                if (end > start + 2) return pushAndReturn(inlines, prefix, "strong", value.substring(start + 2, end), "", end + 2)
            }
        }
        // Chat ranges use a single tilde. Only an unescaped double pair may
        // strike text; longer runs and unfinished streaming markers stay literal.
        if (isStrikeDelimiter(value, start, closing = false)) {
            var end = value.indexOf("~~", start + 2)
            while (end >= 0 && !isStrikeDelimiter(value, end, closing = true)) {
                end = value.indexOf("~~", end + 2)
            }
            if (end > start + 2) {
                return pushAndReturn(inlines, prefix, "delete", unescapeText(value.substring(start + 2, end)), "", end + 2)
            }
        }
        if (value[start] == '[') {
            val labelEnd = value.indexOf(']', start + 1)
            if (labelEnd > start + 1 && labelEnd + 1 < value.length && value[labelEnd + 1] == '(') {
                val urlEnd = value.indexOf(')', labelEnd + 2)
                if (urlEnd > labelEnd + 2) {
                    return pushAndReturn(
                        inlines,
                        prefix,
                        "link",
                        value.substring(start + 1, labelEnd),
                        value.substring(labelEnd + 2, urlEnd),
                        urlEnd + 1,
                    )
                }
            }
        }
        listOf('*', '_').forEach { marker ->
            if (value[start] == marker) {
                val end = value.indexOf(marker, start + 1)
                if (end > start + 1) return pushAndReturn(inlines, prefix, "emphasis", value.substring(start + 1, end), "", end + 1)
            }
        }
        return start
    }

    private fun pushAndReturn(
        inlines: MutableList<MarkdownInline>,
        prefix: String,
        type: String,
        text: String,
        url: String,
        next: Int,
    ): Int {
        pushInline(inlines, prefix, type, text, url)
        return next
    }

    private fun nextInlineMarker(value: String, start: Int): Int =
        listOf("`", "**", "__", "~~", "[", "*", "_")
            .map { marker ->
                var index = value.indexOf(marker, start)
                while (index >= 0 && isEscaped(value, index)) index = value.indexOf(marker, index + marker.length)
                index
            }
            .filter { it >= 0 }
            .minOrNull() ?: -1

    private fun isStrikeDelimiter(value: String, index: Int, closing: Boolean): Boolean {
        if (!value.startsWith("~~", index) || value.getOrNull(index - 1) == '~' ||
            value.getOrNull(index + 2) == '~' || isEscaped(value, index)
        ) return false
        val before = value.getOrNull(index - 1)
        val after = value.getOrNull(index + 2)
        val beforeSpace = before == null || before.isWhitespace()
        val afterSpace = after == null || after.isWhitespace()
        val beforePunctuation = before != null && PUNCTUATION.matches(before.toString())
        val afterPunctuation = after != null && PUNCTUATION.matches(after.toString())
        return if (closing) !beforeSpace && (!beforePunctuation || afterSpace || afterPunctuation)
        else !afterSpace && (!afterPunctuation || beforeSpace || beforePunctuation)
    }

    private fun isEscaped(value: String, index: Int): Boolean {
        var cursor = index - 1
        while (cursor >= 0 && value[cursor] == '\\') cursor -= 1
        return (index - cursor - 1) % 2 == 1
    }

    private fun unescapeText(value: String): String = buildString {
        var index = 0
        while (index < value.length) {
            if (value[index] == '\\' && index + 1 < value.length && value[index + 1] in ESCAPABLE) index += 1
            append(value[index])
            index += 1
        }
    }

    private const val ESCAPABLE = "\\`*{}[]()#+-.!_>~|"
    private val PUNCTUATION = Regex("[\\p{P}\\p{S}]")

    private fun pushInline(
        inlines: MutableList<MarkdownInline>,
        prefix: String,
        type: String,
        text: String,
        url: String,
    ) {
        inlines += MarkdownInline(prefix + "-inline-" + inlines.size, type, text, url)
    }

    private fun shouldParseInline(type: String): Boolean =
        type == "paragraph" || type == "heading" || type == "quote"

    private fun isHeading(line: String): Boolean = Regex("^#{1,4}\\s+").containsMatchIn(line)

    private fun headingLevel(line: String): Int = line.takeWhile { it == '#' }.length.coerceIn(1, 4)

    private fun isDivider(line: String): Boolean = Regex("^(-{3,}|\\*{3,}|_{3,})$").matches(line)

    private fun isQuote(line: String): Boolean = line.startsWith('>')

    private fun isListLine(line: String): Boolean =
        Regex("^[-*+]\\s+").containsMatchIn(line) || Regex("^\\d+\\.\\s+").containsMatchIn(line)

    private fun listMarker(line: String): String =
        Regex("^(\\d+)\\.\\s+").find(line)?.groupValues?.get(1)?.plus('.') ?: "•"

    private fun listText(line: String): String = line
        .replace(Regex("^[-*+]\\s+"), "")
        .replace(Regex("^\\d+\\.\\s+"), "")

    private fun isTableStart(lines: List<String>, index: Int): Boolean {
        if (index + 1 >= lines.size) return false
        val current = lines[index].trim()
        val next = lines[index + 1].trim()
        return hasTablePipes(current) && TABLE_DIVIDER.matches(next)
    }

    private fun hasTablePipes(line: String): Boolean {
        val first = line.indexOf('|')
        return first >= 0 && line.lastIndexOf('|') > first
    }

    private val TABLE_DIVIDER = Regex("^\\|?\\s*:?-{3,}:?\\s*(\\|\\s*:?-{3,}:?\\s*)+\\|?$")
}
