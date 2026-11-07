package com.openbitfun.mobile.core.feature.markdown

import kotlin.test.Test
import kotlin.test.assertEquals

class MarkdownParserTest {
    @Test
    fun chatTildesPreserveRangesEscapesAndCode() {
        val cases = listOf(
            Triple("24~30°C, rain 1~2mm; ~5 min; ~plain~", "24~30°C, rain 1~2mm; ~5 min; ~plain~", emptyList()),
            Triple("~~removed~~", "removed", listOf("removed")),
            Triple("\\~escaped\\~; \\~~literal\\~~", "~escaped~; ~~literal~~", emptyList()),
            Triple("`~~code~~`", "~~code~~", emptyList()),
            Triple("before ~~~literal~~~ after", "before ~~~literal~~~ after", emptyList()),
            Triple("~~ a~~; ~~b ~~; ~~unfinished", "~~ a~~; ~~b ~~; ~~unfinished", emptyList()),
            Triple("~~a\\~~b~~", "a~~b", listOf("a~~b")),
        )
        cases.forEach { (source, text, deleted) ->
            val inlines = MarkdownParser.parseInlineText(source)
            assertEquals(text, inlines.joinToString("") { it.text }, source)
            assertEquals(deleted, inlines.filter { it.type == "delete" }.map { it.text }, source)
            assertEquals(text, MarkdownParser.formatInlineText(source), source)
        }
    }

    @Test
    fun streamingTildesRemainLiteralUntilTheDoublePairCloses() {
        val cache = MarkdownParseCache()
        val prefix = "24~30°C, rain 1~2mm; "
        listOf("~", "~~", "~~removed", "~~removed~").forEach { suffix ->
            val block = cache.blocksFor(prefix + suffix).single()
            assertEquals(prefix + suffix, block.inlines.joinToString("") { it.text })
            assertEquals(emptyList(), block.inlines.filter { it.type == "delete" })
        }
        val complete = cache.blocksFor(prefix + "~~removed~~").single()
        assertEquals(prefix + "removed", complete.inlines.joinToString("") { it.text })
        assertEquals(listOf("removed"), complete.inlines.filter { it.type == "delete" }.map { it.text })
    }

    @Test
    fun parsesCommonMarkdownBlocksIntoStableBlockTypes() {
        val blocks = MarkdownParser.parse(
            "# Title\n\n- first\n- **second**\n\n> quote\n\n```ts\nconst value = 1;\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |",
        )

        assertEquals(5, blocks.size)
        assertEquals("heading", blocks[0].type)
        assertEquals(1, blocks[0].level)
        assertEquals("list", blocks[1].type)
        assertEquals(2, blocks[1].items.size)
        assertEquals("second", blocks[1].items[1].text)
        assertEquals("quote", blocks[2].type)
        assertEquals("code", blocks[3].type)
        assertEquals("ts", blocks[3].language)
        assertEquals("table", blocks[4].type)
    }

    @Test
    fun formatsInlineCodeEmphasisAndLinksWithoutControlText() {
        val blocks = MarkdownParser.parse(
            "Use `pnpm test`, **bold text**, and [docs](https://example.test).",
        )

        assertEquals(1, blocks.size)
        assertEquals("paragraph", blocks[0].type)
        assertEquals("Use pnpm test, bold text, and docs (https://example.test).", blocks[0].text)
        assertEquals(7, blocks[0].inlines.size)
        assertEquals("code", blocks[0].inlines[1].type)
        assertEquals("strong", blocks[0].inlines[3].type)
        assertEquals("link", blocks[0].inlines[5].type)
        assertEquals("https://example.test", blocks[0].inlines[5].url)
    }
}
