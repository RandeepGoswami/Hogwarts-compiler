/**
 * Lumos — Phase 5: Optimization
 * -----------------------------------------------------------------
 * A real (if small) optimizing middle-end. Passes run to a fixed
 * point, since each one exposes work for the others: folding creates
 * constants, propagation spreads them, and DCE sweeps up the corpses.
 *
 * Passes:
 *   1. Constant folding            2 + 3      -> 5
 *   2. Constant propagation        x = 5; y = x + 1 -> y = 6
 *   3. Algebraic simplification    x * 1, x + 0, x - x
 *   4. Strength reduction          x * 8      -> x << 3
 *   5. Common subexpression elim.  reuse an identical earlier result
 *   6. Copy propagation            t1 = x; y = t1 -> y = x
 *   7. Dead code elimination       drop values nobody reads
 *   8. Branch simplification       ifFalse false -> unconditional
 *   9. Unreachable block removal   code after goto with no label
 *
 * Every rewrite appends a human-readable line to the pass log so the
 * UI (and the AI reviewer) can show exactly what changed and why.
 */

const { formatQuad } = require('./ir');

const key = (x) => {
  if (!x) return '_';
  if (x.kind === 'const') return `#${x.type}:${x.value}`;
  if (x.kind === 'strref') return `&${x.name}`;
  return `${x.kind}:${x.name}`;
};
const isConst = (x) => x && x.kind === 'const';
const isTemp = (x) => x && x.kind === 'temp';
const num = (x) => (typeof x.value === 'boolean' ? (x.value ? 1 : 0) : x.value);

function optimizeFunction(fn) {
  let code = fn.code.map((q) => ({ ...q }));
  const log = [];
  const stats = { folded: 0, propagated: 0, simplified: 0, strength: 0, cse: 0, copies: 0, dead: 0, branches: 0, unreachable: 0 };

  let changed = true;
  let rounds = 0;
  while (changed && rounds < 12) {
    changed = false;
    rounds++;
    changed = constantFoldAndPropagate(code, log, stats) || changed;
    changed = algebraicAndStrength(code, log, stats) || changed;
    changed = commonSubexpressions(code, log, stats) || changed;
    changed = copyPropagation(code, log, stats) || changed;
    changed = simplifyBranches(code, log, stats) || changed;
    const r = removeUnreachable(code, log, stats);
    if (r.changed) { code = r.code; changed = true; }
    const d = deadCodeElimination(code, log, stats);
    if (d.changed) { code = d.code; changed = true; }
  }

  code = code.filter((q) => q.op !== 'nop');
  code = removeOrphanLabels(code, log, stats);

  return {
    name: fn.name,
    returnType: fn.returnType,
    params: fn.params,
    strings: fn.strings,
    code,
    log,
    stats,
    rounds,
    before: fn.code.length,
    after: code.length,
  };
}

