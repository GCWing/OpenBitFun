//! Bounded, non-executing analysis of complete POSIX-like shell commands.
//!
//! This is a task-constraint input analyzer, not a shell interpreter or a sandbox.
//! Unknown execution inputs never become an empty successful analysis. Spans are
//! half-open UTF-8 byte offsets in the original command (nested programs use the
//! containing input span, because shell quote removal changes byte coordinates).
mod lexer;
mod program;
use lexer::{Redirect, Token, Word};
use serde::Serialize;

pub const MAX_COMMAND_BYTES: usize = 1024 * 1024;
pub const MAX_DEPTH: usize = 32;
pub const MAX_NODES: usize = 32768;
const MAX_FACTS: usize = 4096;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AnalysisStatus {
    Supported,
    Unsupported,
    Invalid,
    ResourceLimit,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}
#[derive(Clone, Debug, Serialize)]
pub struct Issue {
    pub status: AnalysisStatus,
    pub reason: &'static str,
    pub span: Span,
}
#[derive(Clone, Debug, Serialize)]
pub struct FileOperation {
    pub operation: &'static str,
    pub path: String,
    pub cwd: String,
    pub source_span: Span,
}
#[derive(Clone, Debug, Serialize)]
pub struct DescriptorOperation {
    pub operation: &'static str,
    pub fd: String,
    pub target_fd: Option<String>,
    pub source_span: Span,
}
#[derive(Clone, Debug, Serialize)]
pub struct Analysis {
    pub parse_status: AnalysisStatus,
    pub file_operations: Vec<FileOperation>,
    pub descriptor_operations: Vec<DescriptorOperation>,
    pub unresolved_effects: Vec<Issue>,
}
impl Default for Analysis {
    fn default() -> Self {
        Self {
            parse_status: AnalysisStatus::Supported,
            file_operations: vec![],
            descriptor_operations: vec![],
            unresolved_effects: vec![],
        }
    }
}
impl Analysis {
    fn issue(&mut self, reason: &'static str, span: Span) {
        self.add_issue(Issue {
            status: AnalysisStatus::Supported,
            reason,
            span,
        });
    }
    fn add_issue(&mut self, issue: Issue) {
        if self.unresolved_effects.len() < 64 {
            self.unresolved_effects.push(issue.clone());
        }
        if issue.status == AnalysisStatus::ResourceLimit
            || self.parse_status == AnalysisStatus::Supported
        {
            self.parse_status = issue.status;
        }
    }
    fn file(&mut self, word: &Word, operation: &'static str, cwd: &Cwd) {
        if word.dynamic {
            self.issue("dynamic file target", word.span);
            return;
        }
        if word.value.is_empty() {
            self.issue("empty file target", word.span);
            return;
        }
        if self.file_operations.len() >= MAX_FACTS {
            self.add_issue(Issue {
                status: AnalysisStatus::ResourceLimit,
                reason: "file operation limit",
                span: word.span,
            });
            return;
        }
        if word.value.starts_with('/') {
            self.file_operations.push(FileOperation {
                operation,
                path: word.value.clone(),
                cwd: cwd.label(),
                source_span: word.span,
            });
        } else if let Some(paths) = &cwd.0 {
            for path in paths {
                if self.file_operations.len() >= MAX_FACTS {
                    self.add_issue(Issue {
                        status: AnalysisStatus::ResourceLimit,
                        reason: "file operation limit",
                        span: word.span,
                    });
                    break;
                }
                self.file_operations.push(FileOperation {
                    operation,
                    path: join(path, &word.value),
                    cwd: path.clone(),
                    source_span: word.span,
                });
            }
        } else {
            self.issue(
                "relative target after uncertain directory change",
                word.span,
            );
        }
    }
}
#[derive(Clone, Debug)]
struct Cwd(Option<Vec<String>>);
impl Cwd {
    fn label(&self) -> String {
        self.0
            .as_ref()
            .filter(|v| v.len() == 1)
            .map(|v| v[0].clone())
            .unwrap_or_else(|| "<uncertain>".into())
    }
    fn union(&self, other: &Self) -> Self {
        match (&self.0, &other.0) {
            (Some(a), Some(b)) => {
                let mut r = a.clone();
                for p in b {
                    if !r.contains(p) {
                        r.push(p.clone());
                    }
                }
                if r.len() > 8 {
                    Self(None)
                } else {
                    Self(Some(r))
                }
            }
            _ => Self(None),
        }
    }
    fn change(&self, word: &Word) -> Self {
        if word.dynamic {
            Self(None)
        } else if word.value.starts_with('/') {
            Self(Some(vec![word.value.clone()]))
        } else {
            Self(
                self.0
                    .as_ref()
                    .map(|v| v.iter().map(|p| join(p, &word.value)).collect()),
            )
        }
    }
}
fn join(cwd: &str, path: &str) -> String {
    if path.starts_with('/') {
        path.into()
    } else {
        format!("{}/{}", cwd.trim_end_matches('/'), path)
    }
}
#[derive(Clone)]
struct Flow {
    success: Cwd,
    failure: Cwd,
}
impl Flow {
    fn same(cwd: &Cwd) -> Self {
        Self {
            success: cwd.clone(),
            failure: cwd.clone(),
        }
    }
    fn after(&self) -> Cwd {
        self.success.union(&self.failure)
    }
}
#[derive(Debug)]
enum Ast {
    Command(Vec<Word>, Vec<Redirect>),
    Group(Box<Ast>, Vec<Redirect>),
    And(Box<Ast>, Box<Ast>),
    Or(Box<Ast>, Box<Ast>),
    Pipe(Vec<Ast>),
    Sequence(Vec<Ast>),
}
struct Parser {
    tokens: Vec<Token>,
    pos: usize,
}
impl Parser {
    fn op(&self) -> Option<&str> {
        match self.tokens.get(self.pos) {
            Some(Token::Op(op, _)) => Some(op),
            _ => None,
        }
    }
    fn error(&self, reason: &'static str) -> Issue {
        Issue {
            status: AnalysisStatus::Unsupported,
            reason,
            span: self
                .tokens
                .get(self.pos)
                .map(Token::span)
                .unwrap_or(Span { start: 0, end: 0 }),
        }
    }
    fn sequence(&mut self, depth: usize) -> Result<Ast, Issue> {
        if depth > MAX_DEPTH {
            return Err(Issue {
                status: AnalysisStatus::ResourceLimit,
                reason: "shell nesting limit",
                span: Span { start: 0, end: 0 },
            });
        }
        let mut list = vec![];
        while self.pos < self.tokens.len() && self.op() != Some(")") {
            if self.op() == Some("\n") {
                self.pos += 1;
                continue;
            }
            list.push(self.and_or(depth)?);
            match self.op() {
                Some(";" | "\n") => {
                    self.pos += 1;
                }
                Some(")") | None => break,
                _ => return Err(self.error("unsupported shell control operator")),
            }
        }
        Ok(Ast::Sequence(list))
    }
    fn and_or(&mut self, depth: usize) -> Result<Ast, Issue> {
        let mut a = self.pipeline(depth)?;
        let mut operators = 0;
        while matches!(self.op(), Some("&&" | "||")) {
            operators += 1;
            if operators > MAX_DEPTH {
                return Err(Issue {
                    status: AnalysisStatus::ResourceLimit,
                    reason: "shell control nesting limit",
                    span: self.tokens[self.pos].span(),
                });
            }
            let and = self.op() == Some("&&");
            self.pos += 1;
            while self.op() == Some("\n") {
                self.pos += 1;
            }
            let b = self.pipeline(depth)?;
            a = if and {
                Ast::And(Box::new(a), Box::new(b))
            } else {
                Ast::Or(Box::new(a), Box::new(b))
            };
        }
        Ok(a)
    }
    fn pipeline(&mut self, depth: usize) -> Result<Ast, Issue> {
        let mut list = vec![self.command(depth)?];
        while matches!(self.op(), Some("|" | "|&")) {
            self.pos += 1;
            while self.op() == Some("\n") {
                self.pos += 1;
            }
            list.push(self.command(depth)?);
        }
        if list.len() == 1 {
            Ok(list.pop().unwrap())
        } else {
            Ok(Ast::Pipe(list))
        }
    }
    fn command(&mut self, depth: usize) -> Result<Ast, Issue> {
        if self.op() == Some("(") {
            self.pos += 1;
            let a = self.sequence(depth + 1)?;
            if matches!(&a, Ast::Sequence(list) if list.is_empty()) {
                return Err(self.error("empty subshell"));
            }
            if self.op() != Some(")") {
                return Err(self.error("unclosed subshell"));
            }
            self.pos += 1;
            let mut redirects = vec![];
            while let Some(Token::Redirect(r)) = self.tokens.get(self.pos) {
                redirects.push(r.clone());
                self.pos += 1;
            }
            return Ok(Ast::Group(Box::new(a), redirects));
        }
        let mut words = vec![];
        let mut redirects = vec![];
        while let Some(t) = self.tokens.get(self.pos) {
            match t {
                Token::Word(w) => words.push(w.clone()),
                Token::Redirect(r) => redirects.push(r.clone()),
                _ => break,
            }
            self.pos += 1;
        }
        if words.is_empty() && redirects.is_empty() {
            return Err(self.error("missing command"));
        }
        Ok(Ast::Command(words, redirects))
    }
}

