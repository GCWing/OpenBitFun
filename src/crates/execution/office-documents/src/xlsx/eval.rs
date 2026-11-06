//! Small formula evaluator that fills cached results (`<v>`) so viewers that
//! do not recalculate (previewers, text extractors, the agent's own Read)
//! see values. Anything outside the supported subset is left uncached and
//! the spreadsheet application computes it on open (`fullCalcOnLoad`).

use super::address::{column_number, CellRef, MAX_ROWS};
use super::model::XlsxDocument;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

const MAX_RANGE_CELLS: u64 = 1_000_000;
const MAX_DEPTH: usize = 256;

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Computed {
    Number(f64),
    Text(String),
    Bool(bool),
    Error(&'static str),
    Empty,
}

/// The formula cannot be evaluated locally.
#[derive(Debug)]
struct Unsupported;

type EvalResult<T> = Result<T, Unsupported>;

#[derive(Debug, Clone)]
enum Expr {
    Number(f64),
    Text(String),
    Bool(bool),
    Error(&'static str),
    Cell(Option<String>, CellRef),
    Range(Option<String>, CellRef, CellRef),
    Negate(Box<Expr>),
    Percent(Box<Expr>),
    Binary(char, Box<Expr>, Box<Expr>),
    Compare(&'static str, Box<Expr>, Box<Expr>),
    Call(String, Vec<Expr>),
}

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Number(f64),
    Text(String),
    Ident(String),
    Ref(Option<String>, CellRef),
    Error(&'static str),
    Op(&'static str),
}

const ERRORS: &[&str] = &[
    "#DIV/0!", "#N/A", "#NAME?", "#NULL!", "#NUM!", "#REF!", "#VALUE!",
];

fn tokenize(formula: &str) -> EvalResult<Vec<Token>> {
    let chars: Vec<char> = formula.chars().collect();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if c == '"' {
            let mut text = String::new();
            i += 1;
            loop {
                match chars.get(i) {
                    Some('"') if chars.get(i + 1) == Some(&'"') => {
                        text.push('"');
                        i += 2;
                    }
                    Some('"') => {
                        i += 1;
                        break;
                    }
                    Some(other) => {
                        text.push(*other);
                        i += 1;
                    }
                    None => return Err(Unsupported),
                }
            }
            tokens.push(Token::Text(text));
            continue;
        }
        if c == '#' {
            let rest: String = chars[i..].iter().collect();
            let error = ERRORS
                .iter()
                .find(|error| rest.starts_with(**error))
                .ok_or(Unsupported)?;
            tokens.push(Token::Error(error));
            i += error.chars().count();
            continue;
        }
        if c.is_ascii_digit() || (c == '.' && chars.get(i + 1).is_some_and(char::is_ascii_digit)) {
            let start = i;
            while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
                i += 1;
            }
            if i < chars.len() && (chars[i] == 'e' || chars[i] == 'E') {
                let mut j = i + 1;
                if j < chars.len() && (chars[j] == '+' || chars[j] == '-') {
                    j += 1;
                }
                if j < chars.len() && chars[j].is_ascii_digit() {
                    i = j;
                    while i < chars.len() && chars[i].is_ascii_digit() {
                        i += 1;
                    }
                }
            }
            let text: String = chars[start..i].iter().collect();
            tokens.push(Token::Number(text.parse().map_err(|_| Unsupported)?));
            continue;
        }
        if c == '\'' || c == '$' || c.is_alphabetic() || c == '_' {
            let (token, next) = lex_name_or_ref(&chars, i)?;
            tokens.push(token);
            i = next;
            continue;
        }
        let two: String = chars[i..(i + 2).min(chars.len())].iter().collect();
        let op = match two.as_str() {
            "<>" => Some("<>"),
            "<=" => Some("<="),
            ">=" => Some(">="),
            _ => None,
        };
        if let Some(op) = op {
            tokens.push(Token::Op(op));
            i += 2;
            continue;
        }
        let op = match c {
            '+' => "+",
            '-' => "-",
            '*' => "*",
            '/' => "/",
            '^' => "^",
            '&' => "&",
            '=' => "=",
            '<' => "<",
            '>' => ">",
            '%' => "%",
            ',' => ",",
            '(' => "(",
            ')' => ")",
            ':' => ":",
            _ => return Err(Unsupported),
        };
        tokens.push(Token::Op(op));
        i += 1;
    }
    Ok(tokens)
}

fn lex_name_or_ref(chars: &[char], start: usize) -> EvalResult<(Token, usize)> {
    let mut i = start;
    let mut sheet = None;
    if chars[i] == '\'' {
        let mut name = String::new();
        i += 1;
        loop {
            match chars.get(i) {
                Some('\'') if chars.get(i + 1) == Some(&'\'') => {
                    name.push('\'');
                    i += 2;
                }
                Some('\'') => {
                    i += 1;
                    break;
                }
                Some(c) => {
                    name.push(*c);
                    i += 1;
                }
                None => return Err(Unsupported),
            }
        }
        if chars.get(i) != Some(&'!') {
            return Err(Unsupported);
        }
        sheet = Some(name);
        i += 1;
    } else {
        let mut j = i;
        while j < chars.len() && (chars[j].is_alphanumeric() || chars[j] == '_' || chars[j] == '.')
        {
            j += 1;
        }
        if j > i && chars.get(j) == Some(&'!') {
            sheet = Some(chars[i..j].iter().collect());
            i = j + 1;
        }
    }
    if let Some((cell, next)) = lex_cell(chars, i) {
        let followed_by_name = chars
            .get(next)
            .is_some_and(|c| c.is_alphanumeric() || *c == '_' || *c == '(');
        if !followed_by_name {
            return Ok((Token::Ref(sheet, cell), next));
        }
    }
    if sheet.is_some() {
        // Whole-row/column ranges and names on other sheets are out of scope.
        return Err(Unsupported);
    }
    let mut j = i;
    while j < chars.len() && (chars[j].is_alphanumeric() || chars[j] == '_' || chars[j] == '.') {
        j += 1;
    }
    if j == i {
        return Err(Unsupported);
    }
    Ok((
        Token::Ident(chars[i..j].iter().collect::<String>().to_ascii_uppercase()),
        j,
    ))
}

fn lex_cell(chars: &[char], start: usize) -> Option<(CellRef, usize)> {
    let mut i = start;
    if chars.get(i) == Some(&'$') {
        i += 1;
    }
    let letters_start = i;
    while i < chars.len() && chars[i].is_ascii_alphabetic() && i - letters_start < 3 {
        i += 1;
    }
    let col = column_number(&chars[letters_start..i].iter().collect::<String>())?;
    if chars.get(i) == Some(&'$') {
        i += 1;
    }
    let digits_start = i;
    while i < chars.len() && chars[i].is_ascii_digit() {
        i += 1;
    }
    let row: u32 = chars[digits_start..i]
        .iter()
        .collect::<String>()
        .parse()
        .ok()?;
    (1..=MAX_ROWS)
        .contains(&row)
        .then_some((CellRef::new(row, col), i))
}

struct Parser {
    tokens: Vec<Token>,
    position: usize,
}

impl Parser {
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.position)
    }

    fn eat(&mut self, op: &str) -> bool {
        if self.peek()
            == Some(&Token::Op(match op {
                "(" => "(",
                ")" => ")",
                "," => ",",
                ":" => ":",
                "%" => "%",
                _ => return false,
            }))
        {
            self.position += 1;
            return true;
        }
        false
    }

    fn peek_op(&self) -> Option<&'static str> {
        match self.peek() {
            Some(Token::Op(op)) => Some(op),
            _ => None,
        }
    }

    fn comparison(&mut self) -> EvalResult<Expr> {
        let mut left = self.concat()?;
        while let Some(op @ ("=" | "<>" | "<" | ">" | "<=" | ">=")) = self.peek_op() {
            self.position += 1;
            let right = self.concat()?;
            left = Expr::Compare(op, Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn concat(&mut self) -> EvalResult<Expr> {
        let mut left = self.additive()?;
        while self.peek_op() == Some("&") {
            self.position += 1;
            left = Expr::Binary('&', Box::new(left), Box::new(self.additive()?));
        }
        Ok(left)
    }

    fn additive(&mut self) -> EvalResult<Expr> {
        let mut left = self.multiplicative()?;
        while let Some(op @ ("+" | "-")) = self.peek_op() {
            self.position += 1;
            let right = self.multiplicative()?;
            left = Expr::Binary(
                op.chars().next().unwrap_or('+'),
                Box::new(left),
                Box::new(right),
            );
        }
        Ok(left)
    }

    fn multiplicative(&mut self) -> EvalResult<Expr> {
        let mut left = self.power()?;
        while let Some(op @ ("*" | "/")) = self.peek_op() {
            self.position += 1;
            let right = self.power()?;
            left = Expr::Binary(
                op.chars().next().unwrap_or('*'),
                Box::new(left),
                Box::new(right),
            );
        }
        Ok(left)
    }

    fn power(&mut self) -> EvalResult<Expr> {
        let mut left = self.unary()?;
        while self.peek_op() == Some("^") {
            self.position += 1;
            left = Expr::Binary('^', Box::new(left), Box::new(self.unary()?));
        }
        Ok(left)
    }

    fn unary(&mut self) -> EvalResult<Expr> {
        match self.peek_op() {
            Some("-") => {
                self.position += 1;
                Ok(Expr::Negate(Box::new(self.unary()?)))
            }
            Some("+") => {
                self.position += 1;
                self.unary()
            }
            _ => {
                let mut expr = self.primary()?;
                while self.eat("%") {
                    expr = Expr::Percent(Box::new(expr));
                }
                Ok(expr)
            }
        }
    }

    fn primary(&mut self) -> EvalResult<Expr> {
        let token = self.peek().cloned().ok_or(Unsupported)?;
        self.position += 1;
        match token {
            Token::Number(value) => Ok(Expr::Number(value)),
            Token::Text(text) => Ok(Expr::Text(text)),
            Token::Error(error) => Ok(Expr::Error(error)),
            Token::Ref(sheet, cell) => {
                if self.eat(":") {
                    match self.peek().cloned() {
                        Some(Token::Ref(None, end)) => {
                            self.position += 1;
                            Ok(Expr::Range(sheet, cell, end))
                        }
                        _ => Err(Unsupported),
                    }
                } else {
                    Ok(Expr::Cell(sheet, cell))
                }
            }
            Token::Ident(name) => {
                if self.eat("(") {
                    let mut args = Vec::new();
                    if !self.eat(")") {
                        loop {
                            args.push(self.comparison()?);
                            if self.eat(",") {
                                continue;
                            }
                            if self.eat(")") {
                                break;
                            }
                            return Err(Unsupported);
                        }
                    }
                    Ok(Expr::Call(
                        name.trim_start_matches("_XLFN.").to_string(),
                        args,
                    ))
                } else {
                    match name.as_str() {
                        "TRUE" => Ok(Expr::Bool(true)),
                        "FALSE" => Ok(Expr::Bool(false)),
                        _ => Err(Unsupported),
                    }
                }
            }
            Token::Op("(") => {
                let inner = self.comparison()?;
                if !self.eat(")") {
                    return Err(Unsupported);
                }
                Ok(inner)
            }
            Token::Op(_) => Err(Unsupported),
        }
    }
}

fn parse(formula: &str) -> EvalResult<Expr> {
    let mut parser = Parser {
        tokens: tokenize(formula)?,
        position: 0,
    };
    let expr = parser.comparison()?;
    if parser.position != parser.tokens.len() {
        return Err(Unsupported);
    }
    Ok(expr)
}

/// Computed results of every formula the evaluator understands, keyed by
/// sheet index and cell.
pub(crate) fn evaluate_workbook(book: &XlsxDocument) -> HashMap<(usize, CellRef), Computed> {
    let mut evaluator = Evaluator {
        book,
        memo: HashMap::new(),
        visiting: HashSet::new(),
        depth: 0,
    };
    for (sheet_index, sheet) in book.sheets.iter().enumerate() {
        for (cell, value) in &sheet.cells {
            if value.formula.is_some() {
                let _ = evaluator.cell(sheet_index, *cell);
            }
        }
    }
    evaluator
        .memo
        .into_iter()
        .filter_map(|(key, value)| value.map(|value| (key, value)))
        .collect()
}

struct Evaluator<'a> {
    book: &'a XlsxDocument,
    memo: HashMap<(usize, CellRef), Option<Computed>>,
    visiting: HashSet<(usize, CellRef)>,
    depth: usize,
}

impl Evaluator<'_> {
    fn sheet_index(&self, current: usize, name: &Option<String>) -> Option<usize> {
        match name {
            None => Some(current),
            Some(name) => self.book.sheet_index(name),
        }
    }

    fn cell(&mut self, sheet: usize, cell: CellRef) -> EvalResult<Computed> {
        let Some(stored) = self.book.sheets[sheet].cells.get(&cell) else {
            return Ok(Computed::Empty);
        };
        let Some(formula) = &stored.formula else {
            return Ok(match &stored.value {
                Value::Number(number) => Computed::Number(number.as_f64().unwrap_or(0.0)),
                Value::String(text) => Computed::Text(text.clone()),
                Value::Bool(value) => Computed::Bool(*value),
                _ => Computed::Empty,
            });
        };
        let key = (sheet, cell);
        if let Some(known) = self.memo.get(&key) {
            return known.clone().ok_or(Unsupported);
        }
        if !self.visiting.insert(key) || self.depth > MAX_DEPTH {
            return Err(Unsupported);
        }
        self.depth += 1;
        let result = parse(formula).and_then(|expr| self.scalar(sheet, &expr));
        self.depth -= 1;
        self.visiting.remove(&key);
        let stored = result.as_ref().ok().cloned();
        self.memo.insert(key, stored);
        result
    }

    /// Values of a reference or range argument, row-major.
    fn values(&mut self, sheet: usize, expr: &Expr) -> EvalResult<Vec<Computed>> {
        match expr {
            Expr::Range(name, start, end) => {
                let Some(target) = self.sheet_index(sheet, name) else {
                    return Ok(vec![Computed::Error("#REF!")]);
                };
                let (top, bottom) = (start.row.min(end.row), start.row.max(end.row));
                let (left, right) = (start.col.min(end.col), start.col.max(end.col));
                if (bottom - top + 1) as u64 * (right - left + 1) as u64 > MAX_RANGE_CELLS {
                    return Err(Unsupported);
                }
                // Visit only stored cells: empty cells contribute nothing.
                let cells: Vec<CellRef> = self.book.sheets[target]
                    .cells
                    .range(CellRef::new(top, 0)..=CellRef::new(bottom, u32::MAX))
                    .map(|(cell, _)| *cell)
                    .filter(|cell| (left..=right).contains(&cell.col))
                    .collect();
                cells
                    .into_iter()
                    .map(|cell| self.cell(target, cell))
                    .collect()
            }
            other => Ok(vec![self.scalar(sheet, other)?]),
        }
    }

    fn scalar(&mut self, sheet: usize, expr: &Expr) -> EvalResult<Computed> {
        Ok(match expr {
            Expr::Number(value) => Computed::Number(*value),
            Expr::Text(text) => Computed::Text(text.clone()),
            Expr::Bool(value) => Computed::Bool(*value),
            Expr::Error(error) => Computed::Error(error),
            Expr::Cell(name, cell) => match self.sheet_index(sheet, name) {
                Some(target) => self.cell(target, *cell)?,
                None => Computed::Error("#REF!"),
            },
            Expr::Range(_, start, end) if start == end => {
                let values = self.values(sheet, expr)?;
                values.into_iter().next().unwrap_or(Computed::Empty)
            }
            Expr::Range(..) => return Err(Unsupported),
            Expr::Negate(inner) => match number(self.scalar(sheet, inner)?) {
                Ok(value) => Computed::Number(-value),
                Err(error) => error,
            },
            Expr::Percent(inner) => match number(self.scalar(sheet, inner)?) {
                Ok(value) => Computed::Number(value / 100.0),
                Err(error) => error,
            },
            Expr::Binary('&', left, right) => {
                let left = self.scalar(sheet, left)?;
                let right = self.scalar(sheet, right)?;
                if let Computed::Error(error) = left {
                    return Ok(Computed::Error(error));
                }
                if let Computed::Error(error) = right {
                    return Ok(Computed::Error(error));
                }
                Computed::Text(format!("{}{}", text(&left), text(&right)))
            }
            Expr::Binary(op, left, right) => {
                let left = number(self.scalar(sheet, left)?);
                let right = number(self.scalar(sheet, right)?);
                match (left, right) {
                    (Err(error), _) | (_, Err(error)) => error,
                    (Ok(a), Ok(b)) => match op {
                        '+' => finite(a + b),
                        '-' => finite(a - b),
                        '*' => finite(a * b),
                        '/' if b == 0.0 => Computed::Error("#DIV/0!"),
                        '/' => finite(a / b),
                        '^' => finite(a.powf(b)),
                        _ => return Err(Unsupported),
                    },
                }
            }
            Expr::Compare(op, left, right) => {
                let left = self.scalar(sheet, left)?;
                let right = self.scalar(sheet, right)?;
                if let Computed::Error(error) = left {
                    return Ok(Computed::Error(error));
                }
                if let Computed::Error(error) = right {
                    return Ok(Computed::Error(error));
                }
                let ordering = compare(&left, &right);
                Computed::Bool(match *op {
                    "=" => ordering == std::cmp::Ordering::Equal,
                    "<>" => ordering != std::cmp::Ordering::Equal,
                    "<" => ordering == std::cmp::Ordering::Less,
                    ">" => ordering == std::cmp::Ordering::Greater,
                    "<=" => ordering != std::cmp::Ordering::Greater,
                    _ => ordering != std::cmp::Ordering::Less,
                })
            }
            Expr::Call(name, args) => self.call(sheet, name, args)?,
        })
    }

    /// Numbers from arguments: ranges contribute only their numeric cells,
    /// direct arguments are coerced.
    fn numbers(&mut self, sheet: usize, args: &[Expr]) -> EvalResult<Result<Vec<f64>, Computed>> {
        let mut out = Vec::new();
        for arg in args {
            let is_range = matches!(arg, Expr::Range(..));
            for value in self.values(sheet, arg)? {
                match value {
                    Computed::Error(error) => return Ok(Err(Computed::Error(error))),
                    Computed::Number(number) => out.push(number),
                    other if !is_range => match number(other) {
                        Ok(number) => out.push(number),
                        Err(error) => return Ok(Err(error)),
                    },
                    _ => {}
                }
            }
        }
        Ok(Ok(out))
    }

    fn call(&mut self, sheet: usize, name: &str, args: &[Expr]) -> EvalResult<Computed> {
        let arity = |min: usize, max: usize| -> EvalResult<()> {
            if args.len() < min || args.len() > max {
                Err(Unsupported)
            } else {
                Ok(())
            }
        };
        Ok(match name {
            "SUM" | "AVERAGE" | "MIN" | "MAX" | "COUNT" | "PRODUCT" => {
                if name == "COUNT" {
                    let mut count = 0usize;
                    for arg in args {
                        count += self
                            .values(sheet, arg)?
                            .iter()
                            .filter(|value| matches!(value, Computed::Number(_)))
                            .count();
                    }
                    return Ok(Computed::Number(count as f64));
                }
                let values = match self.numbers(sheet, args)? {
                    Ok(values) => values,
                    Err(error) => return Ok(error),
                };
                match name {
                    "SUM" => finite(values.iter().sum()),
                    "PRODUCT" => finite(values.iter().product()),
                    "AVERAGE" if values.is_empty() => Computed::Error("#DIV/0!"),
                    "AVERAGE" => finite(values.iter().sum::<f64>() / values.len() as f64),
                    _ if values.is_empty() => Computed::Number(0.0),
                    "MIN" => Computed::Number(values.iter().copied().fold(f64::INFINITY, f64::min)),
                    _ => Computed::Number(values.iter().copied().fold(f64::NEG_INFINITY, f64::max)),
                }
            }
            "COUNTA" => {
                let mut count = 0usize;
                for arg in args {
                    count += self
                        .values(sheet, arg)?
                        .iter()
                        .filter(|value| !matches!(value, Computed::Empty))
                        .count();
                }
                Computed::Number(count as f64)
            }
            "ROUND" | "ROUNDUP" | "ROUNDDOWN" => {
                arity(1, 2)?;
                let value = number(self.scalar(sheet, &args[0])?);
                let digits = match args.get(1) {
                    Some(arg) => number(self.scalar(sheet, arg)?),
                    None => Ok(0.0),
                };
                match (value, digits) {
                    (Err(error), _) | (_, Err(error)) => error,
                    (Ok(value), Ok(digits)) => {
                        let factor = 10f64.powi(digits.trunc() as i32);
                        // Strip binary noise first so 2.345 rounds like Excel (to 2.35).
                        let scaled: f64 = format!("{:.9}", value * factor)
                            .parse()
                            .unwrap_or(value * factor);
                        let rounded = match name {
                            "ROUND" => scaled.abs().round().copysign(scaled),
                            "ROUNDUP" => scaled.abs().ceil().copysign(scaled),
                            _ => scaled.trunc(),
                        };
                        finite(rounded / factor)
                    }
                }
            }
            "ABS" => {
                arity(1, 1)?;
                match number(self.scalar(sheet, &args[0])?) {
                    Ok(value) => Computed::Number(value.abs()),
                    Err(error) => error,
                }
            }
            "IF" => {
                arity(2, 3)?;
                match truthy(self.scalar(sheet, &args[0])?) {
                    Err(error) => error,
                    Ok(true) => self.scalar(sheet, &args[1])?,
                    Ok(false) => match args.get(2) {
                        Some(arg) => self.scalar(sheet, arg)?,
                        None => Computed::Bool(false),
                    },
                }
            }
            "IFERROR" => {
                arity(2, 2)?;
                match self.scalar(sheet, &args[0])? {
                    Computed::Error(_) => self.scalar(sheet, &args[1])?,
                    value => value,
                }
            }
            "AND" | "OR" => {
                let mut results = Vec::new();
                for arg in args {
                    for value in self.values(sheet, arg)? {
                        if matches!(value, Computed::Empty | Computed::Text(_))
                            && matches!(arg, Expr::Range(..))
                        {
                            continue;
                        }
                        match truthy(value) {
                            Ok(flag) => results.push(flag),
                            Err(error) => return Ok(error),
                        }
                    }
                }
                if results.is_empty() {
                    Computed::Error("#VALUE!")
                } else if name == "AND" {
                    Computed::Bool(results.iter().all(|flag| *flag))
                } else {
                    Computed::Bool(results.iter().any(|flag| *flag))
                }
            }
            "NOT" => {
                arity(1, 1)?;
                match truthy(self.scalar(sheet, &args[0])?) {
                    Ok(flag) => Computed::Bool(!flag),
                    Err(error) => error,
                }
            }
            "CONCATENATE" | "CONCAT" => {
                let mut out = String::new();
                for arg in args {
                    for value in self.values(sheet, arg)? {
                        if let Computed::Error(error) = value {
                            return Ok(Computed::Error(error));
                        }
                        out.push_str(&text(&value));
                    }
                }
                Computed::Text(out)
            }
            "LEN" | "UPPER" | "LOWER" | "TRIM" => {
                arity(1, 1)?;
                let value = self.scalar(sheet, &args[0])?;
                if let Computed::Error(error) = value {
                    return Ok(Computed::Error(error));
                }
                let value = text(&value);
                match name {
                    "LEN" => Computed::Number(value.chars().count() as f64),
                    "UPPER" => Computed::Text(value.to_uppercase()),
                    "LOWER" => Computed::Text(value.to_lowercase()),
                    _ => Computed::Text(value.split_whitespace().collect::<Vec<_>>().join(" ")),
                }
            }
            _ => return Err(Unsupported),
        })
    }
}

