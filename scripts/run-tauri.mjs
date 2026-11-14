// 启动 Tauri CLI 前自动补齐 MinGW-w64、Cargo 环境变量并绕过本机代理访问 127.0.0.1
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { delimiter, resolve } from "node:path";

const extraBins = [
  "F:\\Scoop\\apps\\mingw\\current\\bin",
  "W:\\env\\rust\\rustup\\.cargo\\bin",
  "F:\\Scoop\\apps\\rustup\\current\\.cargo\\bin",
].filter((p) => existsSync(p));

const currentPath = process.env.PATH ?? process.env.Path ?? "";
const mergedPath = [...extraBins, currentPath].filter(Boolean).join(delimiter);
const noProxy = [process.env.NO_PROXY, "127.0.0.1,localhost"].filter(Boolean).join(",");

const env = {
  ...process.env,
  PATH: mergedPath,
  Path: mergedPath,
  ...(existsSync("W:\\env\\rust\\rustup\\.cargo") && !process.env.CARGO_HOME
    ? { CARGO_HOME: "W:\\env\\rust\\rustup\\.cargo" }
    : {}),
  ...(existsSync("W:\\env\\rust\\rustup\\.rustup") && !process.env.RUSTUP_HOME
    ? { RUSTUP_HOME: "W:\\env\\rust\\rustup\\.rustup" }
    : {}),
  ...(existsSync("F:\\Scoop\\apps\\mingw\\current\\bin") &&
  !process.env.RUSTUP_TOOLCHAIN &&
  !process.env.GITHUB_ACTIONS
    ? { RUSTUP_TOOLCHAIN: "stable-x86_64-pc-windows-gnu" }
    : {}),
  NO_PROXY: noProxy,
  no_proxy: noProxy,
};

const cliJs = resolve("node_modules", "@tauri-apps", "cli", "tauri.js");
const child = spawn(process.execPath, [cliJs, ...process.argv.slice(2)], {
  stdio: "inherit",
  env,
});

child.on("exit", (code) => process.exit(code ?? 0));
