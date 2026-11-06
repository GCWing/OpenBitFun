//! LaTeX math → MathML → native, editable Office Math. All steps are in memory.
//! Unsupported structures fail explicitly; no image or process fallback exists.

use crate::common::MathMode;
use crate::xml::esc;
use crate::{OfficeError, OfficeResult};
use math_core::{LatexToMathML, MathCoreConfig, MathDisplay};
use roxmltree::Node;

pub(super) fn render(source: &str, mode: MathMode) -> OfficeResult<String> {
    if source.trim().is_empty() {
        return Err(OfficeError::invalid(
            "equation text must contain LaTeX math",
        ));
    }
    let converter = LatexToMathML::new(MathCoreConfig::default()).map_err(|error| {
        OfficeError::invalid(format!("cannot initialize math parser: {error:?}"))
    })?;
    let converted = converter.convert_with_local_counter(source, match mode {
        MathMode::Inline => MathDisplay::Inline,
        MathMode::Display => MathDisplay::Block,
    }).map_err(|error| OfficeError::invalid(format!("invalid or unsupported LaTeX math: {error}; correct the equation source or use an explicit code block to show literal TeX")))?;
    let doc = roxmltree::Document::parse(&converted)
        .map_err(|error| OfficeError::invalid(format!("invalid equation MathML: {error}")))?;
    let content = node(doc.root_element())?;
    let math = format!("<m:oMath>{content}</m:oMath>");
    Ok(if mode == MathMode::Display {
        format!("<m:oMathPara><m:oMathParaPr><m:jc m:val=\"center\"/></m:oMathParaPr>{math}</m:oMathPara>")
    } else {
        math
    })
}

fn children(element: Node<'_, '_>) -> OfficeResult<String> {
    element
        .children()
        .filter(Node::is_element)
        .map(node)
        .collect()
}

fn wrap(tag: &str, content: &str) -> String {
    format!("<m:{tag}>{content}</m:{tag}>")
}

fn text(value: &str, normal: bool) -> String {
    let style = if normal {
        "<m:rPr><m:sty m:val=\"p\"/></m:rPr>"
    } else {
        ""
    };
    format!("<m:r>{style}<w:rPr><w:rFonts w:ascii=\"Cambria Math\" w:hAnsi=\"Cambria Math\"/></w:rPr><m:t xml:space=\"preserve\">{}</m:t></m:r>", esc(value))
}

fn delimiter(element: Node<'_, '_>) -> bool {
    // MathML's operator dictionary makes these delimiters stretchy by default;
    // math-core only emits an attribute when it overrides that default.
    element.has_tag_name("mo")
        && element.attribute("stretchy") != Some("false")
        && (element.attribute("stretchy") == Some("true")
            || matches!(
                element.text().unwrap_or(""),
                "(" | ")"
                    | "["
                    | "]"
                    | "{"
                    | "}"
                    | "|"
                    | "‖"
                    | "⟨"
                    | "⟩"
                    | "⌈"
                    | "⌉"
                    | "⌊"
                    | "⌋"
                    | "\u{2063}"
            ))
}

fn delimiter_text<'a, 'input>(element: Node<'a, 'input>) -> &'a str {
    let value = element.text().unwrap_or("");
    if value == "\u{2063}" {
        ""
    } else {
        value
    }
}