fn finite(value: f64) -> Computed {
    if value.is_finite() {
        Computed::Number(value)
    } else {
        Computed::Error("#NUM!")
    }
}

fn number(value: Computed) -> Result<f64, Computed> {
    match value {
        Computed::Number(value) => Ok(value),
        Computed::Bool(value) => Ok(if value { 1.0 } else { 0.0 }),
        Computed::Empty => Ok(0.0),
        Computed::Text(text) if text.trim().is_empty() => Err(Computed::Error("#VALUE!")),
        Computed::Text(text) => text.trim().parse().map_err(|_| Computed::Error("#VALUE!")),
        Computed::Error(error) => Err(Computed::Error(error)),
    }
}

fn truthy(value: Computed) -> Result<bool, Computed> {
    match value {
        Computed::Bool(value) => Ok(value),
        Computed::Number(value) => Ok(value != 0.0),
        Computed::Empty => Ok(false),
        Computed::Text(text) => match text.to_ascii_uppercase().as_str() {
            "TRUE" => Ok(true),
            "FALSE" => Ok(false),
            _ => Err(Computed::Error("#VALUE!")),
        },
        Computed::Error(error) => Err(Computed::Error(error)),
    }
}

/// Excel's general-format rendering of a value used as text.
pub(crate) fn text(value: &Computed) -> String {
    match value {
        Computed::Number(value) => format_number(*value),
        Computed::Text(text) => text.clone(),
        Computed::Bool(value) => if *value { "TRUE" } else { "FALSE" }.to_string(),
        Computed::Error(error) => (*error).to_string(),
        Computed::Empty => String::new(),
    }
}

