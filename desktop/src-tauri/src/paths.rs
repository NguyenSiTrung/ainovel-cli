//! Native path resolution and validation (macOS / Windows / Linux).
//!
//! Rules (design spec "Security and Platform Rules"):
//! * Paths that cross the Tauri command boundary are validated natively:
//!   absolute, normalized (no `..` components), and — where a directory is
//!   required — an existing directory on disk.
//! * The sidecar executable path is validated (existing file; executable bit
//!   on Unix) before the process is ever spawned, and the child is launched
//!   by direct exec with fixed arguments — no shell interpolation anywhere.
//! * The engine stays authoritative for project layout; `recognized` below
//!   is a best-effort hint (presence of the store's `meta/` directory), not
//!   a second opinion about project validity.

use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use tauri::Manager;

use crate::error::DesktopError;

/// Where a resolved sidecar binary came from (surfaced by `desktop_paths`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "source")]
pub enum SidecarSource {
    /// Explicit `AINOVEL_SIDECAR` override (dev story; see README.md).
    EnvOverride { path: PathBuf },
    /// `ainovel-engine-<target-triple>` next to the app executable — the
    /// externalBin naming convention used by the packaged app.
    ExeSiblingTriple { path: PathBuf },
    /// `ainovel-engine` (`.exe` on Windows) next to the app executable.
    ExeSiblingPlain { path: PathBuf },
}

impl SidecarSource {
    pub fn path(&self) -> &Path {
        match self {
            SidecarSource::EnvOverride { path }
            | SidecarSource::ExeSiblingTriple { path }
            | SidecarSource::ExeSiblingPlain { path } => path,
        }
    }
}

/// Best-effort target triple of the running shell, used to locate the
/// sidecar next to the executable with the externalBin naming convention.
pub fn target_triple() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("macos", "x86_64") => "x86_64-apple-darwin",
        ("linux", "x86_64") => "x86_64-unknown-linux-gnu",
        ("linux", "aarch64") => "aarch64-unknown-linux-gnu",
        ("windows", "x86_64") => "x86_64-pc-windows-msvc",
        ("windows", "aarch64") => "aarch64-pc-windows-msvc",
        (os, arch) => {
            // Unknown combination: return a marker that will simply not match
            // a sibling file; the env override still works.
            let _ = (os, arch);
            "unknown-target"
        }
    }
}

/// Candidate sidecar file names (in resolution order) for the current
/// platform. Windows appends `.exe` to BOTH names: Tauri's `externalBin`
/// convention keeps the target triple in the bundled name
/// (`ainovel-engine-x86_64-pc-windows-msvc.exe`), so the triple candidate
/// must carry the suffix too.
fn sidecar_candidate_names() -> [String; 2] {
    let exe_suffix = if cfg!(windows) { ".exe" } else { "" };
    [
        format!("ainovel-engine-{}{exe_suffix}", target_triple()),
        format!("ainovel-engine{exe_suffix}"),
    ]
}

/// Resolve the sidecar binary path.
///
/// Order:
/// 1. `AINOVEL_SIDECAR` env var (absolute or cwd-relative; validated).
/// 2. `ainovel-engine-<triple>` (`.exe` on Windows) next to the current
///    executable — the Tauri externalBin bundled name.
/// 3. `ainovel-engine` (`ainovel-engine.exe` on Windows) next to the
///    current executable.
///
/// Returns a structured [`CODE_INVALID_PATH`] error when nothing resolves.
pub fn resolve_sidecar_path(
    env_value: Option<&str>,
    exe_dir: Option<&Path>,
) -> Result<SidecarSource, DesktopError> {
    if let Some(raw) = env_value.map(str::trim).filter(|s| !s.is_empty()) {
        let path = if Path::new(raw).is_absolute() {
            PathBuf::from(raw)
        } else {
            std::env::current_dir()
                .map_err(|e| DesktopError::sidecar(format!("cannot resolve cwd: {e}")))?
                .join(raw)
        };
        validate_executable(&path).map_err(|e| {
            e.with_details(serde_json::json!({ "env": "AINOVEL_SIDECAR", "path": raw }))
        })?;
        return Ok(SidecarSource::EnvOverride { path });
    }

    let Some(dir) = exe_dir else {
        return Err(DesktopError::sidecar(
            "cannot locate the sidecar binary: no executable directory available",
        ));
    };

    let candidates = sidecar_candidate_names();
    let sources = [
        SidecarSource::ExeSiblingTriple {
            path: dir.join(&candidates[0]),
        },
        SidecarSource::ExeSiblingPlain {
            path: dir.join(&candidates[1]),
        },
    ];
    for candidate in sources {
        if validate_executable(candidate.path()).is_ok() {
            return Ok(candidate);
        }
    }
    Err(DesktopError::sidecar(format!(
        "sidecar binary not found next to the app executable (looked for {} then {}); \
         set AINOVEL_SIDECAR to point at a built engine binary",
        candidates[0], candidates[1]
    )))
}

