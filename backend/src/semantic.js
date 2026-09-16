/**
 * Lumos — Phase 3: Semantic Analysis
 * -----------------------------------------------------------------
 * Scoped symbol table + full expression type checking. This is where
 * the compiler stops trusting the programmer: undeclared names,
 * redeclarations, const violations, bad operand types, wrong argument
 * counts, non-boolean conditions, missing returns, unreachable code
 * and unused variables all surface here.
 *
 * Every expression node is annotated with `.type` so the IR builder
 * downstream never has to guess.
 */

const NUMERIC = ['char', 'int', 'float', 'double'];
const RANK = { char: 0, int: 1, float: 2, double: 3 };

const isNumeric = (t) => NUMERIC.includes(t);

/** Can a value of `from` be implicitly used where `to` is expected? */
function assignable(to, from) {
  if (to === from) return true;
  if (from === 'error' || to === 'error') return true; // don't cascade
  if (isNumeric(to) && isNumeric(from)) return RANK[from] <= RANK[to] || to !== 'char';
  if (to === 'bool' && from === 'bool') return true;
  return false;
}

/** Does the conversion lose information? (int x = 3.7) */
function narrowing(to, from) {
  if (!isNumeric(to) || !isNumeric(from)) return false;
  return RANK[from] > RANK[to];
}

function unify(a, b) {
  if (a === 'error' || b === 'error') return 'error';
  if (isNumeric(a) && isNumeric(b)) return RANK[a] >= RANK[b] ? (a === 'char' ? 'int' : a) : (b === 'char' ? 'int' : b);
  if (a === b) return a;
  return 'error';
}

class Scope {
  constructor(parent, label) {
    this.parent = parent;
    this.label = label;
    this.symbols = new Map();
    this.depth = parent ? parent.depth + 1 : 0;
  }
  declareLocal(sym) {
    if (this.symbols.has(sym.name)) return false;
    this.symbols.set(sym.name, sym);
    return true;
  }
  lookup(name) {
    let s = this;
    while (s) {
      if (s.symbols.has(name)) return s.symbols.get(name);
      s = s.parent;
    }
    return null;
  }
}

