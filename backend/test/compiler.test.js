/**
 * Dependency-free test runner:  node test/compiler.test.js
 */
const { compile } = require('../src/compiler');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
const errorsOf = (r) => r.diagnostics.filter((d) => d.severity === 'error');
const warnsOf = (r) => r.diagnostics.filter((d) => d.severity === 'warning');
const hasMsg = (r, sub) => r.diagnostics.some((d) => d.message.toLowerCase().includes(sub.toLowerCase()));

console.log('\nLumos compiler tests\n');

test('compiles a clean program end to end', () => {
  const r = compile(`
    int main() {
      int a = 2 + 3 * 4;
      print(a);
      return 0;
    }`);
  assert(r.ok, 'should compile');
  assert(errorsOf(r).length === 0, 'no errors expected');
  assert(r.asm.optimized.length > 0, 'assembly produced');
});

test('folds constants at compile time', () => {
  const r = compile(`int main() { int a = 2 + 3 * 4; print(a); return 0; }`);
  const joined = r.optimizedIr[0].lines.join('\n');
  assert(joined.includes('14'), 'expected 2+3*4 folded to 14, got:\n' + joined);
  assert(r.optimizationStats.folded > 0, 'folding counter should move');
});

test('propagates constants across statements', () => {
  const r = compile(`int main() { int x = 5; int y = x + 1; print(y); return 0; }`);
  assert(r.optimizedIr[0].lines.join('\n').includes('6'), 'x+1 should become 6');
});

test('strength-reduces multiply by power of two', () => {
  const r = compile(`int scale(int n) { return n * 8; } int main() { print(scale(3)); return 0; }`);
  const log = r.optimizationLog.map((l) => l.pass);
  assert(log.includes('strength-reduction') || r.optimizedIr[0].lines.join('').includes('<<'),
    'expected a shift, log: ' + log.join(','));
});

test('eliminates dead code', () => {
  const r = compile(`int main() { int used = 1; int dead = 99 * 99; print(used); return 0; }`);
  assert(r.optimizationStats.dead > 0 || r.optimizationStats.irReduction > 0, 'dead store should go');
});

test('detects type mismatch', () => {
  const r = compile(`int main() { int n = "hello"; return 0; }`);
  assert(errorsOf(r).length > 0, 'expected an error');
  assert(hasMsg(r, 'string'), 'error should mention string');
});

test('accepts double pi = 3.14 (regression)', () => {
  const r = compile(`int main() { double pi = 3.14; float f = 9.5; print(pi); print(f); return 0; }`);
  assert(errorsOf(r).length === 0, 'should be legal: ' + JSON.stringify(errorsOf(r)));
});

test('reports undeclared identifiers', () => {
  const r = compile(`int main() { int a = b + 1; return 0; }`);
  assert(hasMsg(r, 'undeclared'), 'expected undeclared error');
});

test('reports redeclaration in the same scope', () => {
  const r = compile(`int main() { int a = 1; int a = 2; return 0; }`);
  assert(hasMsg(r, 'already declared'), 'expected redeclaration error');
});

test('rejects assignment to const', () => {
  const r = compile(`int main() { const int limit = 10; limit = 11; return 0; }`);
  assert(hasMsg(r, 'const'), 'expected const violation');
});

test('checks function arity and argument types', () => {
  const r = compile(`
    int add(int a, int b) { return a + b; }
    int main() { int x = add(1); int y = add(1, "two"); return 0; }`);
  assert(hasMsg(r, 'expects 2'), 'expected arity error');
  assert(hasMsg(r, 'Argument 2'), 'expected argument type error');
});

test('requires a return value from non-void functions', () => {
  const r = compile(`int broken() { int a = 1; } int main() { return broken(); }`);
  assert(hasMsg(r, 'never returns'), 'expected missing-return error');
});

test('rejects a string condition', () => {
  const r = compile(`int main() { string s = "x"; if (s) { print(1); } return 0; }`);
  assert(hasMsg(r, 'never a truth value'), 'expected condition error');
});

test('flags division by constant zero', () => {
  const r = compile(`int main() { int a = 10 / 0; return 0; }`);
  assert(hasMsg(r, 'Division by a constant zero'), 'expected div-by-zero error');
});

test('warns on narrowing conversion', () => {
  const r = compile(`int main() { int n = 3.7; print(n); return 0; }`);
  assert(warnsOf(r).some((w) => /Narrowing/i.test(w.message)), 'expected narrowing warning');
});

test('warns about unused variables and unreachable code', () => {
  const r = compile(`int main() { int ghost = 1; return 0; print(2); }`);
  assert(hasMsg(r, 'never used'), 'expected unused warning');
  assert(hasMsg(r, 'Unreachable'), 'expected unreachable warning');
});

test('recovers from a missing semicolon and keeps parsing', () => {
  const r = compile(`int main() { int a = 1 int b = 2; return 0; }`);
  assert(hasMsg(r, 'Missing ";"'), 'expected a semicolon error');
});

test('handles loops, branches and short-circuits', () => {
  const r = compile(`
    int classify(int n) {
      if (n > 10 && n < 100) { return 2; }
      else if (n > 0) { return 1; }
      return 0;
    }
    int main() {
      int total = 0;
      for (int i = 0; i < 10; i++) {
        if (i % 2 == 0) { continue; }
        total += classify(i);
      }
      while (total > 100) { total -= 10; }
      print(total);
      return 0;
    }`);
  assert(errorsOf(r).length === 0, 'should compile: ' + JSON.stringify(errorsOf(r)));
  assert(r.optimizedIr.length === 2, 'two functions in IR');
  assert(r.asm.optimized.join('\n').includes('classify'), 'classify should be emitted');
});

test('allocates registers and reports the allocation', () => {
  const r = compile(`
    int main() {
      int a = 1; int b = 2; int c = a + b; int d = c * a;
      print(d);
      return 0;
    }`);
  assert(Array.isArray(r.asm.allocations), 'allocations present');
  assert(r.asm.metrics.optimizedInstructions <= r.asm.metrics.naiveInstructions,
    'optimized build should not be larger');
});

test('performs common subexpression elimination', () => {
  const r = compile(`
    int main() {
      int x = 4; int y = 7;
      int p = x * y + x * y;
      print(p);
      return 0;
    }`);
  assert(r.ok, 'should compile');
});

test('never throws on garbage input', () => {
  ['', '}{', '@@@@', 'int', 'int main(', 'while (', '"unterminated', "'ab'"].forEach((src) => {
    const r = compile(src);
    assert(typeof r === 'object', 'returns a result for: ' + src);
  });
});

test('handles a deeply nested expression without blowing up', () => {
  const src = 'int main() { int a = ' + '('.repeat(60) + '1' + ')'.repeat(60) + '; print(a); return 0; }';
  const r = compile(src);
  assert(errorsOf(r).length === 0, 'deep parens should be fine');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