/// Validate that `path` is an existing, non-directory executable file.
/// On Unix the executable bit must be set.
pub fn validate_executable(path: &Path) -> Result<PathBuf, DesktopError> {
    let meta = std::fs::metadata(path).map_err(|e| {
        DesktopError::sidecar(format!(
            "sidecar binary {:?} is not accessible: {e}",
            path.display()
        ))
    })?;
    if !meta.is_file() {
        return Err(DesktopError::sidecar(format!(
            "sidecar binary {:?} is not a regular file",
            path.display()
        )));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 == 0 {
            return Err(DesktopError::sidecar(format!(
                "sidecar binary {:?} is not executable",
                path.display()
            )));
        }
    }
    Ok(path.to_path_buf())
}

/// Reject non-absolute or non-normalized paths (any `..` component, empty
/// segments). Returns the normalized form (no trailing separator).
///
/// This is the traversal guard for every path crossing the IPC boundary:
/// relative paths and parent-relative segments are refused instead of being
/// resolved, so a frontend payload can never redirect the engine into an
/// arbitrary system location through shell-side path joining.
pub fn validate_absolute_normalized(raw: &str) -> Result<PathBuf, DesktopError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(DesktopError::invalid_path("path must not be empty"));
    }
    let path = Path::new(trimmed);
    if !path.is_absolute() {
        return Err(DesktopError::invalid_path(format!(
            "path must be absolute: {trimmed}"
        )));
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component.as_os_str())
            }
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(DesktopError::invalid_path(format!(
                    "path must not contain '..' segments: {trimmed}"
                )))
            }
        }
    }
    Ok(normalized)
}

/// Report produced by `desktop_validate_project_dir`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDirReport {
    /// The normalized path as accepted by the engine.
    pub path: PathBuf,
    /// Whether the directory looks like an existing engine project
    /// (best-effort: store `meta/` directory present). The engine remains
    /// authoritative for project validity.
    pub recognized: bool,
}

/// Validate a directory the frontend wants to open/create a project in:
/// absolute + normalized (see [`validate_absolute_normalized`]), an existing
/// directory on disk, not a symlink-escaped oddity (canonical form is
/// reported through the engine, which owns locking).
pub fn validate_project_dir(raw: &str) -> Result<ProjectDirReport, DesktopError> {
    let path = validate_absolute_normalized(raw)?;
    let meta = std::fs::metadata(&path).map_err(|e| {
        DesktopError::invalid_path(format!(
            "project directory {:?} is not accessible: {e}",
            path.display()
        ))
    })?;
    if !meta.is_dir() {
        return Err(DesktopError::invalid_path(format!(
            "project path {:?} is not a directory",
            path.display()
        )));
    }
    // Best-effort marker only: the Go store lays projects out with a meta/
    // directory. Never reject on this — the engine decides project validity.
    let recognized = path.join("meta").is_dir();
    Ok(ProjectDirReport { path, recognized })
}

/// Default directory offered to users for new projects:
/// `<home>/Documents/Novels` on every platform (mirrored by the native
/// dialog default in the frontend).
pub fn default_projects_dir(home: &Path) -> PathBuf {
    home.join("Documents").join("Novels")
}

/// Native app data directory (Tauri path resolver):
/// macOS `~/Library/Application Support/dev.ainovel.desktop`,
/// Windows `%APPDATA%`, Linux `$XDG_DATA_HOME`/`~/.local/share`.
pub fn app_data_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, DesktopError> {
    app.path()
        .app_data_dir()
        .map_err(|e| DesktopError::internal(format!("cannot resolve app data dir: {e}")))
}

