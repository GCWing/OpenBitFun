import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  diffResolvedTokens,
  mergeTokenDocuments,
  resolveTokens,
} from "@openbitfun/token-engine";
import {
  tokenCatalog,
  tokenModes,
  tokens,
} from "../dist/index.js";
import { createTypographySizeScale } from "../dist/typography-runtime.mjs";

const packageDirectory = fileURLToPath(new URL("../", import.meta.url));

async function readSource(fileName) {
  return JSON.parse(
    await readFile(path.join(packageDirectory, "src", fileName), "utf8"),
  );
}

test("system tokens remain color and brand independent", async () => {
  const systemTokens = resolveTokens(await readSource("system.tokens.json"));
  assert.equal(
    Object.keys(systemTokens).some((name) => name.startsWith("color.")),
    false,
  );
});

test("search height preserves the compact reference and follows other density scales", () => {
  const value = (name, mode) => tokenCatalog.find(token => token.name === name).values[mode];
  for (const mode of tokenModes) {
    for (const size of ["sm", "md", "lg"]) {
      const height = value(`control.searchField.height.${size}`, mode);
      assert.equal(height, mode === "compact" && size === "sm" ? "30px" : value(`control.height.${size}`, mode));
      assert.ok(parseFloat(height) > parseFloat(value("control.iconButton.xsSize", mode)));
    }
  }
  assert.equal(value("control.height.sm", "compact"), "28px");
  assert.equal(value("control.iconButton.xsSize", "compact"), "22px");
  assert.equal(value("space.component.inline", "compact"), "10px");
});

test("Empty media geometry owns semantic artwork sizes", () => {
  assert.equal(tokens["layout.empty.gap"], "10px");
  assert.equal(tokens["layout.empty.paddingBlock"], "32px");
  assert.equal(tokens["layout.empty.paddingInline"], "16px");
  assert.equal(tokens["layout.empty.mediaSizeSm"], "24px");
  assert.equal(tokens["layout.empty.mediaSizeMd"], "32px");
  assert.equal(tokens["layout.empty.mediaSizeLg"], "40px");
  assert.equal(tokens["layout.empty.iconSizeSm"], "24px");
  assert.equal(tokens["layout.empty.iconSizeMd"], "32px");
  assert.equal(tokens["layout.empty.iconSizeLg"], "40px");
});

test("Switch geometry preserves the compact reference contract", () => {
  assert.equal(tokens["control.switch.trackWidth"], "28px");
  assert.equal(tokens["control.switch.trackHeight"], "16px");
  assert.equal(tokens["control.switch.thumbSize"], "12px");
  assert.equal(tokens["control.switch.thumbInset"], "2px");
  assert.equal(tokens["control.switch.thumbTravel"], "12px");
  assert.equal(tokens["control.switch.thumbTravelReverse"], "-12px");
});

test("Icon geometry exposes every catalog size without product semantics", () => {
  assert.equal(tokens["control.icon.size2xs"], "8px");
  assert.equal(tokens["control.icon.sizeXs"], "12px");
  assert.equal(tokens["control.icon.sizeSm"], "14px");
  assert.equal(tokens["control.icon.sizeMd"], "16px");
  assert.equal(tokens["control.icon.sizeLg"], "24px");
});

test("TabGroup geometry preserves the capsule selected and outline contract", async () => {
  const systemDocument = await readSource("system.tokens.json");

  assert.equal(tokens["control.tabGroup.gap"], "8px");
  assert.equal(tokens["control.tabGroup.itemGap"], "6px");
  assert.equal(tokens["control.tabGroup.itemHeight"], "40px");
  assert.equal(tokens["control.tabGroup.itemHeightSm"], "30px");
  assert.equal(tokens["control.tabGroup.itemIconSize"], "16px");
  assert.equal(tokens["control.tabGroup.itemPaddingInline"], "16px");
  assert.equal(tokens["control.tabGroup.itemPaddingBlockSm"], "7px");
  assert.equal(tokens["control.tabGroup.itemPaddingInlineSm"], "12px");
  assert.equal(tokens["control.tabGroup.itemActionSize"], "20px");
  assert.equal(tokens["control.tabGroup.itemActionInset"], "8px");
  assert.equal(systemDocument.control.tabGroup.itemRadius.$value, "{radius.pill}");
  assert.equal(tokens["control.tabGroup.itemRadius"], "9999px");
});