// ---------------------------------------------------------------------
// 1 + 2: constant folding and propagation
// ---------------------------------------------------------------------
function constantFoldAndPropagate(code, log, stats) {
  let changed = false;
  // Per straight-line region: any label or jump target invalidates what
  // we think we know, which keeps this conservative and correct.
  let known = new Map();

  const resolve = (x) => {
    if (!x) return x;
    if ((x.kind === 'temp' || x.kind === 'var') && known.has(key(x))) return known.get(key(x));
    return x;
  };

  for (let i = 0; i < code.length; i++) {
    const q = code[i];

    if (q.op === 'label' || q.op === 'jump' || q.op === 'iffalse' || q.op === 'iftrue') {
      if (q.op !== 'label') {
        const a = resolve(q.a);
        if (a !== q.a) { q.a = a; changed = true; stats.propagated++; }
      }
      known = new Map(); // control-flow join — forget everything
      continue;
    }

    if (q.op === 'bin') {
      const a = resolve(q.a);
      const b = resolve(q.b);
      if (a !== q.a || b !== q.b) { changed = true; stats.propagated++; }
      q.a = a; q.b = b;

      if (isConst(a) && isConst(b)) {
        const folded = fold(q.operator, a, b);
        if (folded !== undefined) {
          const before = formatQuad(q);
          const c = { kind: 'const', value: folded, type: resultType(q.operator, a, b) };
          code[i] = { op: 'const', dest: q.dest, a: c };
          known.set(key(q.dest), c);
          log.push({ pass: 'constant-folding', before, after: formatQuad(code[i]),
            note: `Computed at compile time — the CPU never does this work.` });
          stats.folded++;
          changed = true;
          continue;
        }
      }
      known.delete(key(q.dest));
      continue;
    }

    if (q.op === 'un') {
      const a = resolve(q.a);
      if (a !== q.a) { q.a = a; changed = true; stats.propagated++; }
      if (isConst(a)) {
        const value = q.operator === '-' ? -num(a) : !num(a);
        const before = formatQuad(q);
        const c = { kind: 'const', value, type: q.operator === '-' ? a.type : 'bool' };
        code[i] = { op: 'const', dest: q.dest, a: c };
        known.set(key(q.dest), c);
        log.push({ pass: 'constant-folding', before, after: formatQuad(code[i]),
          note: 'Unary operation on a literal, resolved at compile time.' });
        stats.folded++;
        changed = true;
        continue;
      }
      known.delete(key(q.dest));
      continue;
    }

    if (q.op === 'copy' || q.op === 'const') {
      const a = resolve(q.a);
      if (a !== q.a && isConst(a)) {
        const before = formatQuad(q);
        code[i] = { op: 'const', dest: q.dest, a, declaredType: q.declaredType };
        log.push({ pass: 'constant-propagation', before, after: formatQuad(code[i]),
          note: 'The source value is a known constant, so it is used directly.' });
        stats.propagated++;
        changed = true;
      }
      if (isConst(code[i].a)) known.set(key(q.dest), code[i].a);
      else known.delete(key(q.dest));
      continue;
    }

    if (q.op === 'param' || q.op === 'print' || q.op === 'ret') {
      const a = resolve(q.a);
      if (a !== q.a) { q.a = a; changed = true; stats.propagated++; }
      continue;
    }

    if (q.op === 'call') {
      known = new Map(); // the callee may touch anything
      continue;
    }
  }
  return changed;
}

function fold(op, a, b) {
  const x = num(a), y = num(b);
  switch (op) {
    case '+': return x + y;
    case '-': return x - y;
    case '*': return x * y;
    case '/': return y === 0 ? undefined : (isInt(a) && isInt(b) ? Math.trunc(x / y) : x / y);
    case '%': return y === 0 ? undefined : x % y;
    case '<': return x < y;
    case '>': return x > y;
    case '<=': return x <= y;
    case '>=': return x >= y;
    case '==': return x === y;
    case '!=': return x !== y;
    default: return undefined;
  }
}
const isInt = (x) => x.type === 'int' || x.type === 'char' || x.type === 'bool';
function resultType(op, a, b) {
  if (['<', '>', '<=', '>=', '==', '!='].includes(op)) return 'bool';
  if (a.type === 'double' || b.type === 'double') return 'double';
  if (a.type === 'float' || b.type === 'float') return 'float';
  return 'int';
}