fn node(element: Node<'_, '_>) -> OfficeResult<String> {
    let name = element.tag_name().name();
    let nodes: Vec<_> = element.children().filter(Node::is_element).collect();
    let child = |index: usize| -> OfficeResult<String> {
        nodes.get(index).copied().map(node).unwrap_or_else(|| {
            Err(OfficeError::invalid(format!(
                "incomplete equation element {name}"
            )))
        })
    };
    Ok(match name {
        "math" | "mstyle" | "semantics" => children(element)?,
        "annotation" => String::new(),
        "mrow" => {
            // Preserve scalable fenced matrices/fractions as Office delimiters.
            if nodes.len() >= 2 && nodes.first().copied().is_some_and(delimiter)
                && nodes.last().copied().is_some_and(delimiter) {
                let inner: String = nodes[1..nodes.len()-1].iter().copied().map(node).collect::<OfficeResult<_>>()?;
                format!("<m:d><m:dPr><m:begChr m:val=\"{}\"/><m:endChr m:val=\"{}\"/><m:grow m:val=\"1\"/></m:dPr><m:e>{inner}</m:e></m:d>", esc(delimiter_text(nodes[0])), esc(delimiter_text(nodes[nodes.len()-1])))
            } else { children(element)? }
        },
        "mi" | "mn" | "mo" | "mtext" | "ms" => {
            text(element.text().unwrap_or(""), name != "mi" || element.attribute("mathvariant") == Some("normal"))
        },
        "mspace" => text(" ", true),
        "mfrac" => {
            let props = if element.attribute("linethickness") == Some("0") { "<m:fPr><m:type m:val=\"noBar\"/></m:fPr>" } else { "" };
            format!("<m:f>{props}<m:num>{}</m:num><m:den>{}</m:den></m:f>", child(0)?, child(1)?)
        },
        "msqrt" => format!("<m:rad><m:radPr><m:degHide m:val=\"1\"/></m:radPr><m:deg/><m:e>{}</m:e></m:rad>", children(element)?),
        "mroot" => format!("<m:rad><m:deg>{}</m:deg><m:e>{}</m:e></m:rad>", child(1)?, child(0)?),
        "msub" | "msup" | "msubsup" => {
            let tag = match name { "msub" => "sSub", "msup" => "sSup", _ => "sSubSup" };
            let mut content = wrap("e", &child(0)?);
            content.push_str(&wrap(if name == "msup" {"sup"} else {"sub"}, &child(1)?));
            if name == "msubsup" { content.push_str(&wrap("sup", &child(2)?)); }
            wrap(tag, &content)
        },
        "munder" | "mover" | "munderover" => {
            let base = child(0)?;
            if name == "mover" && nodes.get(1).is_some_and(|n| n.has_tag_name("mo")) && element.attribute("accent") == Some("true") {
                format!("<m:acc><m:accPr><m:chr m:val=\"{}\"/></m:accPr><m:e>{base}</m:e></m:acc>", esc(nodes[1].text().unwrap_or("")))
            } else {
                let lower = if name == "mover" { base } else { format!("<m:limLow><m:e>{base}</m:e><m:lim>{}</m:lim></m:limLow>", child(1)?) };
                if name == "munder" { lower } else { format!("<m:limUpp><m:e>{lower}</m:e><m:lim>{}</m:lim></m:limUpp>", child(if name == "mover" {1} else {2})?) }
            }
        },
        "mtable" => {
            let columns = nodes.first().map(|row| row.children().filter(Node::is_element).count()).unwrap_or(0);
            if columns == 0 || nodes.iter().any(|row| row.children().filter(Node::is_element).count() != columns) {
                return Err(OfficeError::invalid("equation matrices must have equally sized rows"));
            }
            format!("<m:m><m:mPr><m:mcs><m:mc><m:mcPr><m:count m:val=\"{columns}\"/><m:mcJc m:val=\"center\"/></m:mcPr></m:mc></m:mcs></m:mPr>{}</m:m>", children(element)?)
        },
        "mtr" => wrap("mr", &children(element)?),
        "mtd" => wrap("e", &children(element)?),
        _ => return Err(OfficeError::invalid(format!("LaTeX math uses unsupported Word equation structure `{name}`; simplify the expression or show it explicitly as code"))),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_native_equation_structures_and_rejects_unknown_commands() {
        for (source, expected) in [
            (r"\frac{-b\pm\sqrt{b^2-4ac}}{2a}", "<m:f>"),
            (r"\sum_{i=1}^{n} x_i^2", "<m:limUpp>"),
            (r"\int_0^1 x^2\,dx=\frac{1}{3}", "<m:sSubSup>"),
            (r"\begin{pmatrix}a&b\\c&d\end{pmatrix}", "<m:m>"),
            (r"\hat{x}+\alpha+\beta", "<m:acc>"),
            (r"x<y \text{且} y>0", "&lt;"),
        ] {
            let xml = render(source, MathMode::Display).unwrap();
            assert!(xml.contains(expected), "{source}: {xml}");
            let wrapper = format!("<root xmlns:m=\"http://schemas.openxmlformats.org/officeDocument/2006/math\" xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">{xml}</root>");
            roxmltree::Document::parse(&wrapper).unwrap();
        }
        for source in [
            r"\begin{pmatrix}a&b\\c&d\end{pmatrix}",
            r"\left(\frac{1}{2}\right)",
            r"\begin{cases}x&x>0\\0&x=0\end{cases}",
        ] {
            let xml = render(source, MathMode::Display).unwrap();
            assert!(
                xml.contains("<m:d>"),
                "scalable delimiters missing: {source}"
            );
            assert!(xml.contains("<m:grow m:val=\"1\"/>"));
        }
        assert!(!render("(x)", MathMode::Inline).unwrap().contains("<m:d>"));
        assert!(render(r"\unknownCommand{x}", MathMode::Inline).is_err());
        assert!(render(r"\frac{1}", MathMode::Inline).is_err());
    }
}