test("SegmentedControl geometry preserves compact, filled, and filter compositions", async () => {
  const systemDocument = await readSource("system.tokens.json");

  assert.equal(tokens["control.segmentedControl.gap"], "4px");
  assert.equal(tokens["control.segmentedControl.padding"], "2px");
  assert.equal(tokens["control.segmentedControl.paddingMd"], "3px");
  assert.equal(tokens["control.segmentedControl.segmentHeight"], "24px");
  assert.equal(tokens["control.segmentedControl.segmentHeightMd"], "30px");
  assert.equal(tokens["control.segmentedControl.pillSegmentHeight"], "24px");
  assert.equal(tokens["control.segmentedControl.segmentPaddingInline"], "8px");
  assert.equal(tokens["control.segmentedControl.segmentGap"], "4px");
  assert.equal(tokens["control.segmentedControl.iconSize"], "12px");
  assert.equal(tokens["control.segmentedControl.iconSizeMd"], "14px");
  assert.equal(systemDocument.control.segmentedControl.radius.$value, "{radius.pill}");
  assert.equal(systemDocument.control.segmentedControl.segmentRadius.$value, "{radius.pill}");
  assert.equal(systemDocument.control.segmentedControl.pillSegmentRadius.$value, "{radius.sm}");
});

test("Composer geometry preserves independent context, editor, and action regions", async () => {
  const systemDocument = await readSource("system.tokens.json");

  assert.equal(tokens["control.composer.minBlockSize"], "120px");
  assert.equal(tokens["control.composer.contextOffset"], "32px");
  assert.equal(tokens["control.composer.contextPaddingBlock"], "6px");
  assert.equal(tokens["control.composer.dividerBlockSize"], "16px");
  assert.equal(systemDocument.control.composer.surfacePadding.$value, "{space.2}");
  assert.equal(systemDocument.control.composer.surfaceGap.$value, "{space.3}");
  assert.equal(systemDocument.control.composer.surfaceRadius.$value, "{radius.xl}");
  assert.equal(systemDocument.control.composer.editorPadding.$value, "{space.1}");
});

test("Activity geometry preserves inline and surfaced status compositions", async () => {
  const systemDocument = await readSource("system.tokens.json");

  assert.equal(tokens["control.activityItem.inlineIconSize"], "12px");
  assert.equal(tokens["control.activityItem.surfaceHeight"], "40px");
  assert.equal(tokens["control.activityItem.surfaceIconSize"], "14px");
  assert.equal(tokens["control.activityItem.dividerBlockSize"], "16px");
  assert.equal(tokens["control.changeCount.paddingBlock"], "2px");
  assert.equal(tokens["control.iconButton.xsSize"], "22px");
  assert.equal(tokens["control.iconButton.xsIconSize"], "14px");
  assert.equal(systemDocument.control.activityItem.surfaceRadius.$value, "{radius.lg}");
  assert.equal(systemDocument.control.changeCount.radius.$value, "{radius.xs}");
});

test("StatusPill geometry preserves compact semantic status anatomy", async () => {
  const systemDocument = await readSource("system.tokens.json");

  assert.equal(tokens["control.statusPill.gap"], "2px");
  assert.equal(tokens["control.statusPill.paddingBlock"], "2px");
  assert.equal(tokens["control.statusPill.paddingInline"], "6px");
  assert.equal(tokens["control.statusPill.iconSize"], "14px");
  assert.equal(systemDocument.control.statusPill.radius.$value, "{radius.pill}");
});

test("Select geometry preserves independent content and indicator regions", async () => {
  const systemDocument = await readSource("system.tokens.json");

  assert.equal(tokens["control.select.paddingInline"], "12px");
  assert.equal(tokens["control.select.leadingInset"], "12px");
  assert.equal(tokens["control.select.trailingInset"], "12px");
  assert.equal(tokens["control.select.contentGap"], "8px");
  assert.equal(tokens["control.select.indicatorSize"], "14px");
  assert.equal(systemDocument.control.select.radius.$value, "{radius.base}");
});

