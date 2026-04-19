const { spawnSync } = require("child_process");

function run() {
  if (process.platform !== "linux") {
    console.log("[postinstall] Skipping sqlite3 rebuild outside Linux.");
    return;
  }

  console.log("[postinstall] Rebuilding sqlite3 from source for Linux.");

  const result = spawnSync("npm", ["rebuild", "sqlite3", "--build-from-source"], {
    stdio: "inherit",
    shell: false
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

run();
