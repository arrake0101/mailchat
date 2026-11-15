fn main() {
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/32x32.png");
    println!("cargo:rerun-if-changed=icons/128x128.png");
    println!("cargo:rerun-if-changed=icons/128x128@2x.png");
    println!("cargo:rerun-if-changed=icons/icon.png");

    #[cfg(windows)]
    if setup_windows_shared_manifest() {
        let attrs = tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        tauri_build::try_build(attrs).expect("failed to run tauri-build");
        return;
    }

    tauri_build::build();
}

/// Windows 下启用 `tray-icon` / `muda` 后会链接 `comctl32.dll` v6（`SetWindowSubclass` / `DefSubclassProc`）。
/// 将 `Common-Controls 6.0.0.0` 清单从仅 `bin` 生效的资源库抽离为所有目标共享单次嵌入，
/// 既保证 `mailchat.exe` 无重复 `.rsrc` 合并警告，又让 `cargo test --lib` 正常加载 v6 控件库。
#[cfg(windows)]
fn setup_windows_shared_manifest() -> bool {
    const APP_MANIFEST_XML: &str = r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
</assembly>
"#;

    let Ok(out_dir) = std::env::var("OUT_DIR") else {
        return false;
    };
    let out_path = std::path::Path::new(&out_dir);
    let manifest_path = out_path.join("mailchat-common-controls.manifest");
    if std::fs::write(&manifest_path, APP_MANIFEST_XML).is_err() {
        return false;
    }

    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_env == "msvc" {
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg=/MANIFESTINPUT:{}",
            manifest_path.display()
        );
        return true;
    }

    if target_env == "gnu" {
        let rc_path = out_path.join("mailchat-manifest.rc");
        let obj_path = out_path.join("mailchat-manifest.res.o");
        let escaped_manifest = manifest_path.to_string_lossy().replace('\\', "\\\\");
        let rc_content = format!("#pragma code_page(65001)\n1 24 \"{escaped_manifest}\"\n");
        if std::fs::write(&rc_path, rc_content).is_err() {
            return false;
        }
        for tool in ["windres", "x86_64-w64-mingw32-windres"] {
            if let Ok(status) = std::process::Command::new(tool)
                .arg("--input")
                .arg(&rc_path)
                .arg("--output")
                .arg(&obj_path)
                .arg("--output-format=coff")
                .status()
            {
                if status.success() && obj_path.exists() {
                    println!("cargo:rustc-link-arg={}", obj_path.display());
                    return true;
                }
            }
        }
    }

    false
}
