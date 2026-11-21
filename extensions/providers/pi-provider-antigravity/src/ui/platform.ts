import { spawn } from "node:child_process";

export function openUrlInBrowser(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    if (process.platform === "win32") {
      // Avoid cmd shell metacharacter injection by launching rundll32 directly.
      const child = spawn("rundll32", ["url.dll,FileProtocolHandler", url], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return true;
    }
    const cmd = process.platform === "darwin" ? "open" : "xdg-open";
    const child = spawn(cmd, [url], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function copyToClipboard(text: string): boolean {
  try {
    const cmd =
      process.platform === "win32"
        ? { bin: "clip.exe", args: [] as string[] }
        : process.platform === "darwin"
          ? { bin: "pbcopy", args: [] as string[] }
          : { bin: "xclip", args: ["-selection", "clipboard"] };
    const child = spawn(cmd.bin, cmd.args, { stdio: ["pipe", "ignore", "ignore"] });
    child.stdin?.write(text);
    child.stdin?.end();
    return true;
  } catch {
    return false;
  }
}