test("ActionCard geometry preserves compact and descriptive entry compositions", async () => {
  const systemDocument = await readSource("system.tokens.json");

  assert.equal(tokens["control.actionCard.smMinBlockSize"], "54px");
  assert.equal(tokens["control.actionCard.mdMinBlockSize"], "62px");
  assert.equal(tokens["control.actionCard.paddingInline"], "12px");
  assert.equal(tokens["control.actionCard.leadingSize"], "30px");
  assert.equal(tokens["control.actionCard.iconSize"], "16px");
  assert.equal(systemDocument.control.actionCard.radius.$value, "{radius.base}");
});

test("LauncherButton geometry preserves the shell-edge action contract", async () => {
  const systemDocument = await readSource("system.tokens.json");

  assert.equal(tokens["control.launcherButton.minInlineSize"], "72px");
  assert.equal(tokens["control.launcherButton.blockSize"], "40px");
  assert.equal(tokens["control.launcherButton.paddingInline"], "10px");
  assert.equal(tokens["control.launcherButton.gap"], "4px");
  assert.equal(tokens["control.launcherButton.iconSize"], "12px");
  assert.equal(
    systemDocument.control.launcherButton.radius.$value,
    "{radius.lg}",
  );
});

test("AskUser geometry preserves the answered question reference contract", () => {
  assert.equal(tokens["control.askUser.bodyGap"], "12px");
  assert.equal(tokens["control.askUser.bodyPadding"], "16px");
  assert.equal(tokens["control.askUser.descriptionMaxWidth"], "500px");
  assert.equal(tokens["control.askUser.headerHeight"], "30px");
  assert.equal(tokens["control.askUser.iconSize"], "14px");
  assert.equal(tokens["control.askUser.optionContentGap"], "8px");
  assert.equal(tokens["control.askUser.optionGap"], "4px");
  assert.equal(tokens["control.askUser.optionPaddingBlock"], "7px");
  assert.equal(tokens["control.askUser.optionPaddingInline"], "8px");
  assert.equal(tokens["control.askUser.questionOptionsGap"], "12px");
  assert.equal(tokens["control.askUser.questionPaddingInline"], "4px");
  assert.equal(tokens["control.askUser.summaryActionSize"], "22px");
  assert.equal(tokens["control.askUser.summaryPaddingBlock"], "4px");
  assert.equal(tokens["control.askUser.summaryPaddingInlineEnd"], "4px");
  assert.equal(tokens["control.askUser.summaryPaddingInlineStart"], "8px");
});

test("ChatComposer geometry preserves the scaled compact capsule contract", () => {
  assert.equal(tokens["control.chatComposer.compactGap"], "12px");
  assert.equal(tokens["control.chatComposer.compactHeight"], "42px");
  assert.equal(tokens["control.chatComposer.compactPaddingBlock"], "8px");
  assert.equal(tokens["control.chatComposer.compactPaddingInline"], "8px");
  assert.equal(tokens["control.chatComposer.compactTrackHeight"], "24px");
  assert.equal(tokens["control.chatComposer.controlHeight"], "24px");
});

test("FlowChat rhythm keeps compact rows line-like and Turn boundaries distinct", async () => {
  const systemDocument = await readSource("system.tokens.json");

  assert.equal(tokens["control.toolCard.ambientRowMinBlockSize"], "22px");
  assert.equal(systemDocument.control.flowChat.turnGap.$value, "{space.4}");
  assert.equal(tokens["control.flowChat.turnGap"], "16px");
});

test("split-view content panels preserve the elevated shell curvature contract", async () => {
  const systemDocument = await readSource("system.tokens.json");

  assert.equal(
    systemDocument.layout.splitView.contentPanelRadius.$value,
    "{radius.3xl}",
  );
  assert.equal(tokens["radius.3xl"], "24px");
  assert.equal(tokens["layout.splitView.contentPanelRadius"], "24px");
});

test("shared scrollbar geometry preserves the compact native scrollbar contract", async () => {
  const systemDocument = await readSource("system.tokens.json");

  assert.equal(tokens["scrollbar.width"], "6px");
  assert.equal(systemDocument.scrollbar.radius.$value, "{radius.pill}");
  assert.equal(tokens["scrollbar.radius"], "9999px");
});

