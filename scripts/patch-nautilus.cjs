// Nautilus 1.1.0 discards Aquarius validation details through string coercion.
// Keep this version-checked patch until an upstream release preserves them.
const { readFileSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');

const root = join(dirname(require.resolve('@deltadao/nautilus')), '..');
const { version } = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8'),
);
if (version !== '1.1.0') {
  throw new Error(
    `Review the Nautilus validation-error patch for version ${version}`,
  );
}

const original =
  'throw new Error(`Validating Metadata failed: ${validateResult?.errors}`);';
const patched =
  'throw Object.assign(new Error(`Validating Metadata failed: ${typeof validateResult?.errors === "string" ? validateResult.errors : JSON.stringify(validateResult?.errors)}`), { status: 400, details: validateResult?.errors });';
// 'throw new Error(`Validating Metadata failed: ${typeof validateResult?.errors === "string" ? validateResult.errors : JSON.stringify(validateResult?.errors)}`)'

for (const format of ['_cjs', '_esm']) {
  const file = join(root, format, 'publish', 'index.js');
  const source = readFileSync(file, 'utf8');
  if (source.includes(patched)) continue;
  if (source.split(original).length !== 2) {
    throw new Error(
      `Unexpected Nautilus source in ${file}; review the validation-error patch`,
    );
  }
  writeFileSync(file, source.replace(original, patched));
}
