//! Run the user's TeX installation on the host that owns the workspace.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use openbitfun_core::agentic::WorkspaceBinding;
use openbitfun_core::service::remote_ssh::workspace_state::get_remote_workspace_manager;
use openbitfun_services_core::{
    bounded_fs::{is_symlink_or_reparse, read_bounded_file, BoundedFileRead},
    process_manager::create_tokio_command,
    process_tree::ProcessTreeChild,
};
use openbitfun_services_integrations::remote_ssh::{shell_quote_posix, SSHCommandOptions};
use serde::{Deserialize, Serialize};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::io::{AsyncRead, AsyncReadExt};

const COMPILE_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_PDF_BYTES: usize = 8 * 1024 * 1024;
const MAX_LOG_BYTES: usize = 16 * 1024;
const MISSING_COMPILER: &str = "latexmk is required on the machine that owns this workspace.";
const MISSING_PDF: &str = "LaTeX did not produce a PDF.";

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum LatexEngine {
    PdfLatex,
    XeLatex,
}

impl LatexEngine {
    fn arguments(self) -> [&'static str; 6] {
        [
            "-norc",
            match self {
                Self::PdfLatex => "-pdf",
                Self::XeLatex => "-xelatex",
            },
            "-no-shell-escape",
            "-interaction=nonstopmode",
            "-halt-on-error",
            "-file-line-error",
        ]
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileWorkspaceLatexRequest {
    workspace_id: String,
    file_path: String,
    engine: LatexEngine,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileWorkspaceLatexResponse {
    pdf_base64: String,
}

#[tauri::command]
pub async fn compile_workspace_latex(
    request: CompileWorkspaceLatexRequest,
) -> Result<CompileWorkspaceLatexResponse, String> {
    let workspace = WorkspaceBinding::resolve(&request.workspace_id)
        .await
        .map_err(|error| error.to_string())?;
    let pdf_base64 = if workspace.is_remote() {
        let connection_id = workspace
            .connection_id()
            .ok_or("Remote workspace is disconnected.")?;
        compile_remote(connection_id, &workspace.root_path_string(), &request).await?
    } else {
        BASE64.encode(compile_local(workspace.root_path(), &request).await?)
    };
    Ok(CompileWorkspaceLatexResponse { pdf_base64 })
}

// latexmk invokes TeX and bibliography programs via their command templates.
// Avoid names that are shell syntax in either a POSIX or Windows invocation.
fn source_stem(file_name: &str) -> Result<&str, String> {
    let (stem, extension) = file_name.rsplit_once('.').unwrap_or_default();
    if stem.is_empty() || !extension.eq_ignore_ascii_case("tex") {
        return Err("Select the main .tex file.".into());
    }
    if file_name
        .chars()
        .any(|c| c.is_control() || "'\"\\`$%!*?[]{}|&;<>".contains(c))
    {
        return Err("The LaTeX source filename contains unsupported characters.".into());
    }
    Ok(stem)
}

async fn compile_local(
    root: &Path,
    request: &CompileWorkspaceLatexRequest,
) -> Result<Vec<u8>, String> {
    let source = root.join(&request.file_path);
    let root = tokio::fs::canonicalize(root)
        .await
        .map_err(|error| error.to_string())?;
    let source = tokio::fs::canonicalize(source)
        .await
        .map_err(|error| error.to_string())?;
    if !source.starts_with(root)
        || !tokio::fs::metadata(&source)
            .await
            .is_ok_and(|entry| entry.is_file())
    {
        return Err("The main .tex file must be inside this workspace.".into());
    }
    let file_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("The LaTeX source filename is invalid.")?;
    let stem = source_stem(file_name)?;
    let directory = source
        .parent()
        .ok_or("The LaTeX source directory is invalid.")?;
    let build = tempfile::tempdir().map_err(|error| error.to_string())?;
    let mut command = create_tokio_command("latexmk");
    #[cfg(target_os = "macos")]
    if let Some(path) = openbitfun_services_core::process_manager::platform_path_env() {
        let entries = std::env::split_paths(&path).chain([Path::new("/Library/TeX/texbin").into()]);
        command.env(
            "PATH",
            std::env::join_paths(entries).map_err(|error| error.to_string())?,
        );
    }
    command
        .current_dir(directory)
        .args(request.engine.arguments())
        .arg(format!("-outdir={}", build.path().display()))
        .arg(format!("./{file_name}"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = ProcessTreeChild::spawn(&mut command)
        .await
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                MISSING_COMPILER.into()
            } else {
                format!("Could not start latexmk: {error}")
            }
        })?;
    let stdout = child
        .take_stdout()
        .ok_or("Could not capture LaTeX output.")?;
    let stderr = child
        .take_stderr()
        .ok_or("Could not capture LaTeX errors.")?;
    let (status, stdout, stderr) = tokio::time::timeout(COMPILE_TIMEOUT, async {
        tokio::try_join!(child.wait(), read_log_tail(stdout), read_log_tail(stderr))
    })
    .await
    .map_err(|_| "LaTeX compilation timed out.")?
    .map_err(|error| error.to_string())?;
    if !status.success() {
        let log = format!("{stdout}\n{stderr}");
        return Err(format!("latexmk exited with {status}.\n{}", log.trim()));
    }
    drop(child);

    let pdf = build.path().join(format!("{stem}.pdf"));
    tokio::task::spawn_blocking(move || {
        let _build = build;
        let metadata = std::fs::symlink_metadata(&pdf).map_err(|_| MISSING_PDF)?;
        if !metadata.is_file() || is_symlink_or_reparse(&metadata) {
            return Err(MISSING_PDF.into());
        }
        match read_bounded_file(&pdf, MAX_PDF_BYTES).map_err(|error| error.to_string())? {
            BoundedFileRead::Content(bytes) if bytes.starts_with(b"%PDF-") => Ok(bytes),
            BoundedFileRead::Content(_) => Err(MISSING_PDF.into()),
            BoundedFileRead::TooLarge => Err("The PDF exceeds the 8 MiB preview limit.".into()),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

async fn read_log_tail(mut reader: impl AsyncRead + Unpin) -> std::io::Result<String> {
    let mut tail = Vec::with_capacity(MAX_LOG_BYTES);
    let mut chunk = [0; 4096];
    loop {
        let size = reader.read(&mut chunk).await?;
        if size == 0 {
            return Ok(String::from_utf8_lossy(&tail).into_owned());
        }
        let overflow = (tail.len() + size).saturating_sub(MAX_LOG_BYTES);
        tail.drain(..overflow);
        tail.extend_from_slice(&chunk[..size]);
    }
}

fn remote_build_command(root: &str, path: &str, engine: LatexEngine) -> Result<String, String> {
    if path.chars().any(char::is_control) || path.split('/').any(|part| part == "..") {
        return Err("The main .tex file must be inside this workspace.".into());
    }
    let root = root.trim_end_matches('/');
    let relative = if path.starts_with('/') {
        path.strip_prefix(root)
            .and_then(|value| value.strip_prefix('/'))
            .ok_or("The main .tex file must be inside this workspace.")?
    } else {
        path
    };
    let (directory, file_name) = relative.rsplit_once('/').unwrap_or(("", relative));
    let stem = source_stem(file_name)?;
    let root_path = format!("{root}/");
    let directory_path = format!("{root_path}{directory}");
    let script = format!(
        r#"set -eu
root=$(CDPATH= cd -P -- {root} && pwd -P)
CDPATH= cd -P -- {directory}
case "$PWD/" in
    "${{root%/}}/"*) ;;
    *) echo "The main .tex file must be inside this workspace." >&2; exit 1 ;;
esac
source={source}
[ -f "$source" ] && [ ! -L "$source" ] || {{ echo "The main .tex file is unavailable." >&2; exit 1; }}
PATH="$PATH:/Library/TeX/texbin"
export PATH
command -v latexmk >/dev/null || {{ echo "{MISSING_COMPILER}" >&2; exit 127; }}
build=$(mktemp -d /tmp/openbitfun-latex.XXXXXXXX)
trap 'rm -rf -- "$build"' EXIT
trap 'exit 124' HUP INT TERM
if latexmk {arguments} "-outdir=$build" "$source" </dev/null >"$build/compile.log" 2>&1; then
    pdf="$build/"{pdf}
    [ -f "$pdf" ] && [ ! -L "$pdf" ] || {{ echo "{MISSING_PDF}" >&2; exit 1; }}
    [ "$(wc -c < "$pdf")" -le {MAX_PDF_BYTES} ] || {{ echo "The PDF exceeds the 8 MiB preview limit." >&2; exit 1; }}
    base64 < "$pdf"
else
    tail -c {MAX_LOG_BYTES} "$build/compile.log" >&2
    exit 1
fi"#,
        root = shell_quote_posix(&root_path),
        directory = shell_quote_posix(&directory_path),
        source = shell_quote_posix(&format!("./{file_name}")),
        arguments = engine.arguments().join(" "),
        pdf = shell_quote_posix(&format!("{stem}.pdf")),
    );
    Ok(format!("sh -c {}", shell_quote_posix(&script)))
}

async fn compile_remote(
    connection_id: &str,
    root: &str,
    request: &CompileWorkspaceLatexRequest,
) -> Result<String, String> {
    let command = remote_build_command(root, &request.file_path, request.engine)?;
    let manager = get_remote_workspace_manager().ok_or("Remote workspace is unavailable.")?;
    let ssh = manager
        .get_ssh_manager()
        .await
        .ok_or("Remote workspace is disconnected.")?;
    let result = ssh
        .execute_command_with_options(
            connection_id,
            &command,
            SSHCommandOptions {
                timeout_ms: Some(COMPILE_TIMEOUT.as_millis() as u64),
                ..Default::default()
            },
        )
        .await
        .map_err(|error| error.to_string())?;
    if result.timed_out {
        return Err("LaTeX compilation timed out on the workspace host.".into());
    }
    if result.interrupted || result.exit_code != 0 {
        return Err(format!(
            "Remote LaTeX compilation failed.\n{}",
            result.stderr.trim()
        ));
    }
    let encoded: String = result
        .stdout
        .chars()
        .filter(|c| !c.is_ascii_whitespace())
        .collect();
    // The remote shell limits the output before encoding it. Recheck it before
    // accepting the result from the workspace host.
    if encoded.len() > MAX_PDF_BYTES.div_ceil(3) * 4 {
        return Err("The PDF exceeds the 8 MiB preview limit.".into());
    }
    let pdf = BASE64.decode(&encoded).map_err(|_| MISSING_PDF)?;
    if pdf.len() > MAX_PDF_BYTES || !pdf.starts_with(b"%PDF-") {
        return Err(MISSING_PDF.into());
    }
    Ok(encoded)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compile_paths_and_names_remain_workspace_scoped() {
        for path in [
            "/paper-other/main.tex",
            "../main.tex",
            "/paper/chapters/../main.tex",
            "draft.pdf",
            "unsafe%name.tex",
        ] {
            assert!(
                remote_build_command("/paper", path, LatexEngine::PdfLatex).is_err(),
                "{path}"
            );
        }
        assert!(remote_build_command(
            "/paper's folder",
            "/paper's folder/manuscript draft.tex",
            LatexEngine::XeLatex
        )
        .is_ok());
    }

    #[tokio::test]
    #[ignore = "requires a working latexmk and TeX installation"]
    async fn builds_a_paper_without_replacing_workspace_files() {
        let root = tempfile::tempdir().unwrap();
        let file_path = "main draft.tex";
        let source = root.path().join(file_path);
        std::fs::write(
            &source,
            r"\documentclass{article}
\begin{document}
\input{section}
\cite{knuth1984}
\bibliographystyle{plain}
\bibliography{refs}
\end{document}",
        )
        .unwrap();
        std::fs::write(root.path().join("section.tex"), "An equation: $E = mc^2$.").unwrap();
        std::fs::write(
            root.path().join("refs.bib"),
            "@book{knuth1984, title={The TeXbook}, author={Donald Knuth}, year={1984}, publisher={Addison-Wesley}}",
        ).unwrap();
        std::fs::write(
            root.path().join("latexmkrc"),
            "die 'Project rc must not run';",
        )
        .unwrap();
        let previous_pdf = root.path().join("main draft.pdf");
        std::fs::write(&previous_pdf, "previous build").unwrap();

        let request = CompileWorkspaceLatexRequest {
            workspace_id: "fixture".into(),
            file_path: file_path.into(),
            engine: LatexEngine::PdfLatex,
        };
        let pdf = compile_local(root.path(), &request).await.unwrap();
        assert!(pdf.starts_with(b"%PDF-"));
        assert!(!root.path().join("main draft.aux").exists());
        assert_eq!(
            std::fs::read_to_string(previous_pdf).unwrap(),
            "previous build"
        );

        #[cfg(unix)]
        {
            // Exercise the POSIX build command independently of the SSH transport.
            let command = remote_build_command(
                root.path().to_str().unwrap(),
                file_path,
                LatexEngine::XeLatex,
            )
            .unwrap();
            let output = create_tokio_command("sh")
                .arg("-c")
                .arg(command)
                .output()
                .await
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let encoded: Vec<u8> = output
                .stdout
                .into_iter()
                .filter(|byte| !byte.is_ascii_whitespace())
                .collect();
            assert!(BASE64.decode(encoded).unwrap().starts_with(b"%PDF-"));
        }

        std::fs::write(
            &source,
            r"\documentclass{article}\begin{document}\undefinedcommand\end{document}",
        )
        .unwrap();
        let error = compile_local(root.path(), &request).await.unwrap_err();
        assert!(error.contains("Undefined control sequence"), "{error}");
    }
}
