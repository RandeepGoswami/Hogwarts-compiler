/**
 * Lumos — Phase 6: Code Generation
 * -----------------------------------------------------------------
 * Lowers three-address code to x86-64-flavoured assembly (Intel
 * syntax). Two modes:
 *
 *   naive     — every value lives on the stack, loaded and stored
 *               around each operation. Correct, obvious, slow.
 *   allocated — a linear-scan register allocator computes live
 *               ranges and keeps hot values in registers, spilling
 *               only when it runs out.
 *
 * Emitting both is the point: the UI can show them side by side and
 * the instruction-count delta is a real, measured number rather than
 * a claim.
 */

const CALLER_SAVED = ['r10', 'r11', 'rax', 'rcx', 'rdx', 'rsi', 'rdi'];
// Only callee-saved registers are allocatable: a value parked in a
// caller-saved register would be clobbered by the next `call`, and the
// allocator has no spill-around-call logic to repair that.
const ALLOCATABLE = ['rbx', 'r12', 'r13', 'r14', 'r15'];
const ARG_REGS = ['rdi', 'rsi', 'rdx', 'rcx', 'r8', 'r9'];

const operandName = (x) => {
  if (!x) return '';
  if (x.kind === 'const') {
    if (x.type === 'bool') return x.value ? '1' : '0';
    if (x.type === 'char') return String(typeof x.value === 'string' ? x.value.charCodeAt(0) : x.value);
    if (x.type === 'float' || x.type === 'double') return String(x.value);
    return String(x.value);
  }
  if (x.kind === 'strref') return `OFFSET ${x.name}`;
  return x.name;
};
const isConst = (x) => x && x.kind === 'const';

const OPCODE = {
  '+': 'add', '-': 'sub', '*': 'imul',
  '<<': 'shl', '>>': 'sar',
};
const SETCC = { '<': 'setl', '>': 'setg', '<=': 'setle', '>=': 'setge', '==': 'sete', '!=': 'setne' };

// ---------------------------------------------------------------------
// Naive: everything on the stack
// ---------------------------------------------------------------------
function generateNaive(fn) {
  const asm = [];
  const slots = new Map();
  let offset = 0;
  const slotOf = (x) => {
    const k = x.name;
    if (!slots.has(k)) { offset += 8; slots.set(k, offset); }
    return `QWORD PTR [rbp-${slots.get(k)}]`;
  };
  const load = (x, reg) => {
    if (isConst(x) || x.kind === 'strref') return `  mov ${reg}, ${operandName(x)}`;
    return `  mov ${reg}, ${slotOf(x)}`;
  };

  // Pre-assign slots so the frame size is right in the prologue.
  for (const q of fn.code) {
    for (const f of ['dest', 'a', 'b']) {
      const x = q[f];
      if (x && (x.kind === 'var' || x.kind === 'temp')) slotOf(x);
    }
  }
  const frame = Math.ceil((offset || 8) / 16) * 16;

  asm.push(`${fn.name}:`);
  asm.push('  push rbp');
  asm.push('  mov rbp, rsp');
  asm.push(`  sub rsp, ${frame}            ; every value gets its own stack slot`);
  fn.params.forEach((p, i) => {
    if (i < ARG_REGS.length) asm.push(`  mov ${slotOf({ name: p.name })}, ${ARG_REGS[i]}   ; spill parameter ${p.name}`);
  });

  let pendingParams = 0;
  for (const q of fn.code) {
    switch (q.op) {
      case 'enter': break;
      case 'label': asm.push(`${q.name}:`); break;
      case 'const':
      case 'copy':
        asm.push(load(q.a, 'rax'));
        asm.push(`  mov ${slotOf(q.dest)}, rax`);
        break;
      case 'bin': {
        asm.push(load(q.a, 'rax'));
        asm.push(load(q.b, 'rcx'));
        asm.push(...binaryOps(q.operator, 'rax', 'rcx'));
        asm.push(`  mov ${slotOf(q.dest)}, rax`);
        break;
      }
      case 'un':
        asm.push(load(q.a, 'rax'));
        asm.push(q.operator === '-' ? '  neg rax' : '  cmp rax, 0\n  sete al\n  movzx rax, al');
        asm.push(`  mov ${slotOf(q.dest)}, rax`);
        break;
      case 'iffalse':
        asm.push(load(q.a, 'rax'));
        asm.push('  cmp rax, 0');
        asm.push(`  je ${q.target}`);
        break;
      case 'iftrue':
        asm.push(load(q.a, 'rax'));
        asm.push('  cmp rax, 0');
        asm.push(`  jne ${q.target}`);
        break;
      case 'jump': asm.push(`  jmp ${q.target}`); break;
      case 'param':
        asm.push(load(q.a, ARG_REGS[pendingParams] || 'rax'));
        pendingParams++;
        break;
      case 'call':
        asm.push(`  call ${q.name}`);
        if (q.dest) asm.push(`  mov ${slotOf(q.dest)}, rax`);
        pendingParams = 0;
        break;
      case 'print':
        asm.push(load(q.a, 'rdi'));
        asm.push('  call print_value');
        break;
      case 'ret':
        if (q.a) asm.push(load(q.a, 'rax'));
        asm.push('  leave');
        asm.push('  ret');
        break;
      default: break;
    }
  }
  if (asm[asm.length - 1] !== '  ret') { asm.push('  leave'); asm.push('  ret'); }
  return { asm, frame, spills: slots.size };
}