pub(crate) fn format_number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        return format!("{}", value as i64);
    }
    let formatted = format!("{:.15}", value);
    let trimmed = formatted.trim_end_matches('0').trim_end_matches('.');
    // Keep at most 15 significant digits like Excel.
    let significant: usize = trimmed.chars().filter(char::is_ascii_digit).count();
    if significant > 15 {
        let decimals = 15usize.saturating_sub(value.abs().log10().floor().max(0.0) as usize + 1);
        let rounded = format!("{:.*}", decimals, value);
        return rounded
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_string();
    }
    trimmed.to_string()
}

fn compare(left: &Computed, right: &Computed) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let rank = |value: &Computed| match value {
        Computed::Number(_) | Computed::Empty => 0,
        Computed::Text(_) => 1,
        Computed::Bool(_) => 2,
        Computed::Error(_) => 3,
    };
    match (left, right) {
        (Computed::Text(a), Computed::Text(b)) => a.to_lowercase().cmp(&b.to_lowercase()),
        (Computed::Text(a), Computed::Empty) => {
            if a.is_empty() {
                Ordering::Equal
            } else {
                Ordering::Greater
            }
        }
        (Computed::Empty, Computed::Text(b)) => {
            if b.is_empty() {
                Ordering::Equal
            } else {
                Ordering::Less
            }
        }
        (Computed::Bool(a), Computed::Bool(b)) => a.cmp(b),
        _ if rank(left) == 0 && rank(right) == 0 => {
            let a = number(left.clone()).unwrap_or(0.0);
            let b = number(right.clone()).unwrap_or(0.0);
            a.partial_cmp(&b).unwrap_or(Ordering::Equal)
        }
        _ => rank(left).cmp(&rank(right)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::xlsx::model::{Cell, Sheet};
    use serde_json::json;

    fn book(cells: &[(&str, Value)]) -> XlsxDocument {
        let mut sheet = Sheet {
            name: "Data".to_string(),
            ..Sheet::default()
        };
        for (address, value) in cells {
            let cell = crate::xlsx::address::parse_cell(address).unwrap();
            let entry = match value {
                Value::String(text) if text.starts_with('=') => Cell {
                    formula: Some(text[1..].to_string()),
                    ..Cell::default()
                },
                other => Cell {
                    value: other.clone(),
                    ..Cell::default()
                },
            };
            sheet.cells.insert(cell, entry);
        }
        XlsxDocument {
            sheets: vec![
                sheet,
                Sheet {
                    name: "Other Sheet".to_string(),
                    ..Sheet::default()
                },
            ],
            ..XlsxDocument::default()
        }
    }

    fn eval(cells: &[(&str, Value)], target: &str) -> Option<Computed> {
        let book = book(cells);
        let cell = crate::xlsx::address::parse_cell(target).unwrap();
        evaluate_workbook(&book).get(&(0, cell)).cloned()
    }

    #[test]
    fn evaluates_arithmetic_functions_and_references() {
        let cells = [
            ("A1", json!(2)),
            ("A2", json!(3.5)),
            ("A3", json!("x")),
            ("B1", json!("=A1*A2+10%")),
            ("B2", json!("=SUM(A1:A3)")),
            ("B3", json!("=AVERAGE(A1:A2)")),
            ("B4", json!("=IF(B2>5,\"big\",\"small\")&\"!\"")),
            ("B5", json!("=A1/0")),
            ("B6", json!("=IFERROR(B5,0)")),
            ("B7", json!("=ROUND(2.345,2)")),
            ("B8", json!("=-2^2")),
            ("B9", json!("=COUNT(A1:A3)+COUNTA(A1:A3)")),
            ("C1", json!("=FILTER(A1:A3,A1:A3>0)")),
            ("C2", json!("=C3")),
            ("C3", json!("=C2")),
            ("C4", json!("='Other Sheet'!A1+1")),
        ];
        assert_eq!(eval(&cells, "B1"), Some(Computed::Number(7.1)));
        assert_eq!(eval(&cells, "B2"), Some(Computed::Number(5.5)));
        assert_eq!(eval(&cells, "B3"), Some(Computed::Number(2.75)));
        assert_eq!(eval(&cells, "B4"), Some(Computed::Text("big!".to_string())));
        assert_eq!(eval(&cells, "B5"), Some(Computed::Error("#DIV/0!")));
        assert_eq!(eval(&cells, "B6"), Some(Computed::Number(0.0)));
        assert_eq!(eval(&cells, "B7"), Some(Computed::Number(2.35)));
        assert_eq!(eval(&cells, "B8"), Some(Computed::Number(4.0)));
        assert_eq!(eval(&cells, "B9"), Some(Computed::Number(5.0)));
        assert_eq!(
            eval(&cells, "C1"),
            None,
            "unsupported functions stay uncached"
        );
        assert_eq!(eval(&cells, "C2"), None, "cycles stay uncached");
        assert_eq!(eval(&cells, "C4"), Some(Computed::Number(1.0)));
    }

    #[test]
    fn formats_numbers_like_general_format() {
        assert_eq!(format_number(3.0), "3");
        assert_eq!(format_number(0.1 + 0.2), "0.3");
        assert_eq!(format_number(-2.5), "-2.5");
    }
}