test("Menu tokens preserve the compact grouped surface contract", async () => {
  const systemDocument = await readSource("system.tokens.json");

  assert.equal(tokens["overlay.menu.inlineSize"], "220px");
  assert.equal(tokens["overlay.menu.maxBlockSize"], "480px");
  assert.equal(tokens["overlay.menu.headingHeight"], "24px");
  assert.equal(tokens["overlay.menu.itemHeight"], "30px");
  for (const mode of tokenModes) {
    assert.equal(tokenCatalog.find(token => token.name === "overlay.menu.rowGap").values[mode], "2px");
  }
  assert.notEqual(tokens["overlay.menu.rowGap"], tokens["overlay.menu.itemGap"]);
  assert.notEqual(tokens["overlay.menu.rowGap"], tokens["overlay.menu.sectionGap"]);
  assert.equal(tokens["overlay.menu.itemIconSize"], "14px");
  assert.equal(systemDocument.overlay.menu.surfacePadding.$value, "{space.2}");
  assert.equal(systemDocument.overlay.menu.surfaceRadius.$value, "{radius.xl}");
  assert.equal(systemDocument.overlay.menu.itemRadius.$value, "{radius.base}");
});

test("NavigationPanel tokens preserve the grouped sidebar composition contract", async () => {
  const systemDocument = await readSource("system.tokens.json");

  assert.equal(tokens["layout.navigationPanel.inlineSize"], "216px");
  assert.equal(tokens["layout.navigationPanel.headingHeight"], "24px");
  assert.equal(tokens["layout.navigationPanel.itemHeight"], "30px");
  assert.equal(tokens["layout.navigationPanel.itemIconSize"], "14px");
  assert.equal(tokens["layout.navigationPanel.footerHeight"], "40px");
  assert.equal(systemDocument.layout.navigationPanel.surfacePadding.$value, "{space.2}");
  assert.equal(systemDocument.layout.navigationPanel.itemRadius.$value, "{radius.base}");
});

test("Disclosure tokens preserve the compact reference row and nested content rhythm", async () => {
  const systemDocument = await readSource("system.tokens.json");

  assert.equal(tokens["layout.disclosure.triggerMinBlockSize"], "30px");
  assert.equal(tokens["layout.disclosure.triggerPaddingBlock"], "4px");
  assert.equal(tokens["layout.disclosure.triggerPaddingInline"], "8px");
  assert.equal(tokens["layout.disclosure.triggerGap"], "8px");
  assert.equal(tokens["layout.disclosure.indicatorSize"], "14px");
  assert.equal(tokens["layout.disclosure.contentPaddingBlock"], "12px");
  assert.equal(tokens["layout.disclosure.contentPaddingInline"], "32px");
  assert.equal(systemDocument.layout.disclosure.triggerRadius.$value, "{radius.base}");
});

test("Card tokens preserve raised, compact, and media surface compositions", async () => {
  const systemDocument = await readSource("system.tokens.json");

  assert.equal(tokens["layout.card.paddingSm"], "12px");
  assert.equal(tokens["layout.card.paddingMd"], "20px");
  assert.equal(tokens["layout.card.gapLg"], "30px");
  assert.equal(tokens["layout.card.radiusSm"], "8px");
  assert.equal(tokens["layout.card.radiusMd"], "12px");
  assert.equal(tokens["layout.card.radiusLg"], "28px");
  assert.equal(tokens["layout.card.mediaMinBlockSize"], "120px");
  assert.equal(systemDocument.layout.card.paddingSm.$value, "{space.3}");
  assert.equal(systemDocument.layout.card.radiusMd.$value, "{radius.lg}");
});

test("Field tokens preserve independent label, description, and control regions", async () => {
  const systemDocument = await readSource("system.tokens.json");

  assert.equal(tokens["layout.field.rootGap"], "8px");
  assert.equal(tokens["layout.field.horizontalGap"], "20px");
  assert.equal(tokens["layout.field.horizontalGapWide"], "40px");
  assert.equal(tokens["layout.field.labelWidthSm"], "150px");
  assert.equal(tokens["layout.field.labelWidthMd"], "200px");
  assert.equal(tokens["layout.field.labelWidthLg"], "400px");
  assert.equal(tokens["layout.field.contentGap"], "4px");
  assert.equal(tokens["layout.field.labelGap"], "2px");
  assert.equal(tokens["layout.field.labelActionGap"], "8px");
  assert.equal(tokens["layout.field.controlGap"], "8px");
  assert.equal(systemDocument.layout.field.rootGap.$value, "{space.2}");
  assert.equal(systemDocument.layout.field.labelActionGap.$value, "{space.2}");
});