function binaryOps(op, dst, src) {
  if (OPCODE[op]) {
    if (op === '<<' || op === '>>') return [`  mov rcx, ${src}`, `  ${OPCODE[op]} ${dst}, cl`];
    return [`  ${OPCODE[op]} ${dst}, ${src}`];
  }
  if (op === '/' ) return ['  cqo', `  idiv ${src}`];
  if (op === '%') return ['  cqo', `  idiv ${src}`, '  mov rax, rdx'];
  if (SETCC[op]) return [`  cmp ${dst}, ${src}`, `  ${SETCC[op]} al`, '  movzx rax, al'];
  return [`  ; unsupported operator ${op}`];
}

// ---------------------------------------------------------------------
// Linear-scan register allocation
// ---------------------------------------------------------------------
function computeLiveRanges(fn) {
  const ranges = new Map();
  const touch = (x, i) => {
    if (!x || (x.kind !== 'var' && x.kind !== 'temp')) return;
    const r = ranges.get(x.name);
    if (!r) ranges.set(x.name, { name: x.name, kind: x.kind, start: i, end: i });
    else r.end = i;
  };
  fn.code.forEach((q, i) => { touch(q.dest, i); touch(q.a, i); touch(q.b, i); });

  // A value written before a backward jump target and read after it has
  // to survive the whole loop — widen its range accordingly.
  const labelIndex = new Map();
  fn.code.forEach((q, i) => { if (q.op === 'label') labelIndex.set(q.name, i); });
  fn.code.forEach((q, i) => {
    if ((q.op === 'jump' || q.op === 'iffalse' || q.op === 'iftrue') && labelIndex.has(q.target)) {
      const top = labelIndex.get(q.target);
      if (top < i) {
        for (const r of ranges.values()) {
          if (r.start <= i && r.end >= top) { r.start = Math.min(r.start, top); r.end = Math.max(r.end, i); }
        }
      }
    }
  });
  return [...ranges.values()].sort((a, b) => a.start - b.start);
}

function allocateRegisters(fn) {
  const ranges = computeLiveRanges(fn);
  const free = [...ALLOCATABLE];
  const active = [];
  const assignment = new Map();
  const spilled = new Set();

  for (const r of ranges) {
    // expire old intervals
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i].end < r.start) {
        free.push(assignment.get(active[i].name));
        active.splice(i, 1);
      }
    }
    if (free.length) {
      const reg = free.shift();
      assignment.set(r.name, reg);
      active.push(r);
      active.sort((a, b) => a.end - b.end);
    } else {
      // spill the interval that lives longest
      const victim = active[active.length - 1];
      if (victim && victim.end > r.end) {
        assignment.set(r.name, assignment.get(victim.name));
        assignment.delete(victim.name);
        spilled.add(victim.name);
        active.pop();
        active.push(r);
        active.sort((a, b) => a.end - b.end);
      } else {
        spilled.add(r.name);
      }
    }
  }
  return { assignment, spilled, ranges };
}

