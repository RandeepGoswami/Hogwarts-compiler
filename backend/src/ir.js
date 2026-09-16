/**
 * Lumos — Phase 4: Intermediate Representation
 * -----------------------------------------------------------------
 * Lowers the typed AST into three-address code (quadruples). Control
 * flow becomes labels + conditional jumps, expressions become chains
 * of temporaries. This is the form the optimizer actually works on —
 * flat, explicit, and easy to reason about.
 *
 * Quad shapes:
 *   { op: 'const',  dest, a }                dest = a
 *   { op: 'copy',   dest, a }                dest = a
 *   { op: 'bin',    dest, a, b, operator }   dest = a <op> b
 *   { op: 'un',     dest, a, operator }      dest = <op> a
 *   { op: 'label',  name }
 *   { op: 'jump',   target }
 *   { op: 'iffalse',a, target }
 *   { op: 'iftrue', a, target }
 *   { op: 'param',  a }
 *   { op: 'call',   dest, name, argc }
 *   { op: 'ret',    a? }
 *   { op: 'print',  a }
 *   { op: 'enter',  name, params }
 */

function buildIR(ast) {
  const functions = [];

  for (const node of ast.body) {
    if (node.kind === 'FunctionDecl') functions.push(lowerFunction(node));
  }
  // Global declarations become a synthetic init routine.
  const globals = ast.body.filter((n) => n.kind === 'VarDecl');
  if (globals.length) {
    functions.unshift(lowerFunction({
      kind: 'FunctionDecl', name: '__globals', returnType: 'void', params: [],
      body: { kind: 'Block', body: globals }, line: 1,
    }));
  }
  return { functions };
}

function lowerFunction(fn) {
  const code = [];
  let tempCount = 0;
  let labelCount = 0;
  const loopStack = [];
  const strings = [];

  const newTemp = (type) => ({ kind: 'temp', name: `t${tempCount++}`, type });
  const newLabel = (tag) => `${fn.name}_${tag}_${labelCount++}`;
  const emit = (q) => { code.push(q); return q; };

  const vref = (name, type) => ({ kind: 'var', name, type });
  const cref = (value, type) => ({ kind: 'const', value, type });

  emit({ op: 'enter', name: fn.name, params: fn.params.map((p) => p.name), returnType: fn.returnType });

  lowerBlock(fn.body);

  if (fn.returnType === 'void' || !code.some((q) => q.op === 'ret')) {
    emit({ op: 'ret', a: fn.returnType === 'void' ? null : cref(0, fn.returnType) });
  }

  return { name: fn.name, returnType: fn.returnType, params: fn.params, code, strings, tempCount };

  // -----------------------------------------------------------------
  function lowerBlock(block) {
    if (!block) return;
    for (const stmt of block.body) lowerStatement(stmt);
  }

  function lowerStatement(stmt) {
    if (!stmt) return;
    switch (stmt.kind) {
      case 'VarDecl':
        for (const d of stmt.declarators) {
          if (d.init) {
            const v = lowerExpr(d.init);
            emit({ op: v.kind === 'const' ? 'const' : 'copy', dest: vref(d.name, stmt.type), a: v, declaredType: stmt.type });
          } else {
            emit({ op: 'const', dest: vref(d.name, stmt.type), a: cref(defaultFor(stmt.type), stmt.type), declaredType: stmt.type });
          }
        }
        return;

      case 'Block': return lowerBlock(stmt);
      case 'ExprStmt': return void lowerExpr(stmt.expr);

      case 'Print': {
        stmt.args.forEach((a) => emit({ op: 'print', a: lowerExpr(a) }));
        return;
      }

      case 'If': {
        const elseL = newLabel('else');
        const endL = newLabel('endif');
        const cond = lowerExpr(stmt.test);
        emit({ op: 'iffalse', a: cond, target: stmt.alternate ? elseL : endL });
        lowerStatement(stmt.consequent);
        if (stmt.alternate) {
          emit({ op: 'jump', target: endL });
          emit({ op: 'label', name: elseL });
          lowerStatement(stmt.alternate);
        }
        emit({ op: 'label', name: endL });
        return;
      }

      case 'While': {
        const topL = newLabel('while');
        const endL = newLabel('endwhile');
        emit({ op: 'label', name: topL });
        const cond = lowerExpr(stmt.test);
        emit({ op: 'iffalse', a: cond, target: endL });
        loopStack.push({ breakTo: endL, continueTo: topL });
        lowerStatement(stmt.body);
        loopStack.pop();
        emit({ op: 'jump', target: topL });
        emit({ op: 'label', name: endL });
        return;
      }

      case 'For': {
        const topL = newLabel('for');
        const stepL = newLabel('forstep');
        const endL = newLabel('endfor');
        if (stmt.init) lowerStatement(stmt.init);
        emit({ op: 'label', name: topL });
        if (stmt.test) {
          const cond = lowerExpr(stmt.test);
          emit({ op: 'iffalse', a: cond, target: endL });
        }
        loopStack.push({ breakTo: endL, continueTo: stepL });
        lowerStatement(stmt.body);
        loopStack.pop();
        emit({ op: 'label', name: stepL });
        if (stmt.update) lowerExpr(stmt.update);
        emit({ op: 'jump', target: topL });
        emit({ op: 'label', name: endL });
        return;
      }

      case 'Return':
        emit({ op: 'ret', a: stmt.argument ? lowerExpr(stmt.argument) : null });
        return;

      case 'Break': {
        const L = loopStack[loopStack.length - 1];
        if (L) emit({ op: 'jump', target: L.breakTo });
        return;
      }
      case 'Continue': {
        const L = loopStack[loopStack.length - 1];
        if (L) emit({ op: 'jump', target: L.continueTo });
        return;
      }
      default:
        lowerExpr(stmt);
    }
  }

  function lowerExpr(node) {
    if (!node) return cref(0, 'int');
    switch (node.kind) {
      case 'Literal': {
        if (node.literalType === 'string') {
          const label = `${fn.name}_str${strings.length}`;
          strings.push({ label, value: node.value });
          return { kind: 'strref', name: label, value: node.value, type: 'string' };
        }
        return cref(node.value, node.literalType);
      }

      case 'Identifier':
        return vref(node.name, node.type || 'int');

      case 'Unary': {
        const a = lowerExpr(node.operand);
        const t = newTemp(node.type);
        emit({ op: 'un', dest: t, a, operator: node.op });
        return t;
      }

      case 'Binary': {
        // Short-circuit && / || need control flow, not a plain quad.
        if (node.op === '&&' || node.op === '||') return lowerShortCircuit(node);
        const a = lowerExpr(node.left);
        const b = lowerExpr(node.right);
        const t = newTemp(node.type);
        emit({ op: 'bin', dest: t, a, b, operator: node.op });
        return t;
      }

      case 'Assign': {
        const target = vref(node.target.name, node.target.type);
        if (node.op === '=') {
          const v = lowerExpr(node.value);
          emit({ op: v.kind === 'const' ? 'const' : 'copy', dest: target, a: v });
          return target;
        }
        const rhs = lowerExpr(node.value);
        const t = newTemp(node.target.type);
        emit({ op: 'bin', dest: t, a: target, b: rhs, operator: node.op[0] });
        emit({ op: 'copy', dest: target, a: t });
        return target;
      }

      case 'Update': {
        const target = vref(node.target.name, node.target.type);
        const t = newTemp(node.target.type);
        if (node.prefix) {
          emit({ op: 'bin', dest: t, a: target, b: cref(1, 'int'), operator: node.op === '++' ? '+' : '-' });
          emit({ op: 'copy', dest: target, a: t });
          return target;
        }
        const old = newTemp(node.target.type);
        emit({ op: 'copy', dest: old, a: target });
        emit({ op: 'bin', dest: t, a: target, b: cref(1, 'int'), operator: node.op === '++' ? '+' : '-' });
        emit({ op: 'copy', dest: target, a: t });
        return old;
      }

      case 'Call': {
        const args = node.args.map((a) => lowerExpr(a));
        args.forEach((a) => emit({ op: 'param', a }));
        const t = newTemp(node.type === 'void' ? 'int' : node.type);
        emit({ op: 'call', dest: node.type === 'void' ? null : t, name: node.callee, argc: args.length });
        return t;
      }

      default:
        return cref(0, 'int');
    }
  }

  function lowerShortCircuit(node) {
    const result = newTemp('bool');
    const shortL = newLabel(node.op === '&&' ? 'andshort' : 'orshort');
    const endL = newLabel('scend');
    const a = lowerExpr(node.left);
    emit({ op: 'copy', dest: result, a });
    if (node.op === '&&') emit({ op: 'iffalse', a: result, target: shortL });
    else emit({ op: 'iftrue', a: result, target: shortL });
    const b = lowerExpr(node.right);
    emit({ op: 'copy', dest: result, a: b });
    emit({ op: 'jump', target: endL });
    emit({ op: 'label', name: shortL });
    emit({ op: 'label', name: endL });
    return result;
  }
}