test("Form grouping tokens preserve section, surface, and row composition", async () => {
  const systemDocument = await readSource("system.tokens.json");

  assert.equal(tokens["layout.formSection.gap"], "16px");
  assert.equal(tokens["layout.formSection.headerGap"], "20px");
  assert.equal(tokens["layout.formSection.titleDescriptionGap"], "4px");
  assert.equal(tokens["layout.fieldGroup.radius"], "12px");
  assert.equal(tokens["layout.fieldGroup.rowPaddingBlock"], "16px");
  assert.equal(tokens["layout.fieldGroup.rowPaddingInline"], "20px");
  assert.equal(systemDocument.layout.formSection.gap.$value, "{space.4}");
  assert.equal(systemDocument.layout.fieldGroup.radius.$value, "{radius.lg}");
});

test("ConfirmDialog tokens preserve semantic content and preview composition", async () => {
  const systemDocument = await readSource("system.tokens.json");

  assert.equal(tokens["layout.confirmDialog.contentGap"], "16px");
  assert.equal(tokens["layout.confirmDialog.messageGap"], "8px");
  assert.equal(tokens["layout.confirmDialog.iconSize"], "32px");
  assert.equal(tokens["layout.confirmDialog.iconGlyphSize"], "16px");
  assert.equal(tokens["layout.confirmDialog.previewMaxBlockSize"], "240px");
  assert.equal(tokens["layout.spinner.matrixCellXs"], "3px");
  assert.equal(tokens["layout.spinner.matrixCellSm"], "4px");
  assert.equal(tokens["layout.spinner.matrixCellMd"], "6px");
  assert.equal(tokens["layout.spinner.matrixCellLg"], "8px");
  assert.equal(tokens["layout.spinner.matrixGapSm"], "1px");
  assert.equal(tokens["layout.spinner.matrixGapMd"], "2px");
  assert.equal(tokens["layout.confirmDialog.previewPaddingBlock"], "12px");
  assert.equal(tokens["layout.confirmDialog.previewPaddingInline"], "16px");
  assert.equal(tokens["layout.confirmDialog.previewRadius"], "8px");
  assert.equal(systemDocument.layout.confirmDialog.contentGap.$value, "{space.4}");
  assert.equal(systemDocument.layout.confirmDialog.previewRadius.$value, "{radius.base}");
});

test("Toolbar tokens preserve independent compact and tab-strip compositions", async () => {
  const systemDocument = await readSource("system.tokens.json");

  assert.equal(tokens["control.button.xsHeight"], "24px");
  assert.equal(tokens["control.button.xsPaddingInline"], "6px");
  assert.equal(tokens["layout.toolbar.smHeight"], "33px");
  assert.equal(tokens["layout.toolbar.mdHeight"], "45px");
  assert.equal(tokens["layout.toolbar.badgeSize"], "24px");
  assert.equal(tokens["layout.toolbar.separatorBlockSize"], "16px");
  assert.equal(tokens["layout.toolbar.overflowFadeExtent"], "16px");
  assert.equal(systemDocument.layout.toolbar.smPaddingBlock.$value, "{space.1}");
  assert.equal(systemDocument.layout.toolbar.groupGapMd.$value, "{space.2}");
});

test("OverflowText exposes one shared inline-end fade extent", () => {
  assert.equal(tokens["layout.overflowText.fadeExtent"], "16px");
});