// ---------------------------------------------------------------------
// 3 + 4: algebraic identities and strength reduction
// ---------------------------------------------------------------------
function algebraicAndStrength(code, log, stats) {
  let changed = false;
  for (let i = 0; i < code.length; i++) {
    const q = code[i];
    if (q.op !== 'bin') continue;
    const { a, b, operator: op } = q;
    const before = formatQuad(q);

    const toCopy = (src, note, pass = 'algebraic-simplification') => {
      code[i] = { op: src.kind === 'const' ? 'const' : 'copy', dest: q.dest, a: src };
      log.push({ pass, before, after: formatQuad(code[i]), note });
      stats.simplified++;
      changed = true;
    };

    if (isConst(b) && num(b) === 0 && (op === '+' || op === '-')) { toCopy(a, 'Adding or subtracting zero changes nothing.'); continue; }
    if (isConst(a) && num(a) === 0 && op === '+') { toCopy(b, 'Adding zero changes nothing.'); continue; }
    if (isConst(b) && num(b) === 1 && (op === '*' || op === '/')) { toCopy(a, 'Multiplying or dividing by one changes nothing.'); continue; }
    if (isConst(a) && num(a) === 1 && op === '*') { toCopy(b, 'Multiplying by one changes nothing.'); continue; }
    if (isConst(b) && num(b) === 0 && op === '*') {
      toCopy({ kind: 'const', value: 0, type: 'int' }, 'Anything times zero is zero.');
      continue;
    }
    if (op === '-' && key(a) === key(b) && a.kind !== 'const') {
      toCopy({ kind: 'const', value: 0, type: 'int' }, 'A value minus itself is always zero.');
      continue;
    }
    if (op === '/' && key(a) === key(b) && a.kind !== 'const') {
      toCopy({ kind: 'const', value: 1, type: 'int' }, 'A value divided by itself is one (assuming it is non-zero).');
      continue;
    }

    // Strength reduction: multiply/divide by a power of two becomes a
    // shift — but only for integers, and only when the other operand
    // isn't itself constant (folding would have handled that already).
    if (isConst(b) && isInt(b) && !isConst(a) && isInt(q.dest)) {
      const p = log2(num(b));
      if (p !== null && p > 0 && (op === '*' || op === '/')) {
        code[i] = { op: 'bin', dest: q.dest, a, b: { kind: 'const', value: p, type: 'int' }, operator: op === '*' ? '<<' : '>>' };
        log.push({
          pass: 'strength-reduction', before, after: formatQuad(code[i]),
          note: `A shift costs one cycle; an integer ${op === '*' ? 'multiply' : 'divide'} costs several.`,
        });
        stats.strength++;
        changed = true;
        continue;
      }
    }
  }
  return changed;
}
function log2(n) {
  if (!Number.isInteger(n) || n <= 0) return null;
  const p = Math.log2(n);
  return Number.isInteger(p) ? p : null;
}

// ---------------------------------------------------------------------
// 5: common subexpression elimination
// ---------------------------------------------------------------------
function commonSubexpressions(code, log, stats) {
  let changed = false;
  let available = new Map();

  for (let i = 0; i < code.length; i++) {
    const q = code[i];
    if (['label', 'jump', 'iffalse', 'iftrue', 'call'].includes(q.op)) { available = new Map(); continue; }
    if (q.op !== 'bin') {
      if (q.dest) invalidate(available, q.dest);
      continue;
    }
    const sig = `${q.operator}|${key(q.a)}|${key(q.b)}`;
    const commutative = ['+', '*', '==', '!='].includes(q.operator);
    const altSig = commutative ? `${q.operator}|${key(q.b)}|${key(q.a)}` : sig;
    const hit = available.get(sig) || available.get(altSig);
    if (hit && !isConst(q.a && q.b)) {
      const before = formatQuad(q);
      code[i] = { op: 'copy', dest: q.dest, a: hit };
      log.push({
        pass: 'common-subexpression', before, after: formatQuad(code[i]),
        note: `This exact expression was already computed into ${hit.name} — reuse it instead of recomputing.`,
      });
      stats.cse++;
      changed = true;
      invalidate(available, q.dest);
      continue;
    }
    invalidate(available, q.dest);
    available.set(sig, q.dest);
  }
  return changed;
}
function invalidate(available, dest) {
  const k = key(dest);
  for (const [sig, val] of [...available.entries()]) {
    if (sig.includes(`|${k}`) || key(val) === k) available.delete(sig);
  }
}

// ---------------------------------------------------------------------
// 6: copy propagation
// ---------------------------------------------------------------------
function copyPropagation(code, log, stats) {
  let changed = false;
  let copies = new Map(); // temp -> source

  for (let i = 0; i < code.length; i++) {
    const q = code[i];
    if (['label', 'jump', 'iffalse', 'iftrue', 'call'].includes(q.op)) {
      if (q.op !== 'label' && q.a && copies.has(key(q.a))) { q.a = copies.get(key(q.a)); changed = true; stats.copies++; }
      copies = new Map();
      continue;
    }
    for (const field of ['a', 'b']) {
      const operand = q[field];
      if (operand && isTemp(operand) && copies.has(key(operand))) {
        q[field] = copies.get(key(operand));
        stats.copies++;
        changed = true;
      }
    }
    if (q.dest) {
      const dk = key(q.dest);
      for (const [t, src] of [...copies.entries()]) {
        if (key(src) === dk || t === dk) copies.delete(t);
      }
      if (q.op === 'copy' && isTemp(q.dest) && q.a && q.a.kind !== 'strref') copies.set(dk, q.a);
    }
  }
  return changed;
}