function defaultFor(type) {
  switch (type) {
    case 'string': return '';
    case 'char': return 0;
    case 'bool': return false;
    default: return 0;
  }
}

/** Human-readable rendering of one quad, for the UI. */
function formatQuad(q) {
  const v = (x) => {
    if (x === null || x === undefined) return '';
    if (x.kind === 'const') {
      if (x.type === 'bool') return String(x.value);
      if (x.type === 'char') return `'${x.value}'`;
      return String(x.value);
    }
    if (x.kind === 'strref') return `&${x.name}`;
    return x.name;
  };
  switch (q.op) {
    case 'enter': return `func ${q.name}(${q.params.join(', ')}) -> ${q.returnType}`;
    case 'const': return `${v(q.dest)} = ${v(q.a)}`;
    case 'copy': return `${v(q.dest)} = ${v(q.a)}`;
    case 'bin': return `${v(q.dest)} = ${v(q.a)} ${q.operator} ${v(q.b)}`;
    case 'un': return `${v(q.dest)} = ${q.operator}${v(q.a)}`;
    case 'label': return `${q.name}:`;
    case 'jump': return `goto ${q.target}`;
    case 'iffalse': return `ifFalse ${v(q.a)} goto ${q.target}`;
    case 'iftrue': return `ifTrue ${v(q.a)} goto ${q.target}`;
    case 'param': return `param ${v(q.a)}`;
    case 'call': return q.dest ? `${v(q.dest)} = call ${q.name}, ${q.argc}` : `call ${q.name}, ${q.argc}`;
    case 'ret': return q.a ? `return ${v(q.a)}` : 'return';
    case 'print': return `print ${v(q.a)}`;
    case 'nop': return '; (removed)';
    default: return `; ${q.op}`;
  }
}

module.exports = { buildIR, formatQuad };
