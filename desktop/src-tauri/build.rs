fn main() {
    // Must run before tauri_build/codegen: `tauri::generate_context!` reads
    // the frontendDist directory at compile time and fails when it is
    // missing. The repository root's .gitignore ignores `dist/`, so the
    // placeholder page is intentionally NOT tracked — any fresh checkout
    // regenerates it here, and Task 4's real Vite build output naturally
    // supersedes it (this is a no-op whenever index.html already exists).
    ensure_frontend_placeholder();
    // Same fresh-checkout hazard for the bundle's externalBin sidecar:
    // tauri's codegen validates the target-suffixed sidecar file exists
    // even for `cargo check`/`cargo test`, and real sidecars are never
    // committed (gitignored cross-builds from scripts/build-sidecars.sh).
    ensure_sidecar_placeholder();
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();

    if target_os == "windows" && target_env == "msvc" {
        let attrs = tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        tauri_build::try_build(attrs).expect("failed to run tauri-build");
        embed_manifest_for_msvc();
    } else {
        tauri_build::build();
    }
}

#[allow(dead_code)]
fn embed_manifest_for_msvc() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR set");
    let manifest = std::path::Path::new(&manifest_dir).join("windows-app-manifest.xml");

    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
}

fn ensure_sidecar_placeholder() {
    // Without a target triple there is nothing to name; tauri_build will
    // surface its own error in that case.
    let Ok(target) = std::env::var("TARGET") else {
        return;
    };
    if target.is_empty() {
        return;
    }
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR set");
    let binaries_dir = std::path::Path::new(&manifest_dir).join("binaries");
    let is_windows = target.contains("windows");
    let name = if is_windows {
        format!("ainovel-engine-{target}.exe")
    } else {
        format!("ainovel-engine-{target}")
    };
    let sidecar = binaries_dir.join(&name);

    if !sidecar.exists() {
        std::fs::create_dir_all(&binaries_dir).unwrap_or_else(|e| {
            panic!(
                "cannot create sidecar binaries dir {}: {e}",
                binaries_dir.display()
            )
        });
        // A stub that fails loudly if ever spawned instead of silently
        // doing nothing. Real sidecars (built by
        // desktop/scripts/build-sidecars.sh) always take precedence — this
        // only ever creates the file when it is missing.
        let stub = if is_windows {
            "placeholder sidecar - build the real engine with desktop/scripts/build-sidecars.sh\r\n".to_string()
        } else {
            "#!/bin/sh\necho 'placeholder sidecar - build the real engine with desktop/scripts/build-sidecars.sh' >&2\nexit 127\n".to_string()
        };
        std::fs::write(&sidecar, stub).unwrap_or_else(|e| {
            panic!(
                "cannot write placeholder sidecar {}: {e}",
                sidecar.display()
            )
        });
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&sidecar, std::fs::Permissions::from_mode(0o755))
                .unwrap_or_else(|e| {
                    panic!(
                        "cannot make placeholder sidecar executable {}: {e}",
                        sidecar.display()
                    )
                });
        }
        println!(
            "cargo:warning=generated placeholder sidecar {} (real engine: desktop/scripts/build-sidecars.sh)",
            sidecar.display()
        );
    }

    // Watch the binaries directory so a warm cache regenerates a deleted
    // placeholder before tauri_build re-checks externalBin existence.
    println!("cargo:rerun-if-changed={}", binaries_dir.display());
}

fn ensure_frontend_placeholder() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR set");
    let dist_dir = std::path::Path::new(&manifest_dir).join("../frontend/dist");
    let index = dist_dir.join("index.html");

    if !index.exists() {
        std::fs::create_dir_all(&dist_dir).unwrap_or_else(|e| {
            panic!(
                "cannot create frontend dist dir {}: {e}",
                dist_dir.display()
            )
        });
        std::fs::write(&index, PLACEHOLDER_HTML)
            .unwrap_or_else(|e| panic!("cannot write placeholder {}: {e}", index.display()));
        println!(
            "cargo:warning=generated placeholder frontendDist page at {} (real frontend lands with task 4)",
            index.display()
        );
    }

    // Watch the dist directory (not just the file) so deleting the
    // placeholder on a warm cache still reruns this script and regenerates
    // it before rustc re-expands generate_context!.
    println!("cargo:rerun-if-changed={}", dist_dir.display());
}

const PLACEHOLDER_HTML: &str = r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AI Novel Desktop</title>
  </head>
  <body>
    <!--
      Placeholder frontendDist page, generated by build.rs when missing.
      Task 4 replaces desktop/frontend with the real Svelte app built into
      desktop/frontend/dist; until then this stub only exists so
      `cargo check` / `cargo test` can embed a valid context without a
      Node toolchain.
    -->
    <h1>AI Novel Desktop</h1>
    <p>Rust shell is running. The Svelte frontend lands in task 4.</p>
  </body>
</html>
"#;