/// Create `dir` (and parents) if missing; returns the existing path.
pub fn ensure_dir(dir: &Path) -> Result<PathBuf, DesktopError> {
    std::fs::create_dir_all(dir).map_err(|e| {
        DesktopError::invalid_path(format!("cannot create {:?}: {e}", dir.display()))
    })?;
    Ok(dir.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::CODE_INVALID_PATH;

    #[test]
    fn absolute_normalized_accepts_and_normalizes() {
        let p = validate_absolute_normalized("/Users/demo/Novels/First-Novel/").unwrap();
        assert_eq!(p, PathBuf::from("/Users/demo/Novels/First-Novel"));
        // CurDir segments are collapsed, not rejected.
        let p = validate_absolute_normalized("/a/./b").unwrap();
        assert_eq!(p, PathBuf::from("/a/b"));
    }

    #[test]
    fn rejects_relative_and_parent_traversal() {
        assert!(validate_absolute_normalized("Novels/First").is_err());
        assert!(validate_absolute_normalized("").is_err());
        let err = validate_absolute_normalized("/home/user/../root/secret").unwrap_err();
        assert_eq!(err.code, CODE_INVALID_PATH);
        assert!(err.message.contains(".."));
        assert!(validate_absolute_normalized("/tmp/x/../../etc/passwd").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_paths() {
        assert!(validate_absolute_normalized("C:\\Users\\demo\\Novels").is_ok());
        assert!(validate_absolute_normalized("C:\\Users\\..\\demo").is_err());
    }

    #[test]
    fn validate_executable_rejects_missing_and_non_executables() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("nope");
        assert!(validate_executable(&missing).is_err());
        let plain = tmp.path().join("plain.txt");
        std::fs::write(&plain, b"x").unwrap();
        #[cfg(unix)]
        assert!(validate_executable(&plain).is_err()); // no exec bit
        #[cfg(windows)]
        assert!(validate_executable(&plain).is_ok());
    }

    #[test]
    fn resolve_prefers_env_override() {
        let tmp = tempfile::tempdir().unwrap();
        let bin = tmp.path().join("engine");
        std::fs::write(&bin, b"#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let resolved =
            resolve_sidecar_path(Some(bin.to_str().unwrap()), Some(tmp.path().into())).unwrap();
        assert_eq!(resolved, SidecarSource::EnvOverride { path: bin.clone() });

        // Sibling lookup falls back to the plain name.
        let plain = tmp.path().join("ainovel-engine");
        std::fs::write(&plain, b"#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&plain, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let resolved = resolve_sidecar_path(None, Some(tmp.path())).unwrap();
        match resolved {
            SidecarSource::ExeSiblingTriple { path } | SidecarSource::ExeSiblingPlain { path } => {
                assert_eq!(path, plain)
            }
            other => panic!("expected sibling resolution, got {other:?}"),
        }
    }

    #[test]
    fn sidecar_candidate_names_match_externalbin_convention() {
        let [triple_name, plain_name] = sidecar_candidate_names();
        if cfg!(windows) {
            // Tauri externalBin bundles the Windows sidecar as
            // `ainovel-engine-<triple>.exe`; the fallback keeps `.exe` too.
            assert_eq!(triple_name, format!("ainovel-engine-{}.exe", target_triple()));
            assert_eq!(plain_name, "ainovel-engine.exe");
        } else {
            assert_eq!(triple_name, format!("ainovel-engine-{}", target_triple()));
            assert_eq!(plain_name, "ainovel-engine");
            assert!(!triple_name.ends_with(".exe"));
        }
    }

    #[test]
    fn resolve_errors_when_nothing_found() {
        let tmp = tempfile::tempdir().unwrap();
        let err = resolve_sidecar_path(None, Some(tmp.path())).unwrap_err();
        assert_eq!(err.code, crate::error::CODE_SIDECAR_ERROR);
        assert!(err.message.contains("AINOVEL_SIDECAR"));
    }

    #[test]
    fn project_dir_report_recognizes_meta_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("Novel-One");
        std::fs::create_dir_all(dir.join("meta")).unwrap();
        let report = validate_project_dir(dir.to_str().unwrap()).expect("valid project dir");
        assert!(report.recognized);
        assert_eq!(report.path, dir);

        // Not-yet-a-project directories are still valid open targets; only
        // layout hints differ. Missing directories are rejected.
        let bare = tmp.path().join("Bare");
        std::fs::create_dir_all(&bare).unwrap();
        assert!(
            !validate_project_dir(bare.to_str().unwrap())
                .unwrap()
                .recognized
        );
        let missing = tmp.path().join("Missing");
        assert!(validate_project_dir(missing.to_str().unwrap()).is_err());
        // Files are not directories.
        let file = tmp.path().join("file.txt");
        std::fs::write(&file, b"x").unwrap();
        assert!(validate_project_dir(file.to_str().unwrap()).is_err());
    }

    #[test]
    fn default_projects_dir_shape() {
        assert_eq!(
            default_projects_dir(Path::new("/Users/demo")),
            PathBuf::from("/Users/demo/Documents/Novels")
        );
    }
}
