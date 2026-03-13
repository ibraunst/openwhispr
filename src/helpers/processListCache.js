const debugLogger = require("./debugLogger");

const CACHE_TTL_MS = 5000;

class ProcessListCache {
  constructor() {
    this._cache = null;
    this._cacheTime = 0;
    this._pending = null;
  }

  async getProcessList() {
    const now = Date.now();
    if (this._cache && now - this._cacheTime < CACHE_TTL_MS) {
      return this._cache;
    }

    if (this._pending) return this._pending;

    this._pending = this._fetch(now);
    try {
      return await this._pending;
    } finally {
      this._pending = null;
    }
  }

  async _fetch(now) {
    try {
      let names;
      if (process.platform === "darwin") {
        // ps-list's `ps awwxo` format doesn't reliably list all processes on
        // recent macOS versions.  `ps aux` does, so parse it directly.
        const { execFile } = require("child_process");
        const { promisify } = require("util");
        const exec = promisify(execFile);
        const { stdout } = await exec("ps", ["aux"], { maxBuffer: 64_000_000, encoding: "utf8" });
        names = stdout
          .trim()
          .split("\n")
          .slice(1) // skip header
          .map((line) => {
            // ps aux columns: USER PID %CPU %MEM VSZ RSS TT STAT STARTED TIME COMMAND
            // COMMAND is everything after the 10th column
            const parts = line.trim().split(/\s+/);
            const cmd = parts.slice(10).join(" ");
            // Extract the executable name from the command path
            const match = cmd.match(/^(?:\/[^\s]+\/)?([^\s/]+)/);
            return match ? match[1].toLowerCase() : "";
          })
          .filter(Boolean);
      } else {
        const psList = (await import("ps-list")).default;
        const procs = await psList();
        names = procs.map((p) => (p.name || "").toLowerCase());
      }
      this._cache = names;
      this._cacheTime = now;
      debugLogger.debug("Process list refreshed", { count: names.length }, "meeting");
      return names;
    } catch (err) {
      debugLogger.warn("Failed to fetch process list", { error: err.message }, "meeting");
      return [];
    }
  }

  invalidate() {
    this._cache = null;
    this._cacheTime = 0;
    this._pending = null;
  }
}

module.exports = new ProcessListCache();