/// No filesystem access, process launch, environment expansion, or permission decision.
pub fn analyze(command: &str, shell_kind: &str, workdir: &str) -> Analysis {
    let mut result = Analysis::default();
    if !is_absolute_workdir(workdir) {
        result.add_issue(Issue {
            status: AnalysisStatus::Unsupported,
            reason: "non-POSIX working directory requires a shell path adapter",
            span: Span { start: 0, end: 0 },
        });
        return result;
    }
    analyze_into(
        command,
        shell_kind,
        &Cwd(Some(vec![workdir.into()])),
        0,
        &mut result,
    );
    result
}

/// Absolute POSIX (`/...`) or absolute Windows (`C:[/\\]...`, UNC `\\...`)
/// working directory. Host worktrees on Windows use drive-letter paths; these
/// are valid cwd inputs even though the path facts stay best-effort (path
/// joining is POSIX-only, and Windows shell path translation is not inferred).
fn is_absolute_workdir(workdir: &str) -> bool {
    workdir.starts_with('/')
        || workdir.starts_with("\\\\")
        || (workdir.len() >= 3
            && workdir.as_bytes()[0].is_ascii_alphabetic()
            && workdir.as_bytes()[1] == b':'
            && (workdir.as_bytes()[2] == b'/' || workdir.as_bytes()[2] == b'\\'))
}
fn analyze_into(command: &str, shell: &str, cwd: &Cwd, depth: usize, result: &mut Analysis) {
    let span = Span {
        start: 0,
        end: command.len(),
    };
    if command.len() > MAX_COMMAND_BYTES || depth > MAX_DEPTH {
        result.add_issue(Issue {
            status: AnalysisStatus::ResourceLimit,
            reason: "shell input or nesting limit",
            span,
        });
        return;
    }
    if !matches!(shell, "bash" | "sh" | "zsh" | "powershell" | "pwsh" | "cmd" | "ps") {
        result.add_issue(Issue {
            status: AnalysisStatus::Unsupported,
            reason: "unsupported shell dialect",
            span,
        });
        return;
    }
    // Windows shell dialects: the bash syntax oracle cannot parse PowerShell
    // sources, and the complete-shell guard would otherwise fail closed on
    // EVERY ExecCommand on Windows (`whoami` included). Keep the hard input
    // limits and NUL rejection, then treat the command as syntactically
    // supported with best-effort facts (no file-op attribution). Edit-constraint
    // policy still applies through the other tools and the exec policy layer.
    if matches!(shell, "powershell" | "pwsh" | "cmd" | "ps") {
        if command.contains('\0') {
            result.add_issue(Issue {
                status: AnalysisStatus::Invalid,
                reason: "NUL in shell source",
                span,
            });
        }
        return;
    }
    let tokens = match lexer::lex(command) {
        Ok(t) => t,
        Err(e) => {
            result.add_issue(e);
            return;
        }
    };
    let mut parser = Parser { tokens, pos: 0 };
    let ast = match parser.sequence(0) {
        Ok(ast) if parser.pos == parser.tokens.len() => ast,
        Ok(_) => {
            result.add_issue(parser.error("unexpected shell delimiter"));
            return;
        }
        Err(e) => {
            result.add_issue(e);
            return;
        }
    };
    visit(&ast, cwd, shell, depth, result);
}
fn visit(ast: &Ast, cwd: &Cwd, shell: &str, depth: usize, result: &mut Analysis) -> Flow {
    match ast {
        Ast::Command(w, r) => command(w, r, cwd, shell, depth, result),
        Ast::Group(a, r) => {
            redirects(r, cwd, shell, result);
            visit(a, cwd, shell, depth, result);
            Flow::same(cwd)
        }
        Ast::Sequence(list) => {
            let mut flow = Flow::same(cwd);
            for a in list {
                flow = visit(a, &flow.after(), shell, depth, result);
            }
            flow
        }
        Ast::And(a, b) => {
            let left = visit(a, cwd, shell, depth, result);
            let right = visit(b, &left.success, shell, depth, result);
            Flow {
                success: right.success,
                failure: left.failure.union(&right.failure),
            }
        }
        Ast::Or(a, b) => {
            let left = visit(a, cwd, shell, depth, result);
            let right = visit(b, &left.failure, shell, depth, result);
            Flow {
                success: left.success.union(&right.success),
                failure: right.failure,
            }
        }
        Ast::Pipe(list) => {
            for a in list {
                visit(a, cwd, shell, depth, result);
            }
            Flow::same(cwd)
        }
    }
}
fn redirects(rs: &[Redirect], cwd: &Cwd, shell: &str, result: &mut Analysis) {
    for r in rs {
        if r.word.executes || r.body.as_ref().is_some_and(|w| w.executes) {
            result.issue("executable expansion in redirection input", r.span);
        }
        if shell == "sh" && matches!(r.op.as_str(), "&>" | "&>>" | "<<<") {
            result.add_issue(Issue {
                status: AnalysisStatus::Unsupported,
                reason: "redirection outside supported sh subset",
                span: r.span,
            });
            continue;
        }
        match r.op.as_str() {
            ">" | ">>" | ">|" | "<>" | "&>" | "&>>" => result.file(
                &r.word,
                match r.op.as_str() {
                    ">>" | "&>>" => "append",
                    "<>" => "read_write_open",
                    _ => "write",
                },
                cwd,
            ),
            ">&" | "<&" => {
                if r.word.dynamic {
                    result.issue("dynamic descriptor or file target", r.span);
                    continue;
                }
                let v = &r.word.value;
                let number = v.trim_end_matches('-');
                if v == "-"
                    || (!number.is_empty()
                        && number.bytes().all(|c| c.is_ascii_digit())
                        && (v == number || v == &format!("{number}-")))
                {
                    if result.descriptor_operations.len() >= MAX_FACTS {
                        result.add_issue(Issue {
                            status: AnalysisStatus::ResourceLimit,
                            reason: "descriptor operation limit",
                            span: r.span,
                        });
                        continue;
                    }
                    result.descriptor_operations.push(DescriptorOperation {
                        operation: if v == "-" {
                            "close"
                        } else if v.ends_with('-') {
                            "move"
                        } else {
                            "copy"
                        },
                        fd: r
                            .fd
                            .clone()
                            .unwrap_or_else(|| if r.op == ">&" { "1" } else { "0" }.into()),
                        target_fd: (v != "-").then(|| number.into()),
                        source_span: r.span,
                    });
                } else if r.fd.is_none() && r.op == ">&" && shell != "sh" {
                    result.file(&r.word, "write", cwd);
                } else {
                    result.add_issue(Issue {
                        status: AnalysisStatus::Invalid,
                        reason: "non-numeric descriptor operand",
                        span: r.span,
                    });
                }
            }
            "<" | "<<" | "<<-" | "<<<" => {}
            _ => result.add_issue(Issue {
                status: AnalysisStatus::Unsupported,
                reason: "unsupported redirect",
                span: r.span,
            }),
        }
    }
}
fn basename(s: &str) -> &str {
    s.rsplit('/').next().unwrap_or(s)
}
fn command(
    words: &[Word],
    rs: &[Redirect],
    cwd: &Cwd,
    shell: &str,
    depth: usize,
    result: &mut Analysis,
) -> Flow {
    redirects(rs, cwd, shell, result);
    for w in words {
        if w.executes {
            result.issue("executable argument expansion", w.span);
        }
    }
    let mut index = words.iter().take_while(|w| w.assignment).count();
    // Prefix assignments such as CDPATH can alter cd semantics. Do not infer
    // a directory for relative cd when an execution environment is changed.
    loop {
        let Some(w) = words.get(index) else {
            return Flow::same(cwd);
        };
        if w.dynamic {
            result.issue("dynamic command name", w.span);
            return Flow::same(&Cwd(None));
        }
        match basename(&w.value) {
            "env" => {
                index += 1;
                while let Some(a) = words.get(index) {
                    if a.assignment {
                        index += 1;
                    } else if a.value == "--" {
                        index += 1;
                        break;
                    } else if a.value.starts_with('-') {
                        result.issue("unresolved env wrapper options", a.span);
                        return Flow::same(&Cwd(None));
                    } else {
                        break;
                    }
                }
            }
            "command"
                if words
                    .get(index + 1)
                    .is_some_and(|a| matches!(a.value.as_str(), "-v" | "-V")) =>
            {
                return Flow::same(cwd)
            }
            "command" | "nohup" | "exec" => {
                index += 1;
                if words.get(index).is_some_and(|a| a.value == "--") {
                    index += 1;
                }
                if words.get(index).is_some_and(|a| a.value.starts_with('-')) {
                    result.issue("unresolved execution wrapper options", w.span);
                    return Flow::same(&Cwd(None));
                }
            }
            "timeout" => {
                index += 1;
                if words
                    .get(index)
                    .is_none_or(|a| a.dynamic || a.value.starts_with('-'))
                {
                    result.issue("unresolved timeout wrapper", w.span);
                    return Flow::same(&Cwd(None));
                }
                index += 1;
            }
            _ => break,
        }
    }
    let w = &words[index];
    let name = basename(&w.value);
    let args = &words[index + 1..];
    if matches!(
        name,
        "if" | "then"
            | "else"
            | "fi"
            | "for"
            | "while"
            | "until"
            | "do"
            | "done"
            | "case"
            | "esac"
            | "function"
            | "{"
            | "}"
            | "!"
            | "[["
            | "(("
    ) {
        result.add_issue(Issue {
            status: AnalysisStatus::Unsupported,
            reason: "unsupported compound shell program",
            span: w.span,
        });
        return Flow::same(&Cwd(None));
    }
    if name == "cd" {
        // Bash's logical cd (including CDPATH, OLDPWD and symlink/.. cases)
        // cannot be replaced by physical path arithmetic. This first version
        // only propagates absolute cd operands without parent traversal.
        if args.len() != 1
            || !args[0].value.starts_with('/')
            || args[0].value.split('/').any(|part| part == "..")
        {
            return Flow {
                success: Cwd(None),
                failure: cwd.clone(),
            };
        }
        return Flow {
            success: cwd.change(&args[0]),
            failure: cwd.clone(),
        };
    }
    if matches!(name, "pushd" | "popd" | "source" | ".") {
        result.issue("unresolved shell state change", w.span);
        return Flow::same(&Cwd(None));
    }
    if matches!(
        name,
        "bash" | "sh" | "zsh" | "fish" | "ksh" | "python" | "python3" | "node"
    ) {
        interpreter(name, args, rs, cwd, depth, result, w.span);
        return Flow::same(cwd);
    }
    if matches!(
        name,
        "eval"
            | "xargs"
            | "patch"
            | "apply_patch"
            | "ruby"
            | "php"
            | "powershell"
            | "pwsh"
            | "cmd"
            | "sudo"
    ) {
        result.issue("unresolved executable program", w.span);
    }
    if name == "find"
        && args.iter().any(|a| {
            matches!(
                a.value.as_str(),
                "-delete" | "-exec" | "-execdir" | "-ok" | "-okdir"
            )
        })
    {
        result.issue("unresolved find effects", w.span);
    }
    if (name == "tar"
        && !args
            .iter()
            .any(|a| a.value == "--list" || a.value.starts_with('-') && a.value.contains('t')))
        || (name == "unzip" && !args.iter().any(|a| matches!(a.value.as_str(), "-l" | "-v")))
    {
        result.issue("unresolved archive effects", w.span);
    }
    if name == "awk"
        && args.iter().any(|a| {
            a.value.contains("system(") || a.value.contains('>') || a.value.contains("inplace")
        })
    {
        result.issue("unresolved awk program", w.span);
    }
    match name {
        "tee" | "touch" | "truncate" | "mkdir" | "rm" | "rmdir" | "unlink" | "mv" | "cp"
        | "install" | "ln" | "rsync" => {
            let paths = operands(name, args, result);
            if paths.is_empty() && name != "tee" {
                result.issue("missing or implicit mutation target", w.span);
            }
            match name {
                "cp" | "install" | "ln" | "rsync" => {
                    if let Some(p) = paths.last() {
                        result.file(p, "write", cwd);
                    }
                }
                "mv" => {
                    for (i, p) in paths.iter().enumerate() {
                        result.file(
                            p,
                            if i + 1 == paths.len() {
                                "write"
                            } else {
                                "delete"
                            },
                            cwd,
                        );
                    }
                }
                _ => {
                    for p in paths {
                        result.file(
                            p,
                            if matches!(name, "rm" | "rmdir" | "unlink") {
                                "delete"
                            } else {
                                "write"
                            },
                            cwd,
                        );
                    }
                }
            }
        }
        "dd" => {
            for a in args {
                if let Some(path) = a.value.strip_prefix("of=") {
                    let mut p = a.clone();
                    p.value = path.into();
                    result.file(&p, "write", cwd);
                }
            }
        }
        "sed" | "perl" => {
            if args.iter().any(|a| {
                a.value == "--in-place"
                    || a.value.starts_with("--in-place=")
                    || a.value.starts_with('-')
                        && !a.value.starts_with("--")
                        && a.value.contains('i')
            }) {
                let mut script = false;
                let mut files = 0;
                let mut i = 0;
                while i < args.len() {
                    let a = &args[i];
                    if matches!(a.value.as_str(), "-e" | "--expression") {
                        script = true;
                        i += 2;
                        continue;
                    }
                    if matches!(a.value.as_str(), "-f" | "--file") {
                        result.issue("unresolved editing program file", a.span);
                        i += 2;
                        continue;
                    }
                    if a.value.starts_with('-') {
                        if a.value.starts_with("-e") || a.value.starts_with("--expression=") {
                            script = true;
                        }
                        i += 1;
                        continue;
                    }
                    if !script {
                        script = true;
                    } else {
                        result.file(a, "write", cwd);
                        files += 1;
                    }
                    i += 1;
                }
                if files == 0 {
                    result.issue("unresolved in-place file operands", w.span);
                }
            }
            // sed's w/e and Perl program effects are not made safe by finding
            // one explicit in-place target.
            if name == "perl"
                || args.iter().any(|a| {
                    a.value.contains(";w ") || a.value.starts_with("w ") || a.value.ends_with("/e")
                })
            {
                result.issue("unresolved editing program effects", w.span);
            }
        }
        "git" => git(args, cwd, result, w.span),
        _ => {}
    }
    Flow::same(cwd)
}
fn operands<'a>(name: &str, args: &'a [Word], result: &mut Analysis) -> Vec<&'a Word> {
    let mut out = vec![];
    let mut i = 0;
    let mut flags = true;
    while i < args.len() {
        let a = &args[i];
        if flags && a.value == "--" {
            flags = false;
            i += 1;
            continue;
        }
        if flags && a.value.starts_with('-') {
            let takes = match name {
                "truncate" => matches!(a.value.as_str(), "-s" | "--size" | "-r" | "--reference"),
                "touch" => matches!(
                    a.value.as_str(),
                    "-r" | "--reference" | "-d" | "--date" | "-t"
                ),
                "mkdir" => matches!(a.value.as_str(), "-m" | "--mode"),
                _ => false,
            };
            if takes {
                i += 2;
                continue;
            }
            if matches!(name, "cp" | "mv" | "install" | "ln" | "rsync")
                && !matches!(
                    a.value.as_str(),
                    "-f" | "-r" | "-R" | "-a" | "-p" | "-v" | "-n" | "--force" | "--recursive"
                )
            {
                result.issue("unresolved mutation options", a.span);
            }
            if a.dynamic {
                result.issue("dynamic mutation options", a.span);
            }
            i += 1;
            continue;
        }
        out.push(a);
        i += 1;
    }
    out
}
fn git(args: &[Word], cwd: &Cwd, result: &mut Analysis, span: Span) {
    let mut i = 0;
    let mut base = cwd.clone();
    while let Some(a) = args.get(i) {
        if a.value == "-C" {
            if let Some(dir) = args.get(i + 1) {
                base = base.change(dir);
                i += 2;
                continue;
            }
        }
        if a.value.starts_with('-') {
            result.issue("unresolved git global options", a.span);
            return;
        }
        break;
    }
    let Some(sub) = args.get(i) else {
        return;
    };
    if sub.dynamic {
        result.issue("dynamic git operation", sub.span);
        return;
    }
    let rest = &args[i + 1..];
    match sub.value.as_str() {
        "rm" | "mv" => {
            let paths = operands(&sub.value, rest, result);
            for (j, p) in paths.iter().enumerate() {
                result.file(
                    p,
                    if sub.value == "rm" || j + 1 < paths.len() {
                        "delete"
                    } else {
                        "write"
                    },
                    &base,
                );
            }
        }
        "restore" => {
            let paths = operands("restore", rest, result);
            if paths.is_empty() {
                result.issue("implicit git worktree targets", span);
            }
            for p in paths {
                result.file(p, "write", &base);
            }
        }
        "checkout" => {
            if let Some(j) = rest.iter().position(|a| a.value == "--") {
                for p in &rest[j + 1..] {
                    result.file(p, "write", &base);
                }
            } else {
                result.issue("implicit git checkout targets", span);
            }
        }
        "switch" | "pull" | "merge" | "rebase" | "reset" | "stash" | "clean" | "cherry-pick"
        | "apply" | "am" => result.issue("implicit git worktree targets", span),
        _ => {}
    }
}
fn interpreter(
    name: &str,
    args: &[Word],
    rs: &[Redirect],
    cwd: &Cwd,
    depth: usize,
    result: &mut Analysis,
    span: Span,
) {
    let shell = matches!(name, "bash" | "sh" | "zsh" | "fish" | "ksh");
    let mut input = None;
    let mut external = false;
    let mut i = 0;
    while let Some(a) = args.get(i) {
        let code_flag = if shell {
            a.value.starts_with('-') && !a.value.starts_with("--") && a.value.contains('c')
        } else if name == "node" {
            matches!(a.value.as_str(), "-e" | "--eval" | "-p" | "--print")
        } else {
            a.value == "-c"
        };
        if code_flag {
            input = args.get(i + 1);
            if input.is_none() {
                result.issue("missing interpreter program", a.span);
            }
            break;
        }
        if a.value == "--" {
            external = args.get(i + 1).is_some();
            break;
        }
        if !a.value.starts_with('-') {
            external = true;
            break;
        }
        if !matches!(
            a.value.as_str(),
            "-" | "-s" | "-l" | "-u" | "-B" | "-I" | "-S" | "--noprofile" | "--norc"
        ) {
            result.issue("unresolved interpreter options", a.span);
        }
        i += 1;
    }
    if external {
        result.issue(
            "external interpreter program is not statically available",
            span,
        );
        return;
    }
    if input.is_none() {
        for r in rs {
            if r.fd.as_deref().is_none_or(|f| f == "0") {
                match r.op.as_str() {
                    "<<" | "<<-" => input = r.body.as_ref(),
                    "<<<" => input = Some(&r.word),
                    "<" | "<&" => input = None,
                    _ => {}
                }
            }
        }
    }
    let Some(input) = input else {
        result.issue("interpreter consumes unverified input", span);
        return;
    };
    if input.dynamic {
        result.issue("expanded interpreter program", input.span);
        return;
    }
    if shell {
        let mut nested = Analysis::default();
        analyze_into(&input.value, name, cwd, depth + 1, &mut nested);
        for op in &mut nested.file_operations {
            op.source_span = input.span;
        }
        for op in &mut nested.descriptor_operations {
            op.source_span = input.span;
        }
        for issue in &mut nested.unresolved_effects {
            issue.span = input.span;
        }
        for op in nested.file_operations {
            if result.file_operations.len() < MAX_FACTS {
                result.file_operations.push(op);
            } else {
                result.add_issue(Issue {
                    status: AnalysisStatus::ResourceLimit,
                    reason: "nested file operation limit",
                    span,
                });
                break;
            }
        }
        if result.descriptor_operations.len() + nested.descriptor_operations.len() > MAX_FACTS {
            result.add_issue(Issue {
                status: AnalysisStatus::ResourceLimit,
                reason: "nested descriptor operation limit",
                span,
            });
        }
        result.descriptor_operations.extend(
            nested
                .descriptor_operations
                .into_iter()
                .take(MAX_FACTS.saturating_sub(result.descriptor_operations.len())),
        );
        for e in nested.unresolved_effects {
            result.add_issue(e);
        }
    } else {
        let mut targets = vec![];
        let lower = input.value.to_ascii_lowercase();
        if name == "node" {
            program::push_node_mutation_targets(&mut targets, &input.value);
        } else {
            program::push_python_mutation_targets(&mut targets, &input.value);
        }
        for target in targets {
            let word = Word {
                value: target.path,
                dynamic: false,
                executes: false,
                quoted: true,
                assignment: false,
                span: input.span,
            };
            result.file(
                &word,
                match target.operation {
                    program::ShellMutationOperation::Write => "write",
                    program::ShellMutationOperation::Delete => "delete",
                },
                cwd,
            );
        }
        // Existing recognizers identify useful facts, not completeness. A known
        // literal write never cancels another dynamic write in the same program.
        if (name == "node" && program::node_segment_may_mutate(&lower))
            || (name != "node" && program::python_segment_may_mutate(&lower))
            || [
                "exec(",
                "eval(",
                "system(",
                "subprocess",
                "child_process",
                "shutil.",
                "os.remove",
                "os.chdir",
            ]
            .iter()
            .any(|s| lower.contains(s))
        {
            result.issue("interpreter effects cannot be fully resolved", input.span);
        }
    }
}

#[cfg(test)]
mod tests;