test("Dialog tokens preserve the reference surface and chrome contract", async () => {
  const systemDocument = await readSource("system.tokens.json");

  assert.equal(tokens["overlay.dialog.backdropBlur"], "blur(20px)");
  assert.equal(tokens["overlay.dialog.surfaceRadius"], "28px");
  assert.equal(tokens["overlay.dialog.headerGap"], "20px");
  assert.equal(tokens["overlay.dialog.headerPaddingBlockStart"], "24px");
  assert.equal(tokens["overlay.dialog.headerPaddingBlockEnd"], "20px");
  assert.equal(tokens["overlay.dialog.headerPaddingInline"], "24px");
  assert.equal(tokens["overlay.dialog.footerPaddingBlockEnd"], "24px");
  assert.equal(
    tokens["overlay.dialog.footerPaddingBlockEnd"],
    tokens["overlay.dialog.footerPaddingInline"],
  );
  assert.equal(systemDocument.overlay.dialog.scrollbarWidth.$value, "{scrollbar.width}");
  assert.equal(tokens["overlay.dialog.scrollbarWidth"], "6px");
  assert.equal(tokens["overlay.dialog.footerBlur"], "blur(10px)");
  assert.equal(tokens["overlay.dialog.footerFadeExtent"], "24px");
  assert.equal(tokens["overlay.dialog.footerContentInset"], "104px");
});

test("control heights preserve an eight-pixel size step in every density mode", () => {
  const valuesFor = (name) => tokenCatalog.find((token) => token.name === name)?.values;

  assert.deepEqual(valuesFor("control.height.sm"), {
    comfortable: "32px",
    compact: "28px",
    touch: "40px",
  });
  assert.deepEqual(valuesFor("control.height.md"), {
    comfortable: "40px",
    compact: "36px",
    touch: "48px",
  });
  assert.deepEqual(valuesFor("control.height.lg"), {
    comfortable: "48px",
    compact: "44px",
    touch: "56px",
  });
  assert.deepEqual(valuesFor("control.hitTarget"), {
    comfortable: "40px",
    compact: "36px",
    touch: "48px",
  });
  assert.deepEqual(valuesFor("control.tabGroup.itemHeight"), {
    comfortable: "40px",
    compact: "36px",
    touch: "48px",
  });
});

test("shared system scales preserve the migrated Web UI foundation contract", () => {
  assert.deepEqual(
    Object.fromEntries([
      "space.1",
      "space.2",
      "space.3",
      "space.4",
      "space.5",
      "space.6",
      "space.8",
      "space.10",
      "space.12",
      "space.16",
    ].map((name) => [name, tokens[name]])),
    {
      "space.1": "4px",
      "space.2": "8px",
      "space.3": "12px",
      "space.4": "16px",
      "space.5": "20px",
      "space.6": "24px",
      "space.8": "32px",
      "space.10": "40px",
      "space.12": "48px",
      "space.16": "64px",
    },
  );
  const controlFontFamily = tokens["font.family.control"];
  assert.equal(controlFontFamily.startsWith("system-ui"), true);
  assert.equal(controlFontFamily.includes("-apple-system"), true);
  assert.equal(controlFontFamily.includes("'Segoe UI Variable Text'"), true);
  assert.equal(controlFontFamily.includes("'Noto Sans SC'"), false);
  assert.equal(tokens["font.family.sans"].startsWith("system-ui"), true);
  assert.equal(tokens["font.family.mono"].startsWith("'JetBrains Mono'"), true);
  assert.equal(tokens["font.family.mono"].includes("'Fira Code'"), true);
  assert.equal(tokens["font.size.micro"], "10px");
  assert.equal(tokens["font.size.meta"], "11px");
  assert.equal(tokens["font.size.xs"], "12px");
  assert.equal(tokens["font.size.sm"], "13px");
  assert.equal(tokens["font.size.3xl-plus"], "24px");
  assert.equal(tokens["font.size.4xl"], "26px");
  assert.equal(tokens["font.size.8xl"], "56px");
  assert.equal(tokens["font.weight.regular"], 400);
  assert.equal(tokens["font.weight.bold"], 700);
  assert.equal(tokens["lineHeight.base"], 1.5);
  assert.equal(tokens["lineHeight.reading"], 1.58);
  assert.equal(tokens["letterSpacing.normal"], "0em");
  assert.equal(tokens["radius.xs"], "4px");
  assert.equal(tokens["radius.sm"], "6px");
  assert.equal(tokens["radius.2xl"], "20px");
  assert.equal(tokens["radius.3xl"], "24px");
  assert.equal(tokens["motion.duration.instant"], "80ms");
  assert.equal(tokens["motion.duration.slow"], "420ms");
  assert.equal(tokens["motion.duration.contentSwap"], "320ms");
  assert.equal(tokens["motion.easing.standard"], "cubic-bezier(0.23, 1, 0.32, 1)");
  assert.equal(tokens["layer.modal"], 200);
  assert.equal(tokens["layer.contextMenu"], 500);
});