// ---------------------------------------------------------------------
// 7: dead code elimination (liveness over the flat list)
// ---------------------------------------------------------------------
function deadCodeElimination(code, log, stats) {
  const used = new Set();
  // Anything read anywhere, and any var read after a label, is live.
  for (const q of code) {
    for (const field of ['a', 'b']) {
      const x = q[field];
      if (x && (x.kind === 'temp' || x.kind === 'var')) used.add(key(x));
    }
  }
  let changed = false;
  const out = [];
  for (const q of code) {
    const pure = ['bin', 'un', 'const', 'copy'].includes(q.op);
    if (pure && q.dest && !used.has(key(q.dest))) {
      log.push({
        pass: 'dead-code-elimination', before: formatQuad(q), after: '(deleted)',
        note: `Nothing ever reads ${q.dest.name}, so the instruction is pure overhead.`,
      });
      stats.dead++;
      changed = true;
      continue;
    }
    out.push(q);
  }
  return { code: out, changed };
}

// ---------------------------------------------------------------------
// 8: branch simplification
// ---------------------------------------------------------------------
function simplifyBranches(code, log, stats) {
  let changed = false;
  for (let i = 0; i < code.length; i++) {
    const q = code[i];
    if ((q.op === 'iffalse' || q.op === 'iftrue') && isConst(q.a)) {
      const truthy = Boolean(num(q.a));
      const taken = q.op === 'iffalse' ? !truthy : truthy;
      const before = formatQuad(q);
      code[i] = taken ? { op: 'jump', target: q.target } : { op: 'nop' };
      log.push({
        pass: 'branch-simplification', before, after: taken ? formatQuad(code[i]) : '(deleted)',
        note: taken
          ? 'The condition is a compile-time constant, so the branch always jumps.'
          : 'The condition is a compile-time constant that never triggers — the test is removed.',
      });
      stats.branches++;
      changed = true;
    }
    // goto L; L: -> fallthrough
    if (q.op === 'jump') {
      let j = i + 1;
      while (j < code.length && code[j].op === 'nop') j++;
      if (j < code.length && code[j].op === 'label' && code[j].name === q.target) {
        log.push({ pass: 'branch-simplification', before: formatQuad(q), after: '(deleted)',
          note: 'A jump to the very next instruction is a no-op.' });
        code[i] = { op: 'nop' };
        stats.branches++;
        changed = true;
      }
    }
  }
  return changed;
}

// ---------------------------------------------------------------------
// 9: unreachable code removal
// ---------------------------------------------------------------------
function removeUnreachable(code, log, stats) {
  const out = [];
  let dead = false;
  let changed = false;
  for (const q of code) {
    if (q.op === 'label') { dead = false; out.push(q); continue; }
    if (dead) {
      if (q.op !== 'nop') {
        log.push({ pass: 'unreachable-code', before: formatQuad(q), after: '(deleted)',
          note: 'No path reaches this instruction.' });
        stats.unreachable++;
        changed = true;
      }
      continue;
    }
    out.push(q);
    if (q.op === 'jump' || q.op === 'ret') dead = true;
  }
  return { code: out, changed };
}

// ---------------------------------------------------------------------
// 10: orphan label removal (after branches were folded away)
// ---------------------------------------------------------------------
function removeOrphanLabels(code, log, stats) {
  const targets = new Set(code.filter((q) => q.target).map((q) => q.target));
  return code.filter((q) => {
    if (q.op === 'label' && !targets.has(q.name)) {
      log.push({
        pass: 'label-cleanup', before: `${q.name}:`, after: '(deleted)',
        note: 'No branch targets this label any more, so it is just noise.',
      });
      stats.branches++;
      return false;
    }
    return true;
  });
}

function optimize(ir) {
  return { functions: ir.functions.map(optimizeFunction) };
}

module.exports = { optimize };