function analyze(ast) {
  const diagnostics = [];
  // Every type judgement the checker makes, in order. The UI turns this
  // into a readable trace of *why* the program type-checks.
  const judgements = [];
  const note = (line, rule, detail) => {
    if (judgements.length < 400) judgements.push({ line, rule, detail });
  };
  const globalScope = new Scope(null, 'global');
  const functions = new Map();
  const symbolTable = []; // flat, for the UI
  let loopDepth = 0;
  let currentFn = null;

  const err = (line, message, hint, extra = {}) =>
    diagnostics.push({ phase: 'semantic', severity: 'error', line, message, hint, ...extra });
  const warn = (line, message, hint, extra = {}) =>
    diagnostics.push({ phase: 'semantic', severity: 'warning', line, message, hint, ...extra });

  function record(sym) {
    symbolTable.push({
      name: sym.name, type: sym.type, kind: sym.kind,
      scope: sym.scopeLabel, line: sym.line, isConst: !!sym.isConst,
      constValue: sym.constValue === undefined ? null : String(sym.constValue),
    });
  }

  // --- pass 1: hoist function signatures so order doesn't matter ------
  for (const node of ast.body) {
    if (node.kind !== 'FunctionDecl') continue;
    if (functions.has(node.name)) {
      err(node.line, `Function "${node.name}" is defined more than once.`,
        'Rename one of them, or delete the duplicate.');
      continue;
    }
    functions.set(node.name, {
      name: node.name, returnType: node.returnType,
      params: node.params.map((p) => ({ name: p.name, type: p.type })),
      line: node.line,
      used: false,
    });
  }

  if (!functions.has('main')) {
    warn(1, 'No main() function found.',
      'Add `int main() { ... }` — that is where execution begins.');
  }

  // --- pass 2: walk everything ---------------------------------------
  for (const node of ast.body) {
    if (node.kind === 'FunctionDecl') checkFunction(node);
    else if (node.kind === 'VarDecl') checkVarDecl(node, globalScope, 'global');
  }

  for (const fn of functions.values()) {
    if (fn.name !== 'main' && !fn.used) {
      warn(fn.line, `Function "${fn.name}" is never called.`,
        'Dead code adds nothing to the binary but noise — remove it or use it.');
    }
  }

  // -------------------------------------------------------------------
  function checkFunction(node) {
    const scope = new Scope(globalScope, node.name);
    currentFn = { ...node, returnsSomething: false };
    for (const p of node.params) {
      const sym = {
        name: p.name, type: p.type, kind: 'param',
        scopeLabel: node.name, line: p.line, used: false, assigned: true,
      };
      if (!scope.declareLocal(sym)) {
        err(p.line, `Duplicate parameter "${p.name}" in function "${node.name}".`,
          'Each parameter needs a distinct name.');
      } else record(sym);
    }
    checkBlock(node.body, scope, node.name);

    if (node.returnType !== 'void' && !currentFn.returnsSomething) {
      err(node.line, `Function "${node.name}" declares return type "${node.returnType}" but never returns a value.`,
        `Add a \`return <${node.returnType}>;\` on every path out of the function.`);
    }
    reportUnused(scope);
    currentFn = null;
  }

  function reportUnused(scope) {
    for (const sym of scope.symbols.values()) {
      if (sym.kind === 'var' && !sym.used) {
        warn(sym.line, `Variable "${sym.name}" is declared but never used.`,
          'The optimizer will delete it — consider removing it yourself.');
      }
    }
  }

  function checkBlock(block, parentScope, label) {
    const scope = new Scope(parentScope, label);
    let unreachableReported = false;
    let terminated = false;
    for (const stmt of block.body) {
      if (terminated && !unreachableReported) {
        warn(stmt.line, 'Unreachable code after a return/break/continue.',
          'Nothing below this point can ever execute.');
        unreachableReported = true;
      }
      checkStatement(stmt, scope, label);
      if (['Return', 'Break', 'Continue'].includes(stmt.kind)) terminated = true;
    }
    reportUnused(scope);
    return terminated;
  }

  function checkStatement(stmt, scope, label) {
    if (!stmt) return;
    switch (stmt.kind) {
      case 'VarDecl': return checkVarDecl(stmt, scope, label);
      case 'Block': return void checkBlock(stmt, scope, label);
      case 'ExprStmt': {
        const t = checkExpr(stmt.expr, scope);
        if (stmt.expr && ['Binary', 'Literal', 'Identifier'].includes(stmt.expr.kind)) {
          warn(stmt.line, 'This statement computes a value and then throws it away.',
            'Assign the result to a variable, or delete the line.');
        }
        return t;
      }
      case 'If': {
        checkCondition(stmt.test, scope, 'if');
        checkStatement(stmt.consequent, scope, label);
        if (stmt.alternate) checkStatement(stmt.alternate, scope, label);
        return;
      }
      case 'While': {
        checkCondition(stmt.test, scope, 'while');
        loopDepth++;
        checkStatement(stmt.body, scope, label);
        loopDepth--;
        return;
      }
      case 'For': {
        const forScope = new Scope(scope, label);
        if (stmt.init) checkStatement(stmt.init, forScope, label);
        if (stmt.test) checkCondition(stmt.test, forScope, 'for');
        if (stmt.update) checkExpr(stmt.update, forScope);
        loopDepth++;
        checkStatement(stmt.body, forScope, label);
        loopDepth--;
        reportUnused(forScope);
        return;
      }
      case 'Return': {
        if (!currentFn) {
          err(stmt.line, 'return outside of a function.', 'return may only appear inside a function body.');
          return;
        }
        if (stmt.argument) {
          const t = checkExpr(stmt.argument, scope);
          currentFn.returnsSomething = true;
          if (currentFn.returnType === 'void') {
            err(stmt.line, `Function "${currentFn.name}" is void but returns a value.`,
              'Either drop the value, or change the return type.');
          } else if (assignable(currentFn.returnType, t)) {
            note(stmt.line, 'return', `returning ${t} from a ${currentFn.returnType} function`);
          } else if (!assignable(currentFn.returnType, t)) {
            err(stmt.line, `Returning "${t}" from a function declared "${currentFn.returnType}".`,
              `Convert the value to ${currentFn.returnType}, or change the function's return type.`);
          }
        } else if (currentFn.returnType !== 'void') {
          err(stmt.line, `Function "${currentFn.name}" must return a ${currentFn.returnType}.`,
            'A bare `return;` is only legal in a void function.');
        }
        return;
      }
      case 'Break':
      case 'Continue': {
        if (loopDepth === 0) {
          err(stmt.line, `"${stmt.kind.toLowerCase()}" used outside of a loop.`,
            'It only makes sense inside while or for.');
        }
        return;
      }
      case 'Print': {
        stmt.args.forEach((a) => checkExpr(a, scope));
        return;
      }
      default:
        if (stmt.kind) checkExpr(stmt, scope);
    }
  }

  function checkCondition(expr, scope, ctx) {
    if (!expr) return;
    const t = checkExpr(expr, scope);
    note(expr.line, 'condition', `${ctx}-condition has type ${t}, must be testable for truth`);
    if (t === 'string') {
      err(expr.line, `The ${ctx}-condition has type "string", which is never a truth value.`,
        'Compare it to something instead, e.g. `name == "Lumos"`.');
    } else if (t !== 'bool' && t !== 'error' && !isNumeric(t)) {
      err(expr.line, `The ${ctx}-condition has type "${t}" and cannot be tested for truth.`,
        'Conditions need a bool (or a number treated as 0/non-zero).');
    }
    if (expr.kind === 'Assign' && expr.op === '=') {
      warn(expr.line, `Assignment inside an ${ctx}-condition — did you mean "==" instead of "="?`,
        'This assigns and then tests, which is almost never what you want.');
    }
  }

  function checkVarDecl(node, scope, label) {
    for (const d of node.declarators) {
      let declaredType = node.type;
      const existing = scope.symbols.get(d.name);
      if (existing) {
        err(d.line, `"${d.name}" is already declared in this scope (line ${existing.line}).`,
          'Pick a different name, or assign to the existing variable instead of redeclaring it.');
      }
      const shadowed = scope.parent && scope.parent.lookup(d.name);
      if (!existing && shadowed && shadowed.kind !== 'param') {
        warn(d.line, `"${d.name}" shadows an outer variable declared on line ${shadowed.line}.`,
          'Shadowing compiles fine but is a classic source of confusion.');
      }

      let constValue;
      if (d.init) {
        const initType = checkExpr(d.init, scope);
        note(d.line, 'declaration',
          `${d.name} declared ${declaredType}, initialiser has type ${initType}`);
        if (isNumeric(declaredType) && isNumeric(initType) && declaredType !== initType && assignable(declaredType, initType)) {
          note(d.line, narrowing(declaredType, initType) ? 'narrowing conversion' : 'implicit widening',
            `${initType} converted to ${declaredType}`);
        }
        if (!assignable(declaredType, initType)) {
          err(d.line,
            `Cannot initialise "${d.name}" of type "${declaredType}" with a value of type "${initType}".`,
            initType === 'string'
              ? `Remove the quotes, or declare "${d.name}" as a string.`
              : `Change the type of "${d.name}" to "${initType}", or convert the value.`,
            { varName: d.name, expected: declaredType, actual: initType });
        } else if (narrowing(declaredType, initType)) {
          warn(d.line, `Narrowing conversion: a "${initType}" value is being squeezed into an "${declaredType}".`,
            `Fractional precision is lost here. Declare "${d.name}" as ${initType} to keep it.`);
        }
        constValue = foldConstant(d.init);
      }

      const sym = {
        name: d.name, type: declaredType, kind: 'var',
        scopeLabel: label, line: d.line, isConst: node.isConst,
        used: false, assigned: Boolean(d.init), constValue,
      };
      if (node.isConst && !d.init) {
        err(d.line, `const variable "${d.name}" must be initialised at declaration.`,
          'A const can never be assigned later, so it needs its value up front.');
      }
      if (!existing) { scope.declareLocal(sym); record(sym); }
    }
  }

  // -------------------------------------------------------------------
  function checkExpr(node, scope) {
    if (!node) return 'error';
    switch (node.kind) {
      case 'Literal':
        node.type = node.literalType;
        return node.type;

      case 'Identifier': {
        const sym = scope.lookup(node.name);
        if (!sym) {
          if (functions.has(node.name)) {
            err(node.line, `"${node.name}" is a function — did you mean to call it as ${node.name}()?`,
              'Add parentheses to invoke it.');
          } else {
            err(node.line, `Undeclared identifier "${node.name}".`,
              `Declare it first, e.g. \`int ${node.name} = 0;\`, or check the spelling.`,
              { varName: node.name });
          }
          node.type = 'error';
          return 'error';
        }
        sym.used = true;
        if (!sym.assigned) {
          warn(node.line, `"${node.name}" is read before it is ever assigned a value.`,
            'Uninitialised reads produce garbage — give it a value at declaration.');
        }
        node.type = sym.type;
        node.symbol = sym;
        return sym.type;
      }

      case 'Unary': {
        const t = checkExpr(node.operand, scope);
        if (node.op === '!') {
          if (t !== 'bool' && !isNumeric(t) && t !== 'error') {
            err(node.line, `Cannot apply "!" to a value of type "${t}".`, '! expects a bool.');
          }
          node.type = 'bool';
          return 'bool';
        }
        if (!isNumeric(t) && t !== 'error') {
          err(node.line, `Cannot negate a value of type "${t}".`, 'Unary minus only applies to numbers.');
          node.type = 'error';
          return 'error';
        }
        node.type = t === 'char' ? 'int' : t;
        return node.type;
      }

      case 'Update': {
        const t = checkExpr(node.target, scope);
        if (node.target && node.target.kind !== 'Identifier') {
          err(node.line, `"${node.op}" can only be applied to a variable.`, 'Increment a named variable instead.');
        } else if (node.target && node.target.symbol) {
          if (node.target.symbol.isConst) {
            err(node.line, `Cannot modify const variable "${node.target.name}".`,
              'Drop the const, or use a separate mutable variable.');
          }
          node.target.symbol.assigned = true;
        }
        if (!isNumeric(t) && t !== 'error') {
          err(node.line, `Cannot apply "${node.op}" to type "${t}".`, 'Only numeric variables can be incremented.');
        }
        node.type = t;
        return t;
      }

      case 'Binary': {
        const lt = checkExpr(node.left, scope);
        const rt = checkExpr(node.right, scope);
        const op = node.op;

        if (['&&', '||'].includes(op)) {
          if ((lt !== 'bool' && isNumeric(lt) === false && lt !== 'error') ||
              (rt !== 'bool' && isNumeric(rt) === false && rt !== 'error')) {
            err(node.line, `Operator "${op}" needs boolean operands, got "${lt}" and "${rt}".`,
              'Compare values first, e.g. `a > 0 && b > 0`.');
          }
          node.type = 'bool';
          return 'bool';
        }

        if (['==', '!='].includes(op)) {
          note(node.line, 'equality operator', `${lt} ${op} ${rt} yields bool`);
          const ok = (lt === rt) || (isNumeric(lt) && isNumeric(rt)) || lt === 'error' || rt === 'error';
          if (!ok) {
            err(node.line, `Cannot compare "${lt}" with "${rt}" using "${op}".`,
              'Both sides of a comparison must be the same kind of thing.',
              { expected: lt, actual: rt });
          }
          node.type = 'bool';
          return 'bool';
        }

        if (['<', '>', '<=', '>='].includes(op)) {
          note(node.line, 'relational operator', `${lt} ${op} ${rt} yields bool`);
          if (!((isNumeric(lt) || lt === 'error') && (isNumeric(rt) || rt === 'error'))) {
            err(node.line, `Cannot order "${lt}" against "${rt}" with "${op}".`,
              'Relational operators compare numbers.',
              { expected: lt, actual: rt });
          }
          node.type = 'bool';
          return 'bool';
        }

        // arithmetic
        if (op === '+' && (lt === 'string' || rt === 'string')) {
          if (lt !== rt) {
            err(node.line, `Cannot concatenate "${lt}" with "${rt}".`,
              'Both sides of a string "+" must be strings.',
              { expected: lt, actual: rt });
            node.type = 'error';
            return 'error';
          }
          node.type = 'string';
          return 'string';
        }

        if (!isNumeric(lt) && lt !== 'error') {
          err(node.line, `Left operand of "${op}" has type "${lt}", which is not a number.`,
            'Arithmetic needs numeric operands.', { expected: 'int', actual: lt });
          node.type = 'error';
          return 'error';
        }
        if (!isNumeric(rt) && rt !== 'error') {
          err(node.line, `Right operand of "${op}" has type "${rt}", which is not a number.`,
            'Arithmetic needs numeric operands.', { expected: 'int', actual: rt });
          node.type = 'error';
          return 'error';
        }
        if (op === '%' && (lt === 'float' || lt === 'double' || rt === 'float' || rt === 'double')) {
          err(node.line, 'The "%" operator requires integer operands.',
            'Use integer types, or compute the remainder differently.');
        }
        if (['/', '%'].includes(op)) {
          const rv = foldConstant(node.right);
          if (rv === 0) {
            err(node.line, `Division by a constant zero.`,
              'This traps at runtime — guard the divisor or use a non-zero constant.');
          }
        }
        node.type = unify(lt, rt);
        if (lt !== rt) note(node.line, 'usual arithmetic conversions',
          `${lt} ${op} ${rt} promotes to ${node.type}`);
        return node.type;
      }

      case 'Assign': {
        const rt = checkExpr(node.value, scope);
        const target = node.target;
        if (!target || target.kind !== 'Identifier') { node.type = 'error'; return 'error'; }
        const sym = scope.lookup(target.name);
        if (!sym) {
          err(node.line, `Assignment to undeclared variable "${target.name}".`,
            `Declare it first: \`int ${target.name} = 0;\``, { varName: target.name });
          node.type = 'error';
          return 'error';
        }
        if (sym.isConst) {
          err(node.line, `Cannot assign to const variable "${sym.name}" (declared on line ${sym.line}).`,
            'const means "fixed forever" — remove the const if it needs to change.',
            { varName: sym.name });
        }
        target.type = sym.type;
        target.symbol = sym;
        sym.assigned = true;

        if (node.op !== '=' && !isNumeric(sym.type) && sym.type !== 'string') {
          err(node.line, `Compound operator "${node.op}" is not valid for type "${sym.type}".`,
            'Use it on numbers.');
        }
        note(node.line, 'assignment', `${sym.name} is ${sym.type}, value is ${rt}`);
        if (!assignable(sym.type, rt)) {
          err(node.line, `Cannot assign a "${rt}" to "${sym.name}", which is "${sym.type}".`,
            rt === 'string'
              ? 'Remove the quotes, or change the variable type to string.'
              : `Convert the value to ${sym.type} first.`,
            { varName: sym.name, expected: sym.type, actual: rt });
        } else if (narrowing(sym.type, rt)) {
          warn(node.line, `Narrowing assignment: "${rt}" value stored into an "${sym.type}" variable.`,
            'The fractional part is discarded.');
        }
        node.type = sym.type;
        return sym.type;
      }

      case 'Call': {
        const fn = functions.get(node.callee);
        if (!fn) {
          err(node.line, `Call to undefined function "${node.callee}()".`,
            'Define the function above, or check the spelling.');
          node.args.forEach((a) => checkExpr(a, scope));
          node.type = 'error';
          return 'error';
        }
        fn.used = true;
        const argTypes = node.args.map((a) => checkExpr(a, scope));
        if (argTypes.length !== fn.params.length) {
          err(node.line,
            `"${node.callee}()" expects ${fn.params.length} argument(s) but received ${argTypes.length}.`,
            `Signature: ${fn.returnType} ${fn.name}(${fn.params.map((p) => `${p.type} ${p.name}`).join(', ')})`);
        } else {
          fn.params.forEach((p, idx) => {
            note(node.line, 'argument binding',
              `${node.callee} parameter ${p.name} is ${p.type}, argument is ${argTypes[idx]}`);
            if (!assignable(p.type, argTypes[idx])) {
              err(node.line,
                `Argument ${idx + 1} of "${node.callee}()" should be "${p.type}" but is "${argTypes[idx]}".`,
                `Parameter "${p.name}" is declared ${p.type}.`,
                { expected: p.type, actual: argTypes[idx] });
            }
          });
        }
        node.type = fn.returnType;
        return fn.returnType;
      }

      default:
        node.type = 'error';
        return 'error';
    }
  }

  return {
    diagnostics,
    judgements,
    symbolTable,
    functions: [...functions.values()].map((f) => ({
      name: f.name, returnType: f.returnType, params: f.params, line: f.line,
    })),
  };
}

/** Best-effort compile-time value of a pure expression (used by the checker). */
function foldConstant(node) {
  if (!node) return undefined;
  if (node.kind === 'Literal') return node.value;
  if (node.kind === 'Unary' && node.op === '-') {
    const v = foldConstant(node.operand);
    return typeof v === 'number' ? -v : undefined;
  }
  if (node.kind === 'Binary') {
    const a = foldConstant(node.left);
    const b = foldConstant(node.right);
    if (typeof a !== 'number' || typeof b !== 'number') return undefined;
    switch (node.op) {
      case '+': return a + b;
      case '-': return a - b;
      case '*': return a * b;
      case '/': return b === 0 ? undefined : a / b;
      case '%': return b === 0 ? undefined : a % b;
      default: return undefined;
    }
  }
  return undefined;
}

module.exports = { analyze, foldConstant, assignable, isNumeric };
