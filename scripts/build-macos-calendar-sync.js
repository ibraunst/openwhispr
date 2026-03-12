const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const platform = process.platform;
if (platform !== 'darwin') {
  console.log('Skipping macOS calendar sync tool build (not on macOS)');
  process.exit(0);
}

const resourcesDir = path.join(__dirname, '..', 'resources', 'bin');
const srcDir = path.join(__dirname, 'src');
const sourceFile = path.join(srcDir, 'calendar-sync.swift');
const outputFile = path.join(resourcesDir, 'calendar-sync-mac');

try {
  if (!fs.existsSync(resourcesDir)) {
    fs.mkdirSync(resourcesDir, { recursive: true });
  }

  console.log(`Building macOS calendar sync tool...`);
  console.log(`Source: ${sourceFile}`);
  console.log(`Target: ${outputFile}`);

  execSync(`swiftc "${sourceFile}" -O -o "${outputFile}"`, {
    stdio: 'inherit'
  });

  console.log('Successfully built macOS calendar sync tool');
} catch (error) {
  console.error('Failed to build macOS calendar sync tool:', error.message);
  process.exit(1);
}