function generateAllocated(fn) {
  const { assignment, spilled, ranges } = allocateRegisters(fn);
  const asm = [];
  const slots = new Map();
  let offset = 0;
  const slotOf = (name) => {
    if (!slots.has(name)) { offset += 8; slots.set(name, offset); }
    return `QWORD PTR [rbp-${slots.get(name)}]`;
  };
  const loc = (x) => {
    if (!x) return '';
    if (x.kind === 'const' || x.kind === 'strref') return operandName(x);
    return assignment.has(x.name) ? assignment.get(x.name) : slotOf(x.name);
  };
  const inReg = (x) => x && (x.kind === 'var' || x.kind === 'temp') && assignment.has(x.name);

  for (const name of spilled) slotOf(name);
  const frame = Math.ceil((offset || 0) / 16) * 16;
  const usedRegs = [...new Set(assignment.values())].filter((r) => !CALLER_SAVED.includes(r));

  asm.push(`${fn.name}:`);
  asm.push('  push rbp');
  asm.push('  mov rbp, rsp');
  if (frame) asm.push(`  sub rsp, ${frame}            ; only spilled values need stack space`);
  usedRegs.forEach((r) => asm.push(`  push ${r}                  ; callee-saved`));
  fn.params.forEach((p, i) => {
    if (i < ARG_REGS.length) {
      const d = assignment.get(p.name);
      asm.push(d ? `  mov ${d}, ${ARG_REGS[i]}            ; ${p.name} lives in ${d}`
                 : `  mov ${slotOf(p.name)}, ${ARG_REGS[i]}`);
    }
  });

  let pendingParams = 0;
  for (const q of fn.code) {
    switch (q.op) {
      case 'enter': break;
      case 'label': asm.push(`${q.name}:`); break;
      case 'const':
      case 'copy': {
        const d = loc(q.dest);
        if (inReg(q.dest) || isConst(q.a) || inReg(q.a)) asm.push(`  mov ${d}, ${loc(q.a)}`);
        else { asm.push(`  mov rax, ${loc(q.a)}`); asm.push(`  mov ${d}, rax`); }
        break;
      }
      case 'bin': {
        const d = loc(q.dest);
        const target = inReg(q.dest) ? d : 'rax';
        if (SETCC[q.operator]) {
          asm.push(`  mov rax, ${loc(q.a)}`);
          asm.push(`  cmp rax, ${loc(q.b)}`);
          asm.push(`  ${SETCC[q.operator]} al`);
          asm.push(`  movzx ${target}, al`);
        } else if (q.operator === '/' || q.operator === '%') {
          asm.push(`  mov rax, ${loc(q.a)}`);
          asm.push('  cqo');
          asm.push(`  mov rcx, ${loc(q.b)}`);
          asm.push('  idiv rcx');
          if (q.operator === '%') asm.push(`  mov ${target}, rdx`);
          else if (target !== 'rax') asm.push(`  mov ${target}, rax`);
        } else if (q.operator === '<<' || q.operator === '>>') {
          asm.push(`  mov ${target}, ${loc(q.a)}`);
          asm.push(`  ${OPCODE[q.operator]} ${target}, ${operandName(q.b)}`);
        } else {
          if (target !== loc(q.a)) asm.push(`  mov ${target}, ${loc(q.a)}`);
          asm.push(`  ${OPCODE[q.operator] || '; ?'} ${target}, ${loc(q.b)}`);
        }
        if (target === 'rax' && d !== 'rax') asm.push(`  mov ${d}, rax`);
        break;
      }
      case 'un': {
        const d = loc(q.dest);
        const target = inReg(q.dest) ? d : 'rax';
        asm.push(`  mov ${target}, ${loc(q.a)}`);
        if (q.operator === '-') asm.push(`  neg ${target}`);
        else { asm.push(`  cmp ${target}, 0`); asm.push('  sete al'); asm.push(`  movzx ${target}, al`); }
        if (target === 'rax' && d !== 'rax') asm.push(`  mov ${d}, rax`);
        break;
      }
      case 'iffalse':
        asm.push(`  cmp ${loc(q.a)}, 0`);
        asm.push(`  je ${q.target}`);
        break;
      case 'iftrue':
        asm.push(`  cmp ${loc(q.a)}, 0`);
        asm.push(`  jne ${q.target}`);
        break;
      case 'jump': asm.push(`  jmp ${q.target}`); break;
      case 'param':
        asm.push(`  mov ${ARG_REGS[pendingParams] || 'rax'}, ${loc(q.a)}`);
        pendingParams++;
        break;
      case 'call':
        asm.push(`  call ${q.name}`);
        if (q.dest) asm.push(`  mov ${loc(q.dest)}, rax`);
        pendingParams = 0;
        break;
      case 'print':
        asm.push(`  mov rdi, ${loc(q.a)}`);
        asm.push('  call print_value');
        break;
      case 'ret':
        if (q.a) asm.push(`  mov rax, ${loc(q.a)}`);
        [...usedRegs].reverse().forEach((r) => asm.push(`  pop ${r}`));
        asm.push('  leave');
        asm.push('  ret');
        break;
      default: break;
    }
  }
  if (asm[asm.length - 1] !== '  ret') {
    [...usedRegs].reverse().forEach((r) => asm.push(`  pop ${r}`));
    asm.push('  leave');
    asm.push('  ret');
  }

  return {
    asm,
    frame,
    allocation: [...assignment.entries()].map(([name, reg]) => ({ name, reg })),
    spilled: [...spilled],
    ranges,
  };
}

