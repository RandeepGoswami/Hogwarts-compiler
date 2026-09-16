/**
 * Dependency-free test runner: node test/autofix.test.js
 */
const { autofix } = require('../src/autofix');
const { compile } = require('../src/compiler');

let pass = 0, fail = 0;
function test(name, fn) {
  fn().then(() => { pass++; console.log(`  ok   ${name}`); })
      .catch((e) => { fail++; console.log(`  FAIL ${name}\n       ${e.message}`); });
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

async function run() {
console.log('\nLumos autofix tests\n');

await test('no errors: reports nothing to fix, code unchanged', async () => {
  const src = 'int main() { int a = 1; print(a); return 0; }';
  const r = await autofix(src, null);
  assert(r.fullyFixed && !r.changed, 'should report already-clean');
  assert(r.code === src, 'code should be untouched');
});

await test('unquotes a numeric string literal', async () => {
  const src = 'int main() { int count = "100"; print(count); return 0; }';
  const r = await autofix(src, null);
  assert(r.fullyFixed, 'should be fully fixed: ' + JSON.stringify(r.remainingErrors));
  const check = compile(r.code);
  assert(check.diagnostics.filter((d) => d.severity === 'error').length === 0, 'recompile must be clean');
});

await test('retypes a declaration when the string is genuinely text', async () => {
  const src = 'int main() { int count = "one hundred"; print(count); return 0; }';
  const r = await autofix(src, null);
  assert(r.fullyFixed, 'should be fully fixed: ' + JSON.stringify(r.remainingErrors));
  assert(/string count/.test(r.code), 'declaration should be retyped to string: ' + r.code);
});

await test('wraps a numeric value assigned to a string variable', async () => {
  const src = 'int main() { string label = 42; print(label); return 0; }';
  const r = await autofix(src, null);
  assert(r.fullyFixed, 'should be fully fixed: ' + JSON.stringify(r.remainingErrors));
  assert(/"42"/.test(r.code), 'value should be quoted: ' + r.code);
});

await test('removes const so a later reassignment is legal', async () => {
  const src = 'int main() { const int limit = 10; limit = 11; print(limit); return 0; }';
  const r = await autofix(src, null);
  assert(r.fullyFixed, 'should be fully fixed: ' + JSON.stringify(r.remainingErrors));
  assert(!/const int limit/.test(r.code), 'const should be removed: ' + r.code);
});

await test('declares a missing variable used in an expression', async () => {
  const src = 'int main() { int wrong = missing + 1; print(wrong); return 0; }';
  const r = await autofix(src, null);
  assert(r.fullyFixed, 'should be fully fixed: ' + JSON.stringify(r.remainingErrors));
  assert(/int missing = 0/.test(r.code), 'missing should be declared: ' + r.code);
});

await test('rewrites an untestable string condition', async () => {
  const src = 'int main() { string name = "Lumos"; if (name) { print(1); } return 0; }';
  const r = await autofix(src, null);
  assert(r.fullyFixed, 'should be fully fixed: ' + JSON.stringify(r.remainingErrors));
});

await test('changes a constant-zero divisor', async () => {
  const src = 'int main() { int r = 10 / 0; print(r); return 0; }';
  const r = await autofix(src, null);
  assert(r.fullyFixed, 'should be fully fixed: ' + JSON.stringify(r.remainingErrors));
  assert(!/\/ 0/.test(r.code), 'divisor should no longer be zero: ' + r.code);
});

await test('handles every error in the canonical demo program at once', async () => {
  const src = `int main() {
  int count = "one hundred";
  const int limit = 10;
  limit = 11;
  int wrong = missing + 1;
  double ratio = 10 / 0;
  string name = "Lumos";
  if (name) { print(1); }
  return 0;
}`;
  const before = compile(src);
  const beforeErrors = before.diagnostics.filter((d) => d.severity === 'error');
  assert(beforeErrors.length >= 5, 'fixture should start with several errors');

  const r = await autofix(src, null);
  assert(r.fullyFixed, 'should resolve every error deterministically: ' + JSON.stringify(r.remainingErrors));
  const after = compile(r.code);
  assert(after.diagnostics.filter((d) => d.severity === 'error').length === 0, 'recompile must be fully clean');
});

await test('stacks multiple independent fixes when they collide on one physical line', async () => {
  const src = 'int main() { int count = "one hundred"; const int limit = 10; limit = 11; int wrong = missing + 1; double ratio = 10 / 0; string name = "Lumos"; if (name) { print(1); } return 0; }';
  const before = compile(src);
  assert(before.diagnostics.filter((d) => d.severity === 'error').length >= 5, 'fixture should start with several errors, all on one line');

  const r = await autofix(src, null);
  assert(r.fullyFixed, 'should resolve every error even though they share a line: ' + JSON.stringify(r.remainingErrors));
  const after = compile(r.code);
  assert(after.diagnostics.filter((d) => d.severity === 'error').length === 0, 'recompile must be fully clean');
});

await test('never reports success without a clean recompile', async () => {
  // A case with no deterministic rule and no AI available: arity mismatch.
  const src = 'int add(int a, int b) { return a + b; } int main() { print(add(1)); return 0; }';
  const r = await autofix(src, null);
  if (r.fullyFixed) {
    const check = compile(r.code);
    assert(check.diagnostics.filter((d) => d.severity === 'error').length === 0, 'if it claims fullyFixed, recompile must agree');
  } else {
    assert(r.remainingErrors.length > 0, 'should honestly report remaining errors');
  }
});

await test('a fake AI pass that returns broken code is discarded, never accepted', async () => {
  const src = 'int main() { int count = "one hundred"; int wrong = missing + 1; return 0; }';
  const badAgent = async () => ({ ok: true, content: '{{{ not even close to valid' });
  const r = await autofix(src, badAgent);
  // deterministic pass alone should already fully fix this one, so the bad
  // AI response should never even be consulted — but if it somehow was,
  // fullyFixed must still only be true with a verified clean recompile.
  if (r.fullyFixed) {
    const check = compile(r.code);
    assert(check.diagnostics.filter((d) => d.severity === 'error').length === 0, 'must never claim success on broken AI output');
  }
});

await test('a fake AI pass that legitimately fixes remaining errors is accepted', async () => {
  const src = 'int add(int a, int b) { return a + b; } int main() { print(add(1)); return 0; }';
  const goodAgent = async () => ({
    ok: true,
    content: 'int add(int a, int b) { return a + b; } int main() { print(add(1, 2)); return 0; }',
  });
  const r = await autofix(src, goodAgent);
  assert(r.fullyFixed, 'should accept a verified-correct AI rewrite: ' + JSON.stringify(r.remainingErrors));
  assert(r.aiSucceededPartially, 'should record that the AI pass contributed');
});

setTimeout(() => {
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}, 50);
}

run();