test("tooltips outrank popovers and nested menus without covering priority chrome", () => {
  for (const mode of tokenModes) {
    const modeTokens = Object.fromEntries(
      tokenCatalog.filter(token => token.category === "layer")
        .map(token => [token.name, Number(token.values[mode])]),
    );
    assert.ok(modeTokens["layer.modal"] < modeTokens["layer.popover"]);
    assert.ok(modeTokens["layer.popover"] + 1 < modeTokens["layer.tooltip"]);
    for (const layer of ["toast", "notification", "contextMenu"]) {
      assert.ok(modeTokens["layer.tooltip"] < modeTokens[`layer.${layer}`]);
    }
  }
});

test("semantic typography roles resolve to the canonical foundation", async () => {
  const systemDocument = await readSource("system.tokens.json");

  assert.equal(systemDocument.type.body.md.fontSize.$value, "{font.size.base}");
  assert.equal(systemDocument.type.body.md.lineHeight.$value, "{lineHeight.base}");
  assert.equal(systemDocument.type.label.selected.fontWeight.$value, "{font.weight.semibold}");
  assert.equal(systemDocument.type.flow.body.lineHeight.$value, "{lineHeight.reading}");
  assert.equal(tokens["type.body.md.fontSize"], "14px");
  assert.equal(tokens["type.label.selected.fontWeight"], 600);
  assert.equal(systemDocument.type.heading.page.fontFamily.$value, "{font.family.control}");
  assert.equal(systemDocument.type.heading.page.fontWeight.$value, "{font.weight.bold}");
  assert.equal(systemDocument.type.heading.navigation.fontSize.$value, "{font.size.xl-plus}");
  assert.equal(systemDocument.type.heading.compactPage.fontSize.$value, "{font.size.2xl-plus}");
  assert.equal(systemDocument.type.heading.section.fontSize.$value, "{font.size.lg}");
  assert.equal(systemDocument.type.heading.card.fontSize.$value, "{font.size.sm}");
  assert.equal(systemDocument.type.body.lg.fontSize.$value, "{font.size.lg}");
  assert.equal(systemDocument.type.support.fontSize.$value, "{font.size.meta}");
  assert.equal(systemDocument.type.label.md.fontWeight.$value, "{font.weight.regular}");
  assert.equal(systemDocument.type.overline.xs.fontSize.$value, "{font.size.3xs}");
  assert.equal(systemDocument.type.overline.sm.fontSize.$value, "{font.size.2xs}");
  assert.equal(systemDocument.type.modifier.leading.ui.lineHeight.$value, "{lineHeight.ui}");
  assert.equal(systemDocument.type.modifier.leading.support.lineHeight.$value, "{lineHeight.support}");
  assert.equal(systemDocument.type.modifier.leading.balanced.lineHeight.$value, "{lineHeight.balanced}");
  assert.equal(systemDocument.type.modifier.tracking.wider.letterSpacing.$value, "{letterSpacing.wider}");
  assert.equal(systemDocument.type.display.xxl.fontSize.$value, "{font.size.9xl}");
  assert.equal(tokens["type.heading.page.fontSize"], "24px");
  assert.equal(tokens["type.heading.page.fontWeight"], 700);
  assert.equal(tokens["type.heading.navigation.fontSize"], "17px");
  assert.equal(tokens["type.heading.compactPage.fontSize"], "20px");
  assert.equal(tokens["type.heading.section.fontSize"], "15px");
  assert.equal(tokens["type.heading.card.fontSize"], "13px");
  assert.equal(tokens["type.body.lg.fontSize"], "15px");
  assert.equal(tokens["type.support.fontSize"], "11px");
  assert.equal(tokens["type.label.md.fontWeight"], 400);
  assert.equal(tokens["type.overline.xs.fontSize"], "8px");
  assert.equal(tokens["type.modifier.leading.ui.lineHeight"], 1.4);
  assert.equal(tokens["type.modifier.leading.support.lineHeight"], 1.45);
  assert.equal(tokens["type.modifier.leading.balanced.lineHeight"], 1.35);
  assert.equal(tokens["type.modifier.tracking.wider.letterSpacing"], "0.04em");
  assert.equal(tokens["type.display.xxl.fontSize"], "64px");
  assert.equal(tokens["type.code.md.fontSize"], "13px");
  assert.equal(tokens["type.flow.body.lineHeight"], 1.58);
});