// ---------------------------------------------------------------------
function generate(irFunctions, optimizedFunctions) {
  const data = [];
  for (const fn of irFunctions) {
    (fn.strings || []).forEach((s) => data.push(`  ${s.label}: .asciz "${s.value}"`));
  }

  const naive = [];
  naive.push('; ===== Lumos codegen — naive stack machine =====');
  if (data.length) { naive.push('section .data'); naive.push(...data); }
  naive.push('section .text');
  naive.push('  global main');
  let naiveCount = 0;
  for (const fn of irFunctions) {
    const g = generateNaive(fn);
    naive.push('');
    naive.push(...g.asm);
    naiveCount += g.asm.filter((l) => l.startsWith('  ')).length;
  }

  const optimized = [];
  optimized.push('; ===== Lumos codegen — optimized IR + linear-scan register allocation =====');
  if (data.length) { optimized.push('section .data'); optimized.push(...data); }
  optimized.push('section .text');
  optimized.push('  global main');
  let optCount = 0;
  const allocations = [];
  for (const fn of optimizedFunctions) {
    const g = generateAllocated(fn);
    optimized.push('');
    optimized.push(`; ${fn.name}: ${g.allocation.length} value(s) in registers, ${g.spilled.length} spilled`);
    optimized.push(...g.asm);
    optCount += g.asm.filter((l) => l.startsWith('  ')).length;
    const regOf = new Map(g.allocation.map((x) => [x.name, x.reg]));
    allocations.push({
      fn: fn.name,
      allocation: g.allocation,
      spilled: g.spilled,
      frame: g.frame,
      length: fn.code.length,
      ranges: g.ranges.map((r) => ({
        name: r.name, kind: r.kind, start: r.start, end: r.end,
        reg: regOf.get(r.name) || null,
      })),
    });
  }

  return {
    naive,
    optimized,
    allocations,
    metrics: {
      naiveInstructions: naiveCount,
      optimizedInstructions: optCount,
      reduction: naiveCount ? Math.round(((naiveCount - optCount) / naiveCount) * 100) : 0,
    },
  };
}

module.exports = { generate, ALLOCATABLE };
