#!/bin/bash
set -e

cd "$(dirname "$0")/.."

echo "==> Compiling TypeScript..."
npx tsc standard-miner/continuous-miner.ts --outDir dist --esModuleInterop --resolveJsonModule --module commonjs --target es2020 --skipLibCheck

echo "==> Inlining IDL into compiled JS..."
node -e "
const fs = require('fs');
const idl = fs.readFileSync('target/idl/pow_protocol.json', 'utf-8').trim();
let js = fs.readFileSync('dist/continuous-miner.js', 'utf-8');

// Replace the two lines: const idlPath = ...; const idl = ...;
js = js.replace(
  /const idlPath = .*pow_protocol\.json.*;\n\s*const idl = .*readFileSync\(idlPath.*;\n/,
  'const idl = ' + idl + ';\n'
);

fs.writeFileSync('dist/continuous-miner.js', js);

// Verify
if (js.includes('idlPath')) {
  console.error('ERROR: IDL not inlined, idlPath still present');
  process.exit(1);
}
console.log('IDL inlined successfully');
"

echo "==> Packaging Windows exe..."
npx @yao-pkg/pkg dist/continuous-miner.js --targets node18-win-x64 --output hashish-miner.exe

echo "==> Done! hashish-miner.exe ($(du -h hashish-miner.exe | cut -f1))"