test("generated CSS preserves semantic typography references", async () => {
  const css = await readFile(path.join(packageDirectory, "dist", "tokens.css"), "utf8");

  assert.match(css, /--openbitfun-type-body-md-font-size: var\(--openbitfun-font-size-base\);/);
  assert.match(css, /--openbitfun-type-flow-body-line-height: var\(--openbitfun-line-height-reading\);/);
  assert.match(css, /--openbitfun-type-label-selected-font-weight: var\(--openbitfun-font-weight-semibold\);/);
  assert.match(css, /--openbitfun-type-heading-compact-page-font-size: var\(--openbitfun-font-size-2xl-plus\);/);
  assert.match(css, /--openbitfun-type-modifier-leading-ui-line-height: var\(--openbitfun-line-height-ui\);/);
  assert.match(css, /--openbitfun-type-modifier-leading-support-line-height: var\(--openbitfun-line-height-support\);/);
  assert.match(css, /--openbitfun-type-modifier-leading-balanced-line-height: var\(--openbitfun-line-height-balanced\);/);
  assert.match(css, /--openbitfun-type-modifier-tracking-wider-letter-spacing: var\(--openbitfun-letter-spacing-wider\);/);
});

test("runtime typography scaling uses the canonical complete size ladder", () => {
  assert.deepEqual(createTypographySizeScale(14), {
    "4xs": "7px",
    "3xs": "8px",
    "2xs": "9px",
    micro: "10px",
    meta: "11px",
    xs: "12px",
    sm: "13px",
    base: "14px",
    lg: "15px",
    xl: "16px",
    "xl-plus": "17px",
    "2xl": "18px",
    "2xl-plus": "20px",
    "3xl": "22px",
    "3xl-plus": "24px",
    "4xl": "26px",
    "5xl": "32px",
    "6xl": "40px",
    "7xl": "48px",
    "8xl": "56px",
    "9xl": "64px",
  });
  assert.equal(createTypographySizeScale(8).base, "12px");
  assert.equal(createTypographySizeScale(8)["4xs"], "7px");
  assert.equal(createTypographySizeScale(24).base, "20px");
  assert.throws(() => createTypographySizeScale(Number.NaN), /finite number/);
});

test("component spacing remains available in every density mode", () => {
  const inlineSpacing = tokenCatalog.find(
    ({ name }) => name === "space.component.inline",
  );
  const blockSpacing = tokenCatalog.find(
    ({ name }) => name === "space.component.block",
  );

  assert.deepEqual(inlineSpacing?.values, {
    comfortable: "12px",
    compact: "10px",
    touch: "16px",
  });
  assert.deepEqual(blockSpacing?.values, {
    comfortable: "8px",
    compact: "6px",
    touch: "12px",
  });
});

test("density documents only override existing system tokens", async () => {
  const systemDocument = await readSource("system.tokens.json");
  const compactDocument = await readSource("density-compact.tokens.json");
  const baseTokens = resolveTokens(systemDocument);
  const compactTokens = resolveTokens(
    mergeTokenDocuments(systemDocument, compactDocument),
  );
  const changes = diffResolvedTokens(baseTokens, compactTokens);

  for (const name of Object.keys(changes)) {
    assert.ok(name in baseTokens, `Density mode introduced unknown token ${name}.`);
  }
});

test("public token catalog exposes every system token in every density mode", () => {
  assert.equal(tokenCatalog.length, Object.keys(tokens).length);
  assert.deepEqual(tokenModes, ["comfortable", "compact", "touch"]);
  for (const token of tokenCatalog) {
    assert.equal(token.cssVariable.startsWith("--openbitfun-"), true);
    assert.deepEqual(Object.keys(token.values), tokenModes);
  }
});
